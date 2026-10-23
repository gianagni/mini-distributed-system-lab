// Eksperimen yang bisa direproduksi. Semua di localhost, tanpa layanan eksternal.
//
//   npm run experiment            (default 3 repetisi per konfigurasi, sekitar 5-6 menit)
//   EXP_REPS=1 npm run experiment (cepat, sekitar 2 menit)
//
// Output: docs/EXPERIMENT-RESULTS.md (ringkasan) dan docs/experiment-results.json (data mentah).
//
// 1. Ablation: baseline lalu menyalakan retry / timeout / lease recovery satu per satu, lalu semuanya.
//    Workload dan jadwal crash identik untuk semua konfigurasi.
// 2. Drain capacity: antrean diisi dulu tanpa worker, lalu k worker menghabiskannya.
//    Mengukur kapasitas worker tanpa dibatasi client.
// 3. Latency POST dari satu client berurutan (bukan kapasitas maksimum sistem).
import { execSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { checkConsistency } from '../src/consistency.js';
import { percentile } from '../src/metrics.js';
import { startApi, startWorker, waitUntil } from './lib/harness.js';

const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));
const REPS = Number(process.env.EXP_REPS ?? 3);
const SEED = 42;
const N_JOBS = 200;
const DEADLINE_MS = 15_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const range = (xs) => `${median(xs)} (${Math.min(...xs)}-${Math.max(...xs)})`;

const COMMON = {
  LEASE_MS: '1000',
  HEARTBEAT_MS: '250',
  BUSY_TIMEOUT_MS: '300',
  BACKOFF_BASE_MS: '100',
  BACKOFF_CAP_MS: '1000',
  POLL_MS: '20',
  ALLOW_FAULT_INJECTION: '1',
  MAX_PENDING: '100000',
};

const CONFIGS = [
  { key: 'baseline', label: 'Baseline', env: { RECOVERY: '0', MAX_ATTEMPTS: '1', JOB_TIMEOUT_MS: '0' } },
  { key: 'retry', label: '+ retry saja', env: { RECOVERY: '0', MAX_ATTEMPTS: '3', JOB_TIMEOUT_MS: '0' } },
  { key: 'timeout', label: '+ timeout saja', env: { RECOVERY: '0', MAX_ATTEMPTS: '1', JOB_TIMEOUT_MS: '1000' } },
  { key: 'recovery', label: '+ lease recovery saja', env: { RECOVERY: '1', MAX_ATTEMPTS: '1', JOB_TIMEOUT_MS: '0' } },
  { key: 'improved', label: 'Semua (improved)', env: { RECOVERY: '1', MAX_ATTEMPTS: '3', JOB_TIMEOUT_MS: '1000' } },
];
const CATEGORIES = ['clean', 'transient1', 'transient2', 'permanent', 'hang'];

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function faultPlan(n, seed) {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const r = rand();
    const delayMs = 20 + Math.floor(rand() * 80);
    const category =
      r < 0.6 ? 'clean' : r < 0.85 ? 'transient1' : r < 0.95 ? 'transient2' : r < 0.98 ? 'permanent' : 'hang';
    const simulate = { delayMs };
    if (category === 'transient1') simulate.failTransientTimes = 1;
    if (category === 'transient2') simulate.failTransientTimes = 2;
    if (category === 'permanent') simulate.failPermanent = true;
    if (category === 'hang') simulate.hang = true;
    return { i, category, body: { type: 'order_report', payload: { orderCount: 2000, seed: i + 1, simulate } } };
  });
}

