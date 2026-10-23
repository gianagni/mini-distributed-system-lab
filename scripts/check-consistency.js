// npm run check
// Memeriksa invariant DB_PATH vs REPORT_DIR. Exit 1 kalau ada violation, 2 kalau DB tidak bisa dibuka.
// Aman dijalankan saat API/worker hidup: hanya membaca (read-only).
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { checkConsistency } from '../src/consistency.js';

const cfg = loadConfig();
if (!existsSync(cfg.dbPath)) {
  console.error(`Database tidak ditemukan: ${cfg.dbPath}. Belum ada job, atau DB_PATH salah.`);
  process.exit(2);
}
const db = new DatabaseSync(cfg.dbPath, { readOnly: true });
db.exec(`PRAGMA busy_timeout = ${cfg.busyTimeoutMs};`);
const r = checkConsistency(db, cfg.reportDir);
db.close();

const countBy = (list) => list.reduce((acc, x) => ({ ...acc, [x.rule]: (acc[x.rule] ?? 0) + 1 }), {});
console.log(
  JSON.stringify(
    {
      dbPath: cfg.dbPath,
      reportDir: cfg.reportDir,
      checkedJobs: r.checkedJobs,
      violations: r.violations.length,
      violationsByRule: countBy(r.violations),
      warnings: r.warnings.length,
      warningsByRule: countBy(r.warnings),
      details: { violations: r.violations.slice(0, 20), warnings: r.warnings.slice(0, 20) },
    },
    null,
    2,
  ),
);
process.exit(r.violations.length > 0 ? 1 : 0);
