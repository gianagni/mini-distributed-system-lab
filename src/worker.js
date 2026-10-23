import { loadConfig } from './config.js';
import { isBusyError, openDb } from './db.js';
import { createLogger, installCrashHandlers } from './logger.js';
import { processNext } from './processor.js';

const cfg = loadConfig();
const log = createLogger('worker', { workerId: cfg.workerId });
installCrashHandlers(log);
const db = openDb(cfg.dbPath, { busyTimeoutMs: cfg.busyTimeoutMs });

let stopping = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requestStop(signal) {
  if (stopping) return;
  stopping = true;
  log.info('worker_stopping', { signal });
  // Kalau job yang sedang jalan tidak selesai dalam 10 detik, keluar saja.
  // Lease akan kedaluwarsa dan job diambil worker lain.
  setTimeout(() => {
    log.warn('worker_forced_exit', { reason: 'job tidak selesai dalam 10 detik setelah sinyal stop' });
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGTERM', () => requestStop('SIGTERM'));
process.on('SIGINT', () => requestStop('SIGINT'));

log.info('worker_started', {
  dbPath: cfg.dbPath,
  recovery: cfg.recovery,
  maxAttempts: cfg.maxAttempts,
  leaseMs: cfg.leaseMs,
  jobTimeoutMs: cfg.jobTimeoutMs,
  busyTimeoutMs: cfg.busyTimeoutMs,
  allowFaultInjection: cfg.allowFaultInjection,
});

while (!stopping) {
  let worked = false;
  try {
    worked = await processNext({ db, cfg, log });
  } catch (err) {
    if (isBusyError(err)) {
      // Kontensi lock saat claim: kondisi normal di bawah beban, tidak ada state yang berubah
      // (transaksi gagal sebelum mulai). Mundur dengan jitter supaya worker tidak serempak.
      log.warn('claim_busy', { message: err.message });
      await sleep(cfg.pollMs * 5 + Math.floor(Math.random() * cfg.pollMs * 10));
    } else {
      log.error('worker_loop_error', { message: err.message, stack: err.stack });
      await sleep(cfg.pollMs * 10);
    }
  }
  if (!worked) await sleep(cfg.pollMs);
}

db.close();
log.info('worker_stopped');
