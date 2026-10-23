# mini-job-system

Capstone Bab 10 modul *Inside Modern AI Systems*: sistem kecil untuk job asynchronous (membuat laporan pesanan dari data dummy). Fokusnya reliability, consistency, dan observability yang **bisa dibuktikan** lewat test dan eksperimen kegagalan.

- 1 API (HTTP) + 1..n worker + 1 file SQLite. Satu codebase, proses Node.js biasa.
- Tanpa dependency npm, tanpa Docker, tanpa layanan eksternal. Butuh **Node.js >= 22.13** (`node:sqlite`).
- Semantik eksekusi: **at-least-once dengan hasil idempotent dan fencing**. Bukan exactly-once.
- Status: proyek belajar. **Tidak production-ready** (lihat Known limitations).

## Mulai cepat

```bash
npm run doctor       # cek Node, node:sqlite, direktori data, port
npm test             # 58 test (unit + proses sungguhan + kill -9/SIGSTOP), sekitar 30 detik
npm run experiment   # ablation + drain capacity, sekitar 5 menit (EXP_REPS=1 untuk sekitar 2 menit)
```
`npm install` tidak diperlukan. Panduan operasional lengkap (background, stop, reset, troubleshooting): **[docs/RUNBOOK.md](docs/RUNBOOK.md)**.

## Dokumen

| Dokumen | Isi |
|---|---|
| [docs/REPORT.md](docs/REPORT.md) (+ PDF) | Laporan capstone (maksimal 3 halaman) |
| [docs/CONCEPTS.md](docs/CONCEPTS.md) | Penjelasan belajar: worker terpisah, SQLite, status, transaksi & fencing, retry, worker mati, broker |
| [docs/AUDIT.md](docs/AUDIT.md) | Temuan audit P0-P3, bukti reproduksi, perbaikan, risiko yang belum terbukti |
| [docs/ADR-001-architecture.md](docs/ADR-001-architecture.md) | Keputusan arsitektur dan trigger untuk membukanya ulang |
| [docs/COMPARISON.md](docs/COMPARISON.md) | Verifikasi evidence InstaBox `nanad` dan perbandingan dengan sandbox |
| [docs/evidence/nanad/](docs/evidence/nanad/) | Hasil eksperimen asli dari InstaBox `nanad` (tidak diubah) |
| [docs/EXPERIMENT-RESULTS.md](docs/EXPERIMENT-RESULTS.md) | Hasil eksperimen sandbox (+ `experiment-results.json` mentah) |
| [docs/DISCOVERY.md](docs/DISCOVERY.md) | Problem, user, rules, data, MVP |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Menjalankan di InstaBox |

## API

| Method | Path | Hasil |
|---|---|---|
| POST | `/jobs` | 202 job baru · 200 replay `Idempotency-Key` · 400 validasi/URL · 409 key dipakai untuk isi berbeda · 413 body > 16 KB · 408 request lambat · 429 antrean penuh (`Retry-After`) |
| GET | `/jobs/:id` | Job + `result` (`reportFile`, `sha256`, `bytes`) + riwayat event per attempt · 404 |
| GET | `/metrics` | Status job, counter, error class, histogram attempts, p50/p95/p99, health antrean |
| GET | `/healthz` | `{"ok":true}` kalau DB bisa diakses |

Body POST: `{"type":"order_report","payload":{"orderCount":1..200000,"seed":0..2^31-1}}`. Field `payload.simulate` (`delayMs`, `failTransientTimes`, `failPermanent`, `hang`, `crashAfterWriteTimes`) untuk fault injection, hanya diterima kalau `ALLOW_FAULT_INJECTION=1` di API **dan** worker, dan hanya di HOST loopback.

Contoh:
```bash
npm run api                       # terminal 1 (127.0.0.1:3000)
WORKER_ID=w1 npm run worker       # terminal 2
curl -s -X POST localhost:3000/jobs -H 'content-type: application/json' \
  -H 'Idempotency-Key: rekap-001' -d '{"type":"order_report","payload":{"orderCount":50000,"seed":7}}'
curl -s localhost:3000/jobs/<jobId>
npm run check                     # invariant database vs file laporan
```

## Status dan error class

