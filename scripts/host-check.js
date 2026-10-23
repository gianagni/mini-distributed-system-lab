// npm run host-check   (jalankan saat npm run lab / api + dashboard hidup)
// Pemeriksaan AUDIT S-2 tanpa dependency dan tanpa DNS sungguhan: mengirim header Host dan Origin
// yang tidak dipercaya ke API dan dashboard lokal, lalu memastikan semuanya ditolak dan akses sah
// tetap jalan. Lintas platform (tidak bergantung pada quoting curl di bash/PowerShell).
// Env: PORT / API_URL dan DASHBOARD_PORT / DASHBOARD_URL, sama dengan proses yang diperiksa.
import { request } from 'node:http';

const api = new URL(process.env.API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`);
const dash = new URL(process.env.DASHBOARD_URL || `http://127.0.0.1:${process.env.DASHBOARD_PORT || 3100}`);
for (const u of [api, dash]) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    console.error(`Hanya untuk server loopback, dapat ${u.origin}`);
    process.exit(1);
  }
}

function send(target, { method = 'GET', path, host, headers = {}, body }) {
  return new Promise((resolve) => {
    const req = request(
      { host: target.hostname.replace(/^\[|\]$/g, ''), port: target.port, method, path, headers: { host, ...headers } },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let code = null;
          try {
            code = JSON.parse(text)?.error?.code ?? null;
          } catch {
            // bukan JSON
          }
          resolve({ status: res.statusCode, code });
        });
      },
    );
    req.on('error', (err) => resolve({ status: null, code: err.code }));
    req.end(body);
  });
}

const BODY = JSON.stringify({ type: 'order_report', payload: { orderCount: 5, seed: 1 } });
const json = { 'content-type': 'application/json' };
const evilOrigin = { origin: 'http://attacker.test', 'sec-fetch-site': 'cross-site' };

const targets = [
  { name: 'API', url: api, read: '/metrics', write: '/jobs' },
  { name: 'Dashboard', url: dash, read: '/api/overview', write: '/api/jobs' },
];
const results = [];
for (const t of targets) {
  const own = t.url.host;
  const probe = await send(t.url, { path: t.read, host: own });
  if (probe.status === null) {
    console.log(`${t.name}: tidak bisa dihubungi di ${t.url.origin} (${probe.code}), dilewati.`);
    continue;
  }
  const cases = [
    ['akses sah (Host asli)', { path: t.read, host: own }, 200],
    ['akses sah lewat localhost', { path: t.read, host: `localhost:${t.url.port}` }, 200],
    ['rebinding: baca dengan Host penyerang', { path: t.read, host: `attacker.test:${t.url.port}` }, 403],
    ['rebinding: tulis dengan Host penyerang', { method: 'POST', path: t.write, host: `attacker.test:${t.url.port}`, headers: json, body: BODY }, 403],
    ['Host tanpa port', { path: t.read, host: t.url.hostname }, 403],
    ['Host port lain', { path: t.read, host: `${t.url.hostname}:${Number(t.url.port) + 1}` }, 403],
    ['tulis dari Origin lain (JSON)', { method: 'POST', path: t.write, host: own, headers: { ...json, ...evilOrigin }, body: BODY }, 403],
  ];
  for (const [label, req, expected] of cases) {
    const r = await send(t.url, req);
    results.push({ target: t.name, label, expected, got: r.status, code: r.code, ok: r.status === expected });
  }
}

for (const r of results) {
  console.log(`${r.ok ? 'LULUS' : 'GAGAL'}  ${r.target.padEnd(9)} ${r.label.padEnd(40)} harap ${r.expected}, dapat ${r.got}${r.code ? ` ${r.code}` : ''}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(results.length === 0 ? 'Tidak ada server yang diperiksa.' : failed === 0 ? 'Semua pemeriksaan Host/Origin lulus.' : `${failed} pemeriksaan gagal.`);
process.exitCode = results.length === 0 || failed > 0 ? 1 : 0;
