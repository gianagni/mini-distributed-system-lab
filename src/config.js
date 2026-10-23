// Semua konfigurasi dari environment variable, divalidasi saat start.
// Proses gagal cepat kalau konfigurasi tidak masuk akal (bukan silent default).

function int(env, name, def, { min = 0 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`Env ${name} harus integer >= ${min}, dapat: ${raw}`);
  }
  return n;
}

export function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function loadConfig(env = process.env) {
  const cfg = {
    dbPath: env.DB_PATH || './data/jobs.db',
    reportDir: env.REPORT_DIR || './data/reports',
    host: env.HOST || '127.0.0.1',
    port: int(env, 'PORT', 3000),
    // API tidak punya autentikasi. Bind ke alamat selain loopback harus disengaja.
    allowRemote: env.ALLOW_REMOTE === '1',
    requestTimeoutMs: int(env, 'REQUEST_TIMEOUT_MS', 10_000, { min: 100 }),
    maxPending: int(env, 'MAX_PENDING', 1000, { min: 1 }),
    maxAttempts: int(env, 'MAX_ATTEMPTS', 3, { min: 1 }),
    backoffBaseMs: int(env, 'BACKOFF_BASE_MS', 500),
    backoffCapMs: int(env, 'BACKOFF_CAP_MS', 10_000),
    leaseMs: int(env, 'LEASE_MS', 5000, { min: 1 }),
    heartbeatMs: int(env, 'HEARTBEAT_MS', 1000, { min: 1 }),
    // Lama menunggu lock SQLite. Menunggu ini MEMBLOKIR event loop (API sinkron),
    // termasuk heartbeat, jadi harus jauh di bawah LEASE_MS.
    busyTimeoutMs: int(env, 'BUSY_TIMEOUT_MS', 1000),
    // 0 = tanpa timeout (hanya untuk eksperimen baseline).
    jobTimeoutMs: int(env, 'JOB_TIMEOUT_MS', 30_000),
    pollMs: int(env, 'POLL_MS', 100, { min: 1 }),
    // RECOVERY=0 mematikan pengambilalihan job dari worker yang mati (mode baseline).
    recovery: env.RECOVERY !== '0',
    allowFaultInjection: env.ALLOW_FAULT_INJECTION === '1',
    workerId: env.WORKER_ID || `w-${process.pid}`,
  };
  if (cfg.busyTimeoutMs + cfg.heartbeatMs >= cfg.leaseMs) {
    throw new Error(
      'BUSY_TIMEOUT_MS + HEARTBEAT_MS harus lebih kecil dari LEASE_MS, ' +
        'supaya menunggu lock database tidak membuat lease kedaluwarsa',
    );
  }
  if (cfg.backoffCapMs < cfg.backoffBaseMs) {
    throw new Error('BACKOFF_CAP_MS harus >= BACKOFF_BASE_MS');
  }
  if (!isLoopbackHost(cfg.host)) {
    if (cfg.allowFaultInjection) {
      throw new Error('ALLOW_FAULT_INJECTION=1 hanya boleh dengan HOST loopback (127.0.0.1/localhost/::1)');
    }
    if (!cfg.allowRemote) {
      throw new Error(`HOST=${cfg.host} bukan loopback. API tanpa autentikasi; set ALLOW_REMOTE=1 kalau memang disengaja`);
    }
  }
  return cfg;
}

/**
 * Konfigurasi proses dashboard (npm run dashboard). Terpisah dari loadConfig supaya
 * validasi API/worker tidak berubah. Aturan keamanannya sama: loopback secara default,
 * fault injection hanya di loopback.
 */
export function loadDashboardConfig(env = process.env) {
  const cfg = {
    dbPath: env.DB_PATH || './data/jobs.db',
    host: env.DASHBOARD_HOST || '127.0.0.1',
    port: int(env, 'DASHBOARD_PORT', 3100),
    apiUrl: env.API_URL || `http://127.0.0.1:${int(env, 'PORT', 3000)}`,
    allowRemote: env.ALLOW_REMOTE === '1',
    // Hanya menampilkan panel fault injection. API dan worker tetap memvalidasi flag mereka sendiri.
    allowFaultInjection: env.ALLOW_FAULT_INJECTION === '1',
    busyTimeoutMs: int(env, 'BUSY_TIMEOUT_MS', 1000),
    requestTimeoutMs: int(env, 'REQUEST_TIMEOUT_MS', 10_000, { min: 100 }),
  };
  let apiHost;
  try {
    const u = new URL(cfg.apiUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protokol');
    apiHost = u.hostname.replace(/^\[|\]$/g, '');
    cfg.apiUrl = u.origin;
  } catch {
    throw new Error(`API_URL tidak valid: ${cfg.apiUrl}`);
  }
  const remote = !isLoopbackHost(cfg.host) || !isLoopbackHost(apiHost);
  if (remote) {
    if (cfg.allowFaultInjection) {
      throw new Error('ALLOW_FAULT_INJECTION=1 hanya boleh dengan DASHBOARD_HOST dan API_URL loopback');
    }
    if (!cfg.allowRemote) {
      throw new Error(
        `DASHBOARD_HOST=${cfg.host} / API_URL=${cfg.apiUrl} bukan loopback. Dashboard tanpa autentikasi; set ALLOW_REMOTE=1 kalau memang disengaja`,
      );
    }
  }
  return cfg;
}
