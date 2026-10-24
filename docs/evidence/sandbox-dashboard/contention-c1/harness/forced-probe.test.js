import { test } from 'node:test';
import { waitUntil } from '../scripts/lib/harness.js';
import { setup } from './helpers.js';
test('forced contention probe', async (t) => {
  const s = await setup(t, { POLL_MS: '1', MAX_PENDING: '1000' }, { workers: 4, workerEnv: { BUSY_TIMEOUT_MS: '1' } });
  const codes = {};
  for (let i = 0; i < 150; i++) { const r = await s.post({ type: 'order_report', payload: { orderCount: 50, seed: i + 1 } }); codes[r.status] = (codes[r.status] ?? 0) + 1; }
  console.log('API ' + JSON.stringify(codes));
  await waitUntil(async () => { const b = (await s.get('/metrics')).body.jobs.byStatus; return b.SUCCEEDED + b.FAILED === 150; }, { timeoutMs: 60_000 });
  const m = (await s.get('/metrics')).body;
  const ev = s.workers.flatMap((w) => w.events);
  const count = (f) => ev.filter(f).length;
  const c = s.consistency();
  console.log('PROBE ' + JSON.stringify({ succeeded: m.jobs.byStatus.SUCCEEDED, failed: m.jobs.byStatus.FAILED, failedByErrorClass: m.failedByErrorClass, retries: m.counters.retriesScheduled, workerLost: m.counters.workerLost, dup: m.counters.duplicateSuccessJobs, violations: c.violations.length, claim_busy: count((e) => e.event === 'claim_busy'), state_write_busy: count((e) => e.event === 'state_write_busy'), job_state_write_failed: count((e) => e.event === 'job_state_write_failed'), internalLocked: count((e) => e.errorClass === 'INTERNAL' && /locked/.test(e.message ?? '')), heartbeat_err: count((e) => /heartbeat|lease_at_risk/.test(e.event) && e.level === 'error'), errors: count((e) => e.level === 'error' || e.level === 'fatal') }));
});
