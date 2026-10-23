// Browser through an SSH-like TCP forwarder (byte pipe) on a different local port.
// Playwright TIDAK ada di dependency repo. Set PLAYWRIGHT ke path index.js Playwright yang terpasang global.
const pw = (await import(process.env.PLAYWRIGHT ?? 'playwright')).default;
import net from 'node:net';
const [listenPort, targetPort, label, shot] = process.argv.slice(2);
const socks = new Set();
const srv = net.createServer((c) => { const u = net.connect(Number(targetPort), '127.0.0.1'); for (const x of [c, u]) { socks.add(x); x.on('error', () => {}); x.on('close', () => socks.delete(x)); } c.pipe(u); u.pipe(c); });
await new Promise((r) => srv.listen(Number(listenPort), '127.0.0.1', r));
const b = await pw.chromium.launch();
const p = await b.newPage();
const errors = []; p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const base = `http://127.0.0.1:${listenPort}/`;
const res = await p.goto(base);
console.log(`[${label}] GET ${base} -> HTTP ${res.status()}`);
if (res.status() === 200) {
  await p.waitForSelector('.tiles');
  await p.goto(base + '#/new'); await p.waitForSelector('#job-form');
  await p.click('[data-preset="transient2"]'); await p.click('#submit');
  await p.waitForURL(/#\/jobs\/[0-9a-f-]{36}\?created=202/);
  await p.waitForFunction(() => document.querySelector('.badges')?.textContent.includes('SUCCEEDED'), null, { timeout: 15000 });
  console.log(`[${label}] job via tunnel: ${(await p.locator('.badges').innerText()).split('\n')[0]}, attempts ${(await p.locator('.stat-value').first().innerText())}`);
  await p.screenshot({ path: shot, fullPage: false });
} else {
  console.log(`[${label}] body: ${(await p.locator('body').innerText()).slice(0, 120)}`);
}
console.log(`[${label}] console errors: ${errors.length ? errors.join(' | ') : 'none'}`);
await b.close(); for (const x of socks) x.destroy(); srv.close();