`PENDING -> RUNNING -> SUCCEEDED | FAILED`. Retry mengembalikan job ke `PENDING` dengan `nextRunAt` (backoff). Diagram dan aturannya ada di [CONCEPTS.md](docs/CONCEPTS.md#3-bagaimana-job-berpindah-status).

| Error class | Retry? | Penyebab |
|---|---|---|
| TRANSIENT | ya | Dependency sementara gagal |
| TIMEOUT | ya | Attempt melewati `JOB_TIMEOUT_MS` |
| WORKER_LOST | ya (reclaim) | Worker berhenti heartbeat; final kalau attempt habis |
| INTERNAL | ya | Error tak dikenal |
| STORAGE | tergantung | Gagal tulis laporan. Retry hanya untuk `ENOSPC/EIO/EMFILE/ENFILE/EBUSY/EAGAIN` |
| PERMANENT | tidak | Input/data rusak, tipe tak dikenal, fault injection ditolak |

Semua retry dibatasi `MAX_ATTEMPTS`, dengan exponential backoff + full jitter.

## Konfigurasi (env)

| Variabel | Default | Arti |
|---|---|---|
| `HOST` / `PORT` | 127.0.0.1 / 3000 | Alamat API. Non-loopback ditolak kecuali `ALLOW_REMOTE=1` |
| `ALLOW_REMOTE` | 0 | Izinkan bind non-loopback. API **tanpa autentikasi** |
| `REQUEST_TIMEOUT_MS` | 10000 | Batas waktu request HTTP (408) |
| `DB_PATH` / `REPORT_DIR` | ./data/jobs.db / ./data/reports | Storage |
| `MAX_ATTEMPTS` | 3 | Batas attempt per job |
| `BACKOFF_BASE_MS` / `BACKOFF_CAP_MS` | 500 / 10000 | Backoff |
| `LEASE_MS` / `HEARTBEAT_MS` | 5000 / 1000 | Deteksi worker mati |
| `BUSY_TIMEOUT_MS` | 1000 | Tunggu lock SQLite (memblokir event loop). Wajib `BUSY + HEARTBEAT < LEASE` |
| `JOB_TIMEOUT_MS` | 30000 | Timeout per attempt, 0 = tanpa timeout |
| `POLL_MS` | 100 | Interval polling worker |
| `MAX_PENDING` | 1000 | Backpressure (429) |
| `RECOVERY` | 1 | 0 = mode baseline (tanpa reclaim lease) |
| `ALLOW_FAULT_INJECTION` | 0 | 1 = izinkan `payload.simulate` (loopback saja) |
| `WORKER_ID` | w-<pid> | Identitas worker di log/event |
| `EXP_REPS` | 3 | Repetisi eksperimen |

## Struktur

```
src/api.js          entrypoint API             src/worker.js       entrypoint worker
src/http.js         route, validasi, timeout   src/processor.js    claim, heartbeat, timeout, retry
src/store.js        state machine + fencing    src/db.js           skema SQLite, transaksi
src/task.js         tugas + tulis atomik       src/consistency.js  invariant DB vs file
src/metrics.js      /metrics                   src/errors.js       error class
src/backoff.js      backoff + jitter           src/config.js       env + validasi
scripts/            experiment, compare-results, check-consistency, doctor, clean, lib/harness
test/               unit, integration (34 test asli), storage, reliability (24 test baru), helpers
```

## Known limitations

Ringkasan, detail di [AUDIT.md](docs/AUDIT.md) dan [ADR-001](docs/ADR-001-architecture.md):
- At-least-once: job bisa dieksekusi lebih dari sekali. Aman hanya karena output deterministik dan idempotent. Side effect eksternal (email, pembayaran) butuh outbox + dedupe key.
- File laporan yatim bisa tertinggal untuk job `FAILED`. Database adalah sumber kebenaran.
- Tanpa fsync: listrik padam bisa menghilangkan file dari job `SUCCEEDED` (terdeteksi `npm run check`, belum diperbaiki).
- Satu host: SQLite lokal dan lease berbasis jam lokal.
- Satu penulis SQLite: job ringan tidak naik linear dengan menambah worker (terukur di dua environment: 1.29x dan 0.76x pada 4 worker).
- Throughput sangat bergantung pada biaya fsync storage (`nanad` 6-12x lebih cepat dari sandbox untuk operasi storage); jangan dipindahkan antar mesin tanpa diukur ulang.
- Lock SQLite memblokir event loop proses yang menunggu (dibatasi `BUSY_TIMEOUT_MS`).
- Tanpa autentikasi, tanpa retensi data, metrik dihitung O(jumlah job).
- Eksperimen dan test dijalankan di InstaBox `nanad` oleh pemilik proyek (hasil di `docs/evidence/nanad/`, diverifikasi di `COMPARISON.md`). Log test `nanad` tidak dilampirkan.
