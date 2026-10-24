// Test dashboard: timeline dari event asli, read model, konfigurasi, dan proses dashboard sungguhan
// (API + worker + dashboard, satu file SQLite). Test lama tidak diubah.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { startApi, startDashboard, waitUntil } from '../scripts/lib/harness.js';
import { loadDashboardConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { getJobDetail, listJobs } from '../src/readmodel.js';
import { claimNext, completeAttempt, createJob, failAttempt, getEvents, getJob } from '../src/store.js';
import { validateJobRequest } from '../src/task.js';
import { buildTimeline, parseBackoffMs } from '../src/timeline.js';
import { PRESETS } from '../dashboard/views/create.js';
import { TERMINAL, removeTempDir, report, setup } from './helpers.js';

const T0 = 1_000_000;
const LEASE = 1000;

function fresh({ maxAttempts = 3, n = 1, now = T0, db = openDb(':memory:') } = {}) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  createJob(db, {
    id,
    type: 'order_report',
    payload: { orderCount: 10, seed: n },
    idempotencyKey: null,
    requestHash: `h${n}`,
    maxAttempts,
    maxPending: 100,
    now,
  });
  return { db, id };
}
const timelineOf = (db, id, now) => buildTimeline(getJob(db, id), getEvents(db, id), now);
const fail = (db, id, workerId, attempt, now, { retryable = true, backoffMs = 300, errorClass = 'TRANSIENT' } = {}) =>
  failAttempt(db, { id, workerId, attempt, errorClass, message: 'boom', retryable, backoffMs, execMs: 5, now });

