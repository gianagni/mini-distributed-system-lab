// usage: node repro.mjs <repoRoot> <scenario>
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { busyInjector } from './inject.mjs';
const [root, scenario] = process.argv.slice(2);
const { openDb } = await import(join(root, 'src/db.js'));
const { createJob, getJob, getEvents } = await import(join(root, 'src/store.js'));
const { processNext } = await import(join(root, 'src/processor.js'));
const { checkConsistency } = await import(join(root, 'src/consistency.js'));
const dir = mkdtempSync(join(tmpdir(), 'busy-'));
const path = join(dir, 'jobs.db');
const real = openDb(path, { busyTimeoutMs: 50 });
const SC = {
  // begin #1 = claimNext, #2 = first state write after the task, #3 = second state write
  'windows-log': { maxAttempts: 3, busy: [2, 3], simulate: undefined },
  'success-charged-as-failure': { maxAttempts: 1, busy: [2], simulate: undefined },
  'task-fail-write-busy': { maxAttempts: 3, busy: [2], simulate: { failTransientTimes: 5 } },
  'busy-never-clears': { maxAttempts: 3, busy: Array.from({ length: 80 }, (_, i) => i + 2), simulate: undefined },
  'non-busy-db-error': { maxAttempts: 3, busy: [], ioerrOnBegin: [2], simulate: undefined },
}[scenario];
const now = Date.now();
createJob(real, { id: '00000000-0000-4000-8000-000000000001', type: 'order_report', payload: { orderCount: 100, seed: 1, ...(SC.simulate ? { simulate: { delayMs: 0, failPermanent: false, hang: false, crashAfterWriteTimes: 0, failTransientTimes: 0, ...SC.simulate } } : {}) }, idempotencyKey: null, requestHash: 'h', maxAttempts: SC.maxAttempts, maxPending: 10, now });
const inj = busyInjector(real, path, SC.busy, SC.ioerrOnBegin ?? []);
const events = [];
const mk = (level) => (event, fields = {}) => events.push({ level, event, ...fields });
const log = { info: mk('info'), warn: mk('warn'), error: mk('error'), fatal: mk('fatal') };
const cfg = { workerId: 'w1', leaseMs: 5000, heartbeatMs: 1000, busyTimeoutMs: 50, jobTimeoutMs: 30000, recovery: true, reportDir: join(dir, 'reports'), allowFaultInjection: true, backoffBaseMs: 10, backoffCapMs: 10, pollMs: 10 };
await processNext({ db: inj.db, cfg, log });
const job = getJob(real, '00000000-0000-4000-8000-000000000001');
const file = join(dir, 'reports', `${job.id}.json`);
console.log(`[${scenario}] node ${process.version} sqlite ${process.versions.sqlite}`);
console.log(`  injected BUSY: ${JSON.stringify(inj.log)}`);
console.log(`  worker logs (warn/error): ${JSON.stringify(events.filter((e) => e.level !== 'info'))}`);
console.log(`  job: status=${job.status} attempts=${job.attempts}/${job.max_attempts} error=${job.error_class}:${job.error_message}`);
console.log(`  events: ${getEvents(real, job.id).map((e) => `${e.event}(${e.attempt}${e.error_class ? ',' + e.error_class : ''})`).join(' ')}`);
console.log(`  report file on disk: ${existsSync(file)}${existsSync(file) ? ` sha256=${createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)}` : ''}`);
const c = checkConsistency(real, join(dir, 'reports'));
console.log(`  consistency: violations=${c.violations.length} warnings=${JSON.stringify(c.warnings.map((w) => w.rule))}`);
inj.db.close();
