// Playwright TIDAK ada di dependency repo. Set PLAYWRIGHT ke path index.js Playwright yang terpasang global.
const pw = (await import(process.env.PLAYWRIGHT ?? 'playwright')).default;
const b = await pw.chromium.launch(); const p = await b.newPage();
await p.goto(process.argv[2]); await p.waitForFunction(() => document.getElementById('log').textContent.includes('Selesai'), null, { timeout: 15000 });
console.log('page log:', (await p.locator('#log').innerText()).replace(/\n/g, ' | ')); await b.close();
