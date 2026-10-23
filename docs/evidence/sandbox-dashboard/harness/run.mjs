// Playwright TIDAK ada di dependency repo. Set PLAYWRIGHT ke path index.js Playwright yang terpasang global.
const pw = (await import(process.env.PLAYWRIGHT ?? 'playwright')).default; 
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
const BASE = 'http://127.0.0.1:3922/';
const SHOTS = process.argv[2];
const errors = [];
const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

function workerPid(id) {
  for (const p of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      const cmd = readFileSync(`/proc/${p}/cmdline`, 'utf8');
      if (!cmd.includes('src/worker.js')) continue;
      const env = readFileSync(`/proc/${p}/environ`, 'utf8').split('\0');
      if (env.includes(`WORKER_ID=${id}`)) return Number(p);
    } catch {}
  }
  return null;
}
async function createVia(preset) {
  await page.goto(BASE + '#/overview');
  await page.goto(BASE + '#/new');
  await page.waitForSelector('#job-form');
  if (preset) await page.click(`[data-preset="${preset}"]`);
  await page.click('#submit');
  await page.waitForURL(/#\/jobs\/[0-9a-f-]{36}/);
  const id = page.url().match(/jobs\/([0-9a-f-]{36})/)[1];
  log('created', preset, id);
  return id;
}
async function waitText(text, timeout = 20000) {
  await page.waitForFunction((t) => document.querySelector('.badges')?.textContent.includes(t), text, { timeout });
}

await page.goto(BASE);
await page.waitForSelector('.tiles');
await page.screenshot({ path: `${SHOTS}/01-overview-empty.png`, fullPage: true });

// 1. transient 2x -> succeed attempt 3
let id = await createVia('transient2');
await page.waitForSelector('.notice.good');
await page.screenshot({ path: `${SHOTS}/02-detail-just-created.png`, fullPage: true });
await waitText('SUCCEEDED');
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/03-detail-transient-succeeded.png`, fullPage: true });
log('attempt rows', await page.locator('.tl-row').count());

// 2. slow 5s, then kill -9 lease owner -> reclaim
id = await createVia('slow');
await waitText('RUNNING', 5000);
await page.waitForFunction(() => document.querySelector('.tl-label code')?.textContent.match(/^w\d$/));
const owner = (await page.locator('.tl-label code').first().textContent()).trim();
const pid = workerPid(owner);
log('kill -9', owner, pid);
await page.waitForTimeout(1500);
execSync(`kill -9 ${pid}`);
await page.goto(BASE + '#/overview');
await page.waitForTimeout(5500);
await page.screenshot({ path: `${SHOTS}/04-overview-lease-expired.png`, fullPage: true });
await page.goto(BASE + `#/jobs/${id}`);
await waitText('SUCCEEDED', 20000);
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/05-detail-worker-lost-reclaimed.png`, fullPage: true });

// 3. permanent, transient forever
await createVia('permanent');
await waitText('FAILED');
await page.screenshot({ path: `${SHOTS}/06-detail-permanent.png`, fullPage: true });
await createVia('transientAll');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${SHOTS}/07-detail-pending-backoff.png`, fullPage: true });
await waitText('FAILED', 30000);
await page.screenshot({ path: `${SHOTS}/08-detail-transient-exhausted.png`, fullPage: true });

// 4. idempotency replay: same key twice
await page.goto(BASE + '#/new');
await page.fill('input[name=key]', 'demo-key-1');
await page.click('#submit');
await page.waitForURL(/created=202/);
await page.goto(BASE + '#/new');
await page.fill('input[name=key]', 'demo-key-1');
await page.click('#submit');
await page.waitForURL(/created=200/);
await page.screenshot({ path: `${SHOTS}/09-detail-replay-200.png`, fullPage: true });
// conflict 409: same key different orderCount
await page.goto(BASE + '#/new');
await page.fill('input[name=key]', 'demo-key-1');
await page.fill('input[name=orderCount]', '999');
await page.click('#submit');
await page.waitForSelector('#result .badge');
await page.screenshot({ path: `${SHOTS}/10-create-409.png`, fullPage: true });
log('409 result:', (await page.locator('#result').textContent()).replace(/\s+/g, ' ').slice(0, 160));

// 5. crash after write (worker SIGKILLs itself; lab restarts it; lease reclaim)
id = await createVia('crash');
await waitText('SUCCEEDED', 25000);
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/15-detail-crash-after-write.png`, fullPage: true });
log('crash job attempts:', (await page.locator('.stat-value').first().textContent()).trim());
// burst 20 jobs (fresh form)
await page.goto(BASE + '#/overview');
await page.goto(BASE + '#/new');
await page.fill('input[name=count]', '20');
await page.click('#submit');
await page.waitForSelector('#result .badge');
log('burst:', (await page.locator('#result p').first().textContent()).trim());
await page.goto(BASE + '#/jobs');
await page.waitForSelector('table.jobs');
await page.screenshot({ path: `${SHOTS}/11-jobs-list.png`, fullPage: true });
await page.goto(BASE + '#/jobs?status=FAILED');
await page.waitForSelector('table.jobs');
log('FAILED rows', await page.locator('table.jobs tbody tr').count());
await page.waitForTimeout(3000);
await page.goto(BASE + '#/overview');
await page.waitForSelector('.tiles');
await page.waitForTimeout(500);
await page.screenshot({ path: `${SHOTS}/12-overview-after.png`, fullPage: true });

// 6. mobile + dark
const m = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
m.on('console', (x) => { if (x.type() === 'error') errors.push(`mobile ${x.text()}`); });
await m.goto(BASE + `#/jobs/${id}`);
await m.waitForSelector('.timeline');
await m.screenshot({ path: `${SHOTS}/13-mobile-dark-detail.png`, fullPage: true });
const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
log('mobile horizontal overflow px:', overflow);
await m.goto(BASE + '#/overview');
await m.waitForSelector('.tiles');
await m.screenshot({ path: `${SHOTS}/14-mobile-dark-overview.png`, fullPage: true });
log('mobile overview overflow px:', await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth));

console.log('CONSOLE ERRORS:', errors.length ? errors : 'none');
await browser.close();
