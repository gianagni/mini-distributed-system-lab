// Test end-to-end: proses API dan worker sungguhan, satu file SQLite, kill -9 sungguhan.
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { waitUntil } from '../scripts/lib/harness.js';
import { TERMINAL, report, setup, submitJobs, submitSummary } from './helpers.js';

test('happy path: PENDING -> SUCCEEDED, laporan tertulis', async (t) => {
  const s = await setup(t);
  const created = await s.post({ type: 'order_report', payload: { orderCount: 3000, seed: 5 } });
  assert.equal(created.status, 202);
  assert.equal(created.body.status, 'PENDING');
  assert.equal(created.headers.get('location'), `/jobs/${created.body.id}`);

  const done = await s.waitStatus(created.body.id, TERMINAL);
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(done.attempts, 1);
  const file = JSON.parse(await readFile(join(s.env.REPORT_DIR, done.result.reportFile), 'utf8'));
  assert.equal(file.orderCount, 3000);
  assert.equal(file.netRevenue, done.result.netRevenue);
});

test('validasi input dan route', async (t) => {
  const s = await setup(t, {}, { workers: 0 });
  assert.equal((await s.post('{bukan json')).status, 400);
  assert.equal((await s.post({ type: 'hapus_semua' })).status, 400);
  assert.equal((await s.post(report(undefined, 0))).status, 400);
  assert.equal((await s.post(report(), { 'idempotency-key': 'spasi tidak boleh' })).status, 400);
  assert.equal((await s.post('x'.repeat(17 * 1024))).status, 413);
  assert.equal((await s.get('/jobs/bukan-uuid')).status, 404);
  assert.equal((await s.get('/jobs/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await fetch(`${s.api.url}/jobs`)).status, 405);
});

test('fault injection ditolak kalau ALLOW_FAULT_INJECTION mati', async (t) => {
  const s = await setup(t, { ALLOW_FAULT_INJECTION: '0' }, { workers: 0 });
  const r = await s.post(report({ hang: true }));
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /ALLOW_FAULT_INJECTION/);
});

test('idempotency key: request ulang tidak membuat job baru', async (t) => {
  const s = await setup(t, {}, { workers: 0 });
  const a = await s.post(report(), { 'idempotency-key': 'order-123' });
  const b = await s.post(report(), { 'idempotency-key': 'order-123' });
  assert.equal(a.status, 202);
  assert.equal(b.status, 200);
  assert.equal(a.body.id, b.body.id);
  const c = await s.post(report(undefined, 999), { 'idempotency-key': 'order-123' });
  assert.equal(c.status, 409);
  assert.equal((await s.get('/metrics')).body.jobs.total, 1);
});

test('transient error: retry lalu sukses', async (t) => {
  const s = await setup(t);
  const { body } = await s.post(report({ failTransientTimes: 2 }));
  const done = await s.waitStatus(body.id, TERMINAL);
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(done.attempts, 3);
  assert.equal(done.events.filter((e) => e.event === 'retry_scheduled').length, 2);
});

test('retry bounded: gagal terus berhenti di MAX_ATTEMPTS', async (t) => {
  const s = await setup(t);
  const { body } = await s.post(report({ failTransientTimes: 10 }));
  const done = await s.waitStatus(body.id, TERMINAL);
  assert.equal(done.status, 'FAILED');
  assert.equal(done.attempts, 3);
  assert.equal(done.error.class, 'TRANSIENT');
});

test('permanent error: tidak di-retry', async (t) => {
  const s = await setup(t);
  const { body } = await s.post(report({ failPermanent: true }));
  const done = await s.waitStatus(body.id, TERMINAL);
  assert.equal(done.status, 'FAILED');
  assert.equal(done.attempts, 1);
  assert.equal(done.error.class, 'PERMANENT');
});

test('job macet: timeout per attempt, lalu FAILED TIMEOUT', async (t) => {
  const s = await setup(t, { JOB_TIMEOUT_MS: '300', MAX_ATTEMPTS: '2' });
  const { body } = await s.post(report({ hang: true }));
  const done = await s.waitStatus(body.id, TERMINAL);
  assert.equal(done.status, 'FAILED');
  assert.equal(done.attempts, 2);
  assert.equal(done.error.class, 'TIMEOUT');
});

test('worker di-kill -9 saat RUNNING: worker lain mengambil alih, sukses sekali', async (t) => {
  const s = await setup(t);
  const { body } = await s.post(report({ delayMs: 1500 }));
  await s.waitStatus(body.id, ['RUNNING']);
  await s.workers[0].kill('SIGKILL');
  await s.addWorker('w2');

  const done = await s.waitStatus(body.id, TERMINAL);
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(done.attempts, 2);
  const events = done.events.map((e) => e.event);
  assert.ok(events.includes('lease_expired'));
  assert.equal(events.filter((e) => e === 'succeeded').length, 1);
  assert.equal(done.events.find((e) => e.event === 'succeeded').workerId, 'w2');
  await access(join(s.env.REPORT_DIR, `${body.id}.json`));
});

test('worker hilang pada attempt terakhir: FAILED WORKER_LOST', async (t) => {
  const s = await setup(t, { MAX_ATTEMPTS: '1' });
  const { body } = await s.post(report({ delayMs: 1500 }));
  await s.waitStatus(body.id, ['RUNNING']);
  await s.workers[0].kill('SIGKILL');
  await s.addWorker('w2');
  const done = await s.waitStatus(body.id, TERMINAL);
  assert.equal(done.status, 'FAILED');
  assert.equal(done.error.class, 'WORKER_LOST');
});

test('baseline RECOVERY=0: job macet selamanya, tapi terlihat di metrik', async (t) => {
  const s = await setup(t, { RECOVERY: '0' });
  const { body } = await s.post(report({ delayMs: 1500 }));
  await s.waitStatus(body.id, ['RUNNING']);
  await s.workers[0].kill('SIGKILL');
  await s.addWorker('w2');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal((await s.get(`/jobs/${body.id}`)).body.status, 'RUNNING');
  assert.equal((await s.get('/metrics')).body.health.runningWithExpiredLease, 1);
});

test('backpressure: antrean penuh -> 429, replay idempotent tetap dilayani', async (t) => {
  const s = await setup(t, { MAX_PENDING: '2' }, { workers: 0 });
  assert.equal((await s.post(report(undefined, 1), { 'idempotency-key': 'a' })).status, 202);
  assert.equal((await s.post(report(undefined, 2))).status, 202);
  const full = await s.post(report(undefined, 3));
  assert.equal(full.status, 429);
  assert.equal(full.headers.get('retry-after'), '1');
  assert.equal((await s.post(report(undefined, 1), { 'idempotency-key': 'a' })).status, 200);
});

test('dua worker, banyak job: semua selesai, tidak ada sukses ganda', async (t) => {
  const s = await setup(t, {}, { workers: 2 });
  // POST /jobs boleh menjawab 503 DB_BUSY (kontrak sejak AUDIT C-1). Dulu status tidak diperiksa: satu 503
  // berarti hanya 29 job ada dan test menunggu SUCCEEDED === 30 sampai timeout (terbukti di emulasi
  // Windows 3/40 run, AUDIT C-3). Sekarang kontrak klien: Idempotency-Key, ulangi 503 dengan key sama.
  const bodies = Array.from({ length: 30 }, (_, i) => report({ delayMs: 10, failTransientTimes: i % 3 === 0 ? 1 : 0 }, 500));
  const sub = await submitJobs(s, bodies, { keyPrefix: 'dua-worker' });
  assert.equal(sub.gaveUp, 0, `job yang tidak pernah diterima: ${JSON.stringify(submitSummary(sub))}`);
  const ids = sub.ids;
  assert.equal(new Set(ids).size, 30);
  assert.equal((await s.get('/metrics')).body.jobs.total, 30, 'tidak ada job ganda karena retry');
  await waitUntil(
    async () => {
      const m = (await s.get('/metrics')).body;
      return m.jobs.byStatus.SUCCEEDED === 30;
    },
    { timeoutMs: 10_000 },
  );
  const m = (await s.get('/metrics')).body;
  assert.equal(m.counters.duplicateSuccessJobs, 0);
  assert.equal(m.counters.retriesScheduled, 10);
  const workersUsed = new Set();
  for (const id of ids) {
    for (const e of (await s.get(`/jobs/${id}`)).body.events) if (e.workerId) workersUsed.add(e.workerId);
  }
  assert.deepEqual([...workersUsed].sort(), ['w1', 'w2']);
});
