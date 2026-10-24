# Evidence C-2: 5 kegagalan validasi Windows setelah C-1 (sandbox Linux + emulasi waktu Windows)

Kegagalan asli: Windows x64, Node v24.22.1, SQLite 3.53.4, commit `4d85258` (dilaporkan pemilik proyek). Evidence di sini dibuat di sandbox Linux x86_64 dengan Node v22.22.0 (SQLite 3.50.4) dan Node v24.22.1 (SQLite 3.53.4). **Bukan** hasil Windows; lihat `docs/AUDIT.md` C-2 untuk batas emulasi.

| File | Isi |
|---|---|
| `emulation-validation.txt` | `busy-wait-check` tanpa dan dengan shim tick Windows, Node 22 dan 24, dibanding angka Windows |
| `cleanup-leak-before.txt` | Pemeriksa file terbuka saat cleanup pada urutan cleanup lama: tepat 3 test yang EBUSY di Windows |
| `claim-lease.txt` | Lease yang diberikan claim setelah menunggu lock, sebelum/sesudah perbaikan |
| `original-test-replay.txt` | Replay test kontensi capstone (`harness/orig-probe.test.js`) dengan pencatatan status POST dan jumlah job, kode `4d85258` vs C-2, emulasi flush +5/+10 ms, 6 run per sel |
| `check-test-replay.txt` | Replay bentuk lama test "npm run check aman saat worker aktif" (`harness/check-probe.test.js`), 30 run emulasi +5 ms: penyebab timeout 120 s |
| `check-test-after.txt` | Test yang sama setelah perbaikan, 30 run emulasi +5 ms |
| `repeat-*-summary.json` | `npm run test:repeat` suite penuh pada tree final: Node 22 20x, Node 24 20x, Node 24 + emulasi (+2 ms) 10x, Node 24 + emulasi (+5 ms) 10x. Path sandbox diganti `<scratch>` |
| `harness/` | `wintick.c` (shim), `orig-probe.test.js`, `check-probe.test.js`, `claim-stale-now.mjs` |

## Menjalankan ulang emulasi

```bash
gcc -shared -fPIC -O2 -o /tmp/wintick.so docs/evidence/sandbox-dashboard/contention-c2/harness/wintick.c -ldl
LD_PRELOAD=/tmp/wintick.so npm run busy-wait-check                       # harus ±15.9 / 110 / 299 / 1176 ms
WINTICK_FSYNC_US=5000 LD_PRELOAD=/tmp/wintick.so npm test                 # + flush 5 ms per commit
REPO="$PWD" WINTICK_FSYNC_US=10000 LD_PRELOAD=/tmp/wintick.so \
  node --test docs/evidence/sandbox-dashboard/contention-c2/harness/orig-probe.test.js
```
Shim hanya membulatkan sleep yang memblokir (dipakai busy handler SQLite) ke tick 15.625 ms dan opsional menambah biaya `fsync`/`fdatasync`. Tidak meniru timer Node/libuv, penguncian file Windows, maupun biaya flush disk Windows yang sebenarnya.
