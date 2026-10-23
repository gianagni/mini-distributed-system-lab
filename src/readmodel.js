import { stmt } from './db.js';
import { computeMetrics } from './metrics.js';
import { buildTimeline } from './timeline.js';

// Query read-only untuk dashboard. Tidak ada INSERT/UPDATE di file ini, dan koneksi
// dashboard dibuka readOnly, jadi SQLite sendiri yang menolak tulisan.
//
// Setiap fungsi membaca dalam SATU read transaction (snapshot WAL), pola yang sama dengan
// consistency.js (AUDIT P2-10). Tanpa itu, baris jobs dan job_events bisa berasal dari
// waktu berbeda saat worker aktif, misalnya status SUCCEEDED tanpa event succeeded.
//
// Waktu dikirim sebagai epoch ms (bukan ISO) supaya browser bisa menghitung durasi
// tanpa parsing; `now` server ikut dikirim sebagai acuan snapshot.

export const STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'];
export const ERROR_CLASSES = ['TRANSIENT', 'TIMEOUT', 'WORKER_LOST', 'INTERNAL', 'STORAGE', 'PERMANENT'];

export function snapshot(db, fn) {
  db.exec('BEGIN');
  try {
    return fn();
  } finally {
    db.exec('COMMIT');
  }
}

const SUMMARY_COLUMNS = `id, type, status, attempts, max_attempts, error_class, error_message, payload,
  created_at, first_started_at, started_at, finished_at, next_run_at, exec_ms, lease_owner, lease_expires_at`;

function parsePayload(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function summarizeJob(j, now) {
  const payload = parsePayload(j.payload);
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.max_attempts,
    error: j.error_class ? { class: j.error_class, message: j.error_message } : null,
    orderCount: payload?.orderCount ?? null,
    faultInjected: Boolean(payload?.simulate),
    createdAt: j.created_at,
    firstStartedAt: j.first_started_at,
    startedAt: j.started_at,
    finishedAt: j.finished_at,
    nextRunAt: j.status === 'PENDING' ? j.next_run_at : null,
    lease:
      j.status === 'RUNNING'
        ? { owner: j.lease_owner, expiresAt: j.lease_expires_at, remainingMs: j.lease_expires_at - now }
        : null,
    latency: {
      endToEndMs: j.finished_at === null ? null : j.finished_at - j.created_at,
      queueWaitMs: j.first_started_at === null ? null : j.first_started_at - j.created_at,
      lastAttemptExecMs: j.exec_ms,
    },
  };
}

const CURSOR_RE = /^(\d{1,16})_([0-9a-f-]{36})$/;

export function parseCursor(raw) {
  const m = typeof raw === 'string' ? raw.match(CURSOR_RE) : null;
  return m ? { createdAt: Number(m[1]), id: m[2] } : null;
}

/**
 * Daftar job terbaru dulu, keyset pagination (created_at DESC, id DESC).
 * Tanpa index created_at: O(n) per halaman. Cukup untuk skala lab; dicatat di dokumen.
 */
function listJobsInTx(db, { status = null, errorClass = null, retried = false, limit = 50, before = null }, now) {
  const where = [];
  const params = { limit: limit + 1 };
  if (status) {
    where.push('status = :status');
    params.status = status;
  }
  if (errorClass) {
    where.push('error_class = :errorClass');
    params.errorClass = errorClass;
  }
  if (retried) where.push('attempts > 1');
  if (before) {
    where.push('(created_at < :bc OR (created_at = :bc AND id < :bid))');
    params.bc = before.createdAt;
    params.bid = before.id;
  }
  const sql = `SELECT ${SUMMARY_COLUMNS} FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC, id DESC LIMIT :limit`;
  const rows = stmt(db, sql).all(params);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((j) => summarizeJob(j, now)),
    nextCursor: rows.length > limit && last ? `${last.created_at}_${last.id}` : null,
  };
}

