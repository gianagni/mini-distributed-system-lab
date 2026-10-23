// Membandingkan dua file experiment-results.json tanpa menyalin angka manual.
//
//   node scripts/compare-results.js <a.json> <labelA> <b.json> <labelB>
//
// Output: tabel Markdown ke stdout. Semua angka diturunkan langsung dari data mentah
// dengan definisi median yang sama seperti scripts/experiment.js.
import { readFileSync } from 'node:fs';

const [fa, la, fb, lb] = process.argv.slice(2);
if (!fa || !la || !fb || !lb) {
  console.error('Pakai: node scripts/compare-results.js <a.json> <labelA> <b.json> <labelB>');
  process.exit(2);
}
const A = JSON.parse(readFileSync(fa, 'utf8'));
const B = JSON.parse(readFileSync(fb, 'utf8'));

const median = (xs) => {
  const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const rng = (xs) => `${median(xs)} (${Math.min(...xs)}-${Math.max(...xs)})`;
const runs = (d, key) => d.ablation.filter((r) => r.config === key);
const ratio = (a, b) => (a === null || b === null || b === 0 ? '-' : `${(a / b).toFixed(2)}x`);

const L = [];
L.push(`| | ${la} | ${lb} |`, '|---|---|---|');
for (const [name, d] of [
  ['Node', (x) => x.env.node],
  ['CPU', (x) => `${x.env.cpus} x ${x.env.cpuModel}`],
  ['RAM (GiB)', (x) => x.env.ramGiB],
  ['Kernel', (x) => x.env.release],
  ['Versi kode', (x) => x.codeVersion ?? '-'],
  ['Repetisi', (x) => x.reps],
  ['Dijalankan', (x) => x.startedAt],
]) {
  L.push(`| ${name} | ${d(A)} | ${d(B)} |`);
}
L.push('');

L.push('**Ablation** (median (min-max) dari repetisi):', '');
L.push(`| Konfigurasi | Sukses ${la} | Sukses ${lb} | Macet ${la} | Macet ${lb} | p50 e2e ${la} | p50 e2e ${lb} | p95 e2e ${la} | p95 e2e ${lb} | Final (ms) ${la} | Final (ms) ${lb} |`);
L.push('|---|---|---|---|---|---|---|---|---|---|---|');
for (const c of A.configs) {
  const ra = runs(A, c.key);
  const rb = runs(B, c.key);
  const fin = (rs) => (rs.every((r) => r.finalMs === null) ? 'tidak pernah' : rng(rs.map((r) => r.finalMs).filter((x) => x !== null)));
  L.push(
    `| ${c.label} | ${rng(ra.map((r) => r.succeeded))} | ${rng(rb.map((r) => r.succeeded))} | ${rng(ra.map((r) => r.stuck))} | ${rng(rb.map((r) => r.stuck))} | ${median(ra.map((r) => r.e2eP50))} | ${median(rb.map((r) => r.e2eP50))} | ${median(ra.map((r) => r.e2eP95))} | ${median(rb.map((r) => r.e2eP95))} | ${fin(ra)} | ${fin(rb)} |`,
  );
}
L.push('');

L.push('**Drain capacity** (median job/detik, rasio terhadap 1 worker di environment yang sama):', '');
L.push(`| Workload | Worker | ${la} | ${lb} | ${lb} / ${la} |`, '|---|---|---|---|---|');
for (const w of ['light', 'io']) {
  const base = (d) => median(d.drain.filter((r) => r.workload === w && r.workers === 1).map((r) => r.jobsPerSec));
  for (const k of [1, 2, 4]) {
    const ma = median(A.drain.filter((r) => r.workload === w && r.workers === k).map((r) => r.jobsPerSec));
    const mb = median(B.drain.filter((r) => r.workload === w && r.workers === k).map((r) => r.jobsPerSec));
    L.push(`| ${w} | ${k} | ${ma} (${ratio(ma, base(A))}) | ${mb} (${ratio(mb, base(B))}) | ${ratio(mb, ma)} |`);
  }
}
L.push('');
L.push('**POST berurutan dari satu client (ms):**', '');
L.push(`| | ${la} | ${lb} |`, '|---|---|---|');
for (const k of ['postP50', 'postP95', 'postP99', 'clientRatePerSec']) L.push(`| ${k} | ${A.post[k]} | ${B.post[k]} |`);
L.push('');
const viol = (d) => [...d.ablation, ...d.drain, d.post].reduce((a, r) => a + r.consistency.violations, 0);
const dup = (d) => d.ablation.reduce((a, r) => a + r.duplicateSuccessJobs, 0);
const nRuns = (d) => d.ablation.length + d.drain.length + 1;
L.push(`**Invariant:** ${la}: ${viol(A)} violation di ${nRuns(A)} run, sukses ganda ${dup(A)}. ${lb}: ${viol(B)} violation di ${nRuns(B)} run, sukses ganda ${dup(B)}.`);
console.log(L.join('\n'));
