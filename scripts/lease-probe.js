// npm run lease-probe -- [--runs 10] [--out dir] [--jobs 150] [--env KEY=VAL ...]
// Diagnosis lease_at_risk (AUDIT C-3). Memutar ulang skenario test kontensi capstone
// (reliability.test.js "kontensi: 4 worker polling 1 ms, 150 job": konfigurasi FAST, POLL_MS=1,
// 4 worker) dengan LEASE_TRACE=1, lalu untuk SETIAP lease_at_risk menjawab:
//   1. Dari mana sisa lease yang kecil itu berasal: lease yang diberikan sudah pendek (now diambil
//      sebelum menunggu lock), jarak sejak lease ditulis sampai tick heartbeat (interval + event loop
//      terblokir + granularitas timer), atau tunggu lock heartbeat itu sendiri.
//   2. Apa yang terjadi sesudahnya, menurut DATABASE: lease benar-benar diambil alih (lease_expired),
//      tenggat lewat tanpa diambil alih (lease_overrun), atau tulisan berikutnya mendarat sebelum
//      tenggat (berapa ms marginnya).
// Tidak menggagalkan apa pun; hasil per run ditulis ke <out>/run-NNN.json dan ringkasan ke stdout.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FAST, submitJobs } from '../test/helpers.js';
import { startApi, startWorker, waitUntil } from './lib/harness.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i < 0 ? def : args.splice(i, 2)[1];
};
const runs = Number(opt('--runs', '10'));
const jobs = Number(opt('--jobs', '150'));
const out = resolve(opt('--out', join('test-runs', `lease-probe-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
const extraEnv = {};
for (let v; (v = opt('--env', null)) !== null; ) {
  const [k, ...rest] = v.split('=');
  extraEnv[k] = rest.join('=');
}
mkdirSync(out, { recursive: true });

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const dist = (xs) => ({ n: xs.length, min: xs.length ? Math.min(...xs) : null, p50: pct(xs, 50), p90: pct(xs, 90), p99: pct(xs, 99), max: xs.length ? Math.max(...xs) : null });
const ms = (iso) => Date.parse(iso);

async function oneRun(no) {
  const dir = mkdtempSync(join(tmpdir(), 'lease-probe-'));
  const env = { ...FAST, POLL_MS: '1', MAX_PENDING: '1000', LEASE_TRACE: '1', DB_PATH: join(dir, 'jobs.db'), REPORT_DIR: join(dir, 'reports'), ...extraEnv };
  const procs = [];
  try {
    const api = await startApi(env);
    procs.push(api);
    const workers = [];
    for (let i = 1; i <= 4; i++) workers.push(await startWorker({ ...env, WORKER_ID: `w${i}` }));
    procs.push(...workers);
    const get = async (p) => ({ body: await (await fetch(api.url + p)).json() });
    const post = async (body, headers = {}) => {
      const r = await fetch(`${api.url}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json(), headers: r.headers };
    };
    const s = { get, post };
    const t0 = Date.now();
    const bodies = Array.from({ length: jobs }, (_, i) => ({ type: 'order_report', payload: { orderCount: 50, seed: i + 1 } }));
    const sub = await submitJobs(s, bodies, { keyPrefix: 'probe' });
    let settled = true;
    try {
      await waitUntil(async () => {
        const b = (await get('/metrics')).body.jobs.byStatus;
        return (b.SUCCEEDED ?? 0) + (b.FAILED ?? 0) >= sub.ids.length;
      }, { timeoutMs: 20_000 });
    } catch {
      settled = false;
    }
    const metrics = (await get('/metrics')).body;
    const durationMs = Date.now() - t0;
    await Promise.all(procs.map((p) => p.stop()));

    const ro = new DatabaseSync(env.DB_PATH, { readOnly: true });
    const dbEvents = ro.prepare('SELECT job_id, attempt, event, worker_id, at FROM job_events ORDER BY id').all();
    ro.close();
    return analyse({ no, env, sub, settled, metrics, durationMs, workers, api, dbEvents });
  } finally {
    await Promise.all(procs.map((p) => p.stop()));
    rmSync(dir, { recursive: true, force: true });
  }
}

