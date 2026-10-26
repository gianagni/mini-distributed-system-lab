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

Risiko yang tersisa setelah S-1:
- ~~**DNS rebinding ke API.**~~ Diperbaiki di S-2 (di bawah).
- **Tanpa autentikasi.** Proses lokal lain (bukan browser) tetap bisa membuat job. Disengaja (ADR-001), dibatasi bind loopback.
- **Bergantung pada aturan CORS browser.** Proteksi ini benar untuk browser yang mengikuti Fetch standard (Chromium, Firefox, Safari modern). Klien non-browser tidak dibatasi CORS sama sekali.

| ID | Temuan | Bukti | Perbaikan | Test |
|---|---|---|---|---|
| S-2 (P1) | **DNS rebinding ke API dan dashboard.** Domain penyerang yang di-resolve ulang ke `127.0.0.1` membuat halamannya *same-origin* dengan server lokal, sehingga bisa **membaca** respons dan mengirim JSON tanpa preflight. Satu-satunya jejak di server adalah header `Host`. (1) API tidak memeriksa `Host` sama sekali. (2) Dashboard memeriksa `Host`, tetapi `ALLOW_REMOTE=1` mematikan pemeriksaan itu sepenuhnya (efektif wildcard), bahkan dengan bind loopback. (3) Regex `Content-Type` dashboard (`/^application\/json\b/`) menerima `application/json-seq` (tidak bisa dieksploitasi karena tetap kena preflight, tapi tidak konsisten dengan API). | DIREPRODUKSI di `071dc0a`, lingkungan lokal terisolasi. `curl` dengan `Host: attacker.test`: API `/metrics` 200, `POST /jobs` 202; dashboard default 403; dashboard `ALLOW_REMOTE=1` 200. Chromium 141 dengan `rebind.test` dipetakan ke 127.0.0.1 (keadaan setelah rebind; HTML penyerang disajikan untuk load pertama): dengan Private Network Access Chromium **aktif**, request diblokir browser; dengan PNA **dimatikan** (meniru Firefox/Safari/Chrome lama) halaman membaca seluruh `/metrics` (200) dan membuat job (202) di API, serta membaca `/api/overview` dan membuat job lewat dashboard `ALLOW_REMOTE=1`. Halaman penyerang membuat 2 job (job ketiga di database berasal dari uji `curl`). | `src/hostguard.js`, dipakai API dan dashboard. **Allowlist `Host` ketat**: `localhost`, `127.0.0.1`, `[::1]` dengan port yang sedang didengar, plus alamat bind spesifik (bukan `0.0.0.0`/`::`), plus `ALLOWED_HOSTS` eksplisit (`nama[:port]`, dipisah koma; wildcard/skema/path ditolak saat start). Port 80 juga menerima nama tanpa port. Dicek paling awal untuk semua route, termasuk GET (403 `BAD_HOST`, `connection: close`, log `host_rejected`). **Origin** untuk `POST /jobs` dan `POST /api/jobs`: kalau `Origin` atau `Sec-Fetch-Site` dikirim (browser), harus same-origin; kalau tidak ada (curl, `fetch` Node, proxy dashboard) diterima (403 `CROSS_ORIGIN`). Di API dicek setelah gerbang 415 S-1, jadi urutan 408/413/415 lama tidak berubah. `ALLOW_REMOTE` sekarang hanya mengizinkan bind non-loopback, tidak lagi mematikan pemeriksaan. Dashboard memakai `isJsonContentType` yang sama dengan API. | `test/security.test.js` (+9 test: 4 unit, 5 proses sungguhan termasuk SSH forward lewat forwarder TCP). 5 test integrasi gagal di server lama, lulus di server baru. Manual: `npm run host-check` (5 GAGAL di kode lama, semua LULUS di kode baru) |

Dampak S-2 pada penggunaan sah:
- Akses lewat `127.0.0.1`/`localhost` dengan port yang didengar: tidak berubah.
- SSH tunnel dengan **port lokal sama** (`ssh -L 3100:127.0.0.1:3100`): tidak berubah. **Port lokal berbeda** (`-L 8100:127.0.0.1:3100`): browser mengirim `Host: 127.0.0.1:8100`, jadi wajib `ALLOWED_HOSTS=127.0.0.1:8100,localhost:8100` di proses tujuan. Ini disengaja: port tidak ditebak.
- Bind non-loopback (`HOST=10.0.0.5`, `ALLOW_REMOTE=1`): `10.0.0.5:<port>` otomatis diizinkan. Dengan `HOST=0.0.0.0`, nama yang dipakai client harus ditulis di `ALLOWED_HOSTS`.

Batas S-2 (tidak diklaim):
- Proteksi ini untuk serangan lewat browser. Proses lokal non-browser bisa mengirim `Host` apa pun; itu di luar model ancaman (tanpa autentikasi, disengaja, ADR-001).
- Rebinding sungguhan lewat DNS publik tidak diuji (butuh DNS eksternal). Yang diuji adalah keadaan browser setelah rebind, yang menentukan header yang sampai ke server.
- Chromium dengan Private Network Access sudah memblokir pola ini di browser; perbaikan server tetap dibutuhkan untuk browser tanpa fitur itu.

### Perubahan pada test lama (S-2)

Allowlist `Host` membuat 4 test lama di `test/reliability.test.js` gagal karena request mentahnya memakai nilai pengisi `Host: x` (5 request). Isi test tidak berhubungan dengan `Host`: URL malformed, client putus di tengah body, client putus sebelum respons, body lambat, dan `Content-Length` berlebih. Perubahan: **hanya nilai header** `Host: x` diganti host API sungguhan (`new URL(s.api.url).host`). Tidak ada assertion, alur, atau timing yang diubah (`git diff` menunjukkan 0 baris assertion berubah). Alternatif "izinkan `Host: x`" ditolak karena berarti melemahkan pemeriksaan supaya test lulus. Perilaku baru untuk `Host: x` sendiri dikunci test baru (`perubahan disengaja pada perilaku lama`).

## Kegagalan test yang belum terjelaskan (U-1)

**Kejadian awal (fase S-1):** 1 dari 15 run penuh `npm test` gagal di satu test. Nama test tidak diketahui karena run itu hanya menyimpan baris ringkasan, dan berjalan bersamaan dengan proses test lain.

