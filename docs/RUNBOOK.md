# Runbook: menjalankan mini-job-system di InstaBox

Status: semua command di bawah sudah dijalankan di sandbox Linux x86_64 dengan Node 22.22.0. Pemilik proyek menjalankan `npm test` (dilaporkan 58/58) dan `npm run experiment` (3 repetisi) di InstaBox `nanad` (Node v22.23.3, 4 vCPU AMD EPYC, 8 GiB). Hasilnya ada di `docs/evidence/nanad/`. Langkah 3-7 (background, stop, clean) belum dilaporkan dari `nanad`.

Tidak butuh Docker, `npm install`, database server, atau internet.

## 1. Environment check

```bash
cd ~/mini-job-system          # sesuaikan dengan lokasi unzip
node -v                       # wajib >= v22.13 (nanad: v22.23.3)
npm -v
npm run doctor
```

Contoh output sehat:
```
OK   Node.js >= 22.13: v22.x.x
OK   node:sqlite tersedia: SQLite 3.x
OK   Konfigurasi env valid: HOST=127.0.0.1 PORT=3000
OK   DB_PATH dir bisa ditulis: .../data (bebas N GiB)
OK   REPORT_DIR bisa ditulis: .../data/reports (bebas N GiB)
OK   Port 127.0.0.1:3000 bebas: bebas
Semua pemeriksaan lulus.
```
Exit code 0 berarti siap. Kalau ada `GAGAL`, lihat bagian Troubleshooting.

## 2. Menjalankan tests

```bash
npm test                      # 103 test (58 capstone + 13 dashboard + 14 security + 18 contention), sekitar 35 detik
```
Hasil yang diharapkan ada di baris akhir: `# pass 103` dan `# fail 0`. Di Windows dua test di-skip: `worker zombie (SIGSTOP...)` (SIGSTOP tidak ada) dan pemeriksa file terbuka saat cleanup (butuh `/proc`; di Windows file terbuka sudah membuat `rm` gagal EBUSY sendiri). Hasilnya `# pass 101`, `# skipped 2`. Node 24 memakai format `spec` secara default, jadi barisnya `ℹ pass 103` / `ℹ fail 0`. Setiap test dibatasi 120 detik (`--test-timeout`, per test, bukan per file), jadi test yang hang muncul sebagai `testTimeoutFailure`, bukan menggantung. (Run `nanad` yang dilaporkan 58/58 terjadi sebelum test dashboard ditambahkan.) Untuk memeriksa flakiness, pakai runner yang menyimpan bukti (log TAP lengkap per run, exit code, nama test gagal, `summary.json`):
```bash
npm run test:repeat -- --runs 20          # log di test-runs/<waktu>/ (di-ignore git)
```
Test memakai temp directory dan port acak, jadi tidak mengganggu `data/` atau port 3000.

## 3. Menjalankan API dan worker

**Mode interaktif** (satu terminal per proses, `Ctrl+C` untuk berhenti):
```bash
npm run api                                   # terminal 1
WORKER_ID=w1 npm run worker                   # terminal 2
WORKER_ID=w2 npm run worker                   # terminal 3 (opsional)
```

**Mode background** (untuk sesi SSH/web terminal yang bisa terputus):
```bash
mkdir -p logs run
nohup node --disable-warning=ExperimentalWarning src/api.js > logs/api.log 2>&1 & echo $! > run/api.pid
for i in 1 2; do
  WORKER_ID=w$i nohup node --disable-warning=ExperimentalWarning src/worker.js > logs/worker-$i.log 2>&1 &
  echo $! > run/worker-$i.pid
done
sleep 1; curl -s localhost:3000/healthz       # {"ok":true}
```
Proses dijalankan dengan `node` langsung, bukan `npm run`, supaya PID yang disimpan adalah PID proses sebenarnya.

Untuk mencoba fault injection, tambahkan `ALLOW_FAULT_INJECTION=1` ke **API dan semua worker**. API tetap hanya mendengar di `127.0.0.1`.

## 4. Membuat job dan memeriksa hasil

