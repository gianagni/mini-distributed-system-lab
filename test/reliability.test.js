// Skenario kegagalan dengan proses sungguhan. Setiap test diakhiri pemeriksaan invariant:
// status, riwayat attempt, dan file laporan harus konsisten.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { waitUntil } from '../scripts/lib/harness.js';
import { TERMINAL, report, setup, sleep } from './helpers.js';

function assertConsistent(s, { allowWarnings = [] } = {}) {
  const r = s.consistency();
  assert.deepEqual(r.violations, [], 'tidak boleh ada violation');
  const unexpected = r.warnings.filter((w) => !allowWarnings.includes(w.rule));
  assert.deepEqual(unexpected, [], 'warning tak terduga');
  return r;
}

/**
 * Pegang write lock database dari "proses lain" (koneksi terpisah).
 * busy_timeout wajib: tanpa itu BEGIN IMMEDIATE milik test sendiri bisa gagal
 * kalau kebetulan bertabrakan dengan claim worker yang sedang polling.
 */
function holdWriteLock(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 2000;');
  db.exec('BEGIN IMMEDIATE');
  return db;
}

async function assertReportMatches(s, job) {
  const content = await readFile(join(s.env.REPORT_DIR, job.result.reportFile));
  assert.equal(createHash('sha256').update(content).digest('hex'), job.result.sha256);
}

// ---------- File vs database ----------

test('crash setelah file ditulis, sebelum commit DB: retry menulis ulang isi identik', async (t) => {
  const s = await setup(t);
  const { body } = await s.post(report({ crashAfterWriteTimes: 1 }));
  await s.workers[0].exited; // worker bunuh diri tepat setelah rename
  assert.equal((await s.get(`/jobs/${body.id}`)).body.status, 'RUNNING');
  assert.deepEqual(await s.reportFiles(), [`${body.id}.json`]); // file sudah ada, status belum

  await s.addWorker('w2');
  const done = await s.waitStatus(body.id, TERMINAL);
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(done.attempts, 2);
  await assertReportMatches(s, done);
  assertConsistent(s);
});

test('crash setelah file ditulis pada attempt terakhir: FAILED, file yatim terdeteksi sebagai warning', async (t) => {
  const s = await setup(t, { MAX_ATTEMPTS: '1' });
  const { body } = await s.post(report({ crashAfterWriteTimes: 1 }));
  await s.workers[0].exited;
  await s.addWorker('w2');
  const done = await s.waitStatus(body.id, TERMINAL);
  assert.equal(done.status, 'FAILED');
  assert.equal(done.error.class, 'WORKER_LOST');
  assert.equal(done.result, null);
  const r = assertConsistent(s, { allowWarnings: ['orphan_report'] });
  assert.deepEqual(
    r.warnings.map((w) => w.rule),
    ['orphan_report'],
  );
});

test('database terkunci saat commit hasil: tercatat, lalu pulih lewat lease tanpa hasil ganda', async (t) => {
  const s = await setup(t);
  const { body } = await s.post(report({ delayMs: 300 }));
  await s.waitStatus(body.id, ['RUNNING']);

  // Proses lain memegang write lock lebih lama dari BUSY_TIMEOUT_MS (200 ms).
  const locker = holdWriteLock(s.env.DB_PATH);
  await s.workers[0].waitFor((e) => e.event === 'job_state_write_failed', 5000);
  locker.exec('ROLLBACK');
  locker.close();

  const done = await s.waitStatus(body.id, TERMINAL);
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(done.attempts, 2, 'attempt 1 tidak bisa di-commit, diambil alih setelah lease habis');
  assert.ok(done.events.some((e) => e.event === 'lease_expired'));
  await assertReportMatches(s, done);
  assertConsistent(s);
  const errors = s.workers[0].events.filter((e) => e.level === 'error').map((e) => e.event);
  assert.ok(errors.includes('job_state_write_failed'), 'kegagalan tulis status tidak boleh diam');
});

test('filesystem gagal (path laporan diblokir direktori): FAILED STORAGE, tanpa file tmp', async (t) => {
  const s = await setup(t, {}, { workers: 0 });
  const { body } = await s.post(report());
  await mkdir(join(s.env.REPORT_DIR, `${body.id}.json`), { recursive: true });
  await s.addWorker('w1');
  const done = await s.waitStatus(body.id, TERMINAL);
  assert.equal(done.status, 'FAILED');
  assert.equal(done.error.class, 'STORAGE');
  assert.equal(done.attempts, 1, 'salah konfigurasi tidak di-retry');
  assert.deepEqual(await s.reportFiles(), [`${body.id}.json`]); // hanya direktori penghalang
  assertConsistent(s, { allowWarnings: ['orphan_report'] });
});