**Investigasi (bukti di `docs/evidence/sandbox-dashboard/test-repeat/`):**
1. `npm run test:repeat` dibuat: log TAP lengkap per run, exit code, sinyal, durasi, load average, nama test gagal + `failureType`. Timeout ditambahkan supaya hang terdeteksi: `--test-timeout=120000` (di Node 22 berlaku per file test; file terlama 16 s normal / 19 s dengan CPU penuh) di `npm test` dan runner, plus watchdog 10 menit per run. Runner diverifikasi menangkap test gagal, hang async, dan loop sinkron.
2. **Baseline `071dc0a`, 30 run** (sebagian bersamaan dengan pekerjaan lain di mesin): 29 lulus, **1 gagal (run 22)**, 0 hang. Test: `proses dashboard ... buat job lewat dashboard, status berubah, timeline memakai event yang sama dengan API`, `testCodeFailure`: `dashboard harus melihat lebih dari satu status, dapat SUCCEEDED`.
3. **Akar masalah: race di test dashboard yang ditulis fase ini, bukan bug sistem.** Test memastikan dashboard "melihat" ≥ 2 status sambil worker sudah berjalan. Dengan konfigurasi test (POLL_MS 20, backoff 0-50 ms) job itu selesai dalam 13-85 ms (p50 62 ms, diukur 20 job). Kalau poll pertama terlambat (koneksi DB pertama, GC, CPU sibuk), dashboard hanya melihat SUCCEEDED. Dibuktikan: dengan poll pertama ditunda 250 ms, test lama gagal 5/5 dengan pesan yang identik dengan run 22.
4. **Perbaikan berdasarkan bukti:** test dibuat deterministik. Job dibuat lewat dashboard tanpa worker, dashboard harus melihat PENDING (timeline: 0 attempt, jeda antre terbuka), baru worker dinyalakan dan SUCCEEDED ditunggu. Assertion "status berubah teramati" tetap ada, tanpa bergantung timing. Dengan penundaan 250 ms yang sama, test baru lulus 5/5. Tidak ada perubahan di kode sistem.
5. Test capstone diperiksa untuk pola yang sama (assertion status antara sambil worker berjalan): tidak ada. Status antara di test lama berasal dari respons POST, job yang macet disengaja (`RECOVERY=0`), atau worker yang sudah mati.

**Hasil setelah perbaikan (kode final):** 30/30 run lulus dengan mesin tenang, 10/10 run lulus dengan 4 loop CPU penuh (load average ±5 pada 4 CPU). 0 hang, 0 timeout.

**Status:** kegagalan yang tertangkap (run 22) **terselesaikan**, akar masalah terbukti. Kejadian awal 1/15 **tidak bisa dipastikan sama** karena lognya tidak ada; test ini adalah satu-satunya race yang ditemukan dan kejadian awal juga terjadi saat mesin sibuk, jadi kemungkinan besar sama, tetapi itu **inferensi, bukan bukti**. Dicatat sebagai risiko yang tersisa sampai validasi Windows/`nanad` (yang wajib memakai `npm run test:repeat`) juga bersih.


## C-1 (P1): SQLITE_BUSY pada tulisan status dicatat sebagai kegagalan tugas (validasi Windows, 2026-10-24)

**Gejala (Windows x64, Node v24.22.1, SQLite 3.53.4):** `npm test` 83 lulus, 1 gagal, 1 skip (SIGSTOP, wajar). Gagal: `reliability: kontensi: 4 worker polling 1 ms, 150 job` karena worker mencatat `job_state_write_failed` dengan `errorClass: INTERNAL`, `message: database is locked`, `writeError: database is locked`, padahal 150 job akhirnya SUCCEEDED.

### Audit jalur lock

| Jalur | Bentuk tulisan | Perilaku sebelum C-1 | Sesudah C-1 |
|---|---|---|---|
| `claimNext` (worker) | `BEGIN IMMEDIATE` | BUSY -> `warn claim_busy`, mundur dengan jitter (P2-11) | Tidak berubah |
| `extendLease` (heartbeat) | UPDATE autocommit | BUSY -> `error heartbeat_error`, lease tidak diperpanjang | BUSY -> `warn heartbeat_busy` selama lease aman; `error lease_at_risk` kalau heartbeat berikutnya bisa terlambat. Error non-BUSY tetap `error heartbeat_error` |
| `completeAttempt` | `BEGIN IMMEDIATE` (fenced) | **BUSY tertangkap oleh `catch` tugas**, di-`classify` sebagai `INTERNAL` (retryable), lalu `failAttempt` dipanggil | Retry terbatas khusus BUSY (lihat desain). Tidak pernah menjadi kegagalan tugas |
| `failAttempt` | `BEGIN IMMEDIATE` (fenced) | BUSY -> `error job_state_write_failed`, job RUNNING sampai lease habis, lalu dicatat `WORKER_LOST` | Retry terbatas khusus BUSY; kegagalan tugas asli tetap tercatat dengan error class aslinya |
| `createJob` (API) | `BEGIN IMMEDIATE` | BUSY -> **500 INTERNAL** `http_unhandled_error` (tidak bisa dibedakan dari bug, tanpa `Retry-After`) | **503 `DB_BUSY` + `Retry-After: 1`**, `warn db_busy`. Tidak ada job yang dibuat; aman diulang dengan Idempotency-Key |
| `openDb` (start proses) | PRAGMA + `CREATE TABLE IF NOT EXISTS` | Menunggu `busy_timeout`; gagal start kalau terkunci terus | Tidak berubah (gagal cepat saat start sudah benar) |
| Dashboard | baca read-only (`BEGIN` snapshot) | BUSY -> 503 `DB_BUSY` | Tidak berubah |

### Akar masalah

Rantai pada log Windows hanya bisa terjadi lewat satu jalur di `src/processor.js` lama: tugas sukses -> `completeAttempt` menunggu lock lebih lama dari `BUSY_TIMEOUT_MS` (200 ms di test) -> `SQLITE_BUSY` dilempar **di dalam blok `try` yang sama dengan tugas** -> `classify()` menganggapnya error tugas tak dikenal (`INTERNAL`, retryable) -> `failAttempt` juga BUSY -> `job_state_write_failed`.

Klasifikasi:
1. **Bug:** kegagalan *database* saat menulis status diperlakukan sebagai kegagalan *tugas*. Kalau `failAttempt` berhasil, attempt terpakai sebagai `INTERNAL`; dengan attempt habis, **job yang pekerjaannya sukses berakhir FAILED** (dibuktikan di bawah). Pemeriksa konsistensi tidak menangkapnya: hanya warning `orphan_report`.
2. **Kekurangan strategi kontensi:** claim punya penanganan BUSY (P2-11), tulisan status tidak.
3. **Ekspektasi test sudah benar.** Test kontensi menangkap masalah nyata; tidak dilonggarkan.

### Reproduksi terkontrol (bukan race)

Koneksi asli dibungkus; untuk `BEGIN IMMEDIATE` ke-n yang dipilih, koneksi SQLite kedua memegang write lock, sehingga SQLite **sungguhan** menunggu `busy_timeout` lalu melempar `SQLITE_BUSY` (errcode 5) tepat di operasi itu. Hasil pada kode lama, identik di Node 22.22.0/SQLite 3.50.4 dan Node 24.22.1/SQLite 3.53.4:

| Skenario | Kode lama | Kode baru |
|---|---|---|
| BUSY pada commit lalu pada tulisan fail | Persis log Windows: `job_state_write_failed`, `INTERNAL`, `database is locked`; job RUNNING | 2x `warn state_write_busy`, SUCCEEDED attempt 1, tanpa error |
| BUSY pada commit, `MAX_ATTEMPTS=1` | **FAILED `INTERNAL "database is locked"`**, padahal file laporan benar sudah tertulis | SUCCEEDED, `result.sha256` = file |
| Tugas gagal TRANSIENT, tulisan fail BUSY | Tidak tercatat; job RUNNING, nanti tercatat `WORKER_LOST` | `retry_scheduled TRANSIENT` tercatat apa adanya |
| BUSY tidak pernah lepas | (sama dengan baris 1) | Retry sampai satu periode lease, lalu `error job_state_write_failed reason=retry_window_exhausted`; job RUNNING, attempt tidak terpakai, pulih lewat lease |
| Error database non-BUSY (disk I/O) | Dicatat `retry_scheduled INTERNAL` (attempt terpakai) | Tidak di-retry: `error job_state_write_failed reason=non_busy_error`, kode asli (10) ikut dicatat |
| POST /jobs saat DB terkunci | 500 `INTERNAL` | 503 `DB_BUSY` + `Retry-After` |

