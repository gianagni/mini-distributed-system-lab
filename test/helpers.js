// Helper bersama untuk test integrasi. Setiap setup() memakai temp dir + database baru,
// dan cleanup didaftarkan SEBELUM proses dijalankan supaya kegagalan start tidak meninggalkan proses.
import { readdirSync, readlinkSync } from 'node:fs';
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

/**
 * File di bawah `dir` yang masih dibuka proses test ini. Linux: dari /proc/self/fd. Platform lain
 * mengembalikan null (tidak bisa diperiksa; di Windows file terbuka membuat rm gagal EBUSY sendiri).
 */
export function openFilesUnder(dir) {
  if (process.platform !== 'linux') return null;
  const open = [];
  for (const fd of readdirSync('/proc/self/fd')) {
    let target = '';
    try {
      target = readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      continue; // fd sudah tertutup di antara readdir dan readlink
    }
    if (target.startsWith(dir)) open.push(target.slice(dir.length));
  }
  return open;
}

/**
 * Hapus temp dir test. Gagal (bukan retry) kalau masih ada file yang terbuka: itu kebocoran resource
 * (koneksi SQLite belum ditutup) yang di Windows muncul sebagai EBUSY. Lihat AUDIT C-2.
 */
export async function removeTempDir(dir) {
  const open = openFilesUnder(dir);
  if (open && open.length) {
    throw new Error(`Cleanup: masih ada file terbuka di ${dir}: ${[...new Set(open)].join(', ')}. Tutup koneksi sebelum menghapus.`);
  }
  await rm(dir, { recursive: true, force: true });
}

export async function setup(t, overrides = {}, { workers = 1, workerEnv = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-job-'));
  const env = { ...FAST, DB_PATH: join(dir, 'jobs.db'), REPORT_DIR: join(dir, 'reports'), ...overrides };
  const procs = [];
  const closers = [];
  // Urutan wajib: hentikan proses, tutup koneksi/timer milik test (defer), baru hapus direktori.
  // Satu hook saja, supaya urutannya tidak bergantung pada urutan pendaftaran t.after().
  t.after(async () => {
    await Promise.all(procs.map((p) => p.stop()));
    for (const close of closers.reverse()) await close();
    await removeTempDir(dir);
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

  // Request yang menggantung harus gagal dengan nama path-nya, bukan diam sampai timeout test (AUDIT C-2).
  const get = async (path) => {
    const r = await fetch(api.url + path, { signal: httpTimeout(`GET ${path}`) });
    return { status: r.status, body: await r.json() };
  };
  const post = async (body, headers = {}) => {
    const r = await fetch(`${api.url}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: httpTimeout('POST /jobs'),
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
  // Proses tambahan (mis. dashboard) ikut dihentikan SEBELUM temp dir dihapus. Penting di Windows:
  // file yang masih dibuka proses lain tidak bisa dihapus (EBUSY).
  const track = (p) => {
    procs.push(p);
    return p;
  };
  /** Daftarkan penutup resource milik test (koneksi SQLite, timer). Dijalankan sebelum temp dir dihapus. */
  const defer = (close) => {
    closers.push(close);
    return close;
  };
  const s = { env, dir, api, workers: ws, addWorker, restartApi, get, post, waitStatus, consistency, reportFiles, track, defer };
  return s;
}

const HTTP_TIMEOUT_MS = 30_000;
function httpTimeout(what) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`${what}: tidak ada respons dalam ${HTTP_TIMEOUT_MS} ms`)), HTTP_TIMEOUT_MS);
  timer.unref();
  return ac.signal;
}

export const report = (simulate, orderCount = 2000) => ({
  type: 'order_report',
  payload: { orderCount, seed: 11, simulate },
});

/**
 * Kirim job lewat POST /jobs sesuai kontraknya: setiap job punya Idempotency-Key sendiri, 503 DB_BUSY
 * (database terkunci, tidak ada job dibuat) diulang dengan key YANG SAMA setelah Retry-After, maksimal
 * maxTries kali. Mengembalikan pencatatan lengkap supaya test bisa membuktikan tidak ada job hilang
 * atau ganda (AUDIT C-2).
 */
export async function submitJobs(s, bodies, { keyPrefix, maxTries = 10, maxRetryAfterMs = 1000 } = {}) {
  const acc = { attempted: bodies.length, requests: 0, accepted: 0, replayed: 0, busy503: 0, gaveUp: 0, other: {}, ids: [] };
  for (let i = 0; i < bodies.length; i++) {
    const key = `${keyPrefix}-${i}`;
    for (let tryNo = 1; ; tryNo++) {
      const r = await s.post(bodies[i], { 'idempotency-key': key });
      acc.requests += 1;
      if (r.status === 202 || r.status === 200) {
        if (r.status === 202) acc.accepted += 1;
        else acc.replayed += 1;
        acc.ids.push(r.body.id);
        break;
      }
      if (r.status === 503) {
        acc.busy503 += 1;
        if (tryNo < maxTries) {
          const after = Number(r.headers.get('retry-after'));
          await sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : maxRetryAfterMs, maxRetryAfterMs));
          continue;
        }
      } else {
        acc.other[r.status] = (acc.other[r.status] ?? 0) + 1;
      }
      acc.gaveUp += 1;
      break;
    }
  }
  return acc;
}

export const submitSummary = ({ ids, ...rest }) => ({ ...rest, uniqueIds: new Set(ids).size });

/**
 * Tunggu sampai n job selesai (SUCCEEDED atau FAILED), dibatasi timeoutMs, lalu wajibkan semuanya
 * SUCCEEDED. Job yang berakhir FAILED langsung menggagalkan test dengan angka lengkap, bukan menunggu
 * sampai timeout; timeout juga gagal dengan angka lengkap (status job, pengiriman, error worker/API),
 * bukan sekadar "waitUntil: timeout" (AUDIT C-2). onPoll dijalankan setiap putaran (mis. pemeriksaan
 * konsistensi selama worker aktif).
 */
export async function waitForSucceeded(s, n, { timeoutMs, submitted, onPoll, intervalMs } = {}) {
  let m;
  let reason = null;
  try {
    await waitUntil(
      async () => {
        await onPoll?.();
        m = (await s.get('/metrics')).body;
        const b = m.jobs.byStatus;
        return (b.SUCCEEDED ?? 0) + (b.FAILED ?? 0) >= n;
      },
      { timeoutMs, intervalMs },
    );
    if (m.jobs.byStatus.SUCCEEDED !== n) reason = 'ada job yang berakhir FAILED';
  } catch (err) {
    if (!/^waitUntil: timeout/.test(err.message)) throw err;
    reason = err.message;
    m = (await s.get('/metrics')).body;
  }
  if (reason === null) return m;
  const errors = [...s.workers, s.api]
    .flatMap((p) => p.events.filter((e) => e.level === 'error' || e.level === 'fatal'))
    .map((e) => `${e.event}${e.reason ? `:${e.reason}` : ''}`);
  throw new Error(
    `${reason}. byStatus=${JSON.stringify(m.jobs.byStatus)} total=${m.jobs.total} target=${n}` +
      ` failedByErrorClass=${JSON.stringify(m.failedByErrorClass ?? null)}` +
      ` submit=${submitted ? JSON.stringify(submitSummary(submitted)) : 'n/a'}` +
      ` workerLost=${m.counters.workerLost} retries=${m.counters.retriesScheduled} errors=${JSON.stringify(errors)}`,
  );
}
