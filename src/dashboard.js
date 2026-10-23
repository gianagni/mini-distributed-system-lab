import { resolve } from 'node:path';
import { loadDashboardConfig } from './config.js';
import { createDashboardServer } from './dashboard-http.js';
import { createLogger, installCrashHandlers } from './logger.js';

const cfg = loadDashboardConfig();
const log = createLogger('dashboard');
installCrashHandlers(log);
const server = createDashboardServer({ cfg, log });

server.listen(cfg.port, cfg.host, () => {
  const { port } = server.address();
  const host = cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host;
  log.info('dashboard_listening', {
    host: cfg.host,
    port,
    url: `http://${host}:${port}/`,
    apiUrl: cfg.apiUrl,
    dbPath: resolve(cfg.dbPath),
    faultInjectionPanel: cfg.allowFaultInjection,
  });
  if (cfg.allowRemote) log.warn('dashboard_remote_binding', { host: cfg.host, note: 'dashboard tanpa autentikasi' });
});

function shutdown(signal) {
  log.info('dashboard_stopping', { signal });
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