Kontensi dipaksa dengan proses sungguhan (4 worker, POLL 1 ms, `BUSY_TIMEOUT_MS=1` untuk worker, 150 job, 3 run per versi kode, kode final): kode lama 11-22 `job_state_write_failed`, 25-43 event `INTERNAL "database is locked"`, 14-21 retry dan 11-22 reclaim per run, dan **di satu run 1 job berakhir FAILED** (`WORKER_LOST`) karena attempt habis terpakai oleh error lock; kode baru 150/150 SUCCEEDED, 0 error, 0 retry, 0 reclaim di ketiga run (`docs/evidence/sandbox-dashboard/contention-c1/forced-contention-old-vs-new.txt`).

### Node 22 vs Node 24

- Fault injection: perilaku identik di kedua versi (sebelum dan sesudah perbaikan). `errcode` BUSY = 5 di keduanya; `isBusyError` cocok.
- Test kontensi asli, 20x per versi di Linux: 0 gagal di Node 22 maupun Node 24 (0-1 `claim_busy` per run). Jadi versi Node/SQLite **bukan** penyebab; frekuensi BUSY yang panjang yang berbeda per platform. Penjelasan untuk Windows (penguncian file Windows dan granularitas sleep busy handler SQLite) adalah **hipotesis**, belum diverifikasi di Windows.
- Catatan alat ukur: Node 24 memakai reporter `spec` secara default (`ℹ fail 0`), bukan TAP (`# fail 0`). Perbandingan pertama yang memakai grep TAP salah menghitung semua run Node 24 sebagai gagal; diulang dengan `--test-reporter=tap`. `npm run test:repeat` selalu memaksa TAP.

### Desain perbaikan (`src/processor.js`)

1. Fase tugas dan fase tulis status dipisah. Error di fase tulis status tidak pernah di-`classify` sebagai error tugas dan tidak memakai attempt.
2. Retry **hanya untuk SQLITE_BUSY**, aman karena setiap tulisan adalah satu transaksi atomik (BUSY = tidak ada yang tertulis) dan di-fence `(lease_owner, attempts)`. Durasi satu percobaan diprediksi dari **waktu tunggu BUSY terlama yang benar-benar teramati** (minimal `BUSY_TIMEOUT_MS`) + 25 ms kelonggaran timer. Berhenti kalau: lease diketahui hilang; sisa lease tidak cukup untuk satu percobaan lagi (`lease_too_short`); total retry sejak BUSY pertama akan melewati satu periode lease (`retry_window_exhausted`); atau 50 percobaan (pengaman). Backoff full jitter 5-50 ms. Setiap retry `warn state_write_busy` (dengan `busyWaitMs` aktual); berhenti = `error job_state_write_failed` (nama event lama dipertahankan) dengan `op`, `reason`, `tries`, `retryMs`, `maxBusyWaitMs`, `leaseLeftMs`, `writeErrorCode`.
3. Percobaan pertama mempertahankan semantik lama (sukses + lease sudah hilang = tidak menulis; gagal = tetap mencoba, fencing mencatat `stale_failure_rejected`).
4. Tidak menaikkan `busy_timeout`, tidak memperpanjang lease, tidak menghapus assertion.

**Revisi selama investigasi (dicatat apa adanya):** versi pertama membatasi retry dengan 5 percobaan. Test kontensi dipaksa gagal 1 dari 6 run: satu worker kalah 5x berturut-turut dalam ~215 ms dari lease 600 ms, lalu (sesuai desain) error + pemulihan lewat lease. Batas jumlah membuat jendela retry bergantung pada `busy_timeout`; diganti batas waktu lease. Assertion test baru itu juga diganti: dari "0 reclaim" (salah untuk konfigurasi ekstrem) menjadi invariant observability yang lebih ketat: setiap job yang di-reclaim harus punya error yang menjelaskannya, dan satu-satunya error yang boleh adalah `job_state_write_failed` karena BUSY (atau `lease_at_risk`). Test kontensi capstone (konfigurasi realistis) tetap mensyaratkan 0 error.

**Revisi kedua:** pengulangan 20x suite penuh menemukan test baru `BUSY terus-menerus` gagal 3/20: `retryMs` 1500-1501 ms, test mensyaratkan < lease 1500 ms. Penyebab: prediksi memakai `busy_timeout` nominal, padahal waktu tunggu BUSY sebenarnya sedikit lebih lama. Diukur (`npm run busy-wait-check`, Linux): molor 0.1-3.4 ms (1.00-1.20x) di Node 22 dan 24. Di Windows molornya diduga jauh lebih besar karena busy handler SQLite menghitung sleep nominal dan sleep Windows dibulatkan ke granularitas timer (±15.6 ms); **hipotesis, perlu diukur di Windows dengan `npm run busy-wait-check`**. Perbaikan di kode, bukan di test: prediksi memakai waktu tunggu yang teramati + 25 ms. Hasil: test yang sama 0 gagal dari 110 run (40 normal + 15 dengan CPU penuh, di Node 22 dan 24). Batas test tidak diubah.

Implikasi untuk P1-1: aturan `BUSY_TIMEOUT_MS + HEARTBEAT_MS < LEASE_MS` mengasumsikan `busy_timeout` adalah batas waktu nyata. Kalau di Windows waktu tunggu nyata ±1.5x nominal, margin konfigurasi default (1000 + 1000 < 5000) masih cukup, tapi perlu dikonfirmasi dengan pengukuran.

### Test

`test/contention.test.js`, 10 test: 6 fault injection pada fase tulis status, 2 heartbeat, 1 kontensi dipaksa dengan proses sungguhan, 1 POST /jobs saat terkunci. Kesepuluhnya **gagal di kode lama** dan lulus di kode baru (Node 22 dan 24). 85 test sebelumnya tidak diubah.

Pengulangan suite penuh (95 test) pada kode final dengan `npm run test:repeat`, log lengkap: **20/20 di Node 22.22.0 dan 20/20 di Node 24.22.1**, 0 hang. Test kontensi capstone 20x per versi: 0 gagal di keduanya.

### Risiko yang tersisa

- **Windows belum diverifikasi.** Di Linux, race asli test kontensi hampir tidak pernah terjadi, jadi perbaikan dibuktikan lewat fault injection dan kontensi dipaksa, bukan lewat reproduksi kegagalan Windows itu sendiri. Dengan konfigurasi test (`BUSY_TIMEOUT_MS` 200, lease 600), jendela retry (satu lease dikurangi waktu tunggu lock) hanya cukup untuk sekitar 2-3 percobaan; kalau kontensi di Windows lebih lama dari itu, test kontensi capstone tetap akan gagal, dengan error yang jelas (`reason`, `tries`, `retryMs`), dan itu temuan yang perlu dilaporkan, bukan disembunyikan.
- Lock yang dipegang lebih lama dari satu lease tetap berakhir di pemulihan lewat lease (attempt terpakai, `WORKER_LOST`). Disengaja: itu gangguan database sungguhan.
- Selama menunggu lock, event loop worker tetap terblokir hingga `BUSY_TIMEOUT_MS` per percobaan (P1-1, `node:sqlite` sinkron).

