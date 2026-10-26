// Regression test AUDIT C-1: SQLITE_BUSY saat menulis status job (completeAttempt / failAttempt),
// heartbeat, dan POST /jobs. Kegagalan ditemukan di Windows (Node 24): BUSY saat commit hasil
// dicatat sebagai kegagalan TUGAS (INTERNAL "database is locked"), memakai attempt, dan pada
// MAX_ATTEMPTS=1 membuat job yang pekerjaannya sukses berakhir FAILED.
//
// Fault injection terkontrol pada SQLite SUNGGUHAN: untuk BEGIN IMMEDIATE ke-n yang dipilih,
// koneksi kedua memegang write lock, jadi SQLite benar-benar menunggu busy_timeout lalu
// melempar SQLITE_BUSY (errcode 5). Tidak bergantung pada race.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { waitUntil } from '../scripts/lib/harness.js';
import { checkConsistency } from '../src/consistency.js';
import { openDb } from '../src/db.js';
import { STATE_WRITE_MAX_TRIES, processNext } from '../src/processor.js';
import { createJob, getEvents, getJob } from '../src/store.js';
import { openFilesUnder, removeTempDir, report, setup, submitJobs, submitSummary, waitForSucceeded } from './helpers.js';
import { Worker } from 'node:worker_threads';

const JOB_ID = '00000000-0000-4000-8000-0000000000c1';

/**
 * Bungkus koneksi asli. BEGIN IMMEDIATE ke-n (1 = claim, 2 = tulisan status pertama, 3 = kedua, ...)
 * yang ada di `busy` didahului koneksi lain yang memegang write lock -> SQLITE_BUSY sungguhan.
 * Yang ada di `ioerr` melempar error database non-BUSY (bentuk sama dengan error node:sqlite).
 * Heartbeat (sejak AUDIT C-3 juga transaksi BEGIN IMMEDIATE, berlabel) tidak dihitung dan tidak
 * diinjeksi, sama seperti waktu heartbeat masih UPDATE autocommit.
 */
function injector(db, path, { busy = [], ioerr = [], minBusyWaitMs = 0 } = {}) {
  const locker = new DatabaseSync(path);
  locker.exec('PRAGMA busy_timeout = 2000;');
  let begins = 0;
  const thrown = [];
  return {
    thrown,
    locker,
    db: {
      exec(sql) {
        if (/^BEGIN IMMEDIATE/.test(sql) && !/heartbeat/.test(sql)) {
          begins += 1;
          if (ioerr.includes(begins)) {
            const e = Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
            thrown.push({ begin: begins, errcode: 10 });
            throw e;
          }
          if (busy.includes(begins)) {
            locker.exec('BEGIN IMMEDIATE');
            const t0 = performance.now();
            try {
              return db.exec(sql);
            } catch (e) {
              thrown.push({ begin: begins, errcode: e.errcode, message: e.message });
              // Tunggu BUSY yang molor seperti di Windows (terukur 200 ms -> 297 ms): DIGENAPKAN sampai
              // total minBusyWaitMs, bukan DITAMBAH. Di Windows (atau emulasinya) tunggu aslinya sudah
              // ±300 ms, jadi tidak ada tambahan; menambah 100 ms tetap membuat test ini gagal di sana.
              // Blok sinkron, persis seperti busy handler SQLite yang memblokir event loop.
              const rest = minBusyWaitMs - (performance.now() - t0);
              if (rest > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, rest);
              throw e;
            } finally {
              locker.exec('ROLLBACK');
            }
          }
        }
        return db.exec(sql);
      },
      prepare: (sql) => db.prepare(sql),
    },
  };
}