```bash
curl -s -X POST localhost:3000/jobs -H 'content-type: application/json' \
  -H 'Idempotency-Key: rekap-001' -d '{"type":"order_report","payload":{"orderCount":50000,"seed":7}}'
# -> {"id":"<jobId>","status":"PENDING",...}

curl -s localhost:3000/jobs/<jobId>           # status, attempts, error, result.sha256, events
curl -s localhost:3000/metrics                # counter, latency, health
ls data/reports/                              # <jobId>.json
npm run check                                 # invariant DB vs file; exit 0 = konsisten
```

Field `/metrics` yang perlu dipantau:

| Field | Arti kalau naik terus |
|---|---|
| `health.pendingReady`, `health.oldestReadyPendingAgeMs` | Worker tidak jalan atau terlalu sedikit |
| `health.runningWithExpiredLease` | Ada worker mati; job akan diambil alih (kecuali `RECOVERY=0`) |
| `health.oldestRunningAgeMs` | Ada job yang sangat lama, bandingkan dengan `JOB_TIMEOUT_MS` |
| `failedByErrorClass` | Jenis kegagalan; `STORAGE` biasanya berarti masalah disk/path |
| `counters.duplicateSuccessJobs` | Harus selalu 0 |

Log adalah JSON per baris. Contoh filter error: `grep '"level":"error"' logs/*.log`.

## 5. Menjalankan eksperimen

Hentikan dulu beban lain di mesin karena angka latency sensitif terhadap CPU. Eksperimen memakai temp directory dan port acak, jadi tidak menyentuh `data/`.
```bash
npm run experiment            # 3 repetisi, sekitar 5 menit
EXP_REPS=1 npm run experiment # cepat, sekitar 2 menit
```
Output: `docs/EXPERIMENT-RESULTS.md` dan `docs/experiment-results.json` (ditimpa). Exit code 1 kalau ada invariant violation. Untuk menyimpan hasil mesin lain terpisah dari hasil sandbox (contoh yang dipakai untuk `nanad`):
```bash
mkdir -p docs/evidence/nanad
cp docs/EXPERIMENT-RESULTS.md docs/evidence/nanad/EXPERIMENT-RESULTS.nanad-3reps.md
cp docs/experiment-results.json docs/evidence/nanad/experiment-results.nanad-3reps.json
node scripts/compare-results.js docs/experiment-results.json sandbox \
  docs/evidence/nanad/experiment-results.nanad-3reps.json nanad   # tabel perbandingan
```

## 6. Menghentikan proses dengan aman

```bash
for f in run/worker-*.pid run/api.pid; do kill -TERM "$(cat "$f")" 2>/dev/null; done
sleep 2; tail -n 1 logs/worker-1.log           # ..."event":"worker_stopped"
```
- Worker yang menerima `SIGTERM` berhenti mengambil job baru, menyelesaikan job yang sedang jalan (maksimal 10 detik), lalu keluar.
- Kalau dipaksa (`kill -9`) atau melewati 10 detik, job tetap `RUNNING`, lalu diambil alih worker lain setelah `LEASE_MS`. Tidak ada data yang hilang, hanya satu attempt terpakai.
- API menyelesaikan request yang sedang berjalan lalu keluar.

## 7. Mengulang dari state bersih

```bash
# hentikan proses dulu (langkah 6), lalu:
npm run clean                 # hapus data/jobs.db(+wal/shm) dan data/reports
rm -rf logs run
```
`clean` menolak menghapus path di luar direktori proyek, walaupun `DB_PATH`/`REPORT_DIR` diarahkan ke luar.

## 8. Troubleshooting

