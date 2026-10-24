// npm run busy-wait-check
// Mengukur berapa lama SQLITE_BUSY SEBENARNYA menunggu dibanding busy_timeout yang diset
// (AUDIT C-1). Busy handler SQLite menghitung durasi sleep nominal; sleep OS bisa molor
// (granularitas timer Windows default ±15.6 ms). Hasilnya menentukan seberapa realistis asumsi
// BUSY_TIMEOUT_MS + HEARTBEAT_MS < LEASE_MS di mesin ini. Hanya memakai file database sementara.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'busy-wait-'));
const path = join(dir, 'x.db');
const holder = new DatabaseSync(path);
holder.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x);');
const waiter = new DatabaseSync(path);

console.log(`Node ${process.version}, SQLite ${process.versions.sqlite}, ${process.platform} ${process.arch}`);
console.log('busy_timeout | percobaan | tunggu min | median | max | max / busy_timeout');
try {
  for (const timeoutMs of [1, 50, 200, 1000]) {
    waiter.exec(`PRAGMA busy_timeout = ${timeoutMs};`);
    const xs = [];
    const n = timeoutMs >= 1000 ? 3 : 10;
    for (let i = 0; i < n; i++) {
      holder.exec('BEGIN IMMEDIATE');
      const t0 = performance.now();
      try {
        waiter.exec('BEGIN IMMEDIATE');
        waiter.exec('ROLLBACK');
        throw new Error('lock tidak terpegang: pengukuran tidak sah');
      } catch (err) {
        if (err.errcode !== 5) throw err;
      }
      xs.push(performance.now() - t0);
      holder.exec('ROLLBACK');
    }
    xs.sort((a, b) => a - b);
    const f = (v) => `${v.toFixed(1)} ms`.padStart(10);
    console.log(
      `${String(timeoutMs).padStart(9)} ms | ${String(n).padStart(9)} | ${f(xs[0])} | ${f(xs[Math.floor(n / 2)])} | ${f(xs[n - 1])} | ${(xs[n - 1] / timeoutMs).toFixed(2)}x`,
    );
  }
} finally {
  waiter.close();
  holder.close();
  rmSync(dir, { recursive: true, force: true });
}
