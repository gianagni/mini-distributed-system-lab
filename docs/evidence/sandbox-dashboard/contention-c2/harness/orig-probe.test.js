// Replays reliability.test.js "kontensi: 4 worker polling 1 ms, 150 job" exactly, but records
// every POST status and final counts instead of waiting blindly for SUCCEEDED=150.
import { test } from 'node:test';
const ROOT = process.env.REPO;
const { waitUntil } = await import(`${ROOT}/scripts/lib/harness.js`);
const { setup } = await import(`${ROOT}/test/helpers.js`);
test('orig-probe', async (t) => {
  const s = await setup(t, { POLL_MS: '1', MAX_PENDING: '1000' }, { workers: 4 });
  const codes = {};
  const t0 = Date.now();
  for (let i = 0; i < 150; i++) {
    const r = await s.post({ type: 'order_report', payload: { orderCount: 50, seed: i + 1 } });
    codes[r.status] = (codes[r.status] ?? 0) + 1;
  }
  const postMs = Date.now() - t0;
  let settled = true;
  try {
    await waitUntil(async () => { const b = (await s.get('/metrics')).body.jobs.byStatus; return b.PENDING === 0 && b.RUNNING === 0; }, { timeoutMs: 20_000 });
  } catch { settled = false; }
  const m = (await s.get('/metrics')).body;
  const ev = s.workers.flatMap((w) => w.events);
  const n = (f) => ev.filter(f).length;
  const accepted = (codes[202] ?? 0) + (codes[200] ?? 0);
  console.log('PROBE ' + JSON.stringify({
    attempted: 150, postStatus: codes, accepted, rejected: 150 - accepted, postMs, settledIn20s: settled,
    ...m.jobs.byStatus, total: m.jobs.total, dup: m.counters.duplicateSuccessJobs,
    retries: m.counters.retriesScheduled, workerLost: m.counters.workerLost,
    claim_busy: n((e) => e.event === 'claim_busy'), state_write_busy: n((e) => e.event === 'state_write_busy'),
    heartbeat_busy: n((e) => e.event === 'heartbeat_busy'),
    workerErrors: ev.filter((e) => e.level === 'error' || e.level === 'fatal').map((e) => `${e.event}${e.reason ? ':' + e.reason : ''}`),
    apiDbBusy: s.api.events.filter((e) => e.event === 'db_busy').length,
    apiErrors: s.api.events.filter((e) => e.level === 'error').map((e) => e.event),
  }));
});
