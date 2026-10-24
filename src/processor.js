import { performance } from 'node:perf_hooks';
import { backoffDelay } from './backoff.js';
import { isBusyError } from './db.js';
import { LeaseLostError, PermanentError, TimeoutError, classify } from './errors.js';
import { claimNext, completeAttempt, extendLease, failAttempt } from './store.js';
import { TASKS } from './task.js';

// Tulis status (completeAttempt/failAttempt) yang kena SQLITE_BUSY diulang secara terbatas
// (AUDIT C-1). Aman karena setiap tulisan adalah SATU transaksi BEGIN IMMEDIATE: BUSY berarti
// transaksi tidak pernah mulai (atau di-ROLLBACK), jadi tidak ada yang tertulis; dan tulisan
// di-fence dengan (lease_owner, attempts), jadi pengulangan setelah lease diambil alih ditolak.
//
// Batasnya waktu lease, bukan jumlah percobaan: kalau gagal, jalan keluarnya adalah pemulihan lewat
// lease, yang memakan minimal satu periode lease. Jadi mengulang selama masih di dalam lease tidak
// pernah lebih buruk dari menyerah. Batas jumlah hanya pengaman. (Versi pertama memakai 5 percobaan;
// dengan BUSY_TIMEOUT_MS kecil jendela itu hanya ~200 ms dari lease 600 ms, terbukti di test kontensi.)
export const STATE_WRITE_MAX_TRIES = 50;
const STATE_WRITE_BACKOFF = { baseMs: 5, capMs: 50 };
// Waktu tunggu BUSY yang sebenarnya lebih lama dari busy_timeout: busy handler SQLite menghitung
// durasi sleep nominal, dan sleep OS bisa molor (terukur 0.1-3.4 ms di Linux; di Windows granularitas
// timer default ±15.6 ms per sleep). Prediksi durasi percobaan berikutnya memakai waktu tunggu
// terlama yang BENAR-BENAR teramati, ditambah kelonggaran timer ini.
const TIMER_SLACK_MS = 25;
// Retry memakai busy_timeout yang disesuaikan dengan sisa tenggat (lease / jendela retry), tidak
// pernah lebih besar dari BUSY_TIMEOUT_MS. Tanpa ini, di Windows (tunggu nyata ±1.5x nominal) dengan
// lease 600 ms / busy_timeout 200 ms tidak ada satu pun retry yang muat (AUDIT C-2).
const MIN_RETRY_BUSY_TIMEOUT_MS = 1;