async function harness(t, { maxAttempts = 3, simulate, busyTimeoutMs = 50, ...cfgOverrides } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-job-busy-'));
  const path = join(dir, 'jobs.db');
  const db = openDb(path, { busyTimeoutMs });
  const opened = [db];
  const timers = new Set();
  // Satu hook: hentikan timer, tutup SEMUA koneksi (termasuk locker milik skenario), baru hapus dir.
  t.after(async () => {
    for (const x of timers) clearTimeout(x);
    for (const x of opened) {
      try {
        x.close();
      } catch {
        // sudah ditutup
      }
    }
    await removeTempDir(dir);
  });
  /** Koneksi tambahan milik skenario ikut ditutup sebelum dir dihapus. */
  const adopt = (conn) => {
    opened.push(conn);
    return conn;
  };
  const later = (fn, ms) => {
    const x = setTimeout(() => {
      timers.delete(x);
      fn();
    }, ms);
    timers.add(x);
    return x;
  };
  const payload = { orderCount: 100, seed: 1 };
  if (simulate) payload.simulate = { delayMs: 0, failTransientTimes: 0, failPermanent: false, hang: false, crashAfterWriteTimes: 0, ...simulate };
  createJob(db, { id: JOB_ID, type: 'order_report', payload, idempotencyKey: null, requestHash: 'h', maxAttempts, maxPending: 10, now: Date.now() });
  const events = [];
  const mk = (level) => (event, fields = {}) => events.push({ level, event, ...fields });
  const log = { info: mk('info'), warn: mk('warn'), error: mk('error'), fatal: mk('fatal') };
  const reportDir = join(dir, 'reports');
  const cfg = {
    workerId: 'w1',
    leaseMs: 5000,
    heartbeatMs: 1000,
    busyTimeoutMs,
    jobTimeoutMs: 30_000,
    recovery: true,
    reportDir,
    allowFaultInjection: true,
    backoffBaseMs: 10,
    backoffCapMs: 10,
    pollMs: 10,
    ...cfgOverrides,
  };
  const run = async (plan = {}, extra = {}) => {
    const inj = injector(db, path, plan);
    opened.push(inj.locker);
    await processNext({ db: inj.db, cfg: { ...cfg, ...extra }, log });
    return inj;
  };
  const job = () => getJob(db, JOB_ID);
  const evs = () => getEvents(db, JOB_ID).map((e) => `${e.event}:${e.attempt}${e.error_class ? `:${e.error_class}` : ''}`);
  const levels = (lvl) => events.filter((e) => e.level === lvl);
  const consistency = () => checkConsistency(db, reportDir);
  const fileSha = () => {
    const f = join(reportDir, `${JOB_ID}.json`);
    return existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : null;
  };
  return { db, path, cfg, run, job, evs, events, levels, consistency, fileSha, adopt, later };
}

describe('C-1: SQLITE_BUSY saat menulis status (fault injection, SQLite sungguhan)', () => {
  test('pola log Windows (BUSY saat commit, dua kali): retry, SUCCEEDED, tanpa INTERNAL dan tanpa error', async (t) => {
    const h = await harness(t);
    const inj = await h.run({ busy: [2, 3] });
    assert.deepEqual(
      inj.thrown.map((x) => x.errcode),
      [5, 5],
      'BUSY sungguhan (errcode 5) harus benar-benar terjadi pada commit',
    );
    assert.equal(h.job().status, 'SUCCEEDED');
    assert.equal(h.job().attempts, 1);
    assert.deepEqual(h.evs(), ['created:0', 'claimed:1', 'succeeded:1']);
    assert.deepEqual(h.levels('error'), []);
    assert.equal(h.events.filter((e) => e.event === 'state_write_busy').length, 2);
    assert.ok(!h.events.some((e) => e.errorClass === 'INTERNAL'), 'BUSY database bukan kegagalan tugas');
    assert.deepEqual(h.consistency().violations, []);
  });

  test('MAX_ATTEMPTS=1: BUSY saat commit tidak boleh membuat job yang pekerjaannya sukses berakhir FAILED', async (t) => {
    // Kode lama: FAILED INTERNAL "database is locked" padahal laporan sudah tertulis dengan benar.
    const h = await harness(t, { maxAttempts: 1 });
    await h.run({ busy: [2] });
    const job = h.job();
    assert.equal(job.status, 'SUCCEEDED');
    assert.equal(JSON.parse(job.result).sha256, h.fileSha(), 'result di DB = isi file laporan');
    assert.deepEqual(h.consistency().warnings, [], 'tidak ada orphan_report');
  });

  test('kegagalan tugas asli tetap tercatat apa adanya walau tulisan fail kena BUSY', async (t) => {
    const h = await harness(t, { simulate: { failTransientTimes: 5 } });
    await h.run({ busy: [2] });
    assert.equal(h.job().status, 'PENDING');
    assert.equal(h.job().error_class, 'TRANSIENT');
    assert.deepEqual(h.evs(), ['created:0', 'claimed:1', 'retry_scheduled:1:TRANSIENT']);
    assert.deepEqual(h.levels('error'), []);
  });

  test('BUSY terus-menerus: retry dibatasi satu periode lease, error keras, attempt tidak terpakai, lalu pulih lewat lease', async (t) => {
    // Heartbeat (tidak diinjeksi) tetap memperpanjang lease, jadi yang menghentikan retry adalah jendela waktu.
    const h = await harness(t, { leaseMs: 1500, heartbeatMs: 500 });
    const t0 = Date.now();
    await h.run({ busy: Array.from({ length: STATE_WRITE_MAX_TRIES + 1 }, (_, i) => i + 2) });
    const spent = Date.now() - t0;
    const failed = h.levels('error');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].event, 'job_state_write_failed');
    assert.equal(failed[0].reason, 'retry_window_exhausted');
    assert.equal(failed[0].writeErrorCode, 5);
    assert.ok(failed[0].tries >= 3 && failed[0].tries < STATE_WRITE_MAX_TRIES, `tries=${failed[0].tries}`);
    assert.ok(failed[0].retryMs < h.cfg.leaseMs, `retry ${failed[0].retryMs} ms harus < lease ${h.cfg.leaseMs} ms`);
    assert.ok(spent < h.cfg.leaseMs + 500, `processNext harus berhenti dalam ±1 lease, butuh ${spent} ms`);
    assert.equal(h.events.filter((e) => e.event === 'state_write_busy').length, failed[0].tries - 1);
    // Tidak ada attempt yang "dibayar" sebagai kegagalan tugas: job tetap RUNNING, event tidak bertambah.
    assert.equal(h.job().status, 'RUNNING');
    assert.deepEqual(h.evs(), ['created:0', 'claimed:1']);
    // Pemulihan lewat jalur lama: lease habis, worker lain mengambil alih.
    await new Promise((r) => setTimeout(r, Math.max(0, h.job().lease_expires_at - Date.now()) + 50));
    await h.run({}, { workerId: 'w2' });
    assert.equal(h.job().status, 'SUCCEEDED');
    assert.deepEqual(h.evs(), ['created:0', 'claimed:1', 'lease_expired:1:WORKER_LOST', 'claimed:2', 'succeeded:2']);
    assert.deepEqual(h.consistency().violations, []);
  });

  test('error database non-BUSY: tidak di-retry, langsung error dengan kode aslinya', async (t) => {
    const h = await harness(t);
    await h.run({ ioerr: [2] });
    const [e] = h.levels('error');
    assert.equal(e.event, 'job_state_write_failed');
    assert.equal(e.reason, 'non_busy_error');
    assert.equal(e.tries, 1);
    assert.equal(e.writeErrorCode, 10);
    assert.equal(h.events.filter((x) => x.event === 'state_write_busy').length, 0);
    assert.equal(h.job().status, 'RUNNING');
    assert.deepEqual(h.evs(), ['created:0', 'claimed:1'], 'tidak dicatat sebagai kegagalan tugas');
  });

  test('sisa lease tidak cukup untuk menunggu lock lagi: tidak di-retry (lease_too_short)', async (t) => {
    // Lease 120 ms, satu kali menunggu lock 100 ms: setelah percobaan pertama sisa lease < 100 ms.
    const h = await harness(t, { leaseMs: 120, heartbeatMs: 1000, busyTimeoutMs: 100 });
    await h.run({ busy: [2] });
    const [e] = h.levels('error');
    assert.equal(e.event, 'job_state_write_failed');
    assert.equal(e.reason, 'lease_too_short');
    assert.equal(e.tries, 1);
    assert.equal(h.job().status, 'RUNNING');
  });
});

