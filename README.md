# mini-job-system

Capstone Bab 10 modul *Inside Modern AI Systems*: sistem kecil untuk job asynchronous (membuat laporan pesanan dari data dummy). Fokusnya reliability, consistency, dan observability yang **bisa dibuktikan** lewat test dan eksperimen kegagalan.

- 1 API (HTTP) + 1..n worker + 1 file SQLite. Satu codebase, proses Node.js biasa.
- Tanpa dependency npm, tanpa Docker, tanpa layanan eksternal. Butuh **Node.js >= 22.13** (`node:sqlite`).
- Semantik eksekusi: **at-least-once dengan hasil idempotent dan fencing**. Bukan exactly-once.
- Status: proyek belajar. **Tidak production-ready** (lihat Known limitations).

## Mulai cepat

```bash
npm run doctor       # cek Node, node:sqlite, direktori data, port
npm test             # 103 test (58 capstone + 13 dashboard + 14 security + 18 contention), sekitar 35 detik
npm run lab          # API + 2 worker + dashboard di http://127.0.0.1:3100 (Ctrl+C untuk berhenti)
npm run experiment   # ablation + drain capacity, sekitar 5 menit (EXP_REPS=1 untuk sekitar 2 menit)
```
`npm install` tidak diperlukan, juga untuk dashboard (tanpa build step). Panduan operasional lengkap (background, stop, reset, troubleshooting): **[docs/RUNBOOK.md](docs/RUNBOOK.md)**.

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
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Menjalankan di InstaBox, Windows, dan dashboard (§10) |
| [docs/VALIDATION-PLAN.md](docs/VALIDATION-PLAN.md) | Langkah validasi branch dashboard di Windows dan InstaBox `nanad` |
| [docs/REFERENCE-RESEARCH.md](docs/REFERENCE-RESEARCH.md) | Riset Bull Board / Inngest / Chaos Mesh: lisensi, feature mapping, keputusan arsitektur dashboard |

## API

