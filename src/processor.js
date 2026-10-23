import { performance } from 'node:perf_hooks';
import { backoffDelay } from './backoff.js';
import { LeaseLostError, PermanentError, TimeoutError, classify } from './errors.js';
import { claimNext, completeAttempt, extendLease, failAttempt } from './store.js';
import { TASKS } from './task.js';

/**
 * Claim dan jalankan satu job. Return false kalau tidak ada job siap.
 * Setiap jalur keluar menulis status atau mencatat log error: tidak ada silent failure.
 */
export async function processNext({ db, cfg, log }) {
  const job = claimNext(db, {
    workerId: cfg.workerId,
    leaseMs: cfg.leaseMs,
    recovery: cfg.recovery,
    now: Date.now(),
  });
  if (!job) return false;

  const attempt = job.attempts;
  const ctx = { jobId: job.id, attempt, maxAttempts: job.max_attempts };
  log.info('job_claimed', ctx);

  const ac = new AbortController();
  let leaseLost = false;

  const heartbeat = setInterval(() => {
    try {
      const ok = extendLease(db, {
        id: job.id,
        workerId: cfg.workerId,
        attempt,
        leaseMs: cfg.leaseMs,
        now: Date.now(),
      });
      if (!ok && !leaseLost) {
        leaseLost = true;
        ac.abort(new LeaseLostError());
      }
    } catch (err) {
      // Heartbeat gagal sekali belum fatal; lease masih punya sisa waktu.
      log.error('heartbeat_error', { ...ctx, message: err.message });
    }
  }, cfg.heartbeatMs);

  const timeout =
    cfg.jobTimeoutMs > 0 ? setTimeout(() => ac.abort(new TimeoutError(cfg.jobTimeoutMs)), cfg.jobTimeoutMs) : null;

  const t0 = performance.now();
  const execMs = () => Math.round(performance.now() - t0);
  try {
    const run = TASKS[job.type];
    if (!run) throw new PermanentError(`Tipe job tidak dikenal: ${job.type}`);
    const result = await run(
      { id: job.id, type: job.type, payload: JSON.parse(job.payload) },
      { signal: ac.signal, reportDir: cfg.reportDir, attempt, allowFaultInjection: cfg.allowFaultInjection },
    );
    if (leaseLost) throw new LeaseLostError();
    const ok = completeAttempt(db, {
      id: job.id,
      workerId: cfg.workerId,
      attempt,
      result,
      execMs: execMs(),
      now: Date.now(),
    });
    if (ok) log.info('job_succeeded', { ...ctx, status: 'SUCCEEDED', durationMs: execMs() });
    else log.warn('stale_completion_rejected', { ...ctx, durationMs: execMs() });
  } catch (err) {
    const { errorClass, retryable, message } = classify(err);
    if (err instanceof LeaseLostError) {
      // Job sudah milik worker lain. Jangan menulis apa pun.
      log.warn('lease_lost', { ...ctx, errorClass, durationMs: execMs() });
      return true;
    }
    const backoffMs = backoffDelay(attempt, { baseMs: cfg.backoffBaseMs, capMs: cfg.backoffCapMs });
    try {
      const r = failAttempt(db, {
        id: job.id,
        workerId: cfg.workerId,
        attempt,
        errorClass,
        message,
        retryable,
        backoffMs,
        execMs: execMs(),
        now: Date.now(),
      });
      if (r === null) log.warn('stale_failure_rejected', { ...ctx, errorClass, message });
      else if (r.status === 'PENDING') {
        log.warn('job_retry_scheduled', { ...ctx, status: 'PENDING', errorClass, message, backoffMs, durationMs: execMs() });
      } else log.error('job_failed', { ...ctx, status: 'FAILED', errorClass, message, durationMs: execMs() });
    } catch (writeErr) {
      // Status tidak bisa ditulis. Job tetap RUNNING, lease akan kedaluwarsa, lalu di-reclaim.
      log.error('job_state_write_failed', { ...ctx, errorClass, message, writeError: writeErr.message });
    }
  } finally {
    clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
  }
  return true;
}
