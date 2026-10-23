# Audit Engineering: mini-job-system

Tanggal: 2026-10-22. Basis: commit awal capstone (34 test). Environment audit: sandbox Linux x86_64, Node 22.22.0 (bukan InstaBox). Hasil InstaBox `nanad`: `COMPARISON.md`.

Status bukti:
- **DIREPRODUKSI**: gagal nyata dengan script/test, lalu diperbaiki dan diuji ulang.
- **CODE REVIEW**: ditemukan dari membaca kode; jalurnya jelas tapi tidak bisa dipicu lewat API normal.
- **RISIKO BELUM TERBUKTI**: masuk akal secara teori, tidak bisa direproduksi di environment ini. Tidak diubah, didokumentasikan.
- **DISENGAJA**: keterbatasan desain yang diterima di ADR.

## P0: korupsi data, transisi status salah, keamanan serius

| ID | Temuan | Bukti | Perbaikan | Test |
|---|---|---|---|---|
| P0-1 | **Satu request bisa mematikan API.** `new URL(req.url)` dipanggil di luar `try`. Path seperti `GET //[` melempar error, menjadi `unhandledRejection`, lalu crash handler meng-`exit(1)` proses. DoS dengan satu baris. | DIREPRODUKSI: proses API keluar dengan kode 1, log `unhandled_rejection: Invalid URL`. | Parsing URL dipindah ke dalam `try` dan menghasilkan `400 BAD_URL`. | `reliability: URL malformed...` (gagal di kode lama, lulus di kode baru) |

Tidak ditemukan korupsi data atau transisi status ilegal. Klaim ganda, fencing, dan idempotency diuji khusus (lihat bagian "Diuji, bukan bug").

## P1: reliability, concurrency, recovery

| ID | Temuan | Bukti | Perbaikan | Test |
|---|---|---|---|---|
| P1-1 | **Menunggu lock SQLite membekukan proses.** `node:sqlite` sinkron, jadi `busy_timeout` 5000 ms memblokir seluruh event loop, termasuk heartbeat. Dengan `LEASE_MS` 5000, satu kali menunggu lock cukup untuk membuat lease kedaluwarsa. Akibatnya job dieksekusi ulang (hasil tetap aman karena fencing, tapi kerja terbuang). Di API, semua request tertahan. | DIREPRODUKSI: lock dipegang 6.5 s, worker log `heartbeat_error: database is locked`, penyelesaian job 500 ms tertunda sekitar 6 s. | `BUSY_TIMEOUT_MS` bisa dikonfigurasi (default 1000). Validasi saat start: `BUSY_TIMEOUT_MS + HEARTBEAT_MS < LEASE_MS`. | `storage: busy timeout + heartbeat...`, `reliability: database terkunci saat commit...` |
| P1-2 | **Kontrak file vs database tidak bisa diverifikasi.** Laporan ditulis sebelum `SUCCEEDED` di-commit (urutan ini benar untuk at-least-once), tapi tidak ada checksum. File yatim dari job `FAILED` (crash setelah tulis, attempt habis) tidak bisa dibedakan dari hasil sah. | DIREPRODUKSI lewat test crash-setelah-tulis dengan `MAX_ATTEMPTS=1`: status `FAILED WORKER_LOST`, file tetap ada. | `result` menyimpan `sha256` dan `bytes`. `src/consistency.js` + `npm run check` memeriksa invariant status/event/file. Kontrak ditulis di `task.js`, ADR, dan CONCEPTS. Urutan tulis tidak diubah. | `reliability: crash setelah file ditulis...` (2 test), `storage: pemeriksa invariant...` |

## P2: observability, reproducibility, dokumentasi, robustness

