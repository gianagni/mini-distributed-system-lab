# Evidence C-1: SQLITE_BUSY pada tulisan status (sandbox Linux)

Kegagalan asli ditemukan pemilik proyek di Windows x64 (Node v24.22.1, SQLite 3.53.4). Evidence di folder ini dibuat di sandbox Linux x86_64 dengan **Node v22.22.0 (SQLite 3.50.4)** dan **Node v24.22.1 (SQLite 3.53.4)**, binary resmi nodejs.org yang checksum-nya diverifikasi terhadap `SHASUMS256.txt`. Windows belum diuji; lihat `docs/VALIDATION-PLAN.md` §1b.

| File | Isi |
|---|---|
| `injection-before.txt` / `injection-after.txt` | Fault injection terkontrol (BUSY sungguhan di operasi tertentu), kode sebelum / sesudah perbaikan, kedua versi Node |
| `forced-contention-old-vs-new.txt` | 4 worker, POLL 1 ms, `BUSY_TIMEOUT_MS=1`, 150 job, 3 run per versi kode |
| `node22-vs-node24-original-test.txt` | Test kontensi capstone 20x per versi Node, reporter TAP |
| `busy-wait-linux.txt` | `npm run busy-wait-check` di kedua versi Node |
| `repeat-node22-summary.json`, `repeat-node24-summary.json` | 20x suite penuh per versi Node pada kode final (`npm run test:repeat`) |
| `harness/` | Script yang menghasilkan file di atas |

## Menjalankan ulang

```bash
# fault injection (repoRoot = folder repo yang diuji; skenario: windows-log, success-charged-as-failure,
# task-fail-write-busy, busy-never-clears, non-busy-db-error)
node --disable-warning=ExperimentalWarning docs/evidence/sandbox-dashboard/contention-c1/harness/repro.mjs "$PWD" windows-log

# kontensi dipaksa: salin probe ke test/ lalu jalankan
cp docs/evidence/sandbox-dashboard/contention-c1/harness/forced-probe.test.js test/zz-forced-probe.test.js
node --disable-warning=ExperimentalWarning --test test/zz-forced-probe.test.js; rm test/zz-forced-probe.test.js
```
Untuk versi "sebelum", jalankan pada checkout commit `8c78683`.