| Method | Path | Hasil |
|---|---|---|
| POST | `/jobs` | 202 job baru · 200 replay `Idempotency-Key` · 400 validasi/URL · 409 key dipakai untuk isi berbeda · 413 body > 16 KB · 415 bukan `Content-Type: application/json` · 403 `Origin` browser lain · 503 `DB_BUSY` database terkunci (`Retry-After`, aman diulang) · 408 request lambat · 429 antrean penuh (`Retry-After`) |
| GET | `/jobs/:id` | Job + `result` (`reportFile`, `sha256`, `bytes`) + riwayat event per attempt · 404 |
| GET | `/metrics` | Status job, counter, error class, histogram attempts, p50/p95/p99, health antrean |
| GET | `/healthz` | `{"ok":true}` kalau DB bisa diakses |
| semua | semua | 403 `BAD_HOST` kalau header `Host` bukan `localhost`/`127.0.0.1`/`[::1]` dengan port API, atau entri `ALLOWED_HOSTS` (proteksi DNS rebinding, [AUDIT S-2](docs/AUDIT.md#temuan-keamanan-setelah-capstone-fase-dashboard-2026-10-23)) |

Body POST: `{"type":"order_report","payload":{"orderCount":1..200000,"seed":0..2^31-1}}` dengan header wajib `Content-Type: application/json` (proteksi CSRF, [AUDIT S-1](docs/AUDIT.md#temuan-keamanan-setelah-capstone-fase-dashboard-2026-10-23)). Field `payload.simulate` (`delayMs`, `failTransientTimes`, `failPermanent`, `hang`, `crashAfterWriteTimes`) untuk fault injection, hanya diterima kalau `ALLOW_FAULT_INJECTION=1` di API **dan** worker, dan hanya di HOST loopback.

Contoh:
```bash
npm run api                       # terminal 1 (127.0.0.1:3000)
WORKER_ID=w1 npm run worker       # terminal 2
curl -s -X POST localhost:3000/jobs -H 'content-type: application/json' \
  -H 'Idempotency-Key: rekap-001' -d '{"type":"order_report","payload":{"orderCount":50000,"seed":7}}'
curl -s localhost:3000/jobs/<jobId>
npm run check                     # invariant database vs file laporan
```

## Dashboard (Reliability Lab)

Proses terpisah (`npm run dashboard`, default `127.0.0.1:3100`) yang membaca SQLite **read-only** dan meneruskan pembuatan job ke `POST /jobs` milik API. Satu-satunya perubahan di API adalah validasi `Content-Type` (AUDIT S-1). Alasan desain dan lisensi referensi: [REFERENCE-RESEARCH.md](docs/REFERENCE-RESEARCH.md).

- **Overview:** status job, kesehatan antrean (siap vs backoff, lease kedaluwarsa), invariant sukses ganda, latency p50/p95/p99, job RUNNING dengan sisa lease, worker yang terlihat di event.
- **Jobs:** filter status / error class / "attempt > 1", pagination.
- **Detail job:** timeline per attempt (antre, eksekusi, backoff, reclaim, tulisan basi yang ditolak fencing) yang diturunkan dari `job_events`, tabel attempt, event log mentah, payload, result.
- **Buat job:** form ke API; status HTTP asli (202/200/409/429) ditampilkan. Panel fault injection hanya muncul dengan `npm run lab -- --fault-injection`.
- Data adalah snapshot polling (default 2 s, bisa diubah/dimatikan), **bukan** push realtime. Setiap layar menampilkan waktu snapshot server.

| Method | Path (proses dashboard) | Hasil |
|---|---|---|
| GET | `/api/overview` | `computeMetrics` + job RUNNING + worker terlihat + 8 job terbaru |
| GET | `/api/jobs?status=&errorClass=&retried=1&limit=&before=` | Daftar job (terbaru dulu, cursor `before`) + jumlah per status |
| GET | `/api/jobs/:id` | Job + event + `timeline` |
| POST | `/api/jobs` | Proxy ke `POST /jobs`. Wajib `Content-Type: application/json`; origin lain 403 |
| GET | `/api/meta` | Konfigurasi dashboard + status DB/API |

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
| `ALLOW_REMOTE` | 0 | Izinkan bind non-loopback. API **tanpa autentikasi**. Tidak mematikan pemeriksaan `Host` |
| `ALLOWED_HOSTS` | (kosong) | Nilai `Host` tambahan, `nama[:port]` dipisah koma, tanpa wildcard. Mis. SSH forward ke port lokal lain: `127.0.0.1:8100,localhost:8100`. Berlaku untuk API dan dashboard |
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
| `DASHBOARD_HOST` / `DASHBOARD_PORT` | 127.0.0.1 / 3100 | Alamat dashboard. Aturan loopback sama dengan API |
| `API_URL` | `http://127.0.0.1:$PORT` | API tujuan proxy pembuatan job (harus loopback kecuali `ALLOW_REMOTE=1`) |

## Struktur

```
src/api.js          entrypoint API             src/worker.js       entrypoint worker
src/http.js         route, validasi, timeout   src/processor.js    claim, heartbeat, timeout, retry
src/store.js        state machine + fencing    src/db.js           skema SQLite, transaksi
src/task.js         tugas + tulis atomik       src/consistency.js  invariant DB vs file
src/metrics.js      /metrics                   src/errors.js       error class
src/backoff.js      backoff + jitter           src/config.js       env + validasi
src/dashboard.js    entrypoint dashboard       src/dashboard-http.js route, keamanan, proxy
src/readmodel.js    query read-only            src/timeline.js     timeline dari job_events (murni)
src/hostguard.js    allowlist Host + Origin (API dan dashboard)
dashboard/          UI (HTML/CSS/ES modules, tanpa build): app.js, lib.js, views/*.js
scripts/            lab, csrf-check, host-check, busy-wait-check, test-repeat, experiment, compare-results, check-consistency, doctor, clean, lib/harness
test/               unit, integration (34 test asli), storage, reliability (24 test baru), dashboard (13), security (14), contention (15), helpers
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
- Tanpa autentikasi, tanpa retensi data, metrik dihitung O(jumlah job). Dashboard yang polling menjalankan query O(n) itu setiap interval.
- CSRF (AUDIT S-1, `npm run csrf-check`) dan DNS rebinding (AUDIT S-2, `npm run host-check`) sudah ditutup untuk serangan lewat browser. Proses lokal non-browser tetap bisa memakai API (tanpa autentikasi, disengaja).
- Satu kegagalan test yang belum terjelaskan (1 dari 15 run, AUDIT U-1). `npm run test:repeat` menyimpan log lengkap untuk menyelidikinya.
- Kontensi SQLite (AUDIT C-1): tulisan status yang kena `SQLITE_BUSY` diulang terbatas dalam satu periode lease; lock yang lebih lama dari itu tetap berakhir di pemulihan lewat lease dengan error `job_state_write_failed`. Validasi Windows pertama menemukan 5 kegagalan lanjutan (AUDIT C-2: urutan cleanup test, kontrak 503 di test, retry yang tidak muat dengan waktu tunggu Windows, lease claim yang termakan tunggu lock); sudah diperbaiki dan diuji dengan emulasi waktu Windows, belum divalidasi ulang di Windows. Pada storage dengan flush lambat (±5 ms per commit ke atas), kontensi berat masih bisa memunculkan `lease_at_risk`; lihat keputusan terbuka di AUDIT C-2.
- Dashboard: worker idle tidak terlihat (tidak ada registry worker), dan waktu kematian worker hanya diketahui sebagai waktu deteksi (`lease_expired`).
- Eksperimen dan test dijalankan di InstaBox `nanad` oleh pemilik proyek (hasil di `docs/evidence/nanad/`, diverifikasi di `COMPARISON.md`). Log test `nanad` tidak dilampirkan.
