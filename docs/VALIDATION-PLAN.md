# Validasi branch `feat/interactive-dashboard` di Windows dan InstaBox `nanad`

Tujuan: membuktikan dashboard, `npm run lab`, dan perbaikan CSRF (AUDIT S-1) bekerja di luar sandbox Linux tempat semuanya dibuat. Status saat dokumen ditulis: **semua langkah di bawah baru dijalankan di sandbox Linux** (Node 22.22.0). Hasil yang diharapkan di bawah berasal dari sandbox itu.

Aturan:
- **Jangan jalankan `npm run experiment`** untuk validasi ini. Script itu menimpa `docs/EXPERIMENT-RESULTS.md` dan `docs/experiment-results.json` (hasil capstone). Kalau terlanjur: `git checkout -- docs/EXPERIMENT-RESULTS.md docs/experiment-results.json`.
- Simpan bukti di folder **baru**, mis. `docs/evidence/windows-dashboard/` atau `docs/evidence/nanad-dashboard/`. Jangan menyentuh `docs/evidence/nanad/`.
- Catat apa adanya, termasuk kegagalan. Test yang gagal sekali lalu lulus tetap dicatat (lihat AUDIT "Flakiness").

## 0. Ambil branch

```bash
git fetch origin feat/interactive-dashboard
git checkout feat/interactive-dashboard
git log --oneline -4          # commit teratas harus sama dengan yang dilaporkan
node -v                       # >= v22.13
npm run doctor                # semua OK, termasuk "Port dashboard 127.0.0.1:3100 bebas"
```

## 1. Test suite

| | Linux / `nanad` | Windows (PowerShell) |
|---|---|---|
| Perintah | `npm test 2>&1 \| tee test-$(hostname).log` | `npm test 2>&1 \| Tee-Object -FilePath test-windows.log` |
| Hasil diharapkan | `# tests 76`, `# pass 76`, `# fail 0` | `# tests 76`, `# pass 75`, `# skipped 1` (SIGSTOP tidak ada di Windows), `# fail 0` |

Ulangi 3 kali untuk flakiness (`for i in 1 2 3; do npm test 2>&1 | grep -E '^# (pass|fail)'; done`).

Yang paling mungkin berbeda di Windows (belum pernah dijalankan di sana):
- Test kegagalan filesystem: rename ke direktori menghasilkan `EPERM` di Windows (Linux: `EISDIR`). Keduanya non-retryable, jadi test seharusnya tetap lulus.
- Penghapusan temp dir: proses dashboard dihentikan sebelum direktori dihapus (lihat `track()` di `test/helpers.js`). Kalau muncul `EBUSY`/`EPERM` saat cleanup, catat nama test-nya.
- Timing: test memakai lease 600 ms. Antivirus/Defender yang memindai `node.exe` bisa memperlambat start proses.

## 2. Lab dan dashboard (browser sungguhan)

```bash
npm run clean
npm run lab -- --workers 1 --fault-injection
```
Buka `http://127.0.0.1:3100/` (di `nanad`: lihat §4 untuk tunnel). Centang setiap baris:

| # | Langkah | Hasil diharapkan |
|---|---|---|
| 1 | Overview terbuka | Header: "Polling tiap 2 s · snapshot server HH:MM:SS"; badge "lab: fault injection aktif" |
| 2 | Buat job → kirim tanpa preset | Pindah ke detail, banner "202 Accepted", status PENDING/RUNNING → SUCCEEDED tanpa reload |
| 3 | Preset "Transient 2×" | 3 attempt; timeline menampilkan backoff (arsir kuning) dan antre (arsir abu) |
| 4 | Preset "Permanent" | FAILED, PERMANENT, 1 attempt |
| 5 | Isi Idempotency-Key, kirim dua kali; lalu ubah orderCount dan kirim lagi | 202 → 200 (job sama) → 409 di panel Hasil |
| 6 | Preset "Crash setelah tulis" | Terminal lab: `w1 berhenti ... SIGKILL` lalu `restart w1`. Setelah ±5 s job SUCCEEDED di attempt 2; attempt 1 "worker hilang", bar diarsir merah |
| 7 | Preset "Lambat 5 s", lalu matikan worker (lihat bawah) dalam 5 detik | Overview → "Sedang RUNNING": sisa lease turun ke negatif, lalu job selesai di attempt 2 |
| 8 | Polling: pilih "Mati" | Header "Polling mati"; angka berhenti berubah |
| 9 | Hentikan lab (Ctrl+C) sementara tab dashboard terbuka | Header berubah "⚠ Gagal sejak …", data lama tetap tampil |
| 10 | Lebar jendela sempit (±400 px) atau DevTools mode mobile | Tidak ada scroll horizontal halaman; tabel lebar scroll di dalam panelnya |

Mematikan worker untuk langkah 7 (lab me-restart otomatis):
- Linux: `pkill -9 -f 'src/worker.js'`
- Windows PowerShell: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*worker.js*' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`

Setelah selesai: `npm run check` (lab boleh tetap jalan) harus exit 0, `violations: 0`.

## 3. Perbaikan CSRF di browser sungguhan (AUDIT S-1)

Dengan lab masih berjalan, di terminal lain:
```bash
npm run csrf-check
```
Buka URL yang dicetak (`http://localhost:4801/`) di Chrome/Edge/Firefox. Halaman mencoba membuat job ke `http://127.0.0.1:3000/jobs` dari situs lain.

| Hasil terminal | Arti |
|---|---|
| `Job yang berhasil dibuat halaman lintas situs: 0` dan `LULUS`, exit 0 | Perbaikan bekerja di browser ini |
| `GAGAL`, exit 1 | API masih rentan. Catat browser + versi, dan log API (`/jobs` dengan status 202 dari request itu) |

Di halaman, baris B harus "diblokir browser (preflight CORS ditolak)". Iframe di bawah form menampilkan error `UNSUPPORTED_MEDIA_TYPE`.

## 4. InstaBox `nanad` tanpa browser lokal

Dari laptop, tunnel tiga port (dashboard, API untuk csrf-check, halaman csrf-check):
```bash
ssh -L 3100:127.0.0.1:3100 -L 3000:127.0.0.1:3000 -L 4801:localhost:4801 <user>@<nanad>
```
Pastikan laptop tidak sedang menjalankan API sendiri di port 3000. Lalu jalankan §2 dan §3 di `nanad` dan buka URL-nya di browser laptop. Jangan memakai `DASHBOARD_HOST=0.0.0.0` untuk ini.

## 5. Bukti yang dilampirkan

```
docs/evidence/<mesin>-dashboard/
  test-1.log, test-2.log, test-3.log    # output npm test lengkap
  doctor.txt                            # npm run doctor
  check.txt                             # npm run check setelah §2
  csrf-check.txt                        # output terminal §3 + browser dan versinya
  checklist.md                          # tabel §2 dengan hasil per baris, plus OS, versi Node, browser
  screenshots/                          # opsional: overview, detail langkah 3 dan 6
```
Lalu bandingkan dengan hasil sandbox di `docs/REFERENCE-RESEARCH.md` §10 dan `docs/AUDIT.md` S-1.