## C-2: validasi Windows setelah C-1 (5 kegagalan), 2026-10-24

**Hasil Windows (pemilik proyek, commit `4d85258`, Windows x64, Node v24.22.1, SQLite 3.53.4):** `npm test` 89 lulus, 5 gagal, 1 skip. `npm run busy-wait-check`: busy_timeout 1/50/200/1000 ms menunggu nyata median 15.3/109.2/296.9/1168 ms.

### Metode: emulasi waktu tunggu Windows di Linux

Angka Windows cocok dengan model: busy handler SQLite tidur dengan durasi nominal (1, 2, 5, 10, 15, 20, 25, 25, 25, 50, 50, 100 ms) dan Windows membulatkan **setiap** sleep ke atas ke tick 15.625 ms. Untuk 200 ms model memberi 296.75 ms (Windows: 296.9 ms). Shim `LD_PRELOAD` (`docs/evidence/sandbox-dashboard/contention-c2/harness/wintick.c`) membulatkan `usleep`/`nanosleep`/`clock_nanosleep` ke tick itu, dan secara opsional menambah biaya `fsync` (`WINTICK_FSYNC_US`) untuk meniru `FlushFileBuffers` yang lambat. Validasi emulasi (Linux, Node 22 dan 24): 15.9/110.6/299.0/1175.8 ms, cocok dengan Windows.

Batas emulasi: tidak meniru granularitas timer Node/libuv di Windows, semantik penguncian file Windows (`LockFileEx`), maupun biaya flush disk mesin Windows yang sebenarnya (belum diukur; `busy-wait-check` sekarang mengukurnya).

Temuan penting: emulasi tick saja (tanpa biaya flush) **tidak** memunculkan kegagalan 3 dan 5. Keduanya baru muncul ketika setiap commit memegang lock beberapa milidetik (flush lambat), yang memperpanjang kontensi.

### Akar masalah per kegagalan

| # | Test | Akar masalah | Bukti | Perbaikan |
|---|---|---|---|---|
| 1, 2 | `contention.test.js` heartbeat (aman / lease_at_risk): EBUSY unlink `jobs.db-shm` | **Urutan cleanup.** `t.after` dijalankan sesuai urutan pendaftaran. Harness mendaftarkan "hapus temp dir" lebih dulu, `locker.close()` milik skenario sesudahnya, jadi direktori dihapus saat koneksi SQLite masih terbuka. Linux mengizinkan, Windows menolak (EBUSY) | Di Linux, pemeriksaan `/proc/self/fd` tepat sebelum `rm` menemukan `jobs.db`, `jobs.db-shm`, `jobs.db-wal` masih terbuka di tepat 3 test yang gagal di Windows | Satu hook cleanup berurutan: hentikan timer, tutup semua koneksi (`adopt`), baru hapus. Timer pelepas lock dilacak dan dibersihkan |
| 4 | `contention.test.js` API DB_BUSY: EBUSY unlink `jobs.db-wal` | Sama: `locker.close()` didaftarkan sesudah cleanup milik `setup()` | Sama | `setup().defer(fn)`: penutup dijalankan setelah proses berhenti dan sebelum direktori dihapus |
| 3 | Kontensi dipaksa: expected 202, actual 503 | **Kontrak test salah.** Sejak C-1, `POST /jobs` sengaja menjawab 503 `DB_BUSY` + `Retry-After` saat lock tidak didapat; test masih mewajibkan 202 untuk setiap POST | Di emulasi, 1-2 dari 150 POST mendapat 503 | Penerimaan akhir lewat `submitJobs`: setiap job punya Idempotency-Key, 503 diulang dengan key yang sama (maksimal 10x, menghormati `Retry-After`), lalu dibuktikan tepat 150 job unik dan `jobs.total = 150`. Penolakan 503 diuji terpisah |
| 5 | Test kontensi capstone 150 job: `waitUntil` timeout 20 s | (a) **Test tidak memeriksa status POST.** Setiap 503 berarti job tidak pernah dibuat, jadi `SUCCEEDED === 150` mustahil dan test hanya timeout. (b) Dua cacat kode yang memperparah kontensi di Windows (di bawah) | Replay persis test itu di emulasi (`original-test-replay.txt`, kode `4d85258`): di 5 dari 12 run 1-2 POST dijawab 503, jadi hanya 148-149 job ada dan SUCCEEDED berhenti di 148-149 (target 150 tidak mungkin); 0 duplikat; plus 2-8 error worker `lease_too_short` per run | (a) Loop POST memakai `submitJobs` dan memeriksa hasilnya; tunggu SUCCEEDED memakai `waitForSucceeded` yang melaporkan semua angka saat timeout. (b) Lihat cacat kode |

### Dua cacat kode yang ditemukan lewat emulasi

1. **Retry C-1 tidak pernah muat di Windows.** Dengan konfigurasi test (lease 600 ms, busy_timeout 200 ms), satu tunggu BUSY di Windows ±300 ms. Kode C-1 hanya memulai retry kalau satu tunggu PENUH lagi muat di sisa lease, jadi setiap kegagalan pertama langsung menjadi `job_state_write_failed reason=lease_too_short` dengan `state_write_busy: 0`. **Perbaikan:** busy_timeout per retry disesuaikan tenggat: nominal = sisa anggaran (min(sisa lease, sisa jendela retry) - backoff) dikurangi overshoot nyata yang teramati, tidak pernah lebih dari `BUSY_TIMEOUT_MS`, minimal 1 ms; dikembalikan ke `BUSY_TIMEOUT_MS` setelah tulisan selesai. Log `state_write_busy` mencatat `nextBusyTimeoutMs`.
2. **Lease dari claim termakan waktu tunggu lock.** `processNext` mengirim `now: Date.now()` yang dievaluasi **sebelum** `BEGIN IMMEDIATE` menunggu lock. Terukur: setelah menunggu lock 334 ms, lease 600 ms tinggal 266 ms. Di Linux tunggu lock ±1 ms jadi tidak terlihat. **Perbaikan:** `claimNext` menerima `now` berupa fungsi yang dievaluasi di dalam transaksi setelah lock didapat; worker mengirim `Date.now`. Pemanggil dengan angka (unit test) tidak berubah. Setelah perbaikan: lease 598 ms setelah tunggu 333 ms.

Batas yang diketahui, tidak diubah: `extendLease` (heartbeat) adalah UPDATE autocommit dengan `now` yang juga diambil sebelum menunggu lock, jadi perpanjangan lease memendek sebesar waktu tunggu heartbeat itu sendiri (maksimal ±busy_timeout nyata). Mengubahnya ke transaksi mengubah pola lock heartbeat; dicatat untuk keputusan berikutnya.

### Before/after di emulasi (Node 24, tick Windows, 150 job)

