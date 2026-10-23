// Menjalankan proses API/worker sebagai child process dan membaca log JSON-nya.
// Dipakai oleh test integrasi dan script eksperimen.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const API_SCRIPT = join(ROOT, 'src', 'api.js');
export const WORKER_SCRIPT = join(ROOT, 'src', 'worker.js');
export const DASHBOARD_SCRIPT = join(ROOT, 'src', 'dashboard.js');

// Semua child process dibunuh saat proses induk (test/eksperimen) keluar,
// supaya run berikutnya tidak mewarisi worker yatim.
const children = new Set();
process.on('exit', () => {
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  }
});

export function startProcess(script, env, name) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const events = [];
  const waiters = new Set();
  let stderr = '';

  createInterface({ input: child.stdout }).on('line', (line) => {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      e = { raw: line };
    }
    events.push(e);
    for (const w of [...waiters]) {
      if (w.pred(e)) {
        waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(e);
      }
    }
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const alive = () => child.exitCode === null && child.signalCode === null;

  return {
    name,
    child,
    events,
    exited,
    get stderr() {
      return stderr;
    },
    waitFor(pred, timeoutMs = 5000) {
      const found = events.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        w.timer = setTimeout(() => {
          waiters.delete(w);
          reject(new Error(`${name}: timeout menunggu event. stderr: ${stderr.slice(-500)}`));
        }, timeoutMs);
        waiters.add(w);
      });
    },
    kill(signal = 'SIGKILL') {
      if (alive()) child.kill(signal);
      return exited;
    },
    async stop(graceMs = 3000) {
      if (!alive()) return exited;
      child.kill('SIGTERM');
      const t = setTimeout(() => {
        if (alive()) child.kill('SIGKILL');
      }, graceMs);
      const r = await exited;
      clearTimeout(t);
      return r;
    },
  };
}

export async function startApi(env) {
  const p = startProcess(API_SCRIPT, { PORT: '0', ...env }, 'api');
  const e = await p.waitFor((x) => x.event === 'api_listening');
  p.url = `http://127.0.0.1:${e.port}`;
  return p;
}

export async function startWorker(env, name = env.WORKER_ID ?? 'worker') {
  const p = startProcess(WORKER_SCRIPT, env, name);
  await p.waitFor((x) => x.event === 'worker_started');
  return p;
}

export async function startDashboard(env) {
  const p = startProcess(DASHBOARD_SCRIPT, { DASHBOARD_PORT: '0', ...env }, 'dashboard');
  const e = await p.waitFor((x) => x.event === 'dashboard_listening');
  p.url = `http://127.0.0.1:${e.port}`;
  return p;
}

export async function waitUntil(fn, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`waitUntil: timeout ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