| ID | Temuan | Bukti | Perbaikan | Test |
|---|---|---|---|---|
| P2-1 | Rename/tulis gagal meninggalkan file `.tmp`. Error dicatat `INTERNAL` dan salah konfigurasi permanen tetap di-retry 3x. | DIREPRODUKSI: 3 file `.tmp` tertinggal, `FAILED INTERNAL` setelah 3 attempt. | Tmp dihapus saat gagal. Error class baru `STORAGE`: retry hanya untuk `ENOSPC/EIO/EMFILE/ENFILE/EBUSY/EAGAIN`. | `storage: rename gagal...`, `reliability: filesystem gagal...` |
| P2-2 | Client putus di tengah body tercatat `http_unhandled_error` 500 (alarm palsu). | DIREPRODUKSI. | Dicatat `warn client_aborted`, status log 499. | `reliability: client putus di tengah body...` |
| P2-3 | Request lambat ditahan sampai default Node (300 s). `Content-Length` besar ditunggu, bukan ditolak. | DIREPRODUKSI: tidak ada respons setelah 3 s untuk kedua kasus. | `REQUEST_TIMEOUT_MS` (default 10 s) menghasilkan 408. `Content-Length > 16 KB` langsung 413 + `connection: close`. | `reliability: body lambat...` |
| P2-4 | `oldestPendingAgeMs` menghitung job yang sengaja menunggu backoff sebagai lag. Job hang dengan heartbeat hidup tidak terlihat di metrik mana pun. | DIREPRODUKSI di eksperimen lama: 3 job hang tidak terdeteksi `runningWithExpiredLease`. | Metrik baru: `pendingReady`, `pendingInBackoff`, `oldestReadyPendingAgeMs`, `oldestRunningAgeMs`. | dipakai di eksperimen ablation |
| P2-5 | Fault injection hanya dicek di API. Worker menjalankan `simulate` dari database tanpa memeriksa flag sendiri. | CODE REVIEW (terjadi bila API pernah jalan dengan flag lalu dimatikan). | Worker menolak `simulate` (`PERMANENT`) bila `ALLOW_FAULT_INJECTION` mati. | `reliability: fault injection tetap ditolak di worker...` |
| P2-6 | `HOST` non-loopback diterima diam-diam padahal API tanpa autentikasi, dan fault injection bisa ikut terekspos. | CODE REVIEW. | Non-loopback wajib `ALLOW_REMOTE=1`. Fault injection hanya diizinkan di loopback. | `storage: API tetap localhost-only...` |
| P2-7 | Test harness mendaftarkan cleanup setelah proses start, sehingga proses anak bisa yatim kalau setup gagal. | CODE REVIEW. | Cleanup didaftarkan lebih dulu. Harness membunuh semua child saat proses induk keluar. | semua test integrasi |
| P2-8 | Eksperimen lama mencampur kontribusi retry/timeout/recovery, hanya 1 repetisi, dan menyebut throughput client berurutan tanpa pembanding. | Review metodologi. | Ablation 5 konfigurasi x 3 repetisi, drain capacity terpisah, JSON mentah, dan pemeriksaan invariant di setiap run. | `npm run experiment` |
| P2-9 | Tidak ada runbook, pemeriksaan environment, reset state, atau pemeriksa konsistensi. | Review. | `npm run doctor`, `clean`, `check`, dan `docs/RUNBOOK.md`. | dijalankan manual (lihat RUNBOOK) |
| P2-10 | **Bug di alat pemeriksa itu sendiri.** `checkConsistency` membaca tabel `jobs` dan `job_events` dengan query terpisah. Saat worker aktif, worker bisa commit di antara query, sehingga muncul violation palsu (`claims_mismatch`, `succeeded_event_without_status`). Klaim "aman dijalankan saat sistem hidup" sempat salah. | DIREPRODUKSI oleh eksperimen pertama (2 violation di run latency POST, satu-satunya run yang diperiksa saat worker aktif), lalu oleh test baru. | Semua query dibaca dalam satu read transaction (snapshot WAL). File untuk job yang masih aktif dilaporkan `report_before_commit`, bukan orphan. | `reliability: npm run check aman saat worker aktif...` (gagal di checker lama, lulus di yang baru) |
| P2-11 | **Kontensi lock dicatat sebagai error.** Busy handler SQLite tidak adil. Dengan 4 worker polling 1 ms, satu worker sesekali gagal mendapat lock dalam `BUSY_TIMEOUT_MS` walaupun setiap transaksi pendek. Ini terlihat sebagai `worker_loop_error` (level error) dan membuat test kontensi flaky. Tidak ada dampak correctness: transaksi gagal sebelum mengubah apa pun. | DIREPRODUKSI lewat pengulangan test: 3 dari 15 run (dan 2 dari 5 run sebelumnya) gagal di test kontensi dengan `database is locked` dari `claimNext`. | `SQLITE_BUSY` saat claim dicatat `warn claim_busy`, lalu worker mundur dengan jitter. Error lain tetap `worker_loop_error`. Test kontensi menolak semua log error/fatal, mengizinkan `claim_busy`. | `reliability: kontensi lock saat claim...` (deterministik; gagal di worker lama), `reliability: kontensi...`, `storage: claim saat koneksi lain...` |

