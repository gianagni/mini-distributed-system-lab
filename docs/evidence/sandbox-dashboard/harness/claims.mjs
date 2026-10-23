// Playwright TIDAK ada di dependency repo. Set PLAYWRIGHT ke path index.js Playwright yang terpasang global.
const pw = (await import(process.env.PLAYWRIGHT ?? 'playwright')).default;
import { execSync, spawn } from 'node:child_process';
const [labPid, S] = process.argv.slice(2);
const b = await pw.chromium.launch();
// iframe claim (csrf-check page)
const tool = spawn(process.execPath, ['scripts/csrf-check.js'], { env: { ...process.env, PORT: '3921' } });
await new Promise((r) => setTimeout(r, 600));
const c = await b.newPage(); await c.goto('http://localhost:4801/');
await c.waitForFunction(() => document.getElementById('log').textContent.includes('Selesai'), null, { timeout: 15000 });
const frameText = await c.frame({ name: 'sink' }).locator('body').innerText();
console.log('iframe:', frameText.slice(0, 120));
await new Promise((r) => tool.on('exit', r));
// polling off + stale banner
const p = await b.newPage(); await p.goto('http://127.0.0.1:3922/#/overview'); await p.waitForSelector('.tiles');
await p.selectOption('#poll', '0'); console.log('poll off ->', await p.locator('#freshness').innerText());
await p.selectOption('#poll', '1000'); await p.waitForTimeout(1200); console.log('poll 1s ->', await p.locator('#freshness').innerText());
process.kill(Number(labPid), 'SIGINT'); await p.waitForTimeout(4000);
console.log('lab stopped ->', await p.locator('#freshness').innerText());
console.log('banner ->', (await p.locator('#banner').isVisible()) ? await p.locator('#banner').innerText() : '(hidden)');
console.log('old data still shown:', await p.locator('.tile-value').first().innerText());
await p.screenshot({ path: `${S}/shots/20-stale-after-lab-stop.png` });
await b.close();