Replay test kontensi capstone dalam bentuk lamanya (POST tanpa retry), 6 run per sel (`original-test-replay.txt`):

| Biaya flush | Kode `4d85258` | Kode C-2 |
|---|---|---|
| +5 ms | 6/6 run ada error worker: 2-8 `lease_too_short` per run, **0 retry tulis**; job dipulihkan lewat lease (workerLost 2-8). 2/6 run ada POST 503 → 148-149 job, test asli timeout | 1/6 run ada error: 1 `retry_window_exhausted` setelah retry; retry tulis 1-6 per run; 0 `lease_too_short`. 2/6 run ada POST 503 (kontrak API; test baru mengulangnya) |
| +10 ms | 6/6 run: 3-7 `lease_too_short`, 0 retry tulis. 3/6 run ada POST 503 | 1/6 run: 2 `lease_at_risk`; retry tulis 2-5 per run; 0 `job_state_write_failed`. 1/6 run ada POST 503 |

Di semua 24 run: semua job yang diterima akhirnya SUCCEEDED, 0 sukses ganda, 0 FAILED.

Suite penuh pada tree final (`npm run test:repeat`, 103 test, `repeat-*-summary.json`):

| Lingkungan | Hasil | Catatan |
|---|---|---|
| Node 22.22.0, Linux | 20/20 lulus | 0 POST 503 di test kontensi |
| Node 24.22.1, Linux | 20/20 lulus | 0 POST 503 |
| Node 24 + tick Windows + flush 2 ms | 10/10 lulus | 0 POST 503 |
| Node 24 + tick Windows + flush 5 ms | 9/10 lulus | Run 5: test kontensi capstone gagal pada assertion "0 error worker" karena 1 `lease_at_risk` (`leaseLeftMs: -5`); 150/150 tetap SUCCEEDED, 0 ganda, konsisten (`repeat-n24-win5ms-run-005.log`). 6 dari 20 pengiriman 150 job mendapat 1-2 POST 503, semuanya diulang dengan key yang sama, 0 gagal kirim, tepat 150 job |

Sebelum perbaikan test "npm run check aman" dan `waitForSucceeded` (tree C-2 sebelumnya), emulasi +5 ms memberi 7/10: 2 run `lease_at_risk` dan 1 run timeout 120 s di test itu.

### Kesalahan test baru yang ditemukan lewat emulasi (dicatat apa adanya)

Test regresi pertama untuk retry sadar-tenggat meniru Windows dengan **menambah** 100 ms setelah BUSY sungguhan. Lulus 40/40 di Linux biasa, tapi **gagal 10/10 di emulasi waktu Windows**: di sana tunggu BUSY aslinya sudah ±300 ms, jadi tambahan 100 ms membuat total ±400 ms dan tidak ada retry yang muat. Test itu juga akan gagal di Windows sungguhan. Diperbaiki di test (bukan di kode): tunggu **digenapkan** sampai total 300 ms (nilai Windows terukur), tidak ditambah. Setelah itu lulus 5/5 di Linux biasa dan di emulasi, Node 22 dan 24.

### Timeout test "npm run check aman saat worker aktif" (ditemukan di emulasi, belum terlihat di Windows)

Di repeat suite penuh dengan emulasi flush +5 ms, 1 dari 10 run gagal `testTimeoutFailure` 120 s di `reliability.test.js:262` tanpa keterangan apa pun. Test ini punya pola yang sama dengan kegagalan 5: 150 POST tanpa memeriksa status, lalu `for (;;)` sampai `SUCCEEDED === 150` **tanpa batas**.

Replay bentuk lama test itu (`harness/check-probe.test.js`, sama persis tapi dibatasi 60 s dan mencatat angka) di emulasi yang sama, 30 run (`check-test-replay.txt`): 29 selesai; **run 9 macet** karena 1 POST dijawab 503 `DB_BUSY`, hanya 149 job ada, SUCCEEDED berhenti di 149 dan loop berputar 11.951 kali sampai batas. 0 violation, 0 FAILED di semua run. Jadi mekanismenya terbukti. Bahwa run suite yang gagal itu karena hal yang sama **tidak** terbukti: log-nya tidak memuat jumlah job (itulah masalahnya).

Perbaikan di test, tanpa melemahkan assertion: `submitJobs` (Idempotency-Key, ulangi 503, wajib 0 gagal kirim dan 150 id unik), lalu `waitForSucceeded` dengan batas 60 s dan pemeriksaan konsistensi di setiap putaran (`onPoll`). Assertion 0 violation di setiap pemeriksaan, `checks > 3`, dan konsistensi akhir tidak berubah. Setelah perbaikan, 30 run test itu di emulasi +5 ms: 30/30 lulus; di 2 run satu POST mendapat 503 dan diulang dengan key yang sama, tetap tepat 150 job (`check-test-after.txt`).

Ikut diperbaiki di helper, karena keduanya juga bisa membuat test diam sampai 120 s:
- `waitForSucceeded` menunggu sampai semua n job **selesai** (SUCCEEDED atau FAILED), lalu mewajibkan semuanya SUCCEEDED. Job yang berakhir FAILED sekarang langsung menggagalkan test dengan jumlah per status dan `failedByErrorClass`, bukan menunggu timeout. Syarat lulus sama dengan sebelumnya (tepat n SUCCEEDED dalam batas waktu). Regression test: `contention.test.js` "C-2: tunggu job yang dibatasi"; dengan helper lama, test "job berakhir FAILED" menunggu 60 s penuh lalu gagal, dan "assertion di onPoll" gagal.
- `get`/`post` di `setup()` dibatasi 30 s per request (`AbortSignal`), dengan pesan yang menyebut path-nya. Sebelumnya request yang menggantung juga diam sampai timeout test.

### Perubahan pada test lama (C-2)

`reliability.test.js` "kontensi: 4 worker polling 1 ms, 150 job": **hanya** loop POST (sekarang `submitJobs`: Idempotency-Key, retry 503 terbatas, assertion 0 gagal kirim, 150 id unik, `jobs.total = 150`) dan pemanggilan tunggu (`waitForSucceeded`: kondisi `SUCCEEDED === 150` dan timeout 20 s **sama**, hanya pesan gagalnya berisi angka). Assertion 0 sukses ganda, konsistensi, dan **0 error worker** tidak diubah. Alasan: test lama mengabaikan status respons, padahal 503 adalah kontrak sah sejak C-1.

`reliability.test.js` "npm run check aman saat worker aktif": loop POST menjadi `submitJobs`, loop `for (;;)` menjadi `waitForSucceeded` (60 s, `onPoll` menjalankan pemeriksaan konsistensi yang sama). Semua assertion lama tetap. Lihat bagian di atas.

`waitForSucceeded` sekarang gagal lebih awal kalau ada job FAILED (sebelumnya menunggu sampai timeout). Hasil lulus/gagal sama; yang berubah hanya kapan dan dengan pesan apa test gagal.

### Risiko yang tersisa dan keputusan yang dibutuhkan

