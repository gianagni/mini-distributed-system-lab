import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { backoffDelay } from '../src/backoff.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { LeaseLostError, PermanentError, TimeoutError, TransientError, ValidationError, classify } from '../src/errors.js';
import { computeMetrics, percentile } from '../src/metrics.js';
import { claimNext, completeAttempt, createJob, extendLease, failAttempt, getEvents, getJob } from '../src/store.js';
import { buildOrderReport, validateJobRequest } from '../src/task.js';

describe('backoffDelay', () => {
  const opts = { baseMs: 100, capMs: 1000 };
  test('batas atas tumbuh eksponensial lalu dipotong cap', () => {
    assert.equal(backoffDelay(1, opts, () => 0.999999), 100);
    assert.equal(backoffDelay(2, opts, () => 0.999999), 200);
    assert.equal(backoffDelay(3, opts, () => 0.999999), 400);
    assert.equal(backoffDelay(10, opts, () => 0.999999), 1000);
  });
  test('full jitter: batas bawah 0', () => {
    assert.equal(backoffDelay(5, opts, () => 0), 0);
  });
  test('selalu dalam rentang untuk random asli', () => {
    for (let a = 1; a <= 20; a++) {
      const d = backoffDelay(a, opts);
      assert.ok(d >= 0 && d <= Math.min(1000, 100 * 2 ** (a - 1)));
    }
  });
  test('attempt tidak valid ditolak', () => {
    assert.throws(() => backoffDelay(0, opts), RangeError);
  });
});

describe('classify', () => {
  test('memetakan error class dan retryable', () => {
    assert.deepEqual(
      [new TransientError('x'), new PermanentError('x'), new TimeoutError(5), new LeaseLostError()].map((e) => {
        const c = classify(e);
        return [c.errorClass, c.retryable];
      }),
      [
        ['TRANSIENT', true],
        ['PERMANENT', false],
        ['TIMEOUT', true],
        ['LEASE_LOST', false],
      ],
    );
  });
  test('error tak dikenal = INTERNAL, retryable (tetap dibatasi MAX_ATTEMPTS)', () => {
    const c = classify(new Error('boom'));
    assert.equal(c.errorClass, 'INTERNAL');
    assert.equal(c.retryable, true);
  });
});

describe('validateJobRequest', () => {
  const ok = { allowFaultInjection: false };
  test('default payload diisi', () => {
    assert.deepEqual(validateJobRequest({ type: 'order_report' }, ok), {
      type: 'order_report',
      payload: { orderCount: 1000, seed: 1 },
    });
  });
  test('menolak input tidak valid', () => {
    for (const body of [
      null,
      [],
      { type: 'x' },
      { type: 'order_report', extra: 1 },
      { type: 'order_report', payload: { orderCount: 0 } },
      { type: 'order_report', payload: { orderCount: 1.5 } },
      { type: 'order_report', payload: { orderCount: 200_001 } },
      { type: 'order_report', payload: { unknown: 1 } },
    ]) {
      assert.throws(() => validateJobRequest(body, ok), ValidationError, JSON.stringify(body));
    }
  });
  test('simulate ditolak kalau fault injection mati', () => {
    assert.throws(
      () => validateJobRequest({ type: 'order_report', payload: { simulate: { hang: true } } }, ok),
      /ALLOW_FAULT_INJECTION/,
    );
  });
  test('simulate dinormalisasi kalau fault injection hidup', () => {
    const r = validateJobRequest(
      { type: 'order_report', payload: { simulate: { failTransientTimes: 2 } } },
      { allowFaultInjection: true },
    );
    assert.deepEqual(r.payload.simulate, {
      delayMs: 0,
      failTransientTimes: 2,
      failPermanent: false,
      hang: false,
      crashAfterWriteTimes: 0,
    });
  });
});

describe('buildOrderReport', () => {
  test('deterministik untuk seed yang sama', () => {
    assert.deepEqual(buildOrderReport(1000, 42), buildOrderReport(1000, 42));
    assert.notDeepEqual(buildOrderReport(1000, 42), buildOrderReport(1000, 43));
  });
  test('jumlah per status konsisten', () => {
    const r = buildOrderReport(5000, 9);
    const total = r.byStatus.PAID.count + r.byStatus.REFUNDED.count + r.byStatus.CANCELLED.count;
    assert.equal(total, 5000);
    assert.equal(r.netRevenue, r.byStatus.PAID.amount - r.byStatus.REFUNDED.amount);
  });
});

describe('percentile', () => {
  test('nearest rank', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentile(s, 50), 5);
    assert.equal(percentile(s, 95), 10);
    assert.equal(percentile([], 50), null);
  });
});

