// Structured log: satu baris JSON per event, ke stdout.
// Field tetap: ts, level, svc, event. Field job: jobId, attempt, durationMs, status, errorClass.

export function createLogger(svc, base = {}) {
  const write = (level, event, fields = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, svc, event, ...base, ...fields });
    process.stdout.write(line + '\n');
  };
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    fatal: (event, fields) => write('fatal', event, fields),
  };
}

/** Error yang lolos tidak boleh hilang diam-diam: log lalu exit non-zero. */
export function installCrashHandlers(log) {
  process.on('uncaughtException', (err) => {
    log.fatal('uncaught_exception', { message: err.message, stack: err.stack });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.fatal('unhandled_rejection', { message: String(reason?.message ?? reason), stack: reason?.stack });
    process.exit(1);
  });
}
