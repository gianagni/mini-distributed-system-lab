import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApiServer } from './http.js';
import { createLogger, installCrashHandlers } from './logger.js';

const cfg = loadConfig();
const log = createLogger('api');
installCrashHandlers(log);
const db = openDb(cfg.dbPath, { busyTimeoutMs: cfg.busyTimeoutMs });
const server = createApiServer({ db, cfg, log });

server.listen(cfg.port, cfg.host, () => {
  log.info('api_listening', {
    host: cfg.host,
    port: server.address().port,
    dbPath: cfg.dbPath,
    maxPending: cfg.maxPending,
    allowFaultInjection: cfg.allowFaultInjection,
    requestTimeoutMs: cfg.requestTimeoutMs,
  });
  if (cfg.allowRemote) log.warn('api_remote_binding', { host: cfg.host, note: 'API tanpa autentikasi' });
});

function shutdown(signal) {
  log.info('api_stopping', { signal });
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
