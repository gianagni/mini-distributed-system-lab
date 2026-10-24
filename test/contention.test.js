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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { waitUntil } from '../scripts/lib/harness.js';
import { checkConsistency } from '../src/consistency.js';
import { openDb } from '../src/db.js';
import { STATE_WRITE_MAX_TRIES, processNext } from '../src/processor.js';
import { createJob, getEvents, getJob } from '../src/store.js';
import { report, setup } from './helpers.js';

const JOB_ID = '00000000-0000-4000-8000-0000000000c1';

/**
 * Bungkus koneksi asli. BEGIN IMMEDIATE ke-n (1 = claim, 2 = tulisan status pertama, 3 = kedua, ...)
 * yang ada di `busy` didahului koneksi lain yang memegang write lock -> SQLITE_BUSY sungguhan.
 * Yang ada di `ioerr` melempar error database non-BUSY (bentuk sama dengan error node:sqlite).
 */
function injector(db, path, { busy = [], ioerr = [] } = {}) {
  const locker = new DatabaseSync(path);
  locker.exec('PRAGMA busy_timeout = 2000;');
  let begins = 0;
  const thrown = [];
  return {
    thrown,
    locker,
    db: {
      exec(sql) {
        if (/^BEGIN IMMEDIATE/.test(sql)) {
          begins += 1;
          if (ioerr.includes(begins)) {
            const e = Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
            thrown.push({ begin: begins, errcode: 10 });
            throw e;
          }
          if (busy.includes(begins)) {
            locker.exec('BEGIN IMMEDIATE');
            try {
              return db.exec(sql);
            } catch (e) {
              thrown.push({ begin: begins, errcode: e.errcode, message: e.message });
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
  t.after(async () => {
    for (const x of opened) {
      try {
        x.close();
      } catch {
        // sudah ditutup
      }
    }
    await rm(dir, { recursive: true, force: true });
  });
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
  return { db, path, cfg, run, job, evs, events, levels, consistency, fileSha };
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
    const locker = new DatabaseSync(h.path);
    t.after(() => locker.close());
    locker.exec('PRAGMA busy_timeout = 2000;');
    const running = h.run();
    // claimNext sudah selesai (sinkron); tugas sedang tidur. Pegang lock selama beberapa heartbeat.
    locker.exec('BEGIN IMMEDIATE');
    setTimeout(() => locker.exec('ROLLBACK'), holdMs);
    await running;
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
    for (let i = 0; i < 150; i++) assert.equal((await s.post({ type: 'order_report', payload: { orderCount: 50, seed: i + 1 } })).status, 202);
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
    t.diagnostic(`claim_busy=${claimBusy} state_write_busy=${writeBusy} job_state_write_failed=${errors.length} lease_reclaims=${lost.length}`);
  });

  test('POST /jobs saat database terkunci: 503 DB_BUSY + Retry-After, tidak ada job, aman diulang', async (t) => {
    const s = await setup(t, { BUSY_TIMEOUT_MS: '100' }, { workers: 0 });
    const locker = new DatabaseSync(s.env.DB_PATH);
    t.after(() => locker.close());
    locker.exec('PRAGMA busy_timeout = 2000;');
    locker.exec('BEGIN IMMEDIATE');
    const r = await s.post(report(), { 'idempotency-key': 'busy-1' });
    locker.exec('ROLLBACK');
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