describe('C-1: heartbeat kena BUSY', () => {
  async function heartbeatScenario(t, { leaseMs, holdMs }) {
    const h = await harness(t, { leaseMs, heartbeatMs: 40, busyTimeoutMs: 30, simulate: { delayMs: 250 } });
    const locker = h.adopt(new DatabaseSync(h.path));
    locker.exec('PRAGMA busy_timeout = 2000;');
    const running = h.run();
    // claimNext sudah selesai (sinkron); tugas sedang tidur. Pegang lock selama beberapa heartbeat.
    locker.exec('BEGIN IMMEDIATE');
    const released = new Promise((resolve) => h.later(() => resolve(locker.exec('ROLLBACK')), holdMs));
    await running;
    await released;
    locker.close();
    return h;
  }

  test('lease masih aman: warning heartbeat_busy, bukan error; job tetap sukses', async (t) => {
    const h = await heartbeatScenario(t, { leaseMs: 3000, holdMs: 150 });
    assert.ok(h.events.some((e) => e.event === 'heartbeat_busy' && e.level === 'warn'));
    assert.deepEqual(h.levels('error'), []);
    assert.equal(h.job().status, 'SUCCEEDED');
  });

  test('lease hampir habis karena heartbeat terus terkunci: error lease_at_risk (tidak disembunyikan)', async (t) => {
    const h = await heartbeatScenario(t, { leaseMs: 200, holdMs: 230 });
    const risk = h.levels('error').filter((e) => e.event === 'lease_at_risk');
    assert.ok(risk.length >= 1, `harus ada lease_at_risk, dapat ${JSON.stringify(h.events.filter((e) => e.level !== 'info'))}`);
    assert.ok(risk.every((e) => e.leaseLeftMs <= 40 + 30));
  });
});