async function withSystem(envOverrides, workers, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-job-exp-'));
  const env = { ...COMMON, ...envOverrides, DB_PATH: join(dir, 'jobs.db'), REPORT_DIR: join(dir, 'reports') };
  const procs = [];
  try {
    const api = await startApi(env);
    procs.push(api);
    const spawnWorker = async (id) => {
      const w = await startWorker({ ...env, WORKER_ID: id });
      procs.push(w);
      return w;
    };
    const ws = [];
    for (let i = 1; i <= workers; i++) ws.push(await spawnWorker(`w${i}`));
    const out = await fn({ api, ws, spawnWorker, env });
    // Pemeriksaan invariant di akhir setiap run.
    const db = new DatabaseSync(env.DB_PATH, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000;');
    const c = checkConsistency(db, env.REPORT_DIR);
    db.close();
    const byRule = (l) => l.reduce((a, x) => ({ ...a, [x.rule]: (a[x.rule] ?? 0) + 1 }), {});
    out.consistency = { violations: c.violations.length, violationRules: byRule(c.violations), warnings: byRule(c.warnings) };
    return out;
  } finally {
    await Promise.all(procs.map((p) => p.stop(500)));
    await rm(dir, { recursive: true, force: true });
  }
}

const getJson = async (url) => (await fetch(url)).json();
const postJob = async (api, body) =>
  (
    await fetch(`${api.url}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json();

async function runAblation(config, plan) {
  return withSystem(config.env, 3, async ({ api, ws, spawnWorker }) => {
    const t0 = performance.now();
    const ids = [];
    for (const job of plan) ids.push((await postJob(api, job.body)).id);

    // Jadwal crash identik untuk semua konfigurasi: kill -9 w1 dan w2, diganti w4 dan w5.
    const crashes = (async () => {
      await sleep(800);
      await ws[0].kill('SIGKILL');
      await sleep(200);
      await spawnWorker('w4');
      await sleep(600);
      await ws[1].kill('SIGKILL');
      await sleep(200);
      await spawnWorker('w5');
    })();

    let peakReady = 0;
    let finalMs = null;
    let m;
    while (performance.now() - t0 < DEADLINE_MS) {
      m = await getJson(`${api.url}/metrics`);
      peakReady = Math.max(peakReady, m.health.pendingReady);
      if (m.jobs.byStatus.PENDING + m.jobs.byStatus.RUNNING === 0) {
        finalMs = Math.round(performance.now() - t0);
        break;
      }
      await sleep(100);
    }
    await crashes;
    m = await getJson(`${api.url}/metrics`);

    const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, { n: 0, SUCCEEDED: 0, FAILED: 0, STUCK: 0 }]));
    let totalAttempts = 0;
    for (let k = 0; k < ids.length; k++) {
      const j = await getJson(`${api.url}/jobs/${ids[k]}`);
      const b = byCategory[plan[k].category];
      b.n += 1;
      totalAttempts += j.attempts;
      if (j.status === 'SUCCEEDED' || j.status === 'FAILED') b[j.status] += 1;
      else b.STUCK += 1;
    }
    const sum = (k) => CATEGORIES.reduce((a, c) => a + byCategory[c][k], 0);
    return {
      config: config.key,
      finalMs,
      succeeded: sum('SUCCEEDED'),
      failed: sum('FAILED'),
      stuck: sum('STUCK'),
      stuckPendingReady: m.health.pendingReady,
      stuckRunning: m.jobs.byStatus.RUNNING,
      runningWithExpiredLease: m.health.runningWithExpiredLease,
      oldestRunningAgeMs: m.health.oldestRunningAgeMs,
      oldestReadyPendingAgeMs: m.health.oldestReadyPendingAgeMs,
      peakReadyQueue: peakReady,
      totalAttempts,
      retries: m.counters.retriesScheduled,
      leaseReclaims: config.env.RECOVERY === '1' ? m.counters.workerLost : 0,
      duplicateSuccessJobs: m.counters.duplicateSuccessJobs,
      failedByErrorClass: m.failedByErrorClass,
      e2eP50: m.latencyMs.endToEnd.p50,
      e2eP95: m.latencyMs.endToEnd.p95,
      byCategory,
    };
  });
}

async function runDrain(workload, workers, n) {
  const env = { RECOVERY: '1', MAX_ATTEMPTS: '3', JOB_TIMEOUT_MS: '5000' };
  return withSystem(env, 0, async ({ api, spawnWorker, env: fullEnv }) => {
    for (let i = 0; i < n; i++) await postJob(api, workload.body(i));
    const ws = await Promise.all(Array.from({ length: workers }, (_, i) => spawnWorker(`d${i + 1}`)));
    const startedAt = Math.min(...ws.map((w) => Date.parse(w.events.find((e) => e.event === 'worker_started').ts)));
    await waitUntil(async () => (await getJson(`${api.url}/metrics`)).jobs.byStatus.SUCCEEDED === n, {
      timeoutMs: 120_000,
      intervalMs: 50,
    });
    const db = new DatabaseSync(fullEnv.DB_PATH, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000;');
    const { last } = db.prepare('SELECT MAX(finished_at) AS last FROM jobs').get();
    db.close();
    const drainMs = last - startedAt;
    return { workload: workload.key, workers, n, drainMs, jobsPerSec: Math.round((n / drainMs) * 1000) };
  });
}

async function runPostLatency(n) {
  return withSystem({ RECOVERY: '1', MAX_ATTEMPTS: '3', JOB_TIMEOUT_MS: '5000' }, 2, async ({ api }) => {
    const lat = [];
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const s = performance.now();
      await postJob(api, { type: 'order_report', payload: { orderCount: 100, seed: i + 1 } });
      lat.push(performance.now() - s);
    }
    const wallMs = performance.now() - t0;
    lat.sort((a, b) => a - b);
    return {
      n,
      postP50: Number(percentile(lat, 50).toFixed(2)),
      postP95: Number(percentile(lat, 95).toFixed(2)),
      postP99: Number(percentile(lat, 99).toFixed(2)),
      clientRatePerSec: Math.round((n / wallMs) * 1000),
    };
  });
}

// ------------------------------------------------------------------ render

function renderMarkdown(data) {
  const L = [];
  const { env, ablation, drain, post } = data;
  L.push('# Hasil Eksperimen', '');
  L.push('Dibangkitkan otomatis oleh `npm run experiment`. Data mentah: `experiment-results.json`.', '');
  L.push(`- Dijalankan: ${data.startedAt} sampai ${data.finishedAt}`);
  L.push(`- Environment: Node ${env.node}, ${env.platform} ${env.release} ${env.arch}, ${env.cpus} CPU (${env.cpuModel}), RAM ${env.ramGiB} GiB`);
  L.push(`- Versi kode: ${data.codeVersion}`);
  L.push(`- Repetisi per konfigurasi: ${data.reps}. Angka ditulis sebagai median (min-max) kalau lebih dari satu repetisi.`);
  L.push(`- Konfigurasi bersama: \`${JSON.stringify(COMMON)}\``, '');

  L.push('## 1. Ablation: kontribusi retry, timeout, dan lease recovery', '');
  L.push(
    `Workload: ${N_JOBS} job dari seed ${SEED} (komposisi: ${CATEGORIES.map((c) => `${c} ${data.plan[c]}`).join(', ')}). ` +
      '3 worker. Pada t=0.8 s w1 di-kill -9 (diganti w4 pada t=1.0 s), pada t=1.6 s w2 di-kill -9 (diganti w5 pada t=1.8 s). ' +
      `Batas tunggu ${DEADLINE_MS / 1000} s. "Macet" = belum final saat batas tunggu.`,
    '',
  );
  L.push('| Konfigurasi | RECOVERY / MAX_ATTEMPTS / JOB_TIMEOUT_MS | Sukses | Gagal | Macet | Semua final dalam (ms) | Total attempt | Retry | Lease kedaluwarsa diambil alih* | p50 / p95 end-to-end sukses (ms) |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const c of CONFIGS) {
    const runs = ablation.filter((r) => r.config === c.key);
    const finals = runs.map((r) => r.finalMs);
    const finalTxt = finals.every((x) => x === null)
      ? 'tidak pernah'
      : finals.some((x) => x === null)
        ? `${finals.filter((x) => x !== null).length}/${runs.length} run`
        : range(finals);
    L.push(
      `| ${c.label} | ${c.env.RECOVERY} / ${c.env.MAX_ATTEMPTS} / ${c.env.JOB_TIMEOUT_MS} | ${range(runs.map((r) => r.succeeded))} | ${range(runs.map((r) => r.failed))} | ${range(runs.map((r) => r.stuck))} | ${finalTxt} | ${range(runs.map((r) => r.totalAttempts))} | ${range(runs.map((r) => r.retries))} | ${range(runs.map((r) => r.leaseReclaims))} | ${median(runs.map((r) => r.e2eP50))} / ${median(runs.map((r) => r.e2eP95))} |`,
    );
  }
  L.push('');
  L.push(
    '\\* Jumlah event `lease_expired` yang ditangani worker lain. Dengan `MAX_ATTEMPTS=1` job itu langsung ' +
      '`FAILED WORKER_LOST`, tidak dijalankan ulang. Hanya konfigurasi dengan attempt tersisa yang menjalankannya ulang.',
  );
  L.push('');
  L.push('**Efek ke antrean dan deteksi job macet (median):**', '');
  L.push('| Konfigurasi | Puncak antrean siap | Antrean siap tersisa | Job RUNNING tersisa | ...dengan lease kedaluwarsa | Umur RUNNING tertua (ms) | Umur antrean siap tertua (ms) |');
  L.push('|---|---|---|---|---|---|---|');
  for (const c of CONFIGS) {
    const runs = ablation.filter((r) => r.config === c.key);
    const md = (k) => median(runs.map((r) => r[k])) ?? '-';
    L.push(
      `| ${c.label} | ${md('peakReadyQueue')} | ${md('stuckPendingReady')} | ${md('stuckRunning')} | ${md('runningWithExpiredLease')} | ${md('oldestRunningAgeMs')} | ${md('oldestReadyPendingAgeMs')} |`,
    );
  }
  L.push('');
  L.push('**Hasil per kategori job (repetisi pertama), format sukses / gagal / macet:**', '');
  L.push(`| Kategori | n | ${CONFIGS.map((c) => c.label).join(' | ')} |`);
  L.push(`|---|---|${CONFIGS.map(() => '---').join('|')}|`);
  for (const cat of CATEGORIES) {
    const cells = CONFIGS.map((c) => {
      const b = ablation.find((r) => r.config === c.key).byCategory[cat];
      return `${b.SUCCEEDED} / ${b.FAILED} / ${b.STUCK}`;
    });
    L.push(`| ${cat} | ${data.plan[cat]} | ${cells.join(' | ')} |`);
  }
  L.push('');
  L.push('**Kegagalan per error class (repetisi pertama):**', '');
  for (const c of CONFIGS) {
    L.push(`- ${c.label}: \`${JSON.stringify(ablation.find((r) => r.config === c.key).failedByErrorClass)}\``);
  }
  L.push('');
  const allRuns = [...ablation, ...drain, post];
  L.push(
    `**Invariant:** ${allRuns.reduce((a, r) => a + r.consistency.violations, 0)} violation di ${allRuns.length} run ` +
      `(sukses ganda: ${ablation.reduce((a, r) => a + r.duplicateSuccessJobs, 0)}). ` +
      `Warning yang muncul: \`${JSON.stringify(ablation.reduce((acc, r) => {
        for (const [k, v] of Object.entries(r.consistency.warnings)) acc[k] = (acc[k] ?? 0) + v;
        return acc;
      }, {}))}\` (total semua repetisi ablation).`,
    '',
  );

  L.push('## 2. Drain capacity: antrean penuh, k worker', '');
  L.push(
    'Job dimasukkan dulu tanpa worker, lalu k worker dinyalakan bersamaan. Waktu diukur dari worker pertama siap sampai job terakhir selesai (timestamp database). ' +
      'Semua proses berbagi CPU mesin yang sama dan satu file SQLite.',
    '',
  );
  L.push('| Workload | Worker | Job | Drain (ms) | Job/detik |');
  L.push('|---|---|---|---|---|');
  for (const w of DRAIN_WORKLOADS) {
    for (const k of DRAIN_WORKERS) {
      const runs = drain.filter((r) => r.workload === w.key && r.workers === k);
      L.push(`| ${w.label} | ${k} | ${runs[0].n} | ${range(runs.map((r) => r.drainMs))} | ${range(runs.map((r) => r.jobsPerSec))} |`);
    }
  }
  L.push('');
  L.push('## 3. Latency POST dari satu client berurutan', '');
  L.push(
    `${post.n} POST berurutan, 2 worker aktif. p50 / p95 / p99 = ${post.postP50} / ${post.postP95} / ${post.postP99} ms. ` +
      `Laju client ${post.clientRatePerSec} request/detik. Ini batas client berurutan, bukan kapasitas maksimum API.`,
    '',
  );
  return L.join('\n');
}

// ------------------------------------------------------------------ main

const DRAIN_WORKLOADS = [
  { key: 'light', label: 'Ringan (orderCount=100, tanpa delay)', n: 1000, body: (i) => ({ type: 'order_report', payload: { orderCount: 100, seed: i + 1 } }) },
  {
    key: 'io',
    label: 'Menunggu I/O (delayMs=20)',
    n: 300,
    body: (i) => ({ type: 'order_report', payload: { orderCount: 100, seed: i + 1, simulate: { delayMs: 20 } } }),
  },
];
const DRAIN_WORKERS = [1, 2, 4];

const startedAt = new Date().toISOString();
let codeVersion = 'tidak diketahui (bukan git checkout)';
try {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const hash = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const dirty = execSync('git status --porcelain -- src scripts', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  codeVersion = `git ${hash}${dirty ? ' (+perubahan lokal di src/scripts)' : ''}`;
} catch {
  // Bukan git checkout (mis. hasil unzip): biarkan "tidak diketahui".
}
const plan = faultPlan(N_JOBS, SEED);
const planCounts = Object.fromEntries(CATEGORIES.map((c) => [c, plan.filter((p) => p.category === c).length]));

const ablation = [];
for (let rep = 1; rep <= REPS; rep++) {
  for (const c of CONFIGS) {
    process.stdout.write(`ablation rep ${rep}/${REPS}: ${c.key} ... `);
    const r = await runAblation(c, plan);
    r.rep = rep;
    ablation.push(r);
    console.log(`sukses=${r.succeeded} gagal=${r.failed} macet=${r.stuck} violations=${r.consistency.violations}`);
  }
}
const drain = [];
for (let rep = 1; rep <= REPS; rep++) {
  for (const w of DRAIN_WORKLOADS) {
    for (const k of DRAIN_WORKERS) {
      process.stdout.write(`drain rep ${rep}/${REPS}: ${w.key} x${k} ... `);
      const r = await runDrain(w, k, w.n);
      r.rep = rep;
      drain.push(r);
      console.log(`${r.drainMs} ms`);
    }
  }
}
console.log('post latency ...');
const post = await runPostLatency(1000);

const data = {
  startedAt,
  finishedAt: new Date().toISOString(),
  reps: REPS,
  seed: SEED,
  codeVersion,
  env: {
    node: process.version,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    ramGiB: Math.round(totalmem() / 2 ** 30),
  },
  common: COMMON,
  configs: CONFIGS,
  plan: planCounts,
  ablation,
  drain,
  post,
};
await writeFile(join(DOCS, 'experiment-results.json'), JSON.stringify(data, null, 2) + '\n');
const md = renderMarkdown(data);
await writeFile(join(DOCS, 'EXPERIMENT-RESULTS.md'), md);
console.log('\n' + md);
const totalViolations = [...ablation, ...drain, post].reduce((a, r) => a + r.consistency.violations, 0);
if (totalViolations > 0) {
  console.error(`PERINGATAN: ${totalViolations} invariant violation`);
  process.exit(1);
}