describe('timeline dari event store asli', () => {
  test('retry lalu sukses: jeda dipisah jadi backoff + antre, format pesan backoff terkunci', () => {
    const { db, id } = fresh();
    claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: T0 + 10 });
    fail(db, id, 'A', 1, T0 + 20, { backoffMs: 300 });
    // Format pesan dari store.js harus bisa di-parse. Kalau store.js berubah, test ini gagal.
    const msg = getEvents(db, id).find((e) => e.event === 'retry_scheduled').message;
    assert.equal(parseBackoffMs(msg), 300, `format pesan retry_scheduled berubah: ${msg}`);

    claimNext(db, { workerId: 'B', leaseMs: LEASE, recovery: true, now: T0 + 400 });
    completeAttempt(db, { id, workerId: 'B', attempt: 2, result: { ok: 1 }, execMs: 50, now: T0 + 450 });

    const tl = timelineOf(db, id, T0 + 999);
    assert.equal(tl.open, false);
    assert.deepEqual(
      tl.attempts.map((a) => [a.attempt, a.workerId, a.outcome, a.durationMs]),
      [
        [1, 'A', 'retry_scheduled', 10],
        [2, 'B', 'succeeded', 50],
      ],
    );
    assert.equal(tl.attempts[0].errorClass, 'TRANSIENT');
    assert.deepEqual(
      tl.waits.map((w) => [w.kind, w.durationMs, w.backoffMs ?? null, w.queueAfterBackoffMs ?? null]),
      [
        ['queue', 10, null, null],
        ['retry_wait', 380, 300, 80],
      ],
    );
    assert.deepEqual(tl.totals, { endToEndMs: 450, queueWaitMs: 10, execMs: 60, retryWaitMs: 380, staleWritesRejected: 0 });
  });

  test('worker hilang: reclaim, akhir attempt = waktu deteksi, tulisan zombie tercatat di attempt lama', () => {
    const { db, id } = fresh();
    claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: T0 });
    claimNext(db, { workerId: 'B', leaseMs: LEASE, recovery: true, now: T0 + LEASE + 5 });
    assert.equal(completeAttempt(db, { id, workerId: 'A', attempt: 1, result: {}, execMs: 1, now: T0 + LEASE + 50 }), false);

    const now = T0 + LEASE + 200;
    const tl = timelineOf(db, id, now);
    const [a1, a2] = tl.attempts;
    assert.equal(a1.outcome, 'worker_lost');
    assert.equal(a1.endIsDetection, true);
    assert.equal(a1.endedAt, T0 + LEASE + 5);
    assert.equal(a1.staleWrites.length, 1);
    assert.equal(a1.staleWrites[0].event, 'stale_completion_rejected');
    assert.equal(a2.outcome, 'running');
    assert.equal(a2.open, true);
    assert.equal(a2.durationMs, 195);
    assert.deepEqual(tl.waits[1], { kind: 'reclaim', from: T0 + LEASE + 5, to: T0 + LEASE + 5, durationMs: 0, beforeAttempt: 2, open: false });
    assert.equal(tl.totals.staleWritesRejected, 1);
    assert.equal(tl.open, true);
  });

  test('worker hilang pada attempt terakhir: worker_lost + final, tanpa jeda terbuka', () => {
    const { db, id } = fresh({ maxAttempts: 1 });
    claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: T0 });
    claimNext(db, { workerId: 'B', leaseMs: LEASE, recovery: true, now: T0 + LEASE + 1 });
    const tl = timelineOf(db, id, T0 + 5000);
    assert.equal(getJob(db, id).status, 'FAILED');
    assert.equal(tl.attempts.length, 1);
    assert.equal(tl.attempts[0].outcome, 'worker_lost');
    assert.equal(tl.attempts[0].finalFailure, true);
    assert.equal(tl.waits.filter((w) => w.open).length, 0);
    assert.equal(tl.end, T0 + LEASE + 1);
  });

  test('permanen: gagal final tanpa retry', () => {
    const { db, id } = fresh();
    claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: T0 });
    fail(db, id, 'A', 1, T0 + 7, { retryable: false, errorClass: 'PERMANENT' });
    const tl = timelineOf(db, id, T0 + 100);
    assert.equal(tl.attempts[0].outcome, 'failed');
    assert.equal(tl.attempts[0].finalFailure, true);
    assert.equal(tl.attempts[0].backoffMs, null);
  });

  test('PENDING: jeda terbuka sampai snapshot (belum pernah di-claim, dan setelah retry)', () => {
    const a = fresh();
    let tl = timelineOf(a.db, a.id, T0 + 70);
    assert.deepEqual(tl.waits, [{ kind: 'queue', from: T0, to: T0 + 70, durationMs: 70, beforeAttempt: 1, open: true }]);
    assert.equal(tl.totals.queueWaitMs, null);

    claimNext(a.db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: T0 + 100 });
    fail(a.db, a.id, 'A', 1, T0 + 110, { backoffMs: 500 });
    tl = timelineOf(a.db, a.id, T0 + 300);
    const open = tl.waits.find((w) => w.open);
    assert.equal(open.kind, 'retry_wait');
    assert.equal(open.beforeAttempt, 2);
    assert.equal(open.backoffMs, 500);
    assert.equal(open.queueAfterBackoffMs, null);
    assert.equal(tl.totals.retryWaitMs, 0, 'jeda yang masih berjalan tidak dihitung sebagai total');
  });

  test('parseBackoffMs hanya menerima format store.js', () => {
    assert.equal(parseBackoffMs('x (retry dalam 12 ms)'), 12);
    assert.equal(parseBackoffMs('retry dalam 12 ms'), null);
    assert.equal(parseBackoffMs(null), null);
  });
});

