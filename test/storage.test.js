// Test in-process untuk transaksi, kontensi lock, pemeriksa invariant, dan kegagalan filesystem.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { checkConsistency } from '../src/consistency.js';
import { isBusyError, openDb, tx } from '../src/db.js';
import { StorageError, classify } from '../src/errors.js';
import { claimNext, completeAttempt, createJob, getEvents, getJob } from '../src/store.js';
import { runOrderReport, writeFileAtomic } from '../src/task.js';

const T0 = 1_000_000;

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-job-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function newJob(db, n = 1, now = T0) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  createJob(db, {
    id,
    type: 'order_report',
    payload: { orderCount: 10, seed: n },
    idempotencyKey: null,
    requestHash: `h${n}`,
    maxAttempts: 3,
    maxPending: 100,
    now,
  });
  return id;
}

describe('transaksi dan kontensi SQLite', () => {
  test('tx: exception di tengah transaksi me-rollback semua tulisan', () => {
    const db = openDb(':memory:');
    assert.throws(() =>
      tx(db, () => {
        db.prepare(
          `INSERT INTO jobs (id, request_hash, type, payload, status, max_attempts, next_run_at, created_at)
           VALUES ('x', 'h', 't', '{}', 'PENDING', 1, 0, 0)`,
        ).run();
        throw new Error('gagal di tengah');
      }),
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
  });

  test('claim saat koneksi lain memegang write lock: gagal bersih, tanpa state setengah jadi', async (t) => {
    const path = join(await tempDir(t), 'jobs.db');
    const a = openDb(path, { busyTimeoutMs: 50 });
    const b = openDb(path, { busyTimeoutMs: 50 });
    const id = newJob(a);

    a.exec('BEGIN IMMEDIATE');
    const t0 = Date.now();
    assert.throws(() => claimNext(b, { workerId: 'B', leaseMs: 1000, recovery: true, now: T0 }), isBusyError);
    assert.ok(Date.now() - t0 >= 40, 'busy_timeout dihormati');
    a.exec('ROLLBACK');

    assert.equal(getJob(b, id).status, 'PENDING');
    assert.deepEqual(
      getEvents(b, id).map((e) => e.event),
      ['created'],
    );
    const claimed = claimNext(b, { workerId: 'B', leaseMs: 1000, recovery: true, now: T0 });
    assert.equal(claimed.attempts, 1);
    a.close();
    b.close();
  });

  test('dua koneksi berebut 50 job: setiap job di-claim tepat satu kali', async (t) => {
    const path = join(await tempDir(t), 'jobs.db');
    const conns = [openDb(path), openDb(path)];
    for (let i = 1; i <= 50; i++) newJob(conns[0], i);
    const owners = new Map();
    for (let round = 0; round < 60; round++) {
      for (const [k, db] of conns.entries()) {
        const j = claimNext(db, { workerId: `W${k}`, leaseMs: 60_000, recovery: true, now: T0 });
        if (j) {
          assert.ok(!owners.has(j.id), `job ${j.id} di-claim dua kali`);
          owners.set(j.id, `W${k}`);
        }
      }
    }
    assert.equal(owners.size, 50);
    assert.equal(checkConsistency(conns[0], join(path, '..', 'none'), { now: T0 }).violations.length, 0);
    conns.forEach((c) => c.close());
  });
});

describe('pemeriksa invariant (tidak vacuous)', () => {
  test('mendeteksi file laporan hilang, checksum salah, dan state tidak konsisten', async (t) => {
    const dir = await tempDir(t);
    const reportDir = join(dir, 'reports');
    const db = openDb(join(dir, 'jobs.db'));

    // Job 1: sukses benar.
    const ok = newJob(db, 1);
    claimNext(db, { workerId: 'W', leaseMs: 1000, recovery: true, now: T0 });
    const res = await runOrderReport(
      { id: ok, payload: { orderCount: 10, seed: 1 } },
      { signal: new AbortController().signal, reportDir, attempt: 1, allowFaultInjection: false },
    );
    completeAttempt(db, { id: ok, workerId: 'W', attempt: 1, result: res, execMs: 1, now: T0 });
    assert.deepEqual(checkConsistency(db, reportDir).violations, []);

    // Rusak: checksum tidak cocok.
    await writeFile(join(reportDir, res.reportFile), '{"diubah":true}');
    assert.deepEqual(
      checkConsistency(db, reportDir).violations.map((x) => x.rule),
      ['report_checksum_mismatch'],
    );
    // Rusak: file hilang.
    await rm(join(reportDir, res.reportFile));
    assert.deepEqual(
      checkConsistency(db, reportDir).violations.map((x) => x.rule),
      ['report_missing'],
    );
    // Rusak: FAILED tapi punya result, dan PENDING punya lease.
    const bad = newJob(db, 2);
    db.prepare("UPDATE jobs SET status='FAILED', result='{}', finished_at=1 WHERE id=?").run(bad);
    const bad2 = newJob(db, 3);
    db.prepare("UPDATE jobs SET lease_owner='Z', lease_expires_at=1 WHERE id=?").run(bad2);
    const rules = checkConsistency(db, reportDir).violations.map((x) => x.rule).sort();
    assert.deepEqual(rules, ['failed_without_error_class', 'pending_with_lease', 'report_missing', 'result_without_success']);
    db.close();
  });
});

describe('kegagalan filesystem', () => {
  test('rename gagal: file tmp dihapus, error STORAGE non-retryable', async (t) => {
    const dir = await tempDir(t);
    await mkdir(join(dir, 'x.json')); // direktori di posisi file tujuan
    await assert.rejects(writeFileAtomic(dir, 'x.json', 'isi', 'p.1'), (err) => {
      assert.ok(err instanceof StorageError);
      assert.equal(classify(err).errorClass, 'STORAGE');
      assert.equal(classify(err).retryable, false);
      return true;
    });
    assert.deepEqual(await readdir(dir), ['x.json']);
  });

  test('REPORT_DIR berupa file: STORAGE, bukan crash', async (t) => {
    const dir = await tempDir(t);
    await writeFile(join(dir, 'reports'), 'bukan direktori');
    await assert.rejects(writeFileAtomic(join(dir, 'reports'), 'a.json', 'isi', 'p.1'), StorageError);
  });

  test('kode error yang bisa pulih sendiri di-retry', () => {
    for (const code of ['ENOSPC', 'EIO', 'EMFILE']) {
      const e = Object.assign(new Error(code), { code });
      assert.equal(classify(new StorageError(e)).retryable, true, code);
    }
    for (const code of ['EACCES', 'EROFS', 'ENOTDIR', 'EISDIR']) {
      const e = Object.assign(new Error(code), { code });
      assert.equal(classify(new StorageError(e)).retryable, false, code);
    }
  });
});

describe('konfigurasi keamanan dan timing', () => {
  test('API tetap localhost-only kecuali disengaja', () => {
    assert.equal(loadConfig({}).host, '127.0.0.1');
    assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), /ALLOW_REMOTE/);
    assert.equal(loadConfig({ HOST: '0.0.0.0', ALLOW_REMOTE: '1' }).host, '0.0.0.0');
    assert.throws(
      () => loadConfig({ HOST: '0.0.0.0', ALLOW_REMOTE: '1', ALLOW_FAULT_INJECTION: '1' }),
      /ALLOW_FAULT_INJECTION/,
    );
    assert.equal(loadConfig({ HOST: '::1', ALLOW_FAULT_INJECTION: '1' }).allowFaultInjection, true);
  });

  test('busy timeout + heartbeat harus di bawah lease', () => {
    assert.throws(() => loadConfig({ LEASE_MS: '1000', HEARTBEAT_MS: '200', BUSY_TIMEOUT_MS: '900' }), /BUSY_TIMEOUT_MS/);
    assert.equal(loadConfig({ LEASE_MS: '1000', HEARTBEAT_MS: '200', BUSY_TIMEOUT_MS: '500' }).busyTimeoutMs, 500);
  });
});
