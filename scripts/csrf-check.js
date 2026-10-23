// npm run csrf-check  -> buka URL yang dicetak di browser sungguhan (Chrome/Edge/Firefox).
// Pemeriksaan manual AUDIT S-1 tanpa dependency: halaman "penyerang" di situs lain
// (localhost:4801) mencoba membuat job di API (default 127.0.0.1:3000) dengan tiga cara yang
// tersedia untuk halaman web biasa. Hasil dihitung dari GET /metrics di terminal, bukan dari
// browser (browser memang tidak boleh membaca respons lintas origin).
//
// Hanya untuk API lokal milik sendiri. Kalau API masih rentan, alat ini membuat maksimal 2 job dummy.
import { createServer } from 'node:http';

const port = Number(process.env.ATTACKER_PORT || 4801);
const api = (process.env.API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, '');
const apiHost = new URL(api).hostname;
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(apiHost)) {
  console.error(`API_URL harus loopback (dapat ${api}). Alat ini hanya untuk API lokal.`);
  process.exit(1);
}
// Halaman dilayani dari "localhost" supaya beda SITUS dari API di 127.0.0.1 (bukan hanya beda port).
const pageHost = apiHost === 'localhost' ? '127.0.0.1' : 'localhost';

const total = async () => (await (await fetch(`${api}/metrics`)).json()).jobs.total;
let before;
try {
  before = await total();
} catch (err) {
  console.error(`API tidak bisa dihubungi di ${api} (${err.cause?.code ?? err.message}). Jalankan npm run api atau npm run lab dulu.`);
  process.exit(1);
}

const page = `<!doctype html><meta charset="utf-8"><title>csrf-check</title>
<style>body{font:15px system-ui;margin:2rem;max-width:44rem}code{background:#eee;padding:0 4px}</style>
<h1>csrf-check</h1>
<p>Halaman ini (situs <code>${pageHost}:${port}</code>) mencoba membuat job di <code>${api}/jobs</code>.
Hasilnya dicetak di <b>terminal</b> tempat <code>npm run csrf-check</code> berjalan.</p>
<ol id="log"></ol>
<form id="f" method="POST" action="${api}/jobs" enctype="text/plain" target="sink">
<input type="hidden" name='{"type":"x' value='","type":"order_report","payload":{"orderCount":5,"seed":3}}'></form>
<iframe name="sink" title="sink" style="width:100%;height:4rem"></iframe>
<script>
const log = (m) => { const li = document.createElement('li'); li.textContent = m; document.getElementById('log').append(li); };
const body = '{"type":"order_report","payload":{"orderCount":5,"seed":1}}';
(async () => {
  try { await fetch('${api}/jobs', { method: 'POST', mode: 'no-cors', body }); log('A. fetch no-cors text/plain: terkirim (respons opaque, hasil lihat terminal)'); }
  catch (e) { log('A. fetch no-cors text/plain: diblokir browser: ' + e.message); }
  try { await fetch('${api}/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body }); log('B. fetch application/json: TERKIRIM (tidak diharapkan)'); }
  catch (e) { log('B. fetch application/json: diblokir browser (preflight CORS ditolak) - diharapkan'); }
  document.getElementById('f').submit();
  log('C. <form enctype=text/plain> tanpa JavaScript: dikirim (status ada di iframe)');
  setTimeout(() => fetch('/done', { method: 'POST' }).then(() => log('Selesai. Lihat terminal.')), 1500);
})();
</script>`;

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/done') {
    res.end('ok');
    await new Promise((r) => setTimeout(r, 500));
    const created = (await total()) - before;
    console.log('');
    console.log(`Job yang berhasil dibuat halaman lintas situs: ${created}`);
    console.log(created === 0 ? 'LULUS: API menolak semua request lintas situs.' : 'GAGAL: API masih rentan CSRF (lihat AUDIT S-1).');
    server.close();
    process.exitCode = created === 0 ? 0 : 1;
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page);
});
server.listen(port, pageHost, () => {
  console.log(`API target : ${api} (job sekarang: ${before})`);
  console.log(`Buka di browser: http://${pageHost}:${port}/`);
  console.log('Menunggu halaman selesai… (Ctrl+C untuk batal)');
});