function setBusyTimeout(db, ms) {
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(ms))};`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Claim dan jalankan satu job. Return false kalau tidak ada job siap.
 * Setiap jalur keluar menulis status atau mencatat log error: tidak ada silent failure.
 *
 * Dua fase yang dipisah tegas:
 *   1. Tugas: error di sini adalah kegagalan TUGAS (classify -> retry/FAILED).
 *   2. Tulis status: error di sini adalah kegagalan DATABASE. Tidak pernah dicatat sebagai
 *      kegagalan tugas dan tidak memakai attempt. BUSY diulang terbatas; selain itu, atau kalau
 *      batas habis, job dibiarkan RUNNING dan dipulihkan lewat lease (jalur yang sudah diuji).
 */
export async function processNext({ db, cfg, log }) {
  const job = claimNext(db, {
    workerId: cfg.workerId,
    leaseMs: cfg.leaseMs,
    recovery: cfg.recovery,
    now: Date.now, // dievaluasi setelah lock didapat, supaya lease tidak termakan waktu tunggu lock
  });
  if (!job) return false;

  const attempt = job.attempts;
  const ctx = { jobId: job.id, attempt, maxAttempts: job.max_attempts };
  log.info('job_claimed', ctx);

  const ac = new AbortController();
  let leaseLost = false;
  // Batas lease yang terakhir BERHASIL ditulis. Dipakai untuk memutuskan apakah masih aman
  // menunggu lock lagi (heartbeat dan retry tulis status).
  let leaseUntil = job.lease_expires_at;

  const heartbeat = setInterval(() => {
    const now = Date.now();
    try {
      const ok = extendLease(db, { id: job.id, workerId: cfg.workerId, attempt, leaseMs: cfg.leaseMs, now });
      if (ok) leaseUntil = now + cfg.leaseMs;
      else if (!leaseLost) {
        leaseLost = true;
        ac.abort(new LeaseLostError());
      }
    } catch (err) {
      const leaseLeftMs = leaseUntil - Date.now();
      if (isBusyError(err)) {
        // Satu heartbeat yang kena lock sudah diperhitungkan (BUSY_TIMEOUT_MS + HEARTBEAT_MS < LEASE_MS).
        // Menjadi error kalau heartbeat berikutnya (yang bisa menunggu lock lagi) mungkin terlambat.
        if (leaseLeftMs <= cfg.heartbeatMs + cfg.busyTimeoutMs) {
          log.error('lease_at_risk', { ...ctx, leaseLeftMs, message: err.message });
        } else log.warn('heartbeat_busy', { ...ctx, leaseLeftMs });
      } else {
        log.error('heartbeat_error', { ...ctx, leaseLeftMs, message: err.message, code: err.errcode ?? err.code ?? null });
      }
    }
  }, cfg.heartbeatMs);

  const timeout =
    cfg.jobTimeoutMs > 0 ? setTimeout(() => ac.abort(new TimeoutError(cfg.jobTimeoutMs)), cfg.jobTimeoutMs) : null;

  const t0 = performance.now();
  const execMs = () => Math.round(performance.now() - t0);

  /** Jalankan satu tulisan status dengan retry terbatas khusus SQLITE_BUSY. */
  async function writeState(op, write, fields = {}) {
    let firstBusyAt = null;
    let busyWaitMs = 0; // waktu tunggu BUSY terlama yang teramati
    let overshootMs = TIMER_SLACK_MS; // selisih terbesar tunggu nyata - busy_timeout nominal, minimal TIMER_SLACK_MS
    let timeoutMs = cfg.busyTimeoutMs; // busy_timeout yang berlaku untuk percobaan ini
    try {
      return await attempt();
    } finally {
      if (timeoutMs !== cfg.busyTimeoutMs) setBusyTimeout(db, cfg.busyTimeoutMs);
    }

    async function attempt() {
    for (let tryNo = 1; ; tryNo++) {
      // Retry tidak boleh berjalan setelah worker tahu lease-nya hilang (tulisannya pasti ditolak).
      if (tryNo > 1 && leaseLost) {
        log.warn('lease_lost', { ...ctx, op, tries: tryNo - 1, durationMs: execMs() });
        return { ok: false };
      }
      const tryStart = performance.now();
      try {
        return { ok: true, value: write() };
      } catch (err) {
        const busy = isBusyError(err);
        const tookMs = Math.round(performance.now() - tryStart);
        const now = Date.now();
        if (busy) {
          firstBusyAt ??= now - tookMs;
          busyWaitMs = Math.max(busyWaitMs, tookMs);
          overshootMs = Math.max(overshootMs, tookMs - timeoutMs);
        }
        const leaseLeftMs = leaseUntil - now;
        // Heartbeat bisa memperpanjang lease selama retry; total retry tetap dibatasi satu periode lease.
        const windowLeftMs = busy ? cfg.leaseMs - (now - firstBusyAt) : 0;
        const waitMs = backoffDelay(tryNo, STATE_WRITE_BACKOFF);
        // Tunggu lock percobaan berikutnya (nyata = nominal + overshoot teramati) harus selesai sebelum
        // lease habis DAN sebelum jendela retry habis.
        const budgetMs = Math.min(leaseLeftMs, windowLeftMs) - waitMs;
        const nextTimeoutMs = Math.min(cfg.busyTimeoutMs, Math.floor(budgetMs - overshootMs));
        if (busy && tryNo < STATE_WRITE_MAX_TRIES && nextTimeoutMs >= MIN_RETRY_BUSY_TIMEOUT_MS) {
          log.warn('state_write_busy', {
            ...ctx,
            op,
            try: tryNo,
            busyWaitMs: tookMs,
            leaseLeftMs,
            retryInMs: waitMs,
            nextBusyTimeoutMs: nextTimeoutMs,
          });
          await sleep(waitMs);
          if (nextTimeoutMs !== timeoutMs) {
            setBusyTimeout(db, nextTimeoutMs);
            timeoutMs = nextTimeoutMs;
          }
          continue;
        }
        // Status tidak bisa ditulis. Job tetap RUNNING, lease akan kedaluwarsa, lalu di-reclaim.
        log.error('job_state_write_failed', {
          ...ctx,
          op,
          ...fields,
          writeError: err.message,
          writeErrorCode: err.errcode ?? err.code ?? null,
          tries: tryNo,
          leaseLeftMs,
          retryMs: firstBusyAt === null ? 0 : now - firstBusyAt,
          maxBusyWaitMs: busy ? busyWaitMs : null,
          overshootMs: busy ? overshootMs : null,
          reason: !busy
            ? 'non_busy_error'
            : tryNo >= STATE_WRITE_MAX_TRIES
              ? 'max_tries'
              : leaseLeftMs <= windowLeftMs
                ? 'lease_too_short'
                : 'retry_window_exhausted',
        });
        return { ok: false };
      }
    }
    }
  }

  // ---- Fase 1: tugas ----
  let result;
  let taskErr = null;
  try {
    const run = TASKS[job.type];
    if (!run) throw new PermanentError(`Tipe job tidak dikenal: ${job.type}`);
    result = await run(
      { id: job.id, type: job.type, payload: JSON.parse(job.payload) },
      { signal: ac.signal, reportDir: cfg.reportDir, attempt, allowFaultInjection: cfg.allowFaultInjection },
    );
    if (leaseLost) throw new LeaseLostError();
  } catch (err) {
    taskErr = err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  // ---- Fase 2: tulis status (heartbeat tetap jalan selama retry) ----
  try {
    if (taskErr instanceof LeaseLostError) {
      // Job sudah milik worker lain. Jangan menulis apa pun.
      log.warn('lease_lost', { ...ctx, errorClass: 'LEASE_LOST', durationMs: execMs() });
      return true;
    }
    if (!taskErr) {
      const w = await writeState('complete', () =>
        completeAttempt(db, { id: job.id, workerId: cfg.workerId, attempt, result, execMs: execMs(), now: Date.now() }),
      );
      if (w.ok && w.value) log.info('job_succeeded', { ...ctx, status: 'SUCCEEDED', durationMs: execMs() });
      else if (w.ok) log.warn('stale_completion_rejected', { ...ctx, durationMs: execMs() });
      return true;
    }
    const { errorClass, retryable, message } = classify(taskErr);
    const backoffMs = backoffDelay(attempt, { baseMs: cfg.backoffBaseMs, capMs: cfg.backoffCapMs });
    const w = await writeState(
      'fail',
      () =>
        failAttempt(db, {
          id: job.id,
          workerId: cfg.workerId,
          attempt,
          errorClass,
          message,
          retryable,
          backoffMs,
          execMs: execMs(),
          now: Date.now(),
        }),
      { errorClass, message },
    );
    if (!w.ok) return true;
    const r = w.value;
    if (r === null) log.warn('stale_failure_rejected', { ...ctx, errorClass, message });
    else if (r.status === 'PENDING') {
      log.warn('job_retry_scheduled', { ...ctx, status: 'PENDING', errorClass, message, backoffMs, durationMs: execMs() });
    } else log.error('job_failed', { ...ctx, status: 'FAILED', errorClass, message, durationMs: execMs() });
    return true;
  } finally {
    clearInterval(heartbeat);
  }
}