function analyse({ no, env, sub, settled, metrics, durationMs, workers, api, dbEvents }) {
  const leaseMs = Number(env.LEASE_MS);
  const ev = workers.flatMap((w) => w.events.map((e) => ({ ...e, worker: w.name })));
  const of = (name) => ev.filter((e) => e.event === name);
  const errors = ev.filter((e) => e.level === 'error' || e.level === 'fatal');
  const key = (j, a) => `${j}#${a}`;
  const reclaimed = new Set(dbEvents.filter((e) => e.event === 'lease_expired').map((e) => key(e.job_id, e.attempt)));
  const overrun = new Map(of('lease_overrun').map((e) => [key(e.jobId, e.attempt), e]));
  const hbOk = of('heartbeat_ok');

  // Jejak transaksi semua proses: siapa memegang write lock kapan.
  const txs = [api, ...workers].flatMap((p) =>
    p.events.filter((e) => e.event === 'tx_trace').flatMap((e) => e.recs.map(([label, start, wait, hold, outcome, total]) => ({ proc: p.name, label, start, wait, hold, outcome, total }))),
  );
  const holds = txs.filter((r) => r.hold !== null && r.outcome !== -1).map((r) => ({ ...r, from: r.start + r.wait, to: r.start + r.wait + r.hold }));
  const lockIn = (a, b) => {
    const inWin = holds.filter((h) => h.to > a && h.from < b).sort((x, y) => x.from - y.from);
    let covered = 0;
    let cur = a;
    for (const h of inWin) {
      const f = Math.max(h.from, cur);
      const t = Math.min(h.to, b);
      if (t > f) {
        covered += t - f;
        cur = t;
      }
    }
    const by = {};
    for (const h of inWin) {
      const k = `${h.proc === 'api' ? 'api' : 'worker'}:${h.label}${h.outcome === 0 ? ':empty' : ''}`;
      by[k] ??= { n: 0, ms: 0 };
      by[k].n += 1;
      by[k].ms = Math.round((by[k].ms + Math.min(h.to, b) - Math.max(h.from, a)) * 10) / 10;
    }
    return { windowMs: Math.round(b - a), lockHeldPct: Math.round((covered / (b - a)) * 100), holders: by };
  };

  const atRisk = of('lease_at_risk').map((e) => {
    const k = key(e.jobId, e.attempt);
    const grantedAtSet = e.leaseUntil - e.leaseSetAt; // lease yang benar-benar diberikan saat ditulis
    const budget = {
      leaseMs,
      lostBeforeWrittenMs: leaseMs - grantedAtSet, // now diambil sebelum lock didapat (stale now)
      sinceWrittenToTickMs: e.tickAt - e.leaseSetAt, // interval + event loop terblokir + timer
      ofWhichLagMs: e.lagMs,
      ownLockWaitMs: e.lockWaitMs,
      leaseLeftMs: e.leaseLeftMs,
    };
    // Tulisan berhasil berikutnya untuk attempt ini: heartbeat_ok atau commit status.
    const doneAt = (() => {
      const nextHb = hbOk.filter((x) => key(x.jobId, x.attempt) === k && x.tickAt > e.tickAt).map((x) => x.tickAt + x.lockWaitMs);
      const fin = ev.filter((x) => key(x.jobId, x.attempt) === k && ['job_succeeded', 'job_retry_scheduled', 'job_failed'].includes(x.event)).map((x) => ms(x.ts));
      const all = [...nextHb, ...fin];
      return all.length ? Math.min(...all) : null;
    })();
    let outcome;
    if (reclaimed.has(k)) outcome = 'reclaimed_by_other_worker';
    else if (overrun.has(k)) outcome = overrun.get(k).accepted ? 'deadline_passed_write_accepted' : 'deadline_passed_write_rejected';
    else if (doneAt !== null && doneAt <= e.leaseUntil) outcome = 'next_write_before_deadline';
    else outcome = 'unknown';
    const timeline = ev
      .filter((x) => key(x.jobId, x.attempt) === k && x.event !== 'worker_stats')
      .map((x) => ({ t: ms(x.ts) - e.leaseSetAt, ev: x.event, w: x.worker, ...pick(x, ['tick', 'lagMs', 'lockWaitMs', 'busyWaitMs', 'leaseLeftMs', 'nextBusyTimeoutMs', 'busyTimeoutMs', 'blockedBy', 'phase', 'overrunMs']) }));
    const db = dbEvents.filter((x) => x.job_id === e.jobId).map((x) => ({ t: x.at - e.leaseSetAt, ev: `${x.event}:${x.attempt}`, w: x.worker_id }));
    const victimTries = txs.filter((r) => r.proc === e.worker && r.start >= e.leaseSetAt && r.start <= e.tickAt + e.lockWaitMs);
    return {
      lock: { ...lockIn(e.leaseSetAt, e.tickAt + e.lockWaitMs), victimTries: victimTries.map((r) => `${r.label}:${r.outcome}:${Math.round(r.total)}ms`) },
      jobId: e.jobId, attempt: e.attempt, worker: e.worker, phase: e.phase, leaseFrom: e.leaseFrom, busyTimeoutMs: e.busyTimeoutMs,
      blockedBy: e.blockedBy, budget, outcome, marginMs: doneAt === null ? null : e.leaseUntil - doneAt, timeline, db,
    };
  });

  const stats = workers.map((w) => w.events.filter((e) => e.event === 'worker_stats').at(-1) ?? null);
  return {
    run: no,
    pass: errors.length === 0 && metrics.jobs.byStatus.SUCCEEDED === sub.ids.length && sub.gaveUp === 0,
    durationMs,
    settled,
    submit: { accepted: sub.accepted, replayed: sub.replayed, busy503: sub.busy503, gaveUp: sub.gaveUp },
    byStatus: metrics.jobs.byStatus,
    duplicateSuccess: metrics.counters.duplicateSuccessJobs,
    workerLost: metrics.counters.workerLost,
    errors: errors.map((e) => `${e.event}${e.reason ? `:${e.reason}` : ''}`),
    counts: Object.fromEntries(
      ['claim_busy', 'state_write_busy', 'heartbeat_ok', 'heartbeat_busy', 'lease_at_risk', 'lease_overrun', 'job_state_write_failed', 'stale_completion_rejected'].map((n) => [n, of(n).length]),
    ),
    apiDbBusy: api.events.filter((e) => e.event === 'db_busy').length,
    heartbeatLockWaitMs: dist(hbOk.map((e) => e.lockWaitMs)),
    heartbeatLagMs: dist([...hbOk, ...of('heartbeat_busy'), ...of('lease_at_risk')].map((e) => e.lagMs)),
    heartbeatGrantedMs: dist(hbOk.map((e) => e.grantedMs)),
    stateWriteBusyWaitMs: dist(of('state_write_busy').map((e) => e.busyWaitMs)),
    tx: (() => {
      const by = {};
      for (const r of txs) {
        const k = `${r.proc === 'api' ? 'api' : 'worker'}:${r.label}:${r.outcome === 1 ? 'ok' : r.outcome === 0 ? 'empty' : r.outcome === -1 ? 'busy' : 'error'}`;
        by[k] ??= { n: 0, holdMs: 0 };
        by[k].n += 1;
        by[k].holdMs = Math.round(by[k].holdMs + (r.hold ?? 0));
      }
      const t = txs.map((r) => r.start);
      const spanMs = t.length ? Math.max(...t) - Math.min(...t) : 0;
      const held = holds.reduce((a, h) => a + h.hold, 0);
      // Kandidat "complete + claim berikutnya dalam satu transaksi": claim yang berhasil dan tulisan
      // sebelumnya dari worker yang sama adalah complete/fail yang berhasil (loop worker langsung claim).
      let chainable = 0;
      const last = new Map();
      for (const r of [...txs].sort((x, y) => x.start - y.start)) {
        if (r.label === 'heartbeat') continue;
        const prev = last.get(r.proc);
        if (r.label === 'claim' && r.outcome === 1 && prev && ['complete', 'fail'].includes(prev.label) && prev.outcome === 1) chainable += 1;
        last.set(r.proc, r);
      }
      return { spanMs: Math.round(spanMs), lockHeldPct: spanMs ? Math.round((held / spanMs) * 100) : null, chainableClaims: chainable, by };
    })(),
    workerPolls: stats.map((x) => x && { polls: x.polls, jobs: x.jobs, claimBusy: x.claimBusy }),
    atRisk,
  };
}

