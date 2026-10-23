// npm run clean
// Menghapus state lokal (database + laporan) supaya eksperimen bisa diulang dari nol.
// Hanya menghapus path di dalam direktori proyek, untuk mencegah salah hapus lewat env.
import { existsSync, rmSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cfg = loadConfig();
const targets = [
  resolve(cfg.dbPath),
  `${resolve(cfg.dbPath)}-wal`,
  `${resolve(cfg.dbPath)}-shm`,
  resolve(cfg.reportDir),
];

for (const t of targets) {
  const rel = relative(root, t);
  if (rel.startsWith('..') || rel === '' || resolve(root, rel) !== t) {
    console.error(`Menolak menghapus path di luar proyek: ${t}`);
    process.exit(1);
  }
}
for (const t of targets) {
  if (existsSync(t)) {
    rmSync(t, { recursive: true, force: true });
    console.log(`dihapus: ${relative(root, t)}`);
  }
}
const dataDir = dirname(resolve(cfg.dbPath));
console.log(`State bersih. (Direktori ${relative(root, dataDir) || '.'} dipertahankan.)`);