- **Kejenuhan satu penulis pada flush lambat.** Di emulasi dengan flush ≥5 ms, sebagian run masih mencatat `lease_at_risk`: satu worker tidak mendapat lock sepanjang satu lease penuh (600 ms di test), baik untuk commit maupun heartbeat. Tidak ada salah klasifikasi, tidak ada job hilang/ganda, error-nya keras. Tapi assertion "0 error worker" di test capstone akan gagal kalau commit di mesin Windows itu ≥±5 ms. Ini batas yang sudah dinamai ADR-001 ("database is locked berulang pada beban normal → ukur ulang"). Opsi (belum dipilih, butuh keputusan pemilik): (a) perlakukan sebagai batas lingkungan dan dokumentasikan syarat storage untuk test itu; (b) `PRAGMA synchronous = NORMAL` di WAL (flush hanya saat checkpoint; trade-off durabilitas, keputusan arsitektur); (c) kurangi tekanan lock (mis. tidak heartbeat selama retry commit, cek baca sebelum claim saat antrean kosong); (d) lease test lebih panjang, sekarang dengan bukti bahwa tunggu nyata Windows ±1.5x nominal.
- **Sisa yang terlihat di emulasi +5 ms:** 1 dari 10 run suite penuh (`lease_at_risk`), dan di replay 1 `job_state_write_failed reason=retry_window_exhausted` dari 12 run kode baru (setelah retry, bukan `lease_too_short` tanpa retry). Keduanya error keras, job dipulihkan lewat lease, 0 hilang/ganda/FAILED. Di +2 ms: 0 dari 10.
- **`extendLease` masih memakai `now` sebelum menunggu lock** (lihat di atas). Belum diubah.
- **Windows belum diverifikasi ulang.** Biaya flush mesin Windows belum diketahui; `npm run busy-wait-check` sekarang mencetak latency commit dan `setTimeout(1)` nyata.

## C-3: `lease_at_risk` di Windows setelah C-2 (validasi `e48142e`), 2026-10-26

**Hasil Windows (pemilik proyek, commit `e48142e`):** doctor PASS. `npm test` 103 test, 100 lulus, 1 gagal, 2 skip. `busy-wait-check`: commit tulis median 5.23 ms, p90 14.23 ms, max 16.17 ms; `setTimeout(1)` median 15.58 ms. Satu-satunya kegagalan: test kontensi capstone (`reliability.test.js` "kontensi: 4 worker polling 1 ms, 150 job") pada assertion "0 error worker", karena satu `lease_at_risk` (`workerId: w2`, `leaseLeftMs: 15`, `database is locked`). 150/150 diterima, 0 sukses ganda, konsisten.

### Metode

1. **Instrumentasi tanpa mengubah perilaku** (commit `954adeb`, terpisah dari perbaikan supaya "before" diukur dengan kode lama). Setiap event heartbeat membawa: keterlambatan tick (`lagMs`), operasi database sinkron terlama yang memblokir tick itu (`blockedBy`), tunggu lock heartbeat itu sendiri (`lockWaitMs`), `busy_timeout` yang berlaku, batas lease yang tersimpan (`leaseUntil`) dan asalnya (`leaseFrom`, `leaseSetAt`, `leaseSetLockWaitMs`). Baru: `warn lease_overrun` kalau tulisan status mendarat setelah tenggat lease di database. Dengan `LEASE_TRACE=1`: setiap heartbeat sukses (`heartbeat_ok`, `grantedMs` = lease yang benar-benar diberikan), jejak setiap transaksi tulis di semua proses (`tx_trace`: label, mulai, tunggu lock, pegang lock, hasil), dan penghitung polling worker.
2. **`npm run lease-probe`**: memutar ulang skenario test capstone N kali dan, untuk setiap `lease_at_risk`, memecah anggaran lease (lease hilang sebelum ditulis / jarak sampai tick / tunggu heartbeat), menghitung okupansi write lock di jendela itu dari jejak semua proses, dan menentukan hasilnya **dari database** (`lease_expired` = benar-benar diambil alih; `lease_overrun` = tenggat lewat tanpa diambil alih; selain itu tulisan berikutnya mendarat sebelum tenggat).
3. **Emulasi Windows yang lebih lengkap** (`contention-c3/harness/wintimer.c`): selain sleep busy handler (seperti `wintick.c` C-2), timeout `epoll_wait` libuv juga dibulatkan ke tick 15.625 ms (timer Node), dan biaya flush mengikuti distribusi Windows yang dilaporkan (70% +4.7 ms, 30% +13.7 ms). Validasi terhadap angka Windows: commit median 5.80 / p90 14.72 / max 15.85 ms (Windows 5.23 / 14.23 / 16.17), `setTimeout(1)` 15.40 ms (15.58), busy 200 ms → 299 ms (296.9). Batas: tidak meniru `LockFileEx`, scheduler, atau disk Windows sebenarnya.

### Akar masalah (terbukti di emulasi; menunggu konfirmasi Windows lewat §1c VALIDATION-PLAN)

Kode `954adeb` (= `e48142e` + instrumentasi), profil Windows, 30 run: 16/30 lulus, **15 `lease_at_risk`, 15/15 dengan tanda yang sama** (`contention-c3/probe/before-954adeb.txt`, contoh lengkap `before-954adeb-example-run-006.json`):

| Komponen anggaran lease 600 ms | Nilai (15 event) |
|---|---|
| Lease hilang sebelum ditulis (`now` sebelum lock) | **0 ms** (lease berasal dari claim, yang sudah diperbaiki di C-2) |
| Claim → tick heartbeat pertama | 306-328 ms, di antaranya **lag 150-163 ms**: tick jatuh tempo pada 150 ms tidak bisa jalan karena `completeAttempt` sedang menunggu lock **299 ms secara sinkron** (`blockedBy: write:complete`) |
| Tunggu lock heartbeat itu sendiri | 299-304 ms (busy_timeout 200 ms nominal) |
| Sisa lease saat `lease_at_risk` | **-32 s/d -5 ms** (Windows: +15 ms; tunggu Windows 296.9 ms, sedikit di bawah emulasi) |
| Okupansi write lock oleh proses lain di jendela itu | 80-91% |
| Hasil menurut database | **12 diambil alih worker lain** (`lease_expired`, hasil worker lama ditolak fencing: `stale_completion_rejected`), **3 tenggat lewat** tanpa diambil alih (tulisan diterima) |

Rantainya:
1. `node:sqlite` sinkron: selama tulisan status menunggu lock, event loop worker berhenti, termasuk timer heartbeat.
2. Busy handler SQLite menghitung sleep nominal; Windows membulatkan setiap sleep ke tick 15.6 ms, jadi `BUSY_TIMEOUT_MS` 200 = ±297 ms nyata.
3. Commit pertama gagal BUSY (±297 ms), heartbeat yang tertunda langsung jalan lalu gagal BUSY juga (±297 ms): 2 x 297 + jeda > 600. Aturan konfigurasi `BUSY_TIMEOUT_MS + HEARTBEAT_MS < LEASE_MS` (200 + 150 < 600) tidak menangkap ini, karena mengasumsikan heartbeat bisa jalan tepat waktu. Syarat sebenarnya untuk urutan ini: `HEARTBEAT_MS + 2 x tunggu_nyata < LEASE_MS` (Linux 550 < 600, Windows 744 > 600). Aturan di `loadConfig` **tidak** diperketat karena akan menolak konfigurasi yang diterima test lama (`storage.test.js`: lease 1000, heartbeat 200, busy 500); dicatat di sini.
4. Kontensi: write lock dipegang 80-91% waktu di jendela itu oleh commit ber-fsync (create API, claim, complete, porsi hampir sama). Polling claim kosong 85-700 per run, tapi total memegang lock < 3 ms per run: **bukan** sumber tekanan, jadi cek-baca sebelum claim tidak akan membantu.

