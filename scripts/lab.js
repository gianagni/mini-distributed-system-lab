// npm run lab [-- --workers 2 --fault-injection --no-restart]
// Menjalankan API + N worker + dashboard dalam satu terminal, lintas platform.
// Alasan: `WORKER_ID=w1 npm run worker` tidak jalan di cmd/PowerShell Windows.
// Setiap proses tetap proses terpisah (isolasi kegagalan sama dengan menjalankan manual).
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDashboardConfig } from '../src/config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
if (flag('--help') || flag('-h')) {
  console.log(`Pemakaian: npm run lab -- [opsi]
  --workers N          jumlah worker (default 2, maksimal 8)
  --fault-injection    set ALLOW_FAULT_INJECTION=1 untuk API, worker, dan dashboard (loopback saja)
  --no-restart         jangan restart worker yang mati (default: restart setelah 1 s)
  --verbose            tampilkan semua log (default: sembunyikan http_request sukses)
Env lain (PORT, DASHBOARD_PORT, DB_PATH, MAX_ATTEMPTS, LEASE_MS, ...) diteruskan apa adanya.`);
  process.exit(0);
}

const workers = Number(opt('--workers', '2'));
if (!Number.isInteger(workers) || workers < 0 || workers > 8) {
  console.error('--workers harus integer 0..8');
  process.exit(1);
}
const env = { ...process.env };
if (flag('--fault-injection')) env.ALLOW_FAULT_INJECTION = '1';
const restart = !flag('--no-restart');
const verbose = flag('--verbose');

// Validasi konfigurasi di depan supaya error muncul sekali dan jelas, bukan dari 4 proses.
let cfg;
let dcfg;
try {
  cfg = loadConfig(env);
  dcfg = loadDashboardConfig(env);
} catch (err) {
  console.error(`Konfigurasi tidak valid: ${err.message}`);
  process.exit(1);
}

const NODE_ARGS = ['--disable-warning=ExperimentalWarning'];
const procs = new Map();
let stopping = false;

function line(name, raw) {
  let e;
  try {
    e = JSON.parse(raw);
  } catch {
    console.log(`[${name}] ${raw}`);
    return;
  }
  if (!verbose && e.event === 'http_request' && e.status < 400) return;
  const { ts, level, svc, event, workerId, ...rest } = e;
  const time = typeof ts === 'string' ? ts.slice(11, 23) : '';
  const tag = level === 'error' || level === 'fatal' ? ' ERROR' : level === 'warn' ? ' WARN' : '';
  const fields = Object.entries(rest)
    .filter(([k]) => k !== 'stack')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');
  console.log(`${time} [${name}]${tag} ${event} ${fields}`);
}

function start(name, script, extraEnv = {}) {
  const child = spawn(process.execPath, [...NODE_ARGS, join(ROOT, script)], {
    cwd: ROOT,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.set(name, child);
  createInterface({ input: child.stdout }).on('line', (l) => line(name, l));
  createInterface({ input: child.stderr }).on('line', (l) => console.error(`[${name}] ${l}`));
  child.on('exit', (code, signal) => {
    procs.delete(name);
    if (stopping) return;
    console.log(`[lab] ${name} berhenti (code=${code}, signal=${signal})`);
    if (name.startsWith('w') && restart) {
      // Seperti supervisor (systemd Restart=always). Job yang dipegangnya diambil alih setelah LEASE_MS.
      setTimeout(() => {
        if (!stopping) {
          console.log(`[lab] restart ${name} (WORKER_ID sama)`);
          start(name, script, extraEnv);
        }
      }, 1000);
    } else if (name === 'api' || name === 'dashboard') {
      console.log(`[lab] ${name} wajib hidup; menghentikan lab.`);
      shutdown(1);
    }
  });
  return child;
}

function waitForEvent(child, event, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout menunggu ${event}`)), timeoutMs);
    createInterface({ input: child.stdout }).on('line', (l) => {
      if (l.includes(`"event":"${event}"`)) {
        clearTimeout(t);
        resolve(JSON.parse(l));
      }
    });
    child.on('exit', () => reject(new Error(`proses keluar sebelum ${event}`)));
  });
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log('[lab] menghentikan semua proses…');
  // Windows tidak punya SIGTERM sungguhan: kill() langsung menghentikan proses.
  // Job RUNNING akan di-reclaim setelah LEASE_MS saat lab dijalankan lagi. Tidak ada data hilang.
  for (const c of procs.values()) c.kill('SIGTERM');
  const t = setTimeout(() => {
    for (const c of procs.values()) c.kill('SIGKILL');
    process.exit(code);
  }, 12_000);
  const check = setInterval(() => {
    if (procs.size === 0) {
      clearInterval(check);
      clearTimeout(t);
      process.exit(code);
    }
  }, 100);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

try {
  const api = start('api', 'src/api.js');
  await waitForEvent(api, 'api_listening');
  for (let i = 1; i <= workers; i++) start(`w${i}`, 'src/worker.js', { WORKER_ID: `w${i}` });
  const dash = start('dashboard', 'src/dashboard.js');
  const ready = await waitForEvent(dash, 'dashboard_listening');
  console.log('');
  console.log(`[lab] API        http://${cfg.host}:${cfg.port}`);
  console.log(`[lab] Dashboard  ${ready.url}`);
  console.log(`[lab] Worker     ${workers} (restart otomatis: ${restart ? 'ya' : 'tidak'})`);
  console.log(`[lab] Fault inj. ${env.ALLOW_FAULT_INJECTION === '1' ? 'AKTIF (loopback saja)' : 'mati'}`);
  console.log(`[lab] Database   ${cfg.dbPath}`);
  console.log('[lab] Ctrl+C untuk berhenti.');
  console.log('');
  if (dcfg.apiUrl !== `http://${cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host}:${cfg.port}`) {
    console.log(`[lab] Catatan: dashboard memakai API_URL=${dcfg.apiUrl}`);
  }
} catch (err) {
  console.error(`[lab] gagal start: ${err.message}`);
  shutdown(1);
}