describe('loadConfig', () => {
  test('default masuk akal', () => {
    const c = loadConfig({});
    assert.equal(c.maxAttempts, 3);
    assert.equal(c.recovery, true);
    assert.equal(c.allowFaultInjection, false);
  });
  test('menolak nilai tidak valid', () => {
    assert.throws(() => loadConfig({ MAX_ATTEMPTS: 'abc' }), /MAX_ATTEMPTS/);
    assert.throws(() => loadConfig({ MAX_ATTEMPTS: '0' }), /MAX_ATTEMPTS/);
    assert.throws(() => loadConfig({ LEASE_MS: '100', HEARTBEAT_MS: '100' }), /HEARTBEAT_MS/);
  });
});

describe('store: claim, lease, fencing', () => {
  const T0 = 1_000_000;
  const LEASE = 1000;

  function fresh({ maxAttempts = 3 } = {}) {
    const db = openDb(':memory:');
    const { job } = createJob(db, {
      id: '00000000-0000-4000-8000-000000000001',
      type: 'order_report',
      payload: { orderCount: 1, seed: 1 },
      idempotencyKey: 'k',
      requestHash: 'h1',
      maxAttempts,
      maxPending: 10,
      now: T0,
    });
    return { db, id: job.id };
  }

  test('dua worker tidak bisa claim job yang sama', () => {
    const { db } = fresh();
    const a = claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: T0 });
    const b = claimNext(db, { workerId: 'B', leaseMs: LEASE, recovery: true, now: T0 + 10 });
    assert.equal(a.lease_owner, 'A');
    assert.equal(b, null);
  });

  test('lease kedaluwarsa: diambil alih, worker lama ditolak (fencing)', () => {
    const { db, id } = fresh();
    claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: T0 });
    const b = claimNext(db, { workerId: 'B', leaseMs: LEASE, recovery: true, now: T0 + LEASE + 1 });
    assert.equal(b.lease_owner, 'B');
    assert.equal(b.attempts, 2);

    // A bangun lagi (zombie): heartbeat, complete, dan fail semuanya ditolak.
    assert.equal(extendLease(db, { id, workerId: 'A', attempt: 1, leaseMs: LEASE, now: T0 + 1100 }), false);
    assert.equal(completeAttempt(db, { id, workerId: 'A', attempt: 1, result: {}, execMs: 1, now: T0 + 1100 }), false);
    assert.equal(
      failAttempt(db, {
        id,
        workerId: 'A',
        attempt: 1,
        errorClass: 'TRANSIENT',
        message: 'x',
        retryable: true,
        backoffMs: 0,
        execMs: 1,
        now: T0 + 1100,
      }),
      null,
    );
    assert.equal(completeAttempt(db, { id, workerId: 'B', attempt: 2, result: { ok: 1 }, execMs: 1, now: T0 + 1200 }), true);

    const events = getEvents(db, id).map((e) => e.event);
    assert.deepEqual(events, [
      'created',
      'claimed',
      'lease_expired',
      'claimed',
      'stale_completion_rejected',
      'stale_failure_rejected',
      'succeeded',
    ]);
    assert.equal(computeMetrics(db, T0 + 1300).counters.duplicateSuccessJobs, 0);
  });

  test('recovery mati: job macet tetap RUNNING dan terdeteksi di metrik', () => {
    const { db, id } = fresh();
    claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: false, now: T0 });
    assert.equal(claimNext(db, { workerId: 'B', leaseMs: LEASE, recovery: false, now: T0 + 5000 }), null);
    assert.equal(getJob(db, id).status, 'RUNNING');
    assert.equal(computeMetrics(db, T0 + 5000).health.runningWithExpiredLease, 1);
  });

  test('worker hilang pada attempt terakhir: FAILED WORKER_LOST, bukan macet', () => {
    const { db, id } = fresh({ maxAttempts: 1 });
    claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: T0 });
    assert.equal(claimNext(db, { workerId: 'B', leaseMs: LEASE, recovery: true, now: T0 + LEASE + 1 }), null);
    const job = getJob(db, id);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.error_class, 'WORKER_LOST');
  });

  test('retry hanya sampai max_attempts', () => {
    const { db, id } = fresh({ maxAttempts: 2 });
    let now = T0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const j = claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now });
      assert.equal(j.attempts, attempt);
      const r = failAttempt(db, {
        id,
        workerId: 'A',
        attempt,
        errorClass: 'TRANSIENT',
        message: 'x',
        retryable: true,
        backoffMs: 100,
        execMs: 1,
        now,
      });
      assert.equal(r.status, attempt < 2 ? 'PENDING' : 'FAILED');
      // Sebelum backoff lewat, job belum boleh di-claim.
      if (attempt < 2) assert.equal(claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: now + 50 }), null);
      now += 100;
    }
    assert.equal(getJob(db, id).status, 'FAILED');
  });

  test('idempotency key: request sama dedup, isi beda konflik', () => {
    const { db, id } = fresh();
    const base = { type: 'order_report', payload: {}, idempotencyKey: 'k', maxAttempts: 3, maxPending: 10, now: T0 };
    const again = createJob(db, { ...base, id: '00000000-0000-4000-8000-000000000002', requestHash: 'h1' });
    assert.equal(again.created, false);
    assert.equal(again.job.id, id);
    assert.throws(
      () => createJob(db, { ...base, id: '00000000-0000-4000-8000-000000000003', requestHash: 'h2' }),
      /Idempotency-Key/,
    );
  });
});