describe('read model dashboard', () => {
  test('list: terbaru dulu, keyset pagination stabil, filter status/error class/retried', () => {
    const db = openDb(':memory:');
    for (let n = 1; n <= 3; n++) fresh({ db, n, now: T0 + n * 10 });
    const failedId = `00000000-0000-4000-8000-${String(2).padStart(12, '0')}`;
    // Job 2: gagal permanen. Job 3: retry lalu masih PENDING.
    const c = claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: T0 + 100 });
    assert.equal(c.id, `00000000-0000-4000-8000-${String(1).padStart(12, '0')}`);
    completeAttempt(db, { id: c.id, workerId: 'A', attempt: 1, result: { ok: 1 }, execMs: 1, now: T0 + 101 });
    claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: T0 + 102 });
    fail(db, failedId, 'A', 1, T0 + 103, { retryable: false, errorClass: 'PERMANENT' });
    const retryId = claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: T0 + 104 }).id;
    fail(db, retryId, 'A', 1, T0 + 105, { backoffMs: 0 });
    claimNext(db, { workerId: 'A', leaseMs: LEASE, recovery: true, now: T0 + 106 });
    fail(db, retryId, 'A', 2, T0 + 107, { backoffMs: 10_000 });
    // Dibuat setelah retry supaya claim di atas pasti memilih job 3. created_at tetap lebih baru.
    for (let n = 4; n <= 5; n++) fresh({ db, n, now: T0 + n * 10 });

    const p1 = listJobs(db, { limit: 2 }, T0 + 200);
    assert.deepEqual(
      p1.items.map((j) => j.id.slice(-1)),
      ['5', '4'],
    );
    assert.ok(p1.nextCursor);
    const p2 = listJobs(db, { limit: 2, before: { createdAt: Number(p1.nextCursor.split('_')[0]), id: p1.nextCursor.split('_')[1] } }, T0 + 200);
    assert.deepEqual(
      p2.items.map((j) => j.id.slice(-1)),
      ['3', '2'],
    );
    assert.deepEqual(p1.counts.byStatus, { PENDING: 3, RUNNING: 0, SUCCEEDED: 1, FAILED: 1 });

    const failed = listJobs(db, { status: 'FAILED' }, T0 + 200).items;
    assert.deepEqual(failed.map((j) => [j.id, j.error.class]), [[failedId, 'PERMANENT']]);
    assert.equal(listJobs(db, { errorClass: 'TRANSIENT' }, T0 + 200).items[0].id, retryId);
    const retried = listJobs(db, { retried: true }, T0 + 200).items;
    assert.deepEqual(retried.map((j) => [j.id, j.status, j.attempts, j.nextRunAt]), [[retryId, 'PENDING', 2, T0 + 10_107]]);

    const detail = getJobDetail(db, retryId, T0 + 200);
    assert.equal(detail.events.length, getEvents(db, retryId).length);
    assert.equal(detail.timeline.attempts.length, 2);
    assert.equal(getJobDetail(db, '00000000-0000-4000-8000-999999999999', T0), null);
  });
});

describe('konfigurasi dashboard', () => {
  test('default loopback; non-loopback wajib ALLOW_REMOTE; fault injection hanya loopback', () => {
    const d = loadDashboardConfig({});
    assert.equal(d.host, '127.0.0.1');
    assert.equal(d.port, 3100);
    assert.equal(d.apiUrl, 'http://127.0.0.1:3000');
    assert.equal(d.allowFaultInjection, false);
    assert.equal(loadDashboardConfig({ PORT: '3005' }).apiUrl, 'http://127.0.0.1:3005');
    assert.throws(() => loadDashboardConfig({ DASHBOARD_HOST: '0.0.0.0' }), /ALLOW_REMOTE/);
    assert.throws(() => loadDashboardConfig({ API_URL: 'http://10.0.0.5:3000' }), /ALLOW_REMOTE/);
    assert.throws(() => loadDashboardConfig({ API_URL: 'ftp://127.0.0.1' }), /API_URL/);
    assert.throws(
      () => loadDashboardConfig({ DASHBOARD_HOST: '0.0.0.0', ALLOW_REMOTE: '1', ALLOW_FAULT_INJECTION: '1' }),
      /loopback/,
    );
    assert.equal(loadDashboardConfig({ DASHBOARD_HOST: '0.0.0.0', ALLOW_REMOTE: '1' }).allowRemote, true);
  });

  test('setiap preset fault injection di form lolos validasi API', () => {
    for (const p of PRESETS) {
      assert.doesNotThrow(() => validateJobRequest({ type: 'order_report', payload: { orderCount: 10, simulate: p.simulate } }, { allowFaultInjection: true }), p.id);
    }
  });
});