function pick(o, keys) {
  const r = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) r[k] = o[k];
  return r;
}

console.log(`lease-probe: ${runs} run, ${jobs} job, Node ${process.version}, SQLite ${process.versions.sqlite}, ${process.platform}; env ${JSON.stringify(extraEnv)}; out ${out}`);
const all = [];
for (let i = 1; i <= runs; i++) {
  const r = await oneRun(i);
  all.push(r);
  writeFileSync(join(out, `run-${String(i).padStart(3, '0')}.json`), JSON.stringify(r, null, 2));
  const risk = r.atRisk.map((a) => `${a.leaseFrom}/${a.phase} left=${a.budget.leaseLeftMs} lost=${a.budget.lostBeforeWrittenMs} gap=${a.budget.sinceWrittenToTickMs} (lag ${a.budget.ofWhichLagMs}, blockedBy ${JSON.stringify(a.blockedBy)}) wait=${a.budget.ownLockWaitMs} lockHeld=${a.lock.lockHeldPct}% -> ${a.outcome}`);
  console.log(
    `run ${String(i).padStart(3)} ${r.pass ? 'PASS' : 'FAIL'} ${r.durationMs} ms errors=${JSON.stringify(r.errors)} ${JSON.stringify(r.counts)} 503=${r.submit.busy503} lost=${r.workerLost} hbWait=${JSON.stringify(r.heartbeatLockWaitMs)} lockHeld=${r.tx.lockHeldPct}%` +
      (risk.length ? `\n         at_risk: ${risk.join(' | ')}` : ''),
  );
}
const sum = (f) => all.reduce((a, r) => a + f(r), 0);
const summary = {
  runs,
  pass: all.filter((r) => r.pass).length,
  runsWithLeaseAtRisk: all.filter((r) => r.counts.lease_at_risk > 0).length,
  leaseAtRisk: sum((r) => r.counts.lease_at_risk),
  heartbeatBusy: sum((r) => r.counts.heartbeat_busy),
  stateWriteBusy: sum((r) => r.counts.state_write_busy),
  jobStateWriteFailed: sum((r) => r.counts.job_state_write_failed),
  leaseOverrun: sum((r) => r.counts.lease_overrun),
  workerLost: sum((r) => r.workerLost),
  duplicateSuccess: sum((r) => r.duplicateSuccess),
  post503: sum((r) => r.submit.busy503),
  outcomes: all.flatMap((r) => r.atRisk.map((a) => a.outcome)).reduce((m, o) => ({ ...m, [o]: (m[o] ?? 0) + 1 }), {}),
};
writeFileSync(join(out, 'summary.json'), JSON.stringify({ node: process.version, sqlite: process.versions.sqlite, platform: process.platform, env: extraEnv, summary }, null, 2));
console.log(`SUMMARY ${JSON.stringify(summary)}`);