| Gejala | Penyebab umum | Tindakan |
|---|---|---|
| `doctor`: Node < 22.13 atau `node:sqlite` gagal | Versi Node lama | Pasang Node 22 LTS terbaru |
| `EADDRINUSE` / doctor: port tidak bebas | API lama masih jalan | `ss -ltnp \| grep 3000`, hentikan prosesnya, atau pakai `PORT=3001` |
| API menolak start: `HOST=... bukan loopback` | Disengaja: API tanpa autentikasi | Akses lewat SSH tunnel/port forward ke `127.0.0.1`. `ALLOW_REMOTE=1` hanya kalau jaringan sudah dilindungi |
| Start gagal: `BUSY_TIMEOUT_MS + HEARTBEAT_MS harus lebih kecil dari LEASE_MS` | Kombinasi env tidak aman | Turunkan `BUSY_TIMEOUT_MS` atau naikkan `LEASE_MS` |
| `400 ... ALLOW_FAULT_INJECTION` | Fault injection mati | Set `ALLOW_FAULT_INJECTION=1` di API dan worker (loopback saja) |
| Job `FAILED` dengan error `PERMANENT ... ditolak: worker ini berjalan tanpa ALLOW_FAULT_INJECTION` | Worker tidak memakai flag yang sama dengan API | Samakan env worker |
| Job `PENDING` terus, `pendingReady` naik | Tidak ada worker hidup | Jalankan worker, cek `logs/worker-*.log` |
| Job `RUNNING` lama, `runningWithExpiredLease > 0` | Worker mati; atau `RECOVERY=0` | Pastikan ada worker hidup dan `RECOVERY` bukan 0 |
| Log `worker_loop_error` / `job_state_write_failed` dengan `database is locked` | Proses lain memegang transaksi tulis lama (mis. `sqlite3` CLI) | Tutup proses itu. Job pulih otomatis lewat lease |
| Log `warn state_write_busy` / `warn heartbeat_busy` sesekali | Kontensi lock saat menulis status atau heartbeat (AUDIT C-1). Diulang otomatis selama lease aman | Normal di bawah beban. Kalau sering: kurangi worker atau naikkan `POLL_MS` |
| Log `error job_state_write_failed` dengan `reason` | `retry_window_exhausted` / `lease_too_short`: lock tidak didapat selama satu lease penuh. `non_busy_error`: error database lain (disk, I/O), lihat `writeErrorCode` | Job dipulihkan lewat lease (attempt terpakai, `WORKER_LOST`). Cari proses yang memegang lock lama; untuk `non_busy_error` periksa disk (`npm run doctor`) |
| Log `error lease_at_risk` | Heartbeat tidak dapat lock dan sisa lease (`leaseLeftMs`) tidak cukup untuk satu heartbeat lagi. Field menjelaskan sebabnya (AUDIT C-3): `blockedBy`/`lagMs` = heartbeat tertunda oleh operasi database sinkron (biasanya `write:complete` yang menunggu lock), `lockWaitMs` = tunggu heartbeat itu sendiri, `leaseFrom` = asal batas lease yang berlaku | Risiko nyata, bukan false positive: batas di log = `lease_expires_at` di database. Cek `job_events`: `lease_expired` untuk attempt itu berarti job benar-benar diambil alih (fencing menolak hasil worker lama: `stale_completion_rejected`). Kalau sering: `npm run lease-probe` (okupansi lock per jendela) dan `commit tulis` di `npm run busy-wait-check` |
| Log `warn lease_overrun` | Tulisan status mendarat setelah batas lease di database (`overrunMs`). `accepted: true` = belum ada worker lain yang mengambil alih; `false` = sudah, tulisan ditolak fencing | Tidak ada data ganda. Biasanya didahului `lease_at_risk` atau `state_write_busy`; tangani seperti `lease_at_risk` |
| Test gagal `Cleanup: masih ada file terbuka` (Linux) atau `EBUSY` saat menghapus temp dir (Windows) | Test meninggalkan koneksi SQLite terbuka sebelum direktori dihapus | Bug di test: daftarkan penutup lewat `setup().defer()` / `harness.adopt()` (AUDIT C-2) |
| API `503 DB_BUSY` | `POST /jobs` tidak dapat lock dalam `BUSY_TIMEOUT_MS`. Tidak ada job yang dibuat | Ulangi setelah `Retry-After`, sebaiknya dengan `Idempotency-Key` yang sama |
| Log `warn claim_busy` sesekali | Banyak worker berebut lock dengan polling cepat | Normal di bawah beban. Kalau terus-menerus: kurangi worker atau naikkan `POLL_MS` |
| Job `FAILED` `STORAGE` | `REPORT_DIR` tidak bisa ditulis, path salah, atau disk penuh | `npm run doctor`, `df -h .` |
| `415 UNSUPPORTED_MEDIA_TYPE` | Client tidak mengirim `Content-Type: application/json` (mis. `curl -d` tanpa `-H`) | Tambahkan `-H 'content-type: application/json'`. Disengaja: proteksi CSRF (AUDIT S-1) |
| `429 QUEUE_FULL` | Antrean melebihi `MAX_PENDING` | Tambah worker atau tunggu. Naikkan `MAX_PENDING` hanya dengan alasan |
| `npm run check` exit 1 | Invariant dilanggar (bug atau file diubah manual) | Salin `data/` untuk investigasi **sebelum** `clean`, lalu catat temuan |
| `npm run check` warning `orphan_report` / `temp_file_left` | File dari attempt yang crash | Diizinkan desain. File itu bukan hasil sah |
| Test timing gagal sesekali di mesin sibuk | Test memakai lease 600 ms | Ulangi di mesin idle, catat sebagai flaky beserta output-nya |