// ---------- Worker zombie, restart, kontensi ----------

test(
  'worker zombie (SIGSTOP > lease, lalu SIGCONT): hasilnya ditolak, tepat satu sukses',
  { skip: process.platform === 'win32' && 'SIGSTOP tidak ada di Windows' },
  async (t) => {
    const s = await setup(t);
    const { body } = await s.post(report({ delayMs: 800 }));
    await s.waitStatus(body.id, ['RUNNING']);
    const zombie = s.workers[0];
    zombie.child.kill('SIGSTOP');
    await s.addWorker('w2');
    const done = await s.waitStatus(body.id, TERMINAL);
    zombie.child.kill('SIGCONT');
    await zombie.waitFor((e) => e.event === 'lease_lost' || e.event === 'stale_completion_rejected', 5000);

    const final = (await s.get(`/jobs/${body.id}`)).body;
    assert.equal(final.status, 'SUCCEEDED');
    assert.equal(final.events.filter((e) => e.event === 'succeeded').length, 1);
    assert.equal(final.events.find((e) => e.event === 'succeeded').workerId, 'w2');
    assert.equal(done.attempts, 2);
    await assertReportMatches(s, final);
    assertConsistent(s);
  },
);

test('restart total: API dan worker di-kill -9, dinyalakan ulang dengan WORKER_ID sama', async (t) => {
  const s = await setup(t);
  const { body } = await s.post(report({ delayMs: 1000 }));
  await s.waitStatus(body.id, ['RUNNING']);
  await Promise.all([s.api.kill('SIGKILL'), s.workers[0].kill('SIGKILL')]);

  await s.restartApi();
  await s.addWorker('w1'); // identitas sama; fencing tetap memakai nomor attempt
  const done = await s.waitStatus(body.id, TERMINAL);
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(done.attempts, 2);
  assertConsistent(s);
});

test('kontensi: 4 worker polling 1 ms, 150 job: tidak ada claim ganda, semua konsisten', async (t) => {
  const s = await setup(t, { POLL_MS: '1', MAX_PENDING: '1000' }, { workers: 4 });
  for (let i = 0; i < 150; i++) await s.post({ type: 'order_report', payload: { orderCount: 50, seed: i + 1 } });
  await waitUntil(async () => (await s.get('/metrics')).body.jobs.byStatus.SUCCEEDED === 150, { timeoutMs: 20_000 });
  const m = (await s.get('/metrics')).body;
  assert.equal(m.counters.duplicateSuccessJobs, 0);
  assertConsistent(s);
  // Kontensi lock (claim_busy) boleh terjadi dan tercatat sebagai warning; error lain tidak boleh.
  const errors = s.workers.flatMap((w) => w.events.filter((e) => e.level === 'error' || e.level === 'fatal'));
  assert.deepEqual(errors, []);
  const busy = s.workers.flatMap((w) => w.events.filter((e) => e.event === 'claim_busy'));
  t.diagnostic(`claim_busy: ${busy.length}`);
});

test('kontensi lock saat claim: warning claim_busy, bukan error, worker pulih sendiri', async (t) => {
  const s = await setup(t);
  const locker = holdWriteLock(s.env.DB_PATH); // worker yang sedang polling tidak bisa claim
  await s.workers[0].waitFor((e) => e.event === 'claim_busy', 3000);
  locker.exec('ROLLBACK');
  locker.close();
  const { body } = await s.post(report());
  assert.equal((await s.waitStatus(body.id, TERMINAL)).status, 'SUCCEEDED');
  assert.deepEqual(
    s.workers[0].events.filter((e) => e.level === 'error'),
    [],
  );
});

test('fault injection tetap ditolak di worker yang tidak mengizinkannya', async (t) => {
  const s = await setup(t, {}, { workers: 1, workerEnv: { ALLOW_FAULT_INJECTION: '0' } });
  const { body } = await s.post(report({ hang: true }));
  const done = await s.waitStatus(body.id, TERMINAL);
  assert.equal(done.status, 'FAILED');
  assert.equal(done.error.class, 'PERMANENT');
  assert.match(done.error.message, /ALLOW_FAULT_INJECTION/);
});

