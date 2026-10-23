// Regression test AUDIT S-1: CSRF lintas situs ke POST /jobs lewat "simple request" browser.
// Test lama tidak diubah. Perilaku browser dimodelkan dengan request yang persis dikirim
// Chromium (direproduksi dengan browser sungguhan, lihat AUDIT S-1).
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import { describe, test } from 'node:test';
import { startDashboard } from '../scripts/lib/harness.js';
import { loadConfig, loadDashboardConfig } from '../src/config.js';
import { createHostGuard, parseAllowedHosts } from '../src/hostguard.js';
import { isJsonContentType } from '../src/http.js';
import { report, setup } from './helpers.js';

const BODY = JSON.stringify({ type: 'order_report', payload: { orderCount: 5, seed: 1 } });

describe('isJsonContentType', () => {
  test('menerima application/json dengan parameter, menolak tipe lain dan tipe mirip', () => {
    for (const ok of ['application/json', 'application/json; charset=utf-8', 'Application/JSON', 'application/json;charset=UTF-8', ' application/json ']) {
      assert.equal(isJsonContentType(ok), true, ok);
    }
    for (const bad of [
      undefined,
      '',
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/jsonp',
      'application/json-seq',
      'application/vnd.api+json',
      'text/plain; application/json',
      'text/json',
    ]) {
      assert.equal(isJsonContentType(bad), false, String(bad));
    }
  });
});

