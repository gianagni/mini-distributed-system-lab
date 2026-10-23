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
npm test                      # 58 test, sekitar 30 detik
```
Hasil yang diharapkan ada di baris akhir: `# pass 58` dan `# fail 0`. Untuk memeriksa flakiness:
```bash
for i in 1 2 3 4 5; do npm test 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' '; echo; done
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
| Log `warn claim_busy` sesekali | Banyak worker berebut lock dengan polling cepat | Normal di bawah beban. Kalau terus-menerus: kurangi worker atau naikkan `POLL_MS` |
| Job `FAILED` `STORAGE` | `REPORT_DIR` tidak bisa ditulis, path salah, atau disk penuh | `npm run doctor`, `df -h .` |
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
| Lokasi storage eksperimen | Eksperimen memakai `os.tmpdir()`. Jalankan `df -T /tmp "$(pwd)/data"` untuk tahu apakah `/tmp` adalah tmpfs. Ini menentukan apakah angka throughput mewakili disk persisten |
