// npm run test:repeat -- [--runs 20] [--out test-runs/<waktu>] [--test-timeout 120000] [--run-timeout 600000] [file...]
// Menjalankan test suite berulang dan MENYIMPAN BUKTI per run: log TAP lengkap, exit code, sinyal,
// durasi, load average, dan nama test yang gagal beserta jenis kegagalannya. Untuk menyelidiki
// kegagalan yang jarang (lihat docs/AUDIT.md "Kegagalan test yang belum terjelaskan").
//
// Dua lapis timeout supaya test yang hang terlihat, bukan diam:
//   --test-timeout  diteruskan ke node --test. Di Node 22 dengan isolasi proses, batas ini berlaku
//                   per FILE test (file dibunuh, dilaporkan testTimeoutFailure). File terlama terukur
//                   16 s normal / 19 s dengan CPU penuh (reliability.test.js), jadi default 120 s.
//   --run-timeout   watchdog untuk seluruh run; proses dibunuh dan run dicatat HANG.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const runs = Number(opt('--runs', '20'));
const out = resolve(opt('--out', join(ROOT, 'test-runs', new Date().toISOString().replace(/[:.]/g, '-'))));
const testTimeout = Number(opt('--test-timeout', '120000'));
const runTimeout = Number(opt('--run-timeout', '600000'));
const files = args.length ? args : ['test/*.test.js'];
for (const [k, v] of Object.entries({ runs, testTimeout, runTimeout })) {
  if (!Number.isInteger(v) || v < 1) {
    console.error(`${k} harus integer >= 1`);
    process.exit(2);
  }
}
mkdirSync(out, { recursive: true });

/** Ambil test yang gagal dari TAP: nama, kedalaman, failureType, lokasi, baris pertama error. */
export function parseTap(text) {
  const lines = text.split(/\r?\n/);
  const failures = [];
  const summary = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)not ok \d+ - (.*)$/);
    if (m) {
      const f = { name: m[2].trim(), depth: m[1].length / 4, failureType: null, location: null, error: null };
      for (let j = i + 1; j < lines.length && j < i + 60; j++) {
        const l = lines[j].trim();
        if (l === '...') break;
        const kv = l.match(/^(failureType|location|error):\s*(.*)$/);
        if (kv && f[kv[1]] === null) f[kv[1]] = kv[2].replace(/^'|'$/g, '').slice(0, 300);
      }
      failures.push(f);
    }
    const s = lines[i].match(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)$/);
    if (s) summary[s[1]] = Number(s[2]);
  }
  // Daun = kegagalan yang bukan sekadar "subtestsFailed" dari induknya.
  const leaves = failures.filter((f) => f.failureType !== 'subtestsFailed');
  return { summary, failures, leaves };
}

function runOnce(n) {
  return new Promise((resolveRun) => {
    const t0 = Date.now();
    const load = loadavg().map((x) => Math.round(x * 100) / 100);
    const child = spawn(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '--test',
        '--test-concurrency=1',
        `--test-timeout=${testTimeout}`,
        '--test-reporter=tap',
        ...files,
      ],
      { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    let hung = false;
    const watchdog = setTimeout(() => {
      hung = true;
      child.kill('SIGKILL');
    }, runTimeout);
    child.on('exit', (code, signal) => {
      clearTimeout(watchdog);
      const durationMs = Date.now() - t0;
      const file = join(out, `run-${String(n).padStart(3, '0')}.log`);
      writeFileSync(file, log);
      const tap = parseTap(log);
      resolveRun({ run: n, exitCode: code, signal, hung, durationMs, loadavgAtStart: load, log: file, ...tap });
    });
  });
}

console.log(`Node ${process.version}, ${platform()} ${release()}, ${cpus().length} CPU`);
console.log(`${runs} run, test-timeout ${testTimeout} ms, run-timeout ${runTimeout} ms, log: ${out}`);
const results = [];
for (let n = 1; n <= runs; n++) {
  const r = await runOnce(n);
  results.push(r);
  const status = r.hung ? 'HANG' : r.exitCode === 0 ? 'ok' : 'FAIL';
  const s = r.summary;
  console.log(
    `run ${String(n).padStart(3)}: ${status.padEnd(4)} exit=${r.exitCode ?? r.signal} ` +
      `tests=${s.tests ?? '?'} pass=${s.pass ?? '?'} fail=${s.fail ?? '?'} cancelled=${s.cancelled ?? 0} skipped=${s.skipped ?? 0} ` +
      `${(r.durationMs / 1000).toFixed(1)} s load=${r.loadavgAtStart[0]}`,
  );
  for (const f of r.leaves) console.log(`          ✕ ${f.name} [${f.failureType}] ${f.location ?? ''}\n            ${f.error ?? ''}`);
}

const bad = results.filter((r) => r.hung || r.exitCode !== 0);
const byTest = {};
for (const r of bad) for (const f of r.leaves) (byTest[f.name] ??= []).push(r.run);
const report = {
  node: process.version,
  platform: `${platform()} ${release()}`,
  cpus: cpus().length,
  runs,
  testTimeout,
  runTimeout,
  failedRuns: bad.map((r) => r.run),
  hungRuns: results.filter((r) => r.hung).map((r) => r.run),
  failuresByTest: byTest,
  results: results.map(({ log, ...r }) => ({ ...r, log: log.replace(out, '.') })),
};
writeFileSync(join(out, 'summary.json'), JSON.stringify(report, null, 2));
console.log('');
console.log(`Hasil: ${runs - bad.length}/${runs} run lulus. Run gagal: ${bad.map((r) => r.run).join(', ') || '-'}`);
for (const [name, rs] of Object.entries(byTest)) console.log(`  ${name}: gagal di run ${rs.join(', ')}`);
console.log(`Ringkasan: ${join(out, 'summary.json')}`);
process.exitCode = bad.length ? 1 : 0;