describe('store: tulisan status + claim berikutnya dalam satu transaksi (AUDIT C-3)', () => {
  const T0 = 2_000_000;
  const LEASE = 1000;
  const ID1 = '00000000-0000-4000-8000-0000000000a1';
  const ID2 = '00000000-0000-4000-8000-0000000000a2';
  function two() {
    const db = openDb(':memory:');
    for (const [i, id] of [ID1, ID2].entries()) {
      createJob(db, { id, type: 'order_report', payload: { orderCount: 1, seed: 1 }, idempotencyKey: null, requestHash: 'h', maxAttempts: 3, maxPending: 10, now: T0 + i });
    }
    return db;
  }
  const andClaim = { leaseMs: LEASE, recovery: true };

  test('complete + claim: keduanya ter-commit, lease job berikutnya dari waktu yang sama (setelah lock)', () => {
    const db = two();
    claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: T0 + 10 });
    let calls = 0;
    const r = completeAttempt(db, { id: ID1, workerId: 'A', attempt: 1, result: {}, execMs: 1, now: () => (calls++, T0 + 50), andClaim });
    assert.equal(r.value, true);
    assert.equal(r.next.id, ID2);
    assert.equal(r.next.lease_owner, 'A');
    assert.equal(r.next.lease_expires_at, T0 + 50 + LEASE);
    assert.equal(getJob(db, ID1).status, 'SUCCEEDED');
    assert.equal(getJob(db, ID2).status, 'RUNNING');
    assert.equal(calls, 1, "satu transaksi, satu evaluasi waktu");
  });

  test('tanpa andClaim: return dan perilaku lama tidak berubah', () => {
    const db = two();
    claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: T0 + 10 });
    assert.equal(completeAttempt(db, { id: ID1, workerId: 'A', attempt: 1, result: {}, execMs: 1, now: T0 + 50 }), true);
    assert.equal(getJob(db, ID2).status, 'PENDING');
  });

  test('fencing tetap berlaku: complete basi ditolak, claim berikutnya tetap jalan (job lain)', () => {
    const db = two();
    claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: T0 + 10 });
    claimNext(db, { workerId: 'B', leaseMs: LEASE, recovery: true, now: T0 + 20 }); // B memegang ID2
    claimNext(db, { workerId: 'C', leaseMs: LEASE, recovery: true, now: T0 + LEASE + 11 }); // lease A habis, C ambil alih ID1
    const r = completeAttempt(db, { id: ID1, workerId: 'A', attempt: 1, result: {}, execMs: 1, now: T0 + LEASE + 20, andClaim });
    assert.equal(r.value, false, 'worker lama tidak boleh menimpa status');
    assert.equal(r.next, null, 'tidak ada job lain yang siap');
    assert.equal(getJob(db, ID1).lease_owner, 'C');
    assert.equal(getJob(db, ID1).status, 'RUNNING');
  });

  test('atomik: kalau claim di transaksi itu gagal, status juga tidak tertulis', () => {
    const db = two();
    claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: T0 + 10 });
    // UPDATE status sudah jalan, lalu bagian claim melempar (andClaim.recovery dibaca setelahnya).
    const andClaimBoom = { leaseMs: LEASE, get recovery() { throw new Error('boom saat claim'); } };
    assert.throws(() => completeAttempt(db, { id: ID1, workerId: 'A', attempt: 1, result: {}, execMs: 1, now: T0 + 50, andClaim: andClaimBoom }), /boom saat claim/);
    assert.equal(getJob(db, ID1).status, 'RUNNING', 'complete di-ROLLBACK bersama claim');
    assert.deepEqual(getEvents(db, ID1).map((e) => e.event), ['created', 'claimed']);
  });
});
