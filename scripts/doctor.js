// npm run doctor
// Pemeriksaan environment sebelum menjalankan sistem. Tidak mengubah apa pun selain
// membuat lalu menghapus satu file uji di direktori data.
import { mkdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { arch, cpus, freemem, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadConfig, loadDashboardConfig } from '../src/config.js';

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

const [major, minor] = process.versions.node.split('.').map(Number);
check('Node.js >= 22.13', major > 22 || (major === 22 && minor >= 13), process.version);

let sqliteOk = false;
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const v = db.prepare('SELECT sqlite_version() AS v').get().v;
  db.close();
  sqliteOk = true;
  check('node:sqlite tersedia', true, `SQLite ${v}`);
} catch (err) {
  check('node:sqlite tersedia', false, err.message);
}

let cfg = null;
try {
  cfg = loadConfig();
  check('Konfigurasi env valid', true, `HOST=${cfg.host} PORT=${cfg.port}`);
} catch (err) {
  check('Konfigurasi env valid', false, err.message);
}

if (cfg) {
  for (const [label, dir] of [
    ['DB_PATH dir', dirname(resolve(cfg.dbPath))],
    ['REPORT_DIR', resolve(cfg.reportDir)],
  ]) {
    try {
      mkdirSync(dir, { recursive: true });
      const probe = join(dir, `.doctor-${process.pid}`);
      writeFileSync(probe, 'ok');
      rmSync(probe);
      const fs = statfsSync(dir);
      const freeGiB = (fs.bavail * fs.bsize) / 2 ** 30;
      check(`${label} bisa ditulis`, true, `${dir} (bebas ${freeGiB.toFixed(1)} GiB)`);
      if (freeGiB < 0.5) check(`${label} ruang disk >= 0.5 GiB`, false, `${freeGiB.toFixed(2)} GiB`);
    } catch (err) {
      check(`${label} bisa ditulis`, false, `${dir}: ${err.code ?? err.message}`);
    }
  }

  if (cfg.port !== 0) {
    const free = await new Promise((res) => {
      const srv = createServer();
      srv.once('error', (e) => res(e.code));
      srv.listen(cfg.port, cfg.host, () => srv.close(() => res(true)));
    });
    check(`Port ${cfg.host}:${cfg.port} bebas`, free === true, free === true ? 'bebas' : `${free} (API lain sudah jalan?)`);
  }
}

// Dashboard (npm run dashboard / npm run lab). Port terpakai hanya peringatan kalau dashboard memang sedang jalan.
try {
  const d = loadDashboardConfig();
  check('Konfigurasi dashboard valid', true, `DASHBOARD=${d.host}:${d.port} API_URL=${d.apiUrl}`);
  if (d.port !== 0) {
    const free = await new Promise((res) => {
      const srv = createServer();
      srv.once('error', (e) => res(e.code));
      srv.listen(d.port, d.host, () => srv.close(() => res(true)));
    });
    check(`Port dashboard ${d.host}:${d.port} bebas`, free === true, free === true ? 'bebas' : `${free} (dashboard lain sudah jalan?)`);
  }
} catch (err) {
  check('Konfigurasi dashboard valid', false, err.message);
}

console.log(`Platform: ${platform()} ${release()} ${arch()}, ${cpus().length} CPU, RAM bebas ${(freemem() / 2 ** 30).toFixed(1)} GiB`);
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'GAGAL'} ${r.name}: ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? 'Semua pemeriksaan lulus.' : `${failed} pemeriksaan gagal.`);
process.exit(failed === 0 && sqliteOk ? 0 : 1);
