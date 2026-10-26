# Evidence C-3: `lease_at_risk` di Windows setelah C-2 (sandbox Linux + emulasi waktu Windows)

Kegagalan asli: Windows, commit `e48142e`, dilaporkan pemilik proyek (`lease_at_risk`, `w2`, `leaseLeftMs: 15`). Evidence di sini dibuat di sandbox Linux x86_64, Node v22.22.0 (SQLite 3.50.4), dengan emulasi waktu Windows. **Bukan** hasil Windows; lihat `docs/AUDIT.md` C-3 untuk batas emulasi dan apa yang masih perlu dari mesin Windows.

Commit: `954adeb` = `e48142e` + instrumentasi saja (dipakai sebagai "sebelum"); `eb62487` = perbaikan.

| File | Isi |
|---|---|
| `harness/wintimer.c` | Shim `LD_PRELOAD`: sleep busy handler dan timeout `epoll_wait` libuv dibulatkan ke tick 15.625 ms; biaya flush per `fsync` dengan distribusi Windows |
| `probe/before-954adeb.txt`, `-summary.json` | `npm run lease-probe`, 30 run, profil Windows, kode sebelum. Baris `at_risk:` = pemecahan anggaran lease per event |
| `probe/before-954adeb-example-run-006.json` | Satu run lengkap: timeline worker + event database untuk job yang diambil alih, okupansi lock per pemegang |
| `probe/variant-*.txt`, `-summary.json` | Varian yang dibandingkan (heartbeat/timestamp saja; batas lock waktu nyata; batas waktu nyata + chaining; heartbeat/timestamp + chaining). Diukur dari tree belum di-commit dengan switch eksperimen sementara |
| `probe/final-eb62487.txt`, `-summary.json`, `-example-*.json` | Probe yang sama pada commit perbaikan |
| `new-tests-on-954adeb.txt` | Test regresi C-3 dijalankan terhadap kode sebelum: yang gagal dan pesannya |
| `capstone-only-no-trace.txt` | Test kontensi capstone saja, tanpa `LEASE_TRACE`, emulasi Windows, 30 run per kode, error per run yang gagal |
| `repeat-*.txt`, `repeat-*-summary.json` | `npm run test:repeat` suite penuh, 10 run: `eb62487` (Linux, emulasi Windows), `954adeb` (emulasi Windows), tree akhir dengan perbaikan test (`final-*`) |

Path sandbox diganti `<scratch>` / `<repo>`.

## Menjalankan ulang

```bash
gcc -shared -fPIC -O2 -o /tmp/wintimer.so docs/evidence/sandbox-dashboard/contention-c3/harness/wintimer.c -ldl
export WINTICK_FSYNC_US=4700 WINTICK_FSYNC_SLOW_US=13700 WINTICK_FSYNC_SLOW_PCT=30
LD_PRELOAD=/tmp/wintimer.so npm run busy-wait-check    # harus ±16 / 110 / 299 / 1176 ms, commit p50 ±5.8 p90 ±14.7, setTimeout(1) ±15.4
LD_PRELOAD=/tmp/wintimer.so npm run lease-probe -- --runs 30 --out /tmp/probe
```
Di Windows sungguhan tanpa shim: `npm run lease-probe -- --runs 30 --out test-runs/<mesin>-lease-probe` (VALIDATION-PLAN §1c).