**Klasifikasi:**
- **Risiko lease nyata, bukan false positive.** Batas yang dipakai monitor sama dengan `lease_expires_at` di database (sejak C-3 dibaca balik lewat `RETURNING`); di 12/15 kasus job memang diambil alih.
- **Pemulihan lewat lease bekerja**: setiap pengambilalihan menghasilkan tepat satu sukses, worker lama ditolak fencing, 0 sukses ganda di semua run.
- **`now` sebelum lock pada heartbeat (batas yang dicatat di C-2) nyata tapi bukan penyebab event ini.** Terukur terpisah: heartbeat sukses yang menunggu lock 305 ms hanya memberi lease ±295 ms. Test A di bawah: 153 ms hilang di Linux.

### Perbaikan (commit `eb62487`)

| Perubahan | Alasan / bukti |
|---|---|
| **Complete/fail + claim job berikutnya dalam satu transaksi** (`andClaim`, worker loop meneruskan `next`) | Mengurangi tekanan write lock tanpa mengubah durabilitas: 58-83% claim terjadi tepat setelah commit status oleh worker yang sama (`chainableClaims` di probe). Satu commit ber-fsync lebih sedikit per job; keduanya tetap di-commit sebelum dipakai, atomik. Claim commit per run 148 → 29 (median). Saat worker berhenti tidak ada claim baru, dan job yang sudah di-claim tetap diproses |
| `extendLease` = transaksi `BEGIN IMMEDIATE` ber-fence, `now` setelah lock, `RETURNING lease_expires_at` | Lease yang diberikan heartbeat tidak lagi termakan tunggu lock-nya sendiri; monitor memakai nilai yang tersimpan |
| `completeAttempt` / `failAttempt`: `now` setelah lock (satu nilai per transaksi) | `finished_at`, `next_run_at`, dan urutan event mencerminkan kapan status berubah. Sebelumnya `stale_completion_rejected` bisa tercatat lebih awal dari `lease_expired` yang menyebabkannya |
| Batas busy_timeout retry diberikan per transaksi (PRAGMA diset lalu dikembalikan), bukan mengubah state koneksi | Heartbeat yang jalan di sela retry tidak lagi mewarisi batas retry yang dipendekkan (cacat laten; field `busyTimeoutMs` di event heartbeat membuktikannya per event) |
| `BEGIN IMMEDIATE /* label */` | Terlihat di jejak; fault injection test melewatkan heartbeat seperti saat heartbeat masih UPDATE autocommit |

Tidak diubah, sesuai permintaan: `synchronous`, panjang lease, assertion test lama. Fencing `(lease_owner, attempts)` tidak berubah dan berlaku juga untuk claim yang digabung. Perpanjangan lease setelah tenggat tapi sebelum diambil alih tetap diterima (seperti sebelumnya): aman karena semua tulisan diserialkan oleh write lock.

**Dicoba dan ditolak berdasarkan data (dicatat apa adanya):** mengambil write lock dengan batas waktu NYATA (coba ulang tiap tick, bukan busy handler SQLite). Ini memulihkan arti `BUSY_TIMEOUT_MS` di Windows (tunggu 207 ms, bukan 299) dan lease jarang habis, tapi setiap percobaan jadi lebih pendek sehingga BUSY justru naik. Saya sempat mengimplementasikannya lebih dulu; pengukuran menunjukkan hasilnya **lebih buruk** pada test ini, jadi dibuang.

### Before/after (emulasi profil Windows, skenario test capstone, 30 run per baris)

| Varian | Lulus (0 error worker) | `lease_at_risk` | Lease benar-benar habis | POST 503 | `state_write_busy` |
|---|---|---|---|---|---|
| `954adeb` (sebelum) | 16/30 | 15 | 15 | 39 | 117 |
| perbaikan heartbeat/timestamp saja | 18/30 | 15 | 15 | 30 | 133 |
| + batas lock waktu nyata (ditolak) | 9/30 | 28 | 7 | 50 | 171 |
| + batas lock waktu nyata + chaining (ditolak) | 17/30 | 23 | 5 | 16 | 106 |
| **heartbeat/timestamp + chaining** (varian pra-commit) | **22/30** | **6** | **6** | **6** | **109** |
| **`eb62487` final** | **20/30** | **11** | **11** | **4** | **83** |

Di semua run: 0 sukses ganda, 0 job hilang.

Cara membaca angka ini dengan jujur: dua pengukuran kode akhir (22/30 dan 20/30, total 42/60 = 70%) vs sebelum 16/30 (53%) adalah perbaikan sedang yang **belum terpisah tegas dari variasi** (Fisher exact: p = 0.16 dua sisi, 0.09 satu sisi; final saja vs sebelum: p = 0.43). Efek yang jelas: POST 503 39 → 4-6, claim commit 148 → 29 per run, `state_write_busy` 117 → 83-109, lease heartbeat yang diberikan minimal 565 ms (sebelumnya bisa ±295 ms). **Mekanismenya tidak hilang**: 11/11 `lease_at_risk` di run final punya tanda yang sama dengan sebelum perbaikan (`claim/complete`, lease hilang sebelum ditulis 0, lag 150-156 ms karena `write:complete` 299 ms, tunggu heartbeat 298-301 ms). Perbaikan ini mengurangi seberapa sering dua tunggu berturut-turut terjadi, tidak membuatnya muat di lease. File: `contention-c3/probe/*.txt` dan `*-summary.json`. Varian di tengah diukur dari tree yang belum di-commit dengan switch eksperimen sementara (sudah dihapus); baris final diukur dari commit `eb62487`.

**Tanpa jejak** (`LEASE_TRACE` menambah tulisan stdout di setiap proses dan ikut menaikkan kontensi, jadi angka probe di atas pesimis): test capstone saja, emulasi profil Windows, 30 run per kode (`contention-c3/capstone-only-no-trace.txt`):

| Kode | Lulus | Error yang menggagalkan |
|---|---|---|
| `954adeb` (sebelum) | 23/30 | 8 `lease_at_risk` di 7 run, semuanya `blockedBy write:complete`, lag 150-152 ms, tunggu heartbeat 299 ms, sisa lease -25 s/d -4 ms |
| `eb62487` | 27/30 | 2 `lease_at_risk` (tanda yang sama), 2 `job_state_write_failed` (retry habis di dalam lease) |

Arah sama dengan probe, tapi lagi-lagi belum terpisah tegas dari variasi (Fisher exact p = 0.30). Pesan gagal test capstone sekarang sudah memuat sebabnya (`blockedBy`, `lagMs`, `lockWaitMs`, `leaseFrom`) tanpa perlu probe.

Suite penuh (`npm run test:repeat`, 10 run per baris, `contention-c3/repeat-*`):