describe('C-1: proses sungguhan', () => {
  test('kontensi dipaksa (4 worker, BUSY_TIMEOUT_MS=1): tidak ada BUSY yang jadi kegagalan tugas, tanpa error', async (t) => {
    // Membuat kontensi lock pasti terjadi di Linux juga (di sana race aslinya jarang muncul).
    // Kode lama di skenario ini: 11-17 job_state_write_failed dan 20-28 event INTERNAL "database is locked" per run.
    const s = await setup(t, { POLL_MS: '1', MAX_PENDING: '1000' }, { workers: 4, workerEnv: { BUSY_TIMEOUT_MS: '1' } });
    // 503 DB_BUSY adalah jawaban sah di bawah kontensi (diuji terpisah di test berikutnya). Yang diuji
    // di sini: penerimaan AKHIR lewat retry dengan Idempotency-Key yang sama, tanpa job hilang/ganda.
    const bodies = Array.from({ length: 150 }, (_, i) => ({ type: 'order_report', payload: { orderCount: 50, seed: i + 1 } }));
    const sub = await submitJobs(s, bodies, { keyPrefix: 'forced' });
    assert.equal(sub.gaveUp, 0, `job yang tidak pernah diterima: ${JSON.stringify(submitSummary(sub))}`);
    assert.equal(new Set(sub.ids).size, 150);
    assert.equal((await s.get('/metrics')).body.jobs.total, 150, 'tidak ada job ganda karena retry');
    await waitUntil(
      async () => {
        const b = (await s.get('/metrics')).body.jobs.byStatus;
        return b.SUCCEEDED + b.FAILED === 150;
      },
      { timeoutMs: 60_000 },
    );
    const m = (await s.get('/metrics')).body;
    assert.equal(m.jobs.byStatus.SUCCEEDED, 150);
    assert.equal(m.counters.duplicateSuccessJobs, 0);
    assert.equal(m.counters.retriesScheduled, 0, 'tugas tidak pernah gagal; retry berarti BUSY dicatat sebagai kegagalan tugas');
    assert.deepEqual(s.consistency().violations, []);
    const ev = s.workers.flatMap((w) => w.events);
    assert.ok(!ev.some((e) => e.errorClass === 'INTERNAL'), 'BUSY tidak boleh dicatat sebagai INTERNAL');
    // BUSY_TIMEOUT_MS=1 sengaja ekstrem. Gagal menulis status sepanjang satu lease penuh BOLEH terjadi,
    // tapi tidak boleh diam: satu-satunya error yang diizinkan adalah job_state_write_failed karena BUSY
    // dengan batas lease, dan SETIAP job yang di-reclaim harus punya error itu (atau lease_at_risk).
    const errors = ev.filter((e) => e.level === 'error' || e.level === 'fatal');
    for (const e of errors) {
      assert.ok(
        (e.event === 'job_state_write_failed' && e.writeErrorCode === 5 && ['lease_too_short', 'retry_window_exhausted'].includes(e.reason)) ||
          e.event === 'lease_at_risk',
        `error tak terduga: ${JSON.stringify(e)}`,
      );
    }
    const ro = new DatabaseSync(s.env.DB_PATH, { readOnly: true });
    const lost = ro.prepare("SELECT job_id, attempt FROM job_events WHERE event = 'lease_expired'").all();
    ro.close();
    assert.equal(lost.length, m.counters.workerLost);
    for (const l of lost) {
      assert.ok(
        errors.some((e) => e.jobId === l.job_id && e.attempt === l.attempt),
        `job ${l.job_id} attempt ${l.attempt} di-reclaim tanpa error yang menjelaskannya`,
      );
    }
    const claimBusy = ev.filter((e) => e.event === 'claim_busy').length;
    const writeBusy = ev.filter((e) => e.event === 'state_write_busy').length;
    assert.ok(claimBusy + writeBusy > 0, 'kontensi harus benar-benar terjadi, kalau tidak test ini tidak membuktikan apa pun');
    t.diagnostic(`claim_busy=${claimBusy} state_write_busy=${writeBusy} job_state_write_failed=${errors.length} lease_reclaims=${lost.length} submit=${JSON.stringify(submitSummary(sub))}`);
  });

  test('POST /jobs saat database terkunci: 503 DB_BUSY + Retry-After, tidak ada job, aman diulang', async (t) => {
    const s = await setup(t, { BUSY_TIMEOUT_MS: '100' }, { workers: 0 });
    const locker = new DatabaseSync(s.env.DB_PATH);
    s.defer(() => locker.close()); // tetap tertutup sebelum dir dihapus walau assertion gagal
    locker.exec('PRAGMA busy_timeout = 2000;');
    locker.exec('BEGIN IMMEDIATE');
    let r;
    try {
      r = await s.post(report(), { 'idempotency-key': 'busy-1' });
    } finally {
      locker.exec('ROLLBACK');
    }
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'DB_BUSY');
    assert.equal(r.headers.get('retry-after'), '1');
    assert.ok(s.api.events.some((e) => e.event === 'db_busy' && e.level === 'warn'));
    assert.ok(!s.api.events.some((e) => e.event === 'http_unhandled_error'));
    // Tidak ada yang dibuat: request ulang dengan key yang sama adalah job BARU (202), bukan replay (200).
    assert.equal((await s.post(report(), { 'idempotency-key': 'busy-1' })).status, 202);
    assert.equal((await s.get('/metrics')).body.jobs.total, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// AUDIT C-2: kegagalan validasi Windows dari C-1 (cleanup, kontrak 503, retry yang tidak pernah
// muat di Windows, lease yang termakan waktu tunggu lock saat claim).
// ---------------------------------------------------------------------------------------------

describe('C-2: tenggat dan waktu tunggu lock ala Windows', () => {
  test('tunggu BUSY molor 1.5x (Windows): retry tetap terjadi dengan busy_timeout yang dipendekkan, lalu dipulihkan', async (t) => {
    // Konfigurasi test sama dengan FAST (lease 600, busy 200). Dengan tunggu nyata ±300 ms, kode C-1
    // langsung menyerah (lease_too_short, 0 retry).
    const h = await harness(t, { leaseMs: 600, heartbeatMs: 1000, busyTimeoutMs: 200 });
    await h.run({ busy: [2], minBusyWaitMs: 300 });
    assert.equal(h.job().status, 'SUCCEEDED');
    assert.deepEqual(h.levels('error'), []);
    const [w] = h.events.filter((e) => e.event === 'state_write_busy');
    assert.ok(w, 'harus ada retry');
    assert.ok(w.busyWaitMs >= 290, `tunggu pertama harus ±300 ms, dapat ${w.busyWaitMs}`);
    assert.ok(w.nextBusyTimeoutMs > 0 && w.nextBusyTimeoutMs < 200, `busy_timeout retry harus < 200, dapat ${w.nextBusyTimeoutMs}`);
    assert.equal(h.db.prepare('PRAGMA busy_timeout').get().timeout, 200, 'busy_timeout dikembalikan ke konfigurasi');
  });

  test('claim: waktu lease dihitung SETELAH write lock didapat, bukan sebelum menunggu', async (t) => {
    const h = await harness(t, { leaseMs: 600, heartbeatMs: 1000, busyTimeoutMs: 2000 });
    // Thread lain memegang write lock 250 ms (seperti commit lambat di Windows).
    const holder = new Worker(
      `const { DatabaseSync } = require('node:sqlite');
       const { parentPort } = require('node:worker_threads');
       const d = new DatabaseSync(${JSON.stringify(h.path)});
       d.exec('BEGIN IMMEDIATE');
       parentPort.postMessage({ locked: true });
       const end = Date.now() + 250; while (Date.now() < end);
       parentPort.postMessage({ releaseAt: Date.now() });
       d.exec('ROLLBACK'); d.close();`,
      { eval: true },
    );
    const messages = [];
    holder.on('message', (m) => messages.push(m));
    const exited = new Promise((r) => holder.once('exit', r));
    t.after(() => holder.terminate());
    await waitUntil(async () => messages.some((m) => m.locked), { timeoutMs: 5000 });
    await h.run();
    await exited;
    const { releaseAt } = messages.find((m) => m.releaseAt);
    const claimed = getEvents(h.db, JOB_ID).find((e) => e.event === 'claimed');
    // Kode lama: claimed.at = waktu SEBELUM menunggu (±250 ms lebih awal), lease efektif ±350 ms.
    assert.ok(claimed.at >= releaseAt, `claim tercatat ${releaseAt - claimed.at} ms sebelum lock dilepas`);
    assert.equal(h.job().status, 'SUCCEEDED');
  });
});

describe('C-2: kontrak POST /jobs di bawah kontensi', () => {
  test('503 DB_BUSY lalu diterima: retry dengan Idempotency-Key yang sama menghasilkan tepat satu job', async (t) => {
    const s = await setup(t, { BUSY_TIMEOUT_MS: '100' }, { workers: 0 });
    const locker = new DatabaseSync(s.env.DB_PATH);
    s.defer(() => locker.close());
    locker.exec('PRAGMA busy_timeout = 2000;');
    locker.exec('BEGIN IMMEDIATE');
    // Lock dilepas setelah 1.3 s: percobaan pertama (dan mungkin kedua, Retry-After 1 s) pasti 503.
    const release = setTimeout(() => locker.exec('ROLLBACK'), 1300);
    s.defer(() => clearTimeout(release));
    const sub = await submitJobs(s, [report()], { keyPrefix: 'eventual', maxTries: 5 });
    assert.ok(sub.busy503 >= 1, `harus pernah 503, dapat ${JSON.stringify(submitSummary(sub))}`);
    assert.equal(sub.gaveUp, 0);
    assert.equal(sub.accepted + sub.replayed, 1);
    assert.equal((await s.get('/metrics')).body.jobs.total, 1, 'retry tidak boleh membuat job ganda');
    assert.ok(!s.api.events.some((e) => e.event === 'http_unhandled_error'));
  });

  test('batas retry klien: kalau database terkunci terus, berhenti dan melaporkan, tidak mengulang tanpa batas', async (t) => {
    const s = await setup(t, { BUSY_TIMEOUT_MS: '50' }, { workers: 0 });
    const locker = new DatabaseSync(s.env.DB_PATH);
    s.defer(() => locker.close());
    locker.exec('PRAGMA busy_timeout = 2000;');
    locker.exec('BEGIN IMMEDIATE');
    let sub;
    try {
      sub = await submitJobs(s, [report()], { keyPrefix: 'stuck', maxTries: 2, maxRetryAfterMs: 50 });
    } finally {
      locker.exec('ROLLBACK');
    }
    assert.equal(sub.busy503, 2);
    assert.equal(sub.gaveUp, 1);
    assert.equal(sub.requests, 2);
    assert.equal((await s.get('/metrics')).body.jobs.total, 0);
  });
});

describe('C-2: cleanup lintas platform', () => {
  test('temp dir tidak boleh dihapus selama koneksi SQLite di dalamnya masih terbuka', { skip: process.platform !== 'linux' && 'butuh /proc (di Windows rm sendiri yang gagal EBUSY)' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mini-job-leak-'));
    const db = new DatabaseSync(join(dir, 'x.db'));
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x);');
    try {
      assert.ok(openFilesUnder(dir).includes('/x.db'));
      await assert.rejects(removeTempDir(dir), /masih ada file terbuka/);
      assert.ok(existsSync(dir), 'tidak boleh terhapus sebagian');
    } finally {
      db.close();
    }
    assert.deepEqual(openFilesUnder(dir), []);
    await removeTempDir(dir);
    assert.equal(existsSync(dir), false);
  });
});


describe('C-2: tunggu job yang dibatasi', () => {
  // Pengganti s untuk menguji helper tanpa proses: /metrics mengembalikan status tetap.
  const fake = (byStatus) => ({
    get: async () => ({
      status: 200,
      body: {
        jobs: { byStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0) },
        failedByErrorClass: byStatus.FAILED ? { WORKER_LOST: byStatus.FAILED } : {},
        counters: { workerLost: 1, retriesScheduled: 0 },
      },
    }),
    workers: [{ events: [{ level: 'error', event: 'lease_at_risk' }] }],
    api: { events: [] },
  });

  test('job berakhir FAILED: gagal langsung dengan jumlah per status, tidak menunggu sampai timeout', async () => {
    const t0 = performance.now();
    await assert.rejects(
      waitForSucceeded(fake({ SUCCEEDED: 149, FAILED: 1 }), 150, { timeoutMs: 60_000 }),
      (err) =>
        /ada job yang berakhir FAILED/.test(err.message) &&
        err.message.includes('"FAILED":1') &&
        err.message.includes('WORKER_LOST') &&
        err.message.includes('lease_at_risk'),
    );
    assert.ok(performance.now() - t0 < 5_000, 'harus gagal segera, bukan setelah timeoutMs');
  });

  test('job tidak pernah selesai: timeout dengan jumlah per status, bukan menggantung', async () => {
    await assert.rejects(
      waitForSucceeded(fake({ SUCCEEDED: 10, RUNNING: 140 }), 150, { timeoutMs: 100, submitted: { attempted: 150, ids: [] } }),
      (err) => /waitUntil: timeout 100 ms/.test(err.message) && err.message.includes('"RUNNING":140') && err.message.includes('"attempted":150'),
    );
  });

  test('assertion di onPoll tidak tertelan sebagai timeout', async () => {
    await assert.rejects(
      waitForSucceeded(fake({ SUCCEEDED: 10 }), 150, {
        timeoutMs: 5_000,
        onPoll: () => assert.fail('violation palsu'),
      }),
      /violation palsu/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// AUDIT C-3: lease_at_risk di Windows (commit e48142e). Akar masalah terukur: tulisan status yang
// menunggu lock MEMBLOKIR event loop, jadi heartbeat pertama baru jalan setelahnya, lalu menunggu
// lock lagi. Di Windows satu tunggu busy_timeout 200 ms = ±297 ms nyata, jadi 2 tunggu > lease 600 ms.
// Kontensi di sini SQLite sungguhan: thread lain dengan koneksinya sendiri memegang write lock dengan
// waktu yang ditentukan (bukan delay sintetis di kode yang diuji).
// ---------------------------------------------------------------------------------------------

/**
 * Thread lain memegang write lock. lock() -> BEGIN IMMEDIATE, dilepas setelah holdMs.
 * Waktu (lockedAt, releaseAt) dalam ms absolut presisi sub-ms (performance.timeOrigin + now()).
 */
async function lockHolder(h, { holdMs }) {
  const sab = new SharedArrayBuffer(64);
  const ctl = new Int32Array(sab, 0, 4); // [go, state 1=locked 2=released, -, ready]
  const f = new Float64Array(sab, 16, 4); // [lockedAt, releaseAt]
  const w = new Worker(
    `const { DatabaseSync } = require('node:sqlite');
     const { workerData: { path, sab, holdMs } } = require('node:worker_threads');
     const ctl = new Int32Array(sab, 0, 4), f = new Float64Array(sab, 16, 4);
     const now = () => performance.timeOrigin + performance.now();
     const d = new DatabaseSync(path);
     d.exec('PRAGMA busy_timeout = 5000');
     Atomics.store(ctl, 3, 1); Atomics.notify(ctl, 3);
     Atomics.wait(ctl, 0, 0);
     d.exec('BEGIN IMMEDIATE');
     f[0] = now(); Atomics.store(ctl, 1, 1); Atomics.notify(ctl, 1);
     const end = f[0] + holdMs;
     while (now() < end);
     d.exec('ROLLBACK');
     f[1] = now(); Atomics.store(ctl, 1, 2);
     d.close();`,
    { eval: true, workerData: { path: h.path, sab, holdMs } },
  );
  const exited = new Promise((r) => w.once('exit', r));
  h.adopt({ close: () => w.terminate() }); // pengaman kalau test gagal sebelum thread selesai
  await waitUntil(async () => Atomics.load(ctl, 3) === 1, { timeoutMs: 5000, intervalMs: 5 });
  return {
    exited,
    /** Ambil lock sekarang dan tunggu (sinkron) sampai benar-benar terpegang. */
    lock() {
      Atomics.store(ctl, 0, 1);
      Atomics.notify(ctl, 0);
      Atomics.wait(ctl, 1, 0, 5000);
      assert.equal(Atomics.load(ctl, 1), 1, 'holder harus memegang lock');
    },
    get lockedAt() {
      return f[0];
    },
    get releaseAt() {
      return f[1];
    },
  };
}

/** Waktu nyata yang dihabiskan BEGIN IMMEDIATE dengan busy_timeout `ms` terhadap lock yang dipegang. */
function measureBusyWait(path, ms) {
  const a = new DatabaseSync(path);
  const b = new DatabaseSync(path);
  try {
    b.exec(`PRAGMA busy_timeout = ${ms}`);
    let best = Infinity; // minimum dari 3: pengukuran pertama kadang lebih lambat (cache dingin)
    for (let i = 0; i < 3; i++) {
      a.exec('BEGIN IMMEDIATE');
      const t0 = performance.now();
      assert.throws(() => b.exec('BEGIN IMMEDIATE'), (e) => e.errcode === 5);
      best = Math.min(best, performance.now() - t0);
      a.exec('ROLLBACK');
    }
    return Math.round(best);
  } finally {
    a.close();
    b.close();
  }
}

describe('C-3: heartbeat, timestamp setelah lock, dan chaining (kontensi SQLite sungguhan)', () => {
  test('heartbeat: lease dihitung SETELAH write lock didapat, bukan sebelum menunggu', async (t) => {
    // Kode lama: now diambil sebelum UPDATE menunggu lock 250 ms -> lease yang diberikan ±350 ms, bukan 600.
    const h = await harness(t, { leaseMs: 600, heartbeatMs: 100, busyTimeoutMs: 2000, leaseTrace: true, simulate: { delayMs: 500 } });
    const holder = await lockHolder(h, { holdMs: 250 });
    const running = h.run(); // claim selesai sinkron; tugas tidur 500 ms
    holder.lock(); // terpegang sebelum tick heartbeat pertama (100 ms)
    await running;
    await holder.exited;
    const waited = h.events.filter((e) => e.event === 'heartbeat_ok' && e.lockWaitMs >= 100);
    assert.ok(waited.length >= 1, `harus ada heartbeat yang menunggu lock: ${JSON.stringify(h.events.filter((e) => e.event.startsWith('heartbeat')))}`);
    for (const hb of waited) {
      assert.ok(hb.leaseUntil >= holder.releaseAt + h.cfg.leaseMs - 2, `lease ${hb.leaseUntil} dihitung ${Math.round(holder.releaseAt + h.cfg.leaseMs - hb.leaseUntil)} ms sebelum lock dilepas`);
      assert.ok(hb.grantedMs >= h.cfg.leaseMs - 20, `lease yang diberikan ${hb.grantedMs} ms, harus ±${h.cfg.leaseMs}`);
    }
    assert.equal(h.job().status, 'SUCCEEDED');
    assert.deepEqual(h.levels('error'), []);
  });

  test('completeAttempt: finished_at dan waktu event = saat status berubah (setelah lock), bukan sebelum menunggu', async (t) => {
    // Kode lama: stale_completion_rejected bisa tercatat SEBELUM lease_expired yang menyebabkannya.
    const h = await harness(t, { busyTimeoutMs: 2000, simulate: { delayMs: 100 } });
    const holder = await lockHolder(h, { holdMs: 250 });
    const running = h.run();
    holder.lock();
    await running;
    await holder.exited;
    const ev = getEvents(h.db, JOB_ID).find((e) => e.event === 'succeeded');
    assert.ok(ev.at >= Math.floor(holder.releaseAt), `succeeded tercatat ${Math.round(holder.releaseAt - ev.at)} ms sebelum lock dilepas`);
    assert.equal(h.job().finished_at, ev.at);
  });

  test('urutan Windows: commit menunggu lock, heartbeat tertunda lalu BUSY: lease_at_risk dilaporkan dengan sebabnya', async (t) => {
    // Konfigurasi FAST (lease 600, heartbeat 150, busy 200). Lock dipegang tepat setelah claim:
    // commit pertama BUSY; heartbeat (jatuh tempo 150 ms) tidak bisa jalan selama commit menunggu lock
    // (node:sqlite sinkron), baru jalan sesudahnya dan BUSY juga. Ini urutan yang ditemukan di setiap
    // lease_at_risk emulasi Windows (15/15). Di Windows satu tunggu 200 ms = ±297 ms, jadi dua tunggu
    // menghabiskan lease 600 ms: risikonya NYATA, dan harus dilaporkan dengan data yang menjelaskannya.
    const h = await harness(t, { leaseMs: 600, heartbeatMs: 150, busyTimeoutMs: 200 });
    // Tunggu nyata busy_timeout 200 ms di mesin ini (Linux ±200, Windows ±297): lock dipegang cukup
    // lama supaya commit DAN heartbeat sama-sama BUSY, lalu dilepas sebelum retry commit menyerah.
    const realWaitMs = measureBusyWait(h.path, 200);
    const holder = await lockHolder(h, { holdMs: 2 * realWaitMs + 40 });
    const running = h.run();
    holder.lock();
    await running;
    await holder.exited;
    const risk = h.levels('error').filter((e) => e.event === 'lease_at_risk');
    assert.equal(risk.length, 1, `lease_at_risk tidak boleh disembunyikan: ${JSON.stringify(h.events.filter((e) => e.level !== 'info'))}`);
    const [r] = risk;
    assert.equal(r.phase, 'complete');
    assert.equal(r.leaseFrom, 'claim');
    assert.equal(r.blockedBy?.op, 'write:complete', 'heartbeat tertunda oleh tulisan status yang menunggu lock');
    assert.ok(r.blockedBy.ms >= 190, `commit menunggu ${r.blockedBy.ms} ms (tunggu nyata terukur ${realWaitMs})`);
    assert.ok(r.lagMs >= 30, `heartbeat seharusnya terlambat, lag ${r.lagMs} ms`);
    assert.ok(r.lockWaitMs >= 190, `heartbeat menunggu ${r.lockWaitMs} ms (tunggu nyata terukur ${realWaitMs})`);
    assert.equal(r.busyTimeoutMs, h.cfg.busyTimeoutMs, 'heartbeat memakai batas konfigurasi, bukan batas retry');
    // Bukan false positive: batas yang dipakai monitor = batas yang tersimpan di database saat claim.
    const claimed = getEvents(h.db, JOB_ID).find((e) => e.event === 'claimed');
    assert.equal(r.leaseUntil, claimed.at + h.cfg.leaseMs);
    assert.equal(r.leaseLeftMs <= h.cfg.heartbeatMs + h.cfg.busyTimeoutMs, true);
    // Hasil akhir: tanpa worker lain tidak ada yang mengambil alih, jadi commit kedua diterima; kalau
    // mendarat setelah tenggat (Windows), itu WAJIB tercatat sebagai lease_overrun.
    assert.equal(h.job().status, 'SUCCEEDED');
    assert.equal(h.job().attempts, 1);
    const succeededAt = getEvents(h.db, JOB_ID).find((e) => e.event === 'succeeded').at;
    assert.equal(h.events.some((e) => e.event === 'lease_overrun' && e.accepted), succeededAt > r.leaseUntil);
  });

  test('chaining: complete + claim job berikutnya dalam satu transaksi; tanpa chain perilaku lama', async (t) => {
    const h = await harness(t, {});
    const ID2 = '00000000-0000-4000-8000-0000000000c2';
    createJob(h.db, { id: ID2, type: 'order_report', payload: { orderCount: 10, seed: 2 }, idempotencyKey: null, requestHash: 'h2', maxAttempts: 3, maxPending: 10, now: Date.now() + 1 });
    const r1 = await processNext({ db: h.db, cfg: h.cfg, log: { info() {}, warn() {}, error() {} }, chain: () => true });
    assert.equal(r1.next?.id, ID2, 'job berikutnya di-claim di transaksi complete');
    const ev = getEvents(h.db, JOB_ID);
    const ev2 = getEvents(h.db, ID2);
    assert.equal(ev.find((e) => e.event === 'succeeded').at, ev2.find((e) => e.event === 'claimed').at);
    const r2 = await processNext({ db: h.db, cfg: h.cfg, log: { info() {}, warn() {}, error() {} }, job: r1.next, chain: () => false });
    assert.equal(r2, true);
    assert.equal(getJob(h.db, ID2).status, 'SUCCEEDED');
    assert.equal(h.job().status, 'SUCCEEDED');
    assert.equal(await processNext({ db: h.db, cfg: h.cfg, log: { info() {}, warn() {}, error() {} } }), false);
    assert.deepEqual(h.consistency().violations, []);
  });
});
