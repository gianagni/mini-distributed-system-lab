# Validasi branch `feat/interactive-dashboard` di Windows dan InstaBox `nanad`

Tujuan: membuktikan dashboard, `npm run lab`, perbaikan CSRF (AUDIT S-1), dan proteksi DNS rebinding/Origin (AUDIT S-2) bekerja di luar sandbox Linux tempat semuanya dibuat. Status saat dokumen ditulis: **semua langkah di bawah baru dijalankan di sandbox Linux** (Node 22.22.0). Hasil yang diharapkan di bawah berasal dari sandbox itu.

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
| Hasil diharapkan | `# tests 103`, `# pass 103`, `# fail 0` | `# tests 103`, `# pass 101`, `# skipped 2` (SIGSTOP; pemeriksa `/proc` saat cleanup), `# fail 0` |

Node 24 mencetak format `spec` (`ℹ tests 103`, `ℹ pass 101`), bukan TAP. Itu bukan kegagalan. `npm run test:repeat` selalu memakai TAP.

Lalu pengulangan dengan bukti (wajib, terkait AUDIT U-1):
```bash
npm run test:repeat -- --runs 20 --out test-runs/<mesin>
```
Hasilnya: `run-NNN.log` (TAP lengkap) per run dan `summary.json` (exit code, sinyal, durasi, load average, nama test yang gagal + `failureType`). Salin seluruh folder ke bukti. Di Windows, run dengan `skipped=1` dan exit 0 dihitung lulus. Kalau ada run gagal, **jangan** mengulang sampai hijau: lampirkan log run itu apa adanya.

Yang paling mungkin berbeda di Windows (belum pernah dijalankan di sana):
- Test kegagalan filesystem: rename ke direktori menghasilkan `EPERM` di Windows (Linux: `EISDIR`). Keduanya non-retryable, jadi test seharusnya tetap lulus.
- Penghapusan temp dir: proses dashboard dihentikan sebelum direktori dihapus (lihat `track()` di `test/helpers.js`). Kalau muncul `EBUSY`/`EPERM` saat cleanup, catat nama test-nya.
- Timing: test memakai lease 600 ms. Antivirus/Defender yang memindai `node.exe` bisa memperlambat start proses.

## 1b. Kontensi SQLite (AUDIT C-1, wajib di Windows)

Pertama, ukur seberapa lama `SQLITE_BUSY` sebenarnya menunggu di mesin ini (menguji hipotesis granularitas timer Windows):
```bash
npm run busy-wait-check
```
Simpan outputnya (`busy-wait.txt`). Selain tabel tunggu BUSY (Windows terukur ±1.5x di 200 ms), output sekarang memuat:
- `commit tulis (lock dipegang)`: biaya flush per commit di mesin ini. Di emulasi, test kontensi stabil sampai ±2 ms; mulai ±5 ms sebagian run mencatat `lease_at_risk` (AUDIT C-2). **Angka ini yang paling dibutuhkan** untuk menilai hasil test kontensi.
- `setTimeout(1) nyata`: seberapa sering worker `POLL_MS=1` benar-benar polling (tidak bisa diemulasi di Linux).

Lalu ulangi khusus file yang relevan, lebih sering daripada suite penuh:
```bash
npm run test:repeat -- --runs 30 --out test-runs/<mesin>-contention test/reliability.test.js test/contention.test.js
```
| Hasil | Arti |
|---|---|
| 30/30 lulus | Perbaikan bekerja di mesin ini. Catat juga jumlah `state_write_busy`/`claim_busy` dari baris diagnostik `claim_busy=... state_write_busy=...` di log |
| `kontensi: 4 worker ...` gagal dengan `lease_at_risk` saja | Kejenuhan lock: satu worker tidak dapat lock sepanjang satu lease. Bandingkan dengan `commit tulis` di `busy-wait.txt`. Bukan salah klasifikasi; lihat keputusan terbuka di AUDIT C-2. **Lampirkan log run itu** |
| `job_state_write_failed reason=lease_too_short` dengan `tries: 1` dan tanpa `state_write_busy` | Regresi C-2 (retry tidak menyesuaikan tenggat). Lampirkan log |
| Gagal `submit=... gaveUp>0` | `POST /jobs` 503 lebih dari 10x berturut-turut untuk satu job. Lampirkan log (berisi angka attempted/accepted/503) |
| Gagal `ada job yang berakhir FAILED. byStatus=...` atau `waitUntil: timeout ... byStatus=...` | Job tidak selesai sukses. Pesan memuat jumlah per status, `failedByErrorClass`, hasil pengiriman, dan error worker. Lampirkan log |
| `EBUSY` / `Cleanup: masih ada file terbuka` | Kebocoran koneksi di test. Lampirkan nama test |
| Gagal dengan `errorClass: INTERNAL` + `database is locked` | Perbaikan tidak bekerja di mesin ini. Lampirkan log |
| Error lain | Lampirkan log apa adanya |

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

## 3a. Host dan Origin (AUDIT S-2)

Dengan lab masih berjalan, di terminal lain:
```bash
npm run host-check
```
Harus 14 baris `LULUS` (7 untuk API, 7 untuk dashboard) dan exit 0. Ini mengirim `Host: attacker.test:<port>` (keadaan setelah DNS rebinding), Host tanpa port / port lain, dan `POST` JSON dengan `Origin` lain. Akses sah lewat `127.0.0.1` dan `localhost` harus tetap 200.

## 3b. Perbaikan CSRF di browser sungguhan (AUDIT S-1)

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

Dari laptop, tunnel tiga port (dashboard, API untuk csrf-check, halaman csrf-check), **dengan nomor port lokal sama** dengan port di `nanad`:
```bash
ssh -L 3100:127.0.0.1:3100 -L 3000:127.0.0.1:3000 -L 4801:localhost:4801 <user>@<nanad>
```
Pastikan laptop tidak sedang menjalankan API sendiri di port 3000. Port lokal yang sama penting: API dan dashboard memeriksa header `Host` (AUDIT S-2), dan browser mengirim port lokal tunnel. Kalau terpaksa memakai port lokal lain, mis. `-L 8100:127.0.0.1:3100`, jalankan lab di `nanad` dengan `ALLOWED_HOSTS=127.0.0.1:8100,localhost:8100`, lalu catat ini di checklist. Uji juga sekali dengan port lokal berbeda **tanpa** `ALLOWED_HOSTS`: dashboard harus menolak dengan `403 BAD_HOST` (bukti allowlist tidak terbuka). Lalu jalankan §2 dan §3 di `nanad` dan buka URL-nya di browser laptop. Jangan memakai `DASHBOARD_HOST=0.0.0.0` untuk ini.

## 5. Bukti yang dilampirkan

```
docs/evidence/<mesin>-dashboard/
  test-1.log, test-2.log, test-3.log    # output npm test lengkap
  doctor.txt                            # npm run doctor
  check.txt                             # npm run check setelah §2
  test-runs/                            # folder npm run test:repeat (log per run + summary.json)
  busy-wait.txt                         # output npm run busy-wait-check (§1b)
  host-check.txt                        # output §3a
  csrf-check.txt                        # output terminal §3b + browser dan versinya
  checklist.md                          # tabel §2 dengan hasil per baris, plus OS, versi Node, browser
  screenshots/                          # opsional: overview, detail langkah 3 dan 6
```
Lalu bandingkan dengan hasil sandbox di `docs/REFERENCE-RESEARCH.md` §10 dan `docs/AUDIT.md` S-1, S-2, U-1.