## P3: opsional

| ID | Temuan | Perbaikan |
|---|---|---|
| P3-1 | Tipe job tak dikenal di worker diklasifikasi `INTERNAL` dan di-retry. Tidak bisa terjadi lewat API. | Sekarang `PERMANENT`. |
| P3-2 | Slow body yang kena 408 juga tercatat `client_aborted` (socket ditutup server). | Tidak diubah. Log tetap akurat soal koneksi putus. |
| P3-3 | **Label output eksperimen menyesatkan.** Kolom "Reclaim lease" menghitung event `lease_expired`. Pada `MAX_ATTEMPTS=1` job itu menjadi `FAILED WORKER_LOST`, tidak dijalankan ulang. Laporan sebelumnya ikut keliru ("recovery saja menyelamatkan 2 job"). Ditemukan saat memverifikasi evidence `nanad`: `failedByErrorClass.WORKER_LOST` = nilai kolom di semua repetisi. | Label + catatan kaki di `scripts/experiment.js`, koreksi di REPORT. Data dan file evidence tidak berubah. |

## Diuji, bukan bug (tidak diubah)

- **Klaim ganda:** 0 kasus pada 6 worker x 1000 job (script repro), 4 worker x 150 job dengan polling 1 ms (test), dan 2 koneksi x 50 job (unit). `BEGIN IMMEDIATE` menserialkan claim.
- **Worker zombie:** worker di-`SIGSTOP` lebih lama dari lease. Job diambil alih dan selesai oleh worker lain. Setelah `SIGCONT`, worker lama mencatat `lease_lost` dan tidak menulis status. Tepat satu `succeeded`.
- **Hasil dari pemilik yang lease-nya lewat tapi belum diambil alih tetap diterima.** Ini disengaja: fencing memakai `(lease_owner, attempts)`, bukan jam. Selama tidak ada yang mengambil alih, tidak ada konflik.
- **Idempotency paralel:** 20 request paralel dengan key sama menghasilkan tepat satu job.

## Risiko belum terbukti (tidak diubah, didokumentasikan)

- **R1. Tidak ada `fsync`.** Saat listrik padam, commit SQLite (WAL, `synchronous=FULL`) bisa bertahan sementara file laporan yang baru di-rename hilang. Hasilnya `SUCCEEDED` tanpa file. Tidak bisa direproduksi di sandbox. `npm run check` mendeteksinya (`report_missing`). Perbaikan potensial: fsync file dan direktori sebelum commit, dengan biaya latency.
- **R2. `SQLITE_FULL` (disk penuh di database)** tidak diuji. Secara desain jalurnya sama dengan lock (`job_state_write_failed` / `worker_loop_error`, lalu pulih lewat lease), tapi belum dibuktikan.
- **R3. Task CPU-bound lebih lama dari lease** akan diambil alih walau worker hidup. `buildOrderReport(200000)` diukur 6.6-15.7 ms (7 run, median 6.8 ms), jauh di bawah lease 5 s.
- **R4. Jam multi-host.** Lease memakai `Date.now()`. Aman di satu host, tidak dijamin lintas host.

## Disengaja (lihat ADR-001)

At-least-once (bukan exactly-once), file yatim untuk job `FAILED`, tanpa autentikasi, polling, metrik O(n), tanpa retensi, satu host, dan satu penulis SQLite (throughput job ringan tidak naik dengan menambah worker, terukur di eksperimen drain).

## Perubahan pada test lama

Ke-34 test lama tetap ada dan lulus. Total sekarang 58 (24 baru). Perubahan pada test lama:
1. `setup()` dipindah ke `test/helpers.js`, dengan env tambahan `BUSY_TIMEOUT_MS=200` karena validasi P1-1.
2. Satu assertion `validateJobRequest` menyesuaikan field baru `crashAfterWriteTimes: 0`.

## Flakiness

