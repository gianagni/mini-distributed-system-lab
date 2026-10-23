import { stmt } from './db.js';

// Metrik dihitung langsung dari storage, jadi tetap benar walau proses API/worker restart.
// Biaya O(jumlah job). Cukup untuk skala capstone; lihat ADR untuk batasnya.

/** Nearest-rank percentile pada array yang sudah terurut. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

export function summarize(values) {
  const s = values.filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
  return {
    count: s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s.length ? s[s.length - 1] : null,
  };
}

export function computeMetrics(db, now = Date.now()) {
  const byStatus = { PENDING: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0 };
  for (const r of stmt(db, 'SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()) {
    byStatus[r.status] = r.n;
  }

  const events = {};
  for (const r of stmt(db, 'SELECT event, COUNT(*) AS n FROM job_events GROUP BY event').all()) {
    events[r.event] = r.n;
  }

  const failedByErrorClass = {};
  for (const r of stmt(
    db,
    "SELECT error_class, COUNT(*) AS n FROM jobs WHERE status = 'FAILED' GROUP BY error_class",
  ).all()) {
    failedByErrorClass[r.error_class ?? 'UNKNOWN'] = r.n;
  }

  const attemptsHistogram = {};
  for (const r of stmt(
    db,
    "SELECT attempts, COUNT(*) AS n FROM jobs WHERE status IN ('SUCCEEDED','FAILED') GROUP BY attempts",
  ).all()) {
    attemptsHistogram[r.attempts] = r.n;
  }

  const { n: runningWithExpiredLease } = stmt(
    db,
    "SELECT COUNT(*) AS n FROM jobs WHERE status = 'RUNNING' AND lease_expires_at < ?",
  ).get(now);
  // Antrean "siap" = PENDING yang next_run_at sudah lewat. Job yang sedang menunggu backoff tidak dihitung lag.
  const queue = stmt(
    db,
    `SELECT
       SUM(CASE WHEN next_run_at <= :now THEN 1 ELSE 0 END) AS ready,
       SUM(CASE WHEN next_run_at >  :now THEN 1 ELSE 0 END) AS backoff,
       MIN(CASE WHEN next_run_at <= :now THEN next_run_at END) AS oldestReady
     FROM jobs WHERE status = 'PENDING'`,
  ).get({ now });
  const { oldestStart } = stmt(db, "SELECT MIN(started_at) AS oldestStart FROM jobs WHERE status = 'RUNNING'").get();
  const { n: duplicateSuccessJobs } = stmt(
    db,
    `SELECT COUNT(*) AS n FROM (
       SELECT job_id FROM job_events WHERE event = 'succeeded' GROUP BY job_id HAVING COUNT(*) > 1
     )`,
  ).get();

  const done = stmt(
    db,
    "SELECT created_at, first_started_at, finished_at, exec_ms FROM jobs WHERE status = 'SUCCEEDED'",
  ).all();

  return {
    generatedAt: new Date(now).toISOString(),
    jobs: { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus },
    counters: {
      succeeded: byStatus.SUCCEEDED,
      failed: byStatus.FAILED,
      retriesScheduled: events.retry_scheduled ?? 0,
      workerLost: events.lease_expired ?? 0,
      staleWritesRejected: (events.stale_completion_rejected ?? 0) + (events.stale_failure_rejected ?? 0),
      duplicateSuccessJobs,
    },
    failedByErrorClass,
    attemptsHistogram,
    health: {
      // > 0 berarti ada worker yang mati/macet. Di mode RECOVERY=0 job ini tidak akan pernah selesai.
      runningWithExpiredLease,
      // Attempt yang sudah berjalan paling lama. Mendeteksi job hang yang heartbeat-nya masih hidup
      // (tidak terlihat oleh runningWithExpiredLease). Bandingkan dengan JOB_TIMEOUT_MS.
      oldestRunningAgeMs: oldestStart === null ? null : now - oldestStart,
      pendingReady: queue.ready ?? 0,
      pendingInBackoff: queue.backoff ?? 0,
      // Queue lag: berapa lama job siap jalan sudah menunggu worker.
      oldestReadyPendingAgeMs: queue.oldestReady === null ? null : now - queue.oldestReady,
    },
    latencyMs: {
      endToEnd: summarize(done.map((r) => r.finished_at - r.created_at)),
      queueWait: summarize(done.map((r) => (r.first_started_at === null ? null : r.first_started_at - r.created_at))),
      lastAttemptExec: summarize(done.map((r) => r.exec_ms)),
    },
  };
}