// ---------- HTTP ----------

function rawRequest(url, data, { closeAfterMs } = {}) {
  const { port } = new URL(url);
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(data);
      if (closeAfterMs !== undefined) setTimeout(() => sock.destroy(), closeAfterMs);
    });
    let out = '';
    sock.on('data', (d) => (out += d));
    sock.on('error', () => {});
    sock.on('close', () => resolve(out.split('\r\n')[0]));
    setTimeout(() => sock.destroy(), 5000);
  });
}

test('URL malformed tidak mematikan API (dulu: crash proses)', async (t) => {
  const s = await setup(t, {}, { workers: 0 });
  const status = await rawRequest(s.api.url, 'GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  assert.equal(status, 'HTTP/1.1 400 Bad Request');
  assert.equal((await s.get('/healthz')).status, 200);
  assert.equal(s.api.child.exitCode, null);
});

test('client putus di tengah body: tidak ada job, tercatat warning, API sehat', async (t) => {
  const s = await setup(t, {}, { workers: 0 });
  await rawRequest(s.api.url, 'POST /jobs HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n{"type":"order', {
    closeAfterMs: 50,
  });
  await s.api.waitFor((e) => e.event === 'client_aborted');
  assert.equal((await s.get('/metrics')).body.jobs.total, 0);
  assert.ok(!s.api.events.some((e) => e.event === 'http_unhandled_error'));
});

test('client putus sebelum menerima respons: retry dengan Idempotency-Key tidak menggandakan job', async (t) => {
  const s = await setup(t, {}, { workers: 0 });
  const body = JSON.stringify(report());
  await rawRequest(
    s.api.url,
    `POST /jobs HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nIdempotency-Key: k-putus\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    { closeAfterMs: 0 },
  );
  await waitUntil(async () => (await s.get('/metrics')).body.jobs.total === 1);
  const retry = await s.post(report(), { 'idempotency-key': 'k-putus' });
  assert.equal(retry.status, 200);
  assert.equal((await s.get('/metrics')).body.jobs.total, 1);
});

test('20 request paralel dengan Idempotency-Key sama: tepat satu job', async (t) => {
  const s = await setup(t, {}, { workers: 0 });
  const rs = await Promise.all(Array.from({ length: 20 }, () => s.post(report(), { 'idempotency-key': 'paralel' })));
  assert.equal(rs.filter((r) => r.status === 202).length, 1);
  assert.equal(rs.filter((r) => r.status === 200).length, 19);
  assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
});

test('body lambat dihentikan REQUEST_TIMEOUT_MS; Content-Length berlebih ditolak tanpa membaca body', async (t) => {
  const s = await setup(t, { REQUEST_TIMEOUT_MS: '500' }, { workers: 0 });
  const t0 = Date.now();
  const slow = await rawRequest(s.api.url, 'POST /jobs HTTP/1.1\r\nHost: x\r\nContent-Length: 50\r\n\r\n{');
  assert.equal(slow, 'HTTP/1.1 408 Request Timeout');
  assert.ok(Date.now() - t0 < 3000);
  const big = await rawRequest(s.api.url, 'POST /jobs HTTP/1.1\r\nHost: x\r\nContent-Length: 10000000\r\n\r\n{');
  assert.equal(big, 'HTTP/1.1 413 Payload Too Large');
  await sleep(50);
  assert.equal((await s.get('/healthz')).status, 200);
});

// ---------- Pemeriksa invariant saat sistem hidup ----------

test('npm run check aman saat worker aktif: snapshot konsisten, tanpa violation palsu', async (t) => {
  const s = await setup(t, { POLL_MS: '1', MAX_PENDING: '1000' }, { workers: 2 });
  // delayMs membuat worker masih memproses selama pemeriksaan berjalan.
  for (let i = 0; i < 150; i++) {
    await s.post({ type: 'order_report', payload: { orderCount: 200, seed: i + 1, simulate: { delayMs: 15 } } });
  }
  let checks = 0;
  for (;;) {
    const r = s.consistency();
    checks += 1;
    assert.deepEqual(r.violations, [], `violation palsu pada pemeriksaan ke-${checks}`);
    const m = (await s.get('/metrics')).body;
    if (m.jobs.byStatus.SUCCEEDED === 150) break;
  }
  assert.ok(checks > 3, `pemeriksaan harus berjalan beberapa kali selama proses (${checks})`);
  assertConsistent(s);
});
