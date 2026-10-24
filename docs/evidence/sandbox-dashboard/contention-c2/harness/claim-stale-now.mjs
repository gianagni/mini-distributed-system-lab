// Does the lease granted by claimNext shrink by the time spent waiting for the write lock?
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
const ROOT = process.argv[2];
const { openDb } = await import(`${ROOT}/src/db.js`);
const { createJob, claimNext } = await import(`${ROOT}/src/store.js`);
const path = join(mkdtempSync(join(tmpdir(), 'stale-')), 'jobs.db');
const db = openDb(path, { busyTimeoutMs: 2000 });
createJob(db, { id: '00000000-0000-4000-8000-0000000000aa', type: 'order_report', payload: {}, idempotencyKey: null, requestHash: 'h', maxAttempts: 3, maxPending: 10, now: Date.now() });
// Another thread holds the write lock for 250 ms, like a slow concurrent commit.
const holder = new Worker(`const { DatabaseSync } = require('node:sqlite'); const { parentPort } = require('node:worker_threads'); const d = new DatabaseSync(${JSON.stringify(path)});
  d.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked'); const end = Date.now() + 250; while (Date.now() < end); d.exec('ROLLBACK'); d.close();`, { eval: true });
await new Promise((r) => holder.once('message', r)); // lock is really held now
const LEASE = 600;
const t0 = Date.now();
const job = claimNext(db, { workerId: 'w1', leaseMs: LEASE, recovery: true, now: process.argv[3] === 'fn' ? Date.now : Date.now() });
const after = Date.now();
console.log(`[${process.argv[3]}] claim took ${after - t0} ms; lease remaining right after claim returned: ${job.lease_expires_at - after} ms (configured ${LEASE} ms)`);
await new Promise((r) => holder.on('exit', r));