| Lingkungan | Hasil | Catatan |
|---|---|---|
| `eb62487`, Linux biasa | 10/10 | |
| `954adeb`, emulasi profil Windows | 6/10 | Gagal: "BUSY terus-menerus" 2x, "dua worker, banyak job" 2x. Keduanya sudah ada sebelum C-3, lihat di bawah |
| `eb62487`, emulasi profil Windows | 0/10 | Test baru E gagal 10/10 (**kesalahan test saya**, lihat di bawah), "BUSY terus-menerus" 3x, "dua worker" 1x, capstone 1x |
| tree akhir (test E dan "dua worker" diperbaiki), Linux biasa | 10/10 | |
| tree akhir, emulasi profil Windows | 7/10 | "BUSY terus-menerus" 2x (sudah ada sebelumnya); capstone 1x: `lease_at_risk` dengan tanda yang sama (`claim`, lag 151 ms, `write:complete`, tunggu 299 ms, sisa -17 ms) + `job_state_write_failed` untuk job yang sama |

### Kesalahan test yang ditemukan lewat emulasi (dicatat apa adanya)

- **Test E versi pertama gagal 10/10 di emulasi Windows.** Lock dipegang tetap 430 ms. Di Linux itu membuat commit dan heartbeat sama-sama BUSY (200 + 200), tapi di Windows heartbeat baru mulai ±300 ms dan mendapat lock saat dilepas pada 430 ms, jadi tidak pernah BUSY. Test itu akan gagal juga di Windows sungguhan. Diperbaiki di test: tunggu nyata busy_timeout 200 ms diukur dulu di mesin itu (minimum dari 3), lock dipegang `2 x tunggu + 40 ms`, dan batas bawah assertion 190 ms (tunggu tidak mungkin lebih pendek dari nominal), bukan angka kalibrasi. Setelah itu: 30/30 di emulasi, 20/20 di Linux.
- **"dua worker, banyak job" (`integration.test.js`, sudah ada sebelum C-3) mengabaikan status POST.** Satu `503 DB_BUSY` berarti hanya 29 job ada dan test menunggu `SUCCEEDED === 30` sampai timeout 10 s. Terbukti di emulasi: 3/40 run, setiap kegagalan = satu 503, 29 job SUCCEEDED, 0 RUNNING/PENDING, worker hidup. Pola yang sama dengan yang C-2 perbaiki di test 150 job. Diperbaiki di test: `submitJobs` (Idempotency-Key, ulangi 503), ditambah assertion 0 gagal kirim, 30 id unik, `jobs.total = 30`. Semua assertion lama tetap.

### Temuan yang sudah ada sebelum C-3, tidak diperbaiki di sini

"BUSY terus-menerus" (C-1, `contention.test.js`) gagal 2/10 (`954adeb`) dan 3/10 (`eb62487`) di emulasi profil Windows: `retryMs` 1501-1509 ms, assertion `< lease 1500 ms`. Shim C-3 juga membulatkan timer Node, jadi `sleep(5-50 ms)` backoff retry menjadi kelipatan 15.6 ms, dan prediksi retry C-2 hanya memperhitungkan molornya tunggu lock, bukan molornya sleep backoff. Di Windows sungguhan test ini lulus (laporan `e48142e`), jadi belum terbukti di Windows. Usulan (belum diterapkan, di luar lingkup C-3): ukur molor sleep backoff yang teramati dan kurangkan dari anggaran retry seperti `overshootMs`.

### Test regresi (kontensi SQLite sungguhan: thread lain dengan koneksinya sendiri memegang write lock dengan waktu yang ditentukan)

| Test | Di `954adeb` | Di `eb62487` |
|---|---|---|
| A. heartbeat: lease dihitung setelah lock didapat | **gagal**: "lease dihitung 153 ms sebelum lock dilepas" | lulus |
| D. `completeAttempt`: `finished_at`/event setelah lock | **gagal**: "succeeded tercatat 150 ms sebelum lock dilepas" | lulus |
| E. urutan Windows (commit BUSY, heartbeat tertunda lalu BUSY): `lease_at_risk` wajib ada, dengan `blockedBy write:complete`, `lagMs`, `busyTimeoutMs` konfigurasi, `leaseUntil` = batas di database, dan `lease_overrun` tercatat kalau commit mendarat setelah tenggat | lulus (test karakterisasi: memastikan risiko tidak disembunyikan dan bukan false positive, bukan before/after) | lulus |
| Chaining: complete + claim berikutnya satu transaksi, tanpa chain perilaku lama | **gagal** (fitur baru) | lulus |
| Unit store (4): atomik (claim gagal → status juga di-ROLLBACK), fencing tetap menolak complete basi, satu evaluasi waktu per transaksi, tanpa `andClaim` return lama | **gagal** 3 dari 4 (fitur baru) | lulus |

Perubahan pada test lama (C-3): (1) `injector()` di `contention.test.js`: heartbeat (sekarang transaksi berlabel) tidak dihitung sebagai "BEGIN ke-n", supaya penomoran dan semantik test C-1 tetap sama; (2) "dua worker, banyak job": loop POST memakai kontrak 503 (lihat di atas). Tidak ada assertion lama yang dihapus atau dilonggarkan. Bukti kegagalan di kode lama: `contention-c3/new-tests-on-954adeb.txt`.

### Risiko yang tersisa dan keputusan yang dibutuhkan

- **Windows belum diverifikasi ulang.** Semua angka di atas dari emulasi. Yang perlu dari mesin Windows: `npm run lease-probe -- --runs 30` (VALIDATION-PLAN §1c) di `e48142e` **dan** `eb62487`. Akar masalah dianggap terbukti di Windows hanya kalau tanda `lease_at_risk` di sana sama (`claim/complete`, `lost=0`, `blockedBy write:complete` ±297 ms, tunggu heartbeat ±297 ms).
- **Test capstone masih bisa gagal di storage Windows ini** (emulasi: 8-10 dari 30 run, semuanya dengan tanda di atas). Setiap kegagalan yang tersisa adalah risiko lease nyata dengan sebab yang tercatat, bukan salah klasifikasi. Sumbernya tetap kombinasi: event loop terblokir oleh tunggu lock sinkron, `busy_timeout` ±1.5x di Windows, dan okupansi write lock ±80% dari commit ber-fsync di bawah klien yang mengirim secepat mungkin. Opsi berikutnya, semuanya butuh keputusan pemilik: (a) lease atau busy test sesuai syarat `HEARTBEAT_MS + 2 x tunggu_nyata < LEASE_MS` (ditolak untuk C-3); (b) `synchronous = NORMAL` (ditolak); (c) **rekomendasi saya**: heartbeat di thread sendiri dengan koneksi SQLite sendiri, supaya heartbeat mencoba lock **bersamaan** dengan commit yang sedang menunggu, bukan sesudahnya. Ini satu-satunya opsi yang menyerang mekanismenya langsung tanpa mengubah lease, busy_timeout, atau durabilitas (menghapus lag ±150 ms dan antrean dua tunggu berurutan). Biaya: perubahan arsitektur worker, koneksi ketiga per proses, dan fencing heartbeat tetap lewat `(lease_owner, attempts)`. Belum diimplementasikan; (d) memperketat validasi konfigurasi ke syarat di atas (mengubah kontrak `loadConfig`).