Suite diulang berkali-kali, bukan hanya sekali lulus:
- 15 run sebelum P2-11 diperbaiki: 3 gagal (test kontensi, `database is locked`). Ini temuan sistem, lihat P2-11.
- 10 run setelah test `claim_busy` ditambahkan: 6 gagal. **Bug di test sendiri**: koneksi "locker" dibuka tanpa `busy_timeout`, jadi `BEGIN IMMEDIATE` milik test kalah dari claim worker. Diperbaiki dengan helper `holdWriteLock` (busy_timeout 2 s). Koneksi read-only pemeriksa juga diberi busy_timeout.
- 10 run di kode final: 10/10 lulus (58/58).

Test bergantung pada timing (lease 600 ms). Di mesin yang jauh lebih sibuk, kegagalan sesekali masih mungkin. Catat output-nya sebagai temuan, jangan diabaikan.

## Temuan keamanan setelah capstone (fase dashboard, 2026-10-23)

Bagian ini ditambahkan setelah capstone. Tabel di atas tidak diubah.

| ID | Temuan | Bukti | Perbaikan | Test |
|---|---|---|---|---|
| S-1 (P1) | **CSRF lintas situs ke `POST /jobs`.** API tidak memeriksa `Content-Type`. Browser boleh mengirim POST lintas situs tanpa preflight CORS untuk `text/plain`, `application/x-www-form-urlencoded`, dan `multipart/form-data`. Halaman web mana pun yang dibuka di mesin yang sama bisa membuat job, bahkan tanpa JavaScript lewat `<form enctype="text/plain">` (trik duplicate key `{"type":"x=","type":"order_report",...}` membuat body tetap JSON valid). Dampak: antrean bisa diisi sampai `MAX_PENDING` (user sah mendapat 429), dan saat `ALLOW_FAULT_INJECTION=1` situs lain bisa membuat worker crash (`crashAfterWriteTimes`) atau hang. Penyerang **tidak** bisa membaca respons (tanpa header CORS). | DIREPRODUKSI di commit `ae864a8`: `curl` lintas origin `text/plain` → 202. Chromium sungguhan dari `http://localhost:4801` ke `http://127.0.0.1:<port>/jobs`: `fetch(..., {mode:'no-cors'})` → 202, form `text/plain` → 202, `fetch` dengan `application/json` diblokir browser (preflight `OPTIONS` 405 tanpa header CORS). Hasil: 2 job dibuat oleh halaman lintas situs. | `POST /jobs` wajib `Content-Type: application/json` (parameter seperti `charset` boleh), selain itu `415 UNSUPPORTED_MEDIA_TYPE`. Setiap request lintas situs dari browser jadi wajib preflight, dan API tidak pernah menyetujui preflight. Dicek **setelah** body dibaca dan setelah batas 413, supaya perilaku 408/413/`client_aborted` yang sudah diuji tidak berubah; tetap sebelum JSON di-parse, validasi payload, dan idempotency. Tidak ada perubahan arsitektur, state machine, atau semantik reliability. | `test/security.test.js` (5 test; 3 gagal di kode lama, lulus di kode baru). Browser: `npm run csrf-check` (manual, tanpa dependency) melaporkan 2 job dibuat di kode lama dan 0 di kode baru |

Perubahan perilaku yang terlihat client: request tanpa `Content-Type: application/json` (mis. `curl -d '...'` tanpa `-H`) sekarang 415. Semua client di repo (test, `scripts/experiment.js`, dashboard, contoh di README/RUNBOOK) sudah mengirim header itu.

Risiko yang tersisa (tidak diperbaiki di S-1):
- **DNS rebinding ke API.** API tidak memeriksa header `Host`. Domain penyerang yang di-rebind ke `127.0.0.1` menjadi *same-origin* di mata browser, sehingga bisa mengirim JSON dan membaca respons (`GET /jobs/:id`, `/metrics`). Dashboard sudah memeriksa `Host`; API belum. Perbaikan yang diusulkan: allowlist `Host` (loopback + `HOST`), terpisah dari S-1 karena mengubah perilaku untuk semua route.
- **Tanpa autentikasi.** Proses lokal lain (bukan browser) tetap bisa membuat job. Disengaja (ADR-001), dibatasi bind loopback.
- **Bergantung pada aturan CORS browser.** Proteksi ini benar untuk browser yang mengikuti Fetch standard (Chromium, Firefox, Safari modern). Klien non-browser tidak dibatasi CORS sama sekali.

