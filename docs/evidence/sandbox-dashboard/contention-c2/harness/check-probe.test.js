// Replays reliability.test.js "npm run check aman saat worker aktif" (same env, 2 workers, delayMs 15)
// recording every POST status; bounded wait instead of for(;;).
import { test } from 'node:test';
const ROOT = process.env.REPO;
const { waitUntil } = await import(`${ROOT}/scripts/lib/harness.js`);
const { setup } = await import(`${ROOT}/test/helpers.js`);
test('check-probe', async (t) => {
  const s = await setup(t, { POLL_MS: '1', MAX_PENDING: '1000' }, { workers: 2 });
  const codes = {};
  for (let i = 0; i < 150; i++) {
    const r = await s.post({ type: 'order_report', payload: { orderCount: 200, seed: i + 1, simulate: { delayMs: 15 } } });
    codes[r.status] = (codes[r.status] ?? 0) + 1;
  }
  // Exactly the original loop (consistency() + GET /metrics), but bounded to 60 s.
  let checks = 0, violations = 0, stuck = false; const deadline = Date.now() + 60_000;
  for (;;) {
    const r = s.consistency(); checks += 1; violations += r.violations.length;
    const b = (await s.get('/metrics')).body.jobs.byStatus;
    if (b.SUCCEEDED === 150) break;
    if (Date.now() > deadline) { stuck = true; break; }
  }
  const settled = !stuck;
  const m = (await s.get('/metrics')).body;
  console.log('PROBE ' + JSON.stringify({ postStatus: codes, accepted: (codes[202] ?? 0) + (codes[200] ?? 0), ...m.jobs.byStatus, total: m.jobs.total, settled, apiDbBusy: s.api.events.filter((e) => e.event === 'db_busy').length, reachable150: m.jobs.total === 150, checks, violations, failedByErrorClass: m.failedByErrorClass, workerLost: m.counters.workerLost, errors: s.workers.flatMap((w) => w.events.filter((e) => e.level === 'error')).map((e) => e.event + (e.reason ? ':' + e.reason : '')) }));
});