## 9. Status verifikasi di InstaBox

| Item | Status |
|---|---|
| `npm test` | Dilaporkan 58/58 di `nanad`. Log tidak dilampirkan |
| `npm run experiment` (3 repetisi) | Ada di `docs/evidence/nanad/`. Markdown = render JSON, konsisten, SHA-256 ZIP cocok (`COMPARISON.md`) |
| Langkah 3-7 (background, job manual, stop, clean) | Belum dilaporkan dari `nanad` |
| Dashboard (§10) + S-1 + S-2 + C-1 + C-2: `npm test` 103/103 (Node 22.22.0 dan 24.22.1, 20/20 run masing-masing; emulasi waktu tunggu Windows: flush +2 ms 10/10, +5 ms 9/10 karena `lease_at_risk`, AUDIT C-2), `npm run lab`, `csrf-check`, `host-check`, skenario browser | Hanya di sandbox Linux (Node 22.22.0, Chromium headless). **Belum** dijalankan di `nanad` maupun Windows; langkahnya di `docs/VALIDATION-PLAN.md` |
| Lokasi storage eksperimen | Eksperimen memakai `os.tmpdir()`. Jalankan `df -T /tmp "$(pwd)/data"` untuk tahu apakah `/tmp` adalah tmpfs. Ini menentukan apakah angka throughput mewakili disk persisten |

## 10. Dashboard (Reliability Lab)

Tidak butuh `npm install` atau build. Dashboard adalah proses ketiga yang membaca `data/jobs.db` secara read-only dan meneruskan pembuatan job ke API.

### Satu perintah (Linux, macOS, Windows)

```bash
npm run lab                                   # API + 2 worker + dashboard
npm run lab -- --workers 3 --fault-injection  # dengan panel fault injection (loopback saja)
npm run lab -- --help
```
Buka `http://127.0.0.1:3100/`. `Ctrl+C` menghentikan semuanya. Worker yang mati (mis. preset "Crash setelah tulis" atau `kill -9`) di-restart setelah 1 detik dengan `WORKER_ID` yang sama, seperti supervisor; pakai `--no-restart` untuk mengamati job yang menunggu tanpa worker.

`npm run lab` dibuat terutama untuk Windows: `WORKER_ID=w1 npm run worker` tidak jalan di cmd/PowerShell. Kalau tetap ingin menjalankan proses satu per satu di Windows:
```powershell
# PowerShell, satu terminal per proses
npm run api
$env:WORKER_ID="w1"; npm run worker
npm run dashboard
```
```bat
:: cmd.exe
set "WORKER_ID=w1" && npm run worker
```
Fault injection di Windows: `npm run lab -- --fault-injection` (lebih mudah daripada men-set env di tiga terminal).

Catatan Windows (belum diuji di Windows sungguhan, berdasarkan perilaku Node yang terdokumentasi):
- Windows tidak punya `SIGTERM` sungguhan. `Ctrl+C` / `kill()` langsung menghentikan proses, jadi worker tidak sempat graceful shutdown. Job `RUNNING` di-reclaim setelah `LEASE_MS` saat lab dijalankan lagi. Tidak ada data yang hilang, hanya satu attempt terpakai.
- Hentikan dashboard sebelum `npm run clean`: Windows tidak bisa menghapus file database yang sedang dibuka.

### Proses terpisah (Linux/InstaBox)

```bash
npm run api                                   # terminal 1
WORKER_ID=w1 npm run worker                   # terminal 2
npm run dashboard                             # terminal 3 -> http://127.0.0.1:3100/
```
Background, sama dengan §3:
```bash
nohup node --disable-warning=ExperimentalWarning src/dashboard.js > logs/dashboard.log 2>&1 & echo $! > run/dashboard.pid
```