describe('proses dashboard (API + worker + dashboard sungguhan)', () => {
  async function withDashboard(t, overrides = {}, opts = {}) {
    const s = await setup(t, overrides, opts);
    const dash = s.track(await startDashboard({ ...s.env, API_URL: s.api.url }));
    const dget = async (path, headers = {}) => {
      const r = await fetch(dash.url + path, { headers });
      const text = await r.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {
        // file statis
      }
      return { status: r.status, body, headers: r.headers };
    };
    const dpost = async (body, headers = {}) => {
      const r = await fetch(`${dash.url}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json(), headers: r.headers };
    };
    return { ...s, dash, dget, dpost };
  }

  test('buat job lewat dashboard, status berubah, timeline memakai event yang sama dengan API', async (t) => {
    // Tanpa worker dulu: job selesai dalam 13-85 ms dengan konfigurasi test, jadi "melihat status
    // berubah" sambil worker sudah jalan adalah race (AUDIT U-1). PENDING diamati secara deterministik,
    // baru kemudian worker dinyalakan.
    const s = await withDashboard(t, {}, { workers: 0 });
    const created = await s.dpost(report({ failTransientTimes: 1 }), { 'idempotency-key': 'dash-001' });
    assert.equal(created.status, 202);
    assert.equal(created.headers.get('x-upstream'), 'api');

    const pending = await s.dget(`/api/jobs/${created.body.id}`);
    assert.equal(pending.body.job.status, 'PENDING');
    assert.deepEqual(pending.body.timeline.attempts, []);
    assert.equal(pending.body.timeline.waits[0].open, true);
    await s.addWorker('w1');

    const seen = new Set(['PENDING']);
    const done = await waitUntil(
      async () => {
        const { body } = await s.dget(`/api/jobs/${created.body.id}`);
        seen.add(body.job.status);
        return TERMINAL.includes(body.job.status) ? body : null;
      },
      { timeoutMs: 8000, intervalMs: 10 },
    );
    assert.equal(done.job.status, 'SUCCEEDED');
    assert.equal(done.job.faultInjected, true);
    assert.ok(seen.has('PENDING') && seen.has('SUCCEEDED'), `status yang diamati: ${[...seen]}`);
    assert.deepEqual(
      done.timeline.attempts.map((a) => a.outcome),
      ['retry_scheduled', 'succeeded'],
    );

    // Event dashboard = event API (sumber yang sama, bukan data karangan).
    const api = await s.get(`/jobs/${created.body.id}`);
    assert.deepEqual(
      done.events.map((e) => [e.attempt, e.event, e.workerId, e.errorClass, e.message, new Date(e.at).toISOString()]),
      api.body.events.map((e) => [e.attempt, e.event, e.workerId, e.errorClass, e.message, e.at]),
    );

    // Replay idempotent lewat proxy: 200, job yang sama. Isi beda: 409 dari API diteruskan apa adanya.
    const replay = await s.dpost(report({ failTransientTimes: 1 }), { 'idempotency-key': 'dash-001' });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, created.body.id);
    const conflict = await s.dpost(report({ failTransientTimes: 2 }), { 'idempotency-key': 'dash-001' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
    const invalid = await s.dpost({ type: 'hapus_semua' });
    assert.equal(invalid.status, 400);

    // Overview memakai computeMetrics yang sama dengan GET /metrics.
    const ov = await s.dget('/api/overview');
    const metrics = (await s.get('/metrics')).body;
    assert.deepEqual(ov.body.metrics.jobs, metrics.jobs);
    assert.deepEqual(ov.body.metrics.counters, metrics.counters);
    assert.equal(ov.body.api.ok, true);
    assert.deepEqual(
      ov.body.workers.map((w) => w.workerId),
      ['w1'],
    );

    const list = await s.dget('/api/jobs?status=SUCCEEDED');
    assert.deepEqual(
      list.body.items.map((j) => j.id),
      [created.body.id],
    );
    assert.equal((await s.dget('/api/jobs?status=BOGUS')).status, 400);
    assert.equal((await s.dget('/api/jobs?before=xyz')).status, 400);
    assert.equal((await s.dget('/api/jobs/bukan-uuid')).status, 404);

    // API lama tidak berubah: GET /jobs tetap 405.
    assert.equal((await fetch(`${s.api.url}/jobs`)).status, 405);
  });

  test('keamanan: CSP, Host, CSRF, file statis whitelist', async (t) => {
    const s = await withDashboard(t, {}, { workers: 0 });
    const index = await s.dget('/');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.doesNotMatch(index.body, /<script>(?!<\/script>)/, 'tidak boleh ada inline script');
    assert.equal((await s.dget('/app.js')).status, 200);
    assert.equal((await s.dget('/../src/config.js')).status, 404);
    assert.equal((await s.dget('/%2e%2e/package.json')).status, 404);

    // DNS rebinding: Host asing ditolak. fetch() membuang header Host, jadi pakai node:http.
    const hostStatus = (host) =>
      new Promise((resolve, reject) => {
        const req = httpRequest(`${s.dash.url}/api/overview`, { headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.end();
      });
    assert.equal(await hostStatus('evil.example'), 403);
    assert.equal(await hostStatus(`evil.example:${new URL(s.dash.url).port}`), 403);
    assert.equal(await hostStatus(`localhost:${new URL(s.dash.url).port}`), 200);

    // CSRF: simple request text/plain dan Origin asing ditolak, tidak ada job yang dibuat.
    const plain = await fetch(`${s.dash.url}/api/jobs`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"type":"order_report"}' });
    assert.equal(plain.status, 415);
    assert.equal((await s.dpost(report(), { origin: 'http://evil.example' })).status, 403);
    assert.equal((await s.dpost(report(), { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await s.dpost(report(), { 'idempotency-key': 'spasi tidak boleh' })).status, 400);
    assert.equal((await s.get('/metrics')).body.jobs.total, 0);
    // Request same-origin dari browser lolos.
    assert.equal((await s.dpost(report(), { origin: s.dash.url, 'sec-fetch-site': 'same-origin' })).status, 202);
  });

  test('API mati: baca tetap jalan dari SQLite, buat job 502 dengan pesan jelas', async (t) => {
    const s = await withDashboard(t, {}, { workers: 0 });
    assert.equal((await s.dpost(report())).status, 202);
    await s.api.stop();
    const r = await s.dpost(report());
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, 'API_UNREACHABLE');
    const ov = await s.dget('/api/overview');
    assert.equal(ov.status, 200);
    assert.equal(ov.body.metrics.jobs.total, 1);
    assert.equal(ov.body.api.ok, false);
  });

  test('database belum ada: 503, dashboard tidak membuat file; pulih setelah API start', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'mini-job-dash-'));
    const env = { DB_PATH: join(dir, 'jobs.db'), REPORT_DIR: join(dir, 'reports'), BUSY_TIMEOUT_MS: '200' };
    const dash = await startDashboard(env);
    let api = null;
    t.after(async () => {
      await dash.stop();
      await api?.stop();
      await removeTempDir(dir);
    });
    const r = await fetch(`${dash.url}/api/overview`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'DB_NOT_READY');
    assert.equal(existsSync(env.DB_PATH), false, 'dashboard read-only tidak boleh membuat database');

    api = await startApi(env);
    const ok = await fetch(`${dash.url}/api/overview`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).metrics.jobs.total, 0);
  });
});