describe('POST /jobs: Content-Type (proses API sungguhan)', () => {
  const raw = (s, headers, body = BODY) => fetch(`${s.api.url}/jobs`, { method: 'POST', headers, body });
  const total = async (s) => (await s.get('/metrics')).body.jobs.total;

  test('request sah tetap diterima: application/json dengan/ tanpa charset, huruf besar', async (t) => {
    const s = await setup(t, {}, { workers: 0 });
    assert.equal((await s.post(report())).status, 202);
    assert.equal((await raw(s, { 'content-type': 'application/json; charset=utf-8' })).status, 202);
    assert.equal((await raw(s, { 'content-type': 'Application/JSON' })).status, 202);
    assert.equal(await total(s), 3);
  });

  test('Content-Type tidak didukung: 415, tidak ada job, body error konsisten', async (t) => {
    const s = await setup(t, {}, { workers: 0 });
    for (const ct of [
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=----x',
      'application/jsonp',
      'text/plain; application/json',
    ]) {
      const r = await raw(s, { 'content-type': ct });
      assert.equal(r.status, 415, ct);
      assert.deepEqual(await r.json(), {
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type harus application/json' },
      });
    }
    // Tanpa Content-Type sama sekali (fetch memberi text/plain untuk body string; Blob kosong tidak).
    const none = await raw(s, {}, new Blob([BODY]));
    assert.equal(none.status, 415);
    assert.equal(await total(s), 0);
  });

  test('perilaku browser lintas situs: simple request ditolak, preflight tidak pernah disetujui', async (t) => {
    const s = await setup(t, {}, { workers: 0 });
    const evil = { origin: 'http://localhost:4801', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' };

    // 1) fetch(..., {mode:'no-cors'}) dengan body string: Chromium mengirim text/plain;charset=UTF-8.
    assert.equal((await raw(s, { ...evil, 'content-type': 'text/plain;charset=UTF-8' })).status, 415);

    // 2) <form enctype="text/plain"> tanpa JavaScript, trik duplicate key untuk menyerap "=".
    //    Body ini persis yang dikirim Chromium saat reproduksi; JSON-nya sendiri valid.
    const formBody = '{"type":"x=","type":"order_report","payload":{"orderCount":5,"seed":3}}\r\n';
    const formHeaders = { ...evil, 'sec-fetch-mode': 'navigate', 'content-type': 'text/plain' };
    assert.equal((await raw(s, formHeaders, formBody)).status, 415);
    // Dampak terburuk sebelum perbaikan: di mode lab (ALLOW_FAULT_INJECTION=1, aktif di env test),
    // situs lain bisa menyuruh worker bunuh diri atau hang. Sekarang ditolak sebelum validasi payload.
    const crash = JSON.stringify({ type: 'order_report', payload: { simulate: { crashAfterWriteTimes: 10 } } });
    assert.equal((await raw(s, { ...evil, 'content-type': 'text/plain;charset=UTF-8' }, crash)).status, 415);
    // Bukti bahwa yang menghentikan serangan adalah gerbang Content-Type, bukan parsing body.
    assert.equal((await raw(s, { 'content-type': 'application/json' }, formBody)).status, 202);
    assert.equal(await total(s), 1);

    // 3) fetch dengan application/json lintas situs memicu preflight. Browser hanya mengirim POST
    //    kalau preflight 2xx DAN mengizinkan origin. API tidak mengirim header CORS apa pun.
    const pre = await fetch(`${s.api.url}/jobs`, {
      method: 'OPTIONS',
      headers: { origin: evil.origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    assert.notEqual(Math.floor(pre.status / 100), 2, 'preflight tidak boleh sukses');
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
    assert.equal(pre.headers.get('access-control-allow-headers'), null);
    // Respons POST yang sah pun tidak membuka akses baca lintas origin.
    const ok = await s.post(report(undefined, 7));
    assert.equal(ok.headers.get('access-control-allow-origin'), null);
    assert.equal(await total(s), 2);
  });

  test('urutan pemeriksaan: 413 dan validasi key tetap lebih dulu; 415 tidak memakai Idempotency-Key', async (t) => {
    const s = await setup(t, {}, { workers: 0 });
    assert.equal((await raw(s, { 'content-type': 'text/plain' }, 'x'.repeat(17 * 1024))).status, 413);
    assert.equal((await raw(s, { 'content-type': 'text/plain', 'idempotency-key': 'spasi tidak boleh' })).status, 400);

    // Request yang ditolak 415 tidak boleh "mengunci" key: request sah berikutnya tetap job baru (202, bukan 200).
    assert.equal((await raw(s, { 'content-type': 'text/plain', 'idempotency-key': 'k-415' })).status, 415);
    const legit = await raw(s, { 'content-type': 'application/json', 'idempotency-key': 'k-415' });
    assert.equal(legit.status, 202);
    assert.equal(await total(s), 1);
  });
});

// ---------------------------------------------------------------------------------------------
// AUDIT S-2: DNS rebinding (allowlist Host) dan Origin untuk request browser yang mengubah state.
// ---------------------------------------------------------------------------------------------

/** Request dengan header Host bebas (fetch() membuang header Host). */
function hostRequest(port, { method = 'GET', path = '/healthz', host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host, ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // bukan JSON
        }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Forwarder TCP seperti `ssh -L <listen>:127.0.0.1:<target>`: byte diteruskan apa adanya. */
async function tcpForward(t) {
  const sockets = new Set();
  const fwd = { target: null };
  const srv = net.createServer((c) => {
    const u = net.connect(fwd.target, '127.0.0.1');
    for (const x of [c, u]) {
      sockets.add(x);
      x.on('close', () => sockets.delete(x));
      x.on('error', () => {});
    }
    c.pipe(u);
    u.pipe(c);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => {
    for (const x of sockets) x.destroy();
    srv.close();
  });
  fwd.port = srv.address().port;
  return fwd;
}

describe('hostguard (unit)', () => {
  test('parseAllowedHosts: nama[:port], tolak wildcard, skema, path, userinfo, 0.0.0.0', () => {
    assert.deepEqual(parseAllowedHosts(undefined), []);
    assert.deepEqual(parseAllowedHosts(' Lab.Local:8100 , 10.0.0.5,[::1]:9000'), [
      { name: 'lab.local', port: 8100 },
      { name: '10.0.0.5', port: null },
      { name: '[::1]', port: 9000 },
    ]);
    for (const bad of ['*', '*.example.com', 'http://lab', 'lab/x', 'user@lab', '0.0.0.0', '[::]', 'lab:0', 'lab:70000', 'a,,b', 'lab.', '-lab']) {
      assert.throws(() => parseAllowedHosts(bad), /ALLOWED_HOSTS/, bad);
    }
    assert.throws(() => loadConfig({ ALLOWED_HOSTS: '*' }), /ALLOWED_HOSTS/);
    assert.throws(() => loadDashboardConfig({ ALLOWED_HOSTS: '*' }), /ALLOWED_HOSTS/);
  });

  test('allowlist default: loopback + port yang didengar, persis; tanpa wildcard', () => {
    const g = createHostGuard({ bindHost: '127.0.0.1' });
    assert.deepEqual([...g.allowed(3000)].sort(), ['127.0.0.1:3000', '[::1]:3000', 'localhost:3000']);
    for (const ok of ['127.0.0.1:3000', 'localhost:3000', 'LOCALHOST:3000', '[::1]:3000']) assert.equal(g.hostOk(ok, 3000), true, ok);
    for (const bad of [undefined, '', 'x', 'attacker.test:3000', '127.0.0.1', '127.0.0.1:3001', 'localhost.:3000', '127.0.0.2:3000', '0.0.0.0:3000', 'localhost:3000.evil.test', 'evil.test#@localhost:3000']) {
      assert.equal(g.hostOk(bad, 3000), false, String(bad));
    }
    // Port 80: browser tidak menulis port.
    assert.equal(createHostGuard({ bindHost: '127.0.0.1' }).hostOk('localhost', 80), true);
  });

  test('bind spesifik ikut diizinkan, bind wildcard tidak; ALLOWED_HOSTS tanpa port memakai port yang didengar', () => {
    assert.equal(createHostGuard({ bindHost: '10.0.0.5' }).hostOk('10.0.0.5:3000', 3000), true);
    assert.equal(createHostGuard({ bindHost: '0.0.0.0' }).hostOk('0.0.0.0:3000', 3000), false);
    assert.equal(createHostGuard({ bindHost: '::' }).hostOk('[::]:3000', 3000), false);
    assert.equal(createHostGuard({ bindHost: '::1' }).hostOk('[::1]:3000', 3000), true);
    const g = createHostGuard({ bindHost: '0.0.0.0', allowedHosts: parseAllowedHosts('lab.local,127.0.0.1:8100') });
    assert.equal(g.hostOk('lab.local:3000', 3000), true);
    assert.equal(g.hostOk('lab.local:8100', 3000), false);
    assert.equal(g.hostOk('127.0.0.1:8100', 3000), true);
    assert.equal(g.hostOk('sub.lab.local:3000', 3000), false);
  });

  test('sameOriginOk: header browser harus same-origin; tanpa header (CLI) diterima', () => {
    const g = createHostGuard({ bindHost: '127.0.0.1' });
    const req = (headers) => ({ headers: { host: '127.0.0.1:3000', ...headers } });
    assert.equal(g.sameOriginOk(req({})), true, 'curl / fetch Node');
    assert.equal(g.sameOriginOk(req({ 'sec-fetch-mode': 'cors' })), true, 'fetch Node mengirim sec-fetch-mode saja');
    assert.equal(g.sameOriginOk(req({ origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin' })), true);
    assert.equal(g.sameOriginOk(req({ 'sec-fetch-site': 'none' })), true, 'navigasi langsung oleh user');
    for (const h of [
      { origin: 'http://localhost:4801' },
      { origin: 'http://127.0.0.1:3001' },
      { origin: 'https://127.0.0.1:3000' },
      { origin: 'null' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ]) {
      assert.equal(g.sameOriginOk(req(h)), false, JSON.stringify(h));
    }
  });
});

describe('DNS rebinding dan Origin (proses API + dashboard sungguhan)', () => {
  test('API: Host tidak dipercaya ditolak di semua route (baca dan tulis), tanpa job', async (t) => {
    const s = await setup(t, {}, { workers: 0 });
    const port = Number(new URL(s.api.url).port);
    const json = { 'content-type': 'application/json' };
    for (const host of ['attacker.test', `attacker.test:${port}`, 'x', `127.0.0.1:${port + 1}`, `localhost.:${port}`]) {
      for (const path of ['/healthz', '/metrics', '/jobs/00000000-0000-4000-8000-000000000000']) {
        const r = await hostRequest(port, { path, host });
        assert.equal(r.status, 403, `${host} ${path}`);
        assert.equal(r.body.error.code, 'BAD_HOST');
      }
      assert.equal((await hostRequest(port, { method: 'POST', path: '/jobs', host, headers: json, body: BODY })).status, 403, host);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LocalHost:${port}`, `[::1]:${port}`]) {
      assert.equal((await hostRequest(port, { host })).status, 200, host);
    }
    assert.equal(await (async () => (await s.get('/metrics')).body.jobs.total)(), 0);
    assert.ok(s.api.events.some((e) => e.event === 'host_rejected' && e.host === 'attacker.test'));
  });

  test('perubahan disengaja pada perilaku lama: request mentah dengan "Host: x" sekarang 403', async (t) => {
    const s = await setup(t, {}, { workers: 0 });
    const port = Number(new URL(s.api.url).port);
    const line = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write(`POST /jobs HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${BODY.length}\r\n\r\n${BODY}`));
      let out = '';
      sock.on('data', (d) => (out += d));
      sock.on('close', () => resolve(out.split('\r\n')[0]));
      sock.on('error', () => {});
    });
    assert.equal(line, 'HTTP/1.1 403 Forbidden');
    assert.equal((await s.get('/metrics')).body.jobs.total, 0);
  });

  test('API: Origin/Sec-Fetch-Site browser lintas origin ditolak walau JSON; CLI dan same-origin tetap jalan', async (t) => {
    const s = await setup(t, {}, { workers: 0 });
    const post = (headers) => fetch(`${s.api.url}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: BODY });
    for (const h of [{ origin: 'http://localhost:4801' }, { origin: 'null' }, { origin: `http://127.0.0.1:1` }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
      const r = await post(h);
      assert.equal(r.status, 403, JSON.stringify(h));
      assert.equal((await r.json()).error.code, 'CROSS_ORIGIN');
    }
    assert.equal((await s.get('/metrics')).body.jobs.total, 0);
    assert.equal((await post({})).status, 202, 'CLI / fetch Node tanpa Origin');
    assert.equal((await post({ origin: s.api.url, 'sec-fetch-site': 'same-origin' })).status, 202, 'same-origin');
    // GET tetap tanpa pemeriksaan Origin: tidak mengubah state, dan respons tidak bisa dibaca lintas origin.
    assert.equal((await fetch(`${s.api.url}/metrics`, { headers: { origin: 'http://localhost:4801' } })).status, 200);
  });

  test('SSH port forward (forwarder TCP): port sama langsung jalan; port lain butuh ALLOWED_HOSTS', async (t) => {
    // Port lokal berbeda (mis. ssh -L 8100:127.0.0.1:3000): Host = 127.0.0.1:<port lokal>.
    const fwdDefault = await tcpForward(t);
    const a = await setup(t, {}, { workers: 0 });
    fwdDefault.target = Number(new URL(a.api.url).port);
    const viaDefault = await fetch(`http://127.0.0.1:${fwdDefault.port}/healthz`);
    assert.equal(viaDefault.status, 403, 'port forward berbeda tanpa ALLOWED_HOSTS harus ditolak');

    const fwd = await tcpForward(t);
    const b = await setup(t, { ALLOWED_HOSTS: `127.0.0.1:${fwd.port},localhost:${fwd.port}` }, { workers: 1 });
    fwd.target = Number(new URL(b.api.url).port);
    assert.equal((await fetch(`http://127.0.0.1:${fwd.port}/healthz`)).status, 200);
    assert.equal((await fetch(`http://localhost:${fwd.port}/healthz`)).status, 200);
    // Browser di laptop yang membuka API lewat tunnel: Origin = origin tunnel, harus diterima.
    const r = await fetch(`http://127.0.0.1:${fwd.port}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${fwd.port}`, 'sec-fetch-site': 'same-origin' },
      body: BODY,
    });
    assert.equal(r.status, 202);
    const done = await b.waitStatus((await r.json()).id, ['SUCCEEDED', 'FAILED']);
    assert.equal(done.status, 'SUCCEEDED');
    // Allowlist tetap ketat: nama lain di port tunnel ditolak.
    assert.equal((await hostRequest(fwd.port, { host: `attacker.test:${fwd.port}` })).status, 403);
  });

  test('dashboard: ALLOW_REMOTE=1 tidak lagi mematikan pemeriksaan Host; forward dashboard dengan ALLOWED_HOSTS', async (t) => {
    const s = await setup(t, {}, { workers: 0 });
    const remote = s.track(await startDashboard({ ...s.env, API_URL: s.api.url, ALLOW_REMOTE: '1' }));
    const rport = Number(new URL(remote.url).port);
    assert.equal((await hostRequest(rport, { path: '/api/overview', host: `attacker.test:${rport}` })).status, 403);
    assert.equal((await hostRequest(rport, { path: '/api/overview', host: `127.0.0.1:${rport}` })).status, 200);

    const fwd = await tcpForward(t);
    const dash = s.track(await startDashboard({ ...s.env, API_URL: s.api.url, ALLOWED_HOSTS: `127.0.0.1:${fwd.port}` }));
    fwd.target = Number(new URL(dash.url).port);
    const page = await fetch(`http://127.0.0.1:${fwd.port}/`);
    assert.equal(page.status, 200, 'UI terbuka lewat tunnel');
    const create = await fetch(`http://127.0.0.1:${fwd.port}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${fwd.port}`, 'sec-fetch-site': 'same-origin' },
      body: BODY,
    });
    assert.equal(create.status, 202, 'buat job dari UI lewat tunnel -> proxy -> API');
    assert.equal((await fetch(`http://localhost:${fwd.port}/api/overview`)).status, 403, 'localhost:<fwd> tidak ada di ALLOWED_HOSTS');
    // Content-Type mirip JSON ditolak dengan aturan yang sama dengan API.
    const seq = await fetch(`${dash.url}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json-seq' }, body: BODY });
    assert.equal(seq.status, 415);
  });
});
