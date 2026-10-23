// Menurunkan timeline eksekusi dari baris job + job_events asli. Fungsi murni, tanpa I/O.
// Dipakai dashboard. Tidak ada data yang dikarang: setiap segmen punya event awal dan akhir,
// atau ditandai "open" (masih berjalan per snapshot `now`).
//
// Event yang dikenali (lihat src/store.js):
//   created(0) claimed(n) succeeded(n) retry_scheduled(n) failed(n)
//   lease_expired(n)  -> ditulis worker LAIN saat reclaim; `at` = waktu deteksi, bukan waktu mati
//   stale_completion_rejected(n) / stale_failure_rejected(n) -> tulisan worker zombie ditolak fencing

// Format pesan dari failAttempt di store.js: `${message} (retry dalam ${backoffMs} ms)`.
// Dikunci oleh test dashboard supaya perubahan format di store.js langsung ketahuan.
const BACKOFF_RE = /\(retry dalam (\d+) ms\)$/;

export function parseBackoffMs(message) {
  const m = typeof message === 'string' ? message.match(BACKOFF_RE) : null;
  return m ? Number(m[1]) : null;
}

const END_EVENTS = new Set(['succeeded', 'retry_scheduled', 'failed', 'lease_expired']);
const STALE_EVENTS = new Set(['stale_completion_rejected', 'stale_failure_rejected']);

/**
 * @param {object} job baris tabel jobs (snake_case)
 * @param {Array<{attempt:number,event:string,worker_id:string|null,error_class:string|null,message:string|null,at:number}>} events urut id
 * @param {number} now waktu snapshot (ms)
 */
export function buildTimeline(job, events, now) {
  const byAttempt = new Map();
  const attemptOf = (n) => {
    let a = byAttempt.get(n);
    if (!a) {
      a = {
        attempt: n,
        workerId: null,
        claimedAt: null,
        endedAt: null,
        outcome: null,
        errorClass: null,
        message: null,
        backoffMs: null,
        endIsDetection: false,
        finalFailure: false,
        staleWrites: [],
      };
      byAttempt.set(n, a);
    }
    return a;
  };

  let createdAt = job.created_at;
  for (const e of events) {
    if (e.event === 'created') {
      createdAt = e.at;
      continue;
    }
    if (e.attempt < 1) continue;
    const a = attemptOf(e.attempt);
    if (e.event === 'claimed') {
      a.claimedAt = e.at;
      a.workerId = e.worker_id;
    } else if (STALE_EVENTS.has(e.event)) {
      a.staleWrites.push({ event: e.event, at: e.at, workerId: e.worker_id, errorClass: e.error_class });
    } else if (e.event === 'failed' && a.outcome === 'worker_lost') {
      // Reclaim pada attempt terakhir: lease_expired lalu failed WORKER_LOST di transaksi yang sama.
      a.finalFailure = true;
    } else if (END_EVENTS.has(e.event) && a.outcome === null) {
      a.endedAt = e.at;
      a.errorClass = e.error_class;
      a.message = e.message;
      if (e.event === 'succeeded') a.outcome = 'succeeded';
      else if (e.event === 'retry_scheduled') {
        a.outcome = 'retry_scheduled';
        a.backoffMs = parseBackoffMs(e.message);
      } else if (e.event === 'failed') {
        a.outcome = 'failed';
        a.finalFailure = true;
      } else {
        a.outcome = 'worker_lost';
        a.endIsDetection = true;
      }
    }
  }

  const attempts = [...byAttempt.values()].sort((x, y) => x.attempt - y.attempt);
  for (const a of attempts) {
    if (a.outcome === null) {
      // Tanpa event akhir: attempt yang sedang berjalan, atau (seharusnya tidak terjadi) data tidak lengkap.
      const current = job.status === 'RUNNING' && job.attempts === a.attempt;
      a.outcome = current ? 'running' : 'unknown';
    }
    const end = a.endedAt ?? (a.outcome === 'running' ? now : null);
    a.durationMs = a.claimedAt !== null && end !== null ? end - a.claimedAt : null;
    a.open = a.outcome === 'running';
  }

  // Jeda sebelum setiap attempt: antre (sebelum attempt 1), backoff + antre (setelah retry),
  // atau reclaim (setelah worker hilang; biasanya 0 ms karena terjadi dalam transaksi claim).
  const waits = [];
  let prevEnd = createdAt;
  let prevKind = 'queue';
  let prevBackoff = null;
  for (const a of attempts) {
    if (a.claimedAt !== null && prevEnd !== null) {
      waits.push(makeWait(prevKind, prevEnd, a.claimedAt, prevBackoff, a.attempt, false));
    }
    prevEnd = a.endedAt;
    prevKind = a.outcome === 'retry_scheduled' ? 'retry_wait' : a.outcome === 'worker_lost' ? 'reclaim' : null;
    prevBackoff = a.outcome === 'retry_scheduled' ? a.backoffMs : null;
  }
  // Job masih PENDING: jeda terakhir terbuka sampai snapshot.
  if (job.status === 'PENDING' && prevEnd !== null && prevKind !== null) {
    waits.push(makeWait(prevKind, prevEnd, now, prevBackoff, attempts.length + 1, true));
  }

  const end = job.finished_at ?? now;
  const sum = (xs) => xs.reduce((s, v) => s + v, 0);
  return {
    start: createdAt,
    end,
    open: job.finished_at === null,
    attempts,
    waits,
    totals: {
      endToEndMs: job.finished_at === null ? null : job.finished_at - createdAt,
      queueWaitMs: job.first_started_at === null ? null : job.first_started_at - createdAt,
      execMs: sum(attempts.filter((a) => !a.open && a.durationMs !== null).map((a) => a.durationMs)),
      retryWaitMs: sum(waits.filter((w) => w.kind === 'retry_wait' && !w.open).map((w) => w.durationMs)),
      staleWritesRejected: sum(attempts.map((a) => a.staleWrites.length)),
    },
  };
}

function makeWait(kind, from, to, backoffMs, beforeAttempt, open) {
  const durationMs = to - from;
  const w = { kind, from, to, durationMs, beforeAttempt, open };
  if (kind === 'retry_wait') {
    w.backoffMs = backoffMs;
    // Sisa jeda setelah backoff = menunggu worker bebas (queue lag), hanya kalau backoff diketahui.
    w.queueAfterBackoffMs = backoffMs === null || open ? null : Math.max(0, durationMs - backoffMs);
  }
  return w;
}