function countsInTx(db) {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of stmt(db, 'SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()) byStatus[r.status] = r.n;
  const byErrorClass = {};
  for (const r of stmt(
    db,
    'SELECT error_class, COUNT(*) AS n FROM jobs WHERE error_class IS NOT NULL GROUP BY error_class',
  ).all()) {
    byErrorClass[r.error_class] = r.n;
  }
  const { n: retried } = stmt(db, 'SELECT COUNT(*) AS n FROM jobs WHERE attempts > 1').get();
  return { byStatus, byErrorClass, retried };
}

export function listJobs(db, query, now = Date.now()) {
  return snapshot(db, () => ({ generatedAt: now, ...listJobsInTx(db, query, now), counts: countsInTx(db) }));
}

export function getJobDetail(db, id, now = Date.now()) {
  return snapshot(db, () => {
    const job = stmt(db, 'SELECT * FROM jobs WHERE id = ?').get(id);
    if (!job) return null;
    const events = stmt(
      db,
      'SELECT id, attempt, event, worker_id, error_class, message, at FROM job_events WHERE job_id = ? ORDER BY id',
    ).all(id);
    return {
      generatedAt: now,
      job: {
        ...summarizeJob(job, now),
        payload: parsePayload(job.payload),
        result: job.result ? parsePayload(job.result) : null,
        idempotencyKey: job.idempotency_key,
      },
      events: events.map((e) => ({
        seq: e.id,
        attempt: e.attempt,
        event: e.event,
        workerId: e.worker_id,
        errorClass: e.error_class,
        message: e.message,
        at: e.at,
      })),
      timeline: buildTimeline(job, events, now),
    };
  });
}

/**
 * Worker yang TERLIHAT di event. Worker idle tidak menulis apa pun, jadi tidak muncul.
 * lease_expired ditulis worker lain atas nama pemilik lama, jadi tidak dihitung sebagai aktivitas
 * worker itu (dihitung terpisah sebagai leasesLost).
 */
function workersInTx(db, now) {
  const map = new Map();
  const get = (id) => {
    let w = map.get(id);
    if (!w) {
      w = { workerId: id, lastEventAt: null, claims: 0, succeeded: 0, failures: 0, staleRejected: 0, leasesLost: 0, runningNow: [] };
      map.set(id, w);
    }
    return w;
  };
  for (const r of stmt(
    db,
    `SELECT worker_id, MAX(at) AS last,
       SUM(event = 'claimed') AS claims,
       SUM(event = 'succeeded') AS succeeded,
       SUM(event IN ('retry_scheduled', 'failed')) AS failures,
       SUM(event IN ('stale_completion_rejected', 'stale_failure_rejected')) AS stale
     FROM job_events WHERE worker_id IS NOT NULL AND event <> 'lease_expired'
     GROUP BY worker_id`,
  ).all()) {
    Object.assign(get(r.worker_id), {
      lastEventAt: r.last,
      claims: r.claims,
      succeeded: r.succeeded,
      failures: r.failures,
      staleRejected: r.stale,
    });
  }
  for (const r of stmt(
    db,
    "SELECT worker_id, COUNT(*) AS n FROM job_events WHERE event = 'lease_expired' AND worker_id IS NOT NULL GROUP BY worker_id",
  ).all()) {
    get(r.worker_id).leasesLost = r.n;
  }
  const running = stmt(
    db,
    `SELECT ${SUMMARY_COLUMNS} FROM jobs WHERE status = 'RUNNING' ORDER BY started_at LIMIT 100`,
  ).all();
  for (const j of running) if (j.lease_owner) get(j.lease_owner).runningNow.push(j.id);
  const workers = [...map.values()].sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0)).slice(0, 50);
  return { workers, running: running.map((j) => summarizeJob(j, now)) };
}

export function getOverview(db, now = Date.now()) {
  return snapshot(db, () => {
    const { workers, running } = workersInTx(db, now);
    return {
      generatedAt: now,
      metrics: computeMetrics(db, now),
      running,
      workers,
      recent: listJobsInTx(db, { limit: 8 }, now).items,
    };
  });
}
