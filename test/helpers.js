// Helper bersama untuk test integrasi. Setiap setup() memakai temp dir + database baru,
// dan cleanup didaftarkan SEBELUM proses dijalankan supaya kegagalan start tidak meninggalkan proses.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkConsistency } from '../src/consistency.js';
import { startApi, startWorker, waitUntil } from '../scripts/lib/harness.js';

export const FAST = {
  LEASE_MS: '600',
  HEARTBEAT_MS: '150',
  BUSY_TIMEOUT_MS: '200',
  BACKOFF_BASE_MS: '50',
  BACKOFF_CAP_MS: '200',
  POLL_MS: '20',
  JOB_TIMEOUT_MS: '3000',
  ALLOW_FAULT_INJECTION: '1',
  MAX_ATTEMPTS: '3',
};
export const TERMINAL = ['SUCCEEDED', 'FAILED'];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function setup(t, overrides = {}, { workers = 1, workerEnv = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-job-'));
  const env = { ...FAST, DB_PATH: join(dir, 'jobs.db'), REPORT_DIR: join(dir, 'reports'), ...overrides };
  const procs = [];
  t.after(async () => {
    await Promise.all(procs.map((p) => p.stop()));
    await rm(dir, { recursive: true, force: true });
  });

  let api = await startApi(env);
  procs.push(api);
  const addWorker = async (id, extraEnv = {}) => {
    const w = await startWorker({ ...env, ...workerEnv, ...extraEnv, WORKER_ID: id });
    procs.push(w);
    return w;
  };
  const restartApi = async () => {
    api = await startApi(env);
    procs.push(api);
    s.api = api;
    return api;
  };
  const ws = [];
  for (let i = 1; i <= workers; i++) ws.push(await addWorker(`w${i}`));

  const get = async (path) => {
    const r = await fetch(api.url + path);
    return { status: r.status, body: await r.json() };
  };
  const post = async (body, headers = {}) => {
    const r = await fetch(`${api.url}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json(), headers: r.headers };
  };
  const waitStatus = (id, statuses, timeoutMs = 8000) =>
    waitUntil(
      async () => {
        const { body } = await get(`/jobs/${id}`);
        return statuses.includes(body.status) ? body : null;
      },
      { timeoutMs },
    );
  /** Jalankan pemeriksa invariant langsung terhadap file database (read-only). */
  const consistency = () => {
    const db = new DatabaseSync(env.DB_PATH, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000;');
    try {
      return checkConsistency(db, env.REPORT_DIR);
    } finally {
      db.close();
    }
  };
  const reportFiles = async () => readdir(env.REPORT_DIR).catch(() => []);
  const s = { env, dir, api, workers: ws, addWorker, restartApi, get, post, waitStatus, consistency, reportFiles };
  return s;
}

export const report = (simulate, orderCount = 2000) => ({
  type: 'order_report',
  payload: { orderCount, seed: 11, simulate },
});