### Membuka dashboard dari InstaBox

Dashboard hanya mendengar di `127.0.0.1` (tanpa autentikasi, sama seperti API). Dari laptop, pakai SSH tunnel, bukan `DASHBOARD_HOST=0.0.0.0`:
```bash
ssh -L 3100:127.0.0.1:3100 <user>@<instabox>     # lalu buka http://127.0.0.1:3100/ di laptop
```
**Pakai port lokal yang sama dengan port di InstaBox.** Server memeriksa header `Host` (proteksi DNS rebinding, AUDIT S-2), dan browser mengirim port lokal tunnel. Kalau port lokal harus berbeda (mis. 3100 sudah dipakai di laptop):
```bash
ssh -L 8100:127.0.0.1:3100 <user>@<instabox>
# di InstaBox:
ALLOWED_HOSTS=127.0.0.1:8100,localhost:8100 npm run lab
```
Kalau InstaBox punya fitur port forwarding di web UI-nya, arahkan ke port 3100. `ALLOW_REMOTE=1` hanya kalau jaringan sudah dilindungi; fault injection tetap ditolak di non-loopback.

### Skenario untuk diamati

| Skenario | Cara | Yang terlihat |
|---|---|---|
| Retry + backoff | Buat job, preset "Transient 2×" | 3 attempt; jeda backoff (kuning) dan menunggu worker (abu) terpisah di timeline |
| Retry habis | Preset "Transient terus" | `FAILED TRANSIENT` di attempt `MAX_ATTEMPTS` |
| Permanen | Preset "Permanent" | `FAILED PERMANENT`, 1 attempt |
| Worker mati | Preset "Lambat 5 s", lalu `kill -9` worker pemegang lease (lihat Overview → Sedang RUNNING) | Sisa lease turun ke negatif, lalu attempt baru oleh worker lain/restart; bar attempt lama berlabel "sampai deteksi" |
| Crash sebelum commit | Preset "Crash setelah tulis" | Worker mati sendiri; job di-reclaim; `result.sha256` sama |
| Idempotency | Isi Idempotency-Key, kirim dua kali | 202 lalu 200 dengan job yang sama; ubah orderCount → 409 |
| Backpressure | `MAX_PENDING=5 npm run lab -- --workers 0`, kirim 10 request | 202 × 5, 429 × 5 |
| Kontensi | `--workers 4`, kirim 50 request | Job tersebar di worker; "sukses ganda" tetap 0 |

Mencari PID worker untuk `kill -9` di Linux: `pgrep -af 'src/worker.js'`.

### Troubleshooting dashboard

| Gejala | Penyebab | Tindakan |
|---|---|---|
| `DB_NOT_READY` | Database belum dibuat | Jalankan API dulu; dashboard memuat sendiri setelahnya |
| Form: `502 API_UNREACHABLE` | API mati atau `API_URL`/`PORT` berbeda | Jalankan API, samakan `PORT` |
| Panel fault injection tidak muncul | Dashboard tanpa `ALLOW_FAULT_INJECTION=1` | `npm run lab -- --fault-injection` |
| `400 ... ALLOW_FAULT_INJECTION` padahal panel muncul | Dashboard punya flag, API tidak | Jalankan semua lewat `npm run lab -- --fault-injection` |
| `403 BAD_HOST` (API atau dashboard) | Dibuka lewat nama/port selain `127.0.0.1`/`localhost` dengan port server, mis. SSH tunnel ke port lokal berbeda | Pakai port lokal yang sama, atau set `ALLOWED_HOSTS=127.0.0.1:<port lokal>,localhost:<port lokal>`. Jangan menambahkan nama yang tidak dipakai. Log server: `host_rejected` |
| `403 CROSS_ORIGIN` | Request browser dari origin lain (atau `Origin: null`) | Disengaja (AUDIT S-2). Kirim dari dashboard/origin yang sama, atau dari CLI (tanpa `Origin`) |
| Header: "⚠ Gagal sejak …" | Dashboard server mati atau DB sibuk | Data di layar adalah snapshot terakhir; cek proses dashboard |
| `EADDRINUSE` port 3100 | Dashboard lama masih jalan | Hentikan, atau `DASHBOARD_PORT=3101` |

