# ADR-001: API + worker + SQLite, tanpa broker dan tanpa DB baru

- Status: Diterima (iterasi 4), direvisi setelah audit hardening
- Tanggal: 2026-10-22
- Bukti: `docs/EXPERIMENT-RESULTS.md` (sandbox), `docs/evidence/nanad/` (InstaBox), `docs/COMPARISON.md`, `docs/AUDIT.md`, `npm test`

## Konteks
Brief Bab 10 membatasi scope: satu API service, satu worker, satu storage sederhana. Database dan message broker opsional. Iterasi 4 meminta kita bertanya apakah worker perlu jadi service terpisah, perlu queue, atau perlu DB baru, dan "belum perlu" boleh jadi jawaban final.

## Keputusan

1. **Worker adalah proses terpisah dari API, tapi satu codebase dan satu deployment unit.** Alasannya isolasi kegagalan dan CPU, bukan skala. Worker di-`kill -9` atau di-`SIGSTOP` tidak mengganggu API (teruji).

2. **Tabel SQLite sebagai queue, tanpa message broker.** Claim memakai `BEGIN IMMEDIATE`. Hanya satu penulis, jadi dua worker tidak bisa mengambil job yang sama. Teruji 0 claim ganda pada 6 worker x 1000 job dan 4 worker dengan polling 1 ms.

3. **Tanpa DB baru.** Satu file SQLite (WAL, `synchronous=FULL` bawaan) dipakai bersama oleh API dan worker di satu host.

4. **Semantik: at-least-once + hasil idempotent + fencing.** Exactly-once tidak dijanjikan.
   - Kontrak file vs database: file laporan ditulis atomik (tmp + rename) **lebih dulu**, lalu `SUCCEEDED` di-commit bersama `sha256` file. Commit database adalah titik "selesai".
   - Crash di antara keduanya membuat job di-retry dan file ditulis ulang dengan isi identik.
   - Kalau attempt habis, file yatim bisa tertinggal untuk job `FAILED`. Ini diizinkan dan dilaporkan `npm run check` sebagai warning.
   - Alternatif "commit dulu, tulis file kemudian" ditolak. Crash setelah commit akan menghasilkan `SUCCEEDED` tanpa file, dan butuh mekanisme pemulihan tambahan.
   - Semua tulisan status worker di-fence dengan `(lease_owner, attempts)`.

5. **Retry bounded:** `MAX_ATTEMPTS=3`, exponential backoff full jitter (base 500 ms, cap 10 s). Hanya error yang aman diulang yang di-retry. Ablation menunjukkan retry **tanpa** timeout memperburuk antrean: job hang ditahan lebih lama, sehingga job macet bertambah. Retry hanya bernilai bersama timeout dan lease recovery.

6. **Timing:** lease 5 s, heartbeat 1 s, `BUSY_TIMEOUT_MS` 1 s, job timeout 30 s, request timeout 10 s. Aturan yang divalidasi saat start: `BUSY_TIMEOUT_MS + HEARTBEAT_MS < LEASE_MS`. Alasannya, `node:sqlite` sinkron, jadi menunggu lock membekukan heartbeat (AUDIT P1-1).

7. **Batas keamanan:** API hanya loopback secara default. Non-loopback wajib `ALLOW_REMOTE=1`. Fault injection hanya di loopback dan wajib diizinkan di API **dan** worker.

## Alternatif yang ditolak

| Alternatif | Kenapa ditolak sekarang |
|---|---|
| Redis/RabbitMQ/Kafka sebagai queue | Satu sistem lagi untuk dioperasikan, tanpa bottleneck terbukti. Status job dan pesan jadi dual write. |
| PostgreSQL + `FOR UPDATE SKIP LOCKED` | Pola yang tepat untuk multi-host dan banyak penulis, tapi butuh server DB. Belum ada kebutuhan multi-host. |
| Satu proses (API sekaligus worker) | Crash/CPU worker ikut menjatuhkan atau memperlambat API. |
| Kubernetes/containers | Satu host, dua jenis proses. Overhead tidak sebanding (Bab 6.3). Docker juga tidak dibutuhkan untuk menjalankan. |
| fsync file sebelum commit | Belum dibuktikan perlu di environment ini (lihat AUDIT R1). Dicatat sebagai langkah berikut, bukan diterapkan berdasarkan dugaan. |

## Konsekuensi (terukur)

- **Satu penulis membatasi job ringan.** Di eksperimen drain, job ringan tidak naik linear dari 1 ke 4 worker: sandbox 1.29x, InstaBox `nanad` 0.76x. Besarnya penurunan di `nanad` tercampur ongkos startup karena drain-nya hanya 0.2-0.3 s. Job yang menunggu I/O naik linear di keduanya (3.86x dan 4.00x). Menambah worker hanya membantu kalau kerja per job lebih mahal daripada claim-nya.
- **Throughput bergantung pada biaya fsync.** `nanad` 6-12x lebih cepat dari sandbox untuk operasi storage, tapi hampir sama untuk latency yang didominasi delay. Ukur ulang di setiap mesin target.
- **Correctness tidak bergantung environment.** Konfigurasi lengkap memberi 192/8/0 di 6/6 repetisi pada dua mesin, dengan 0 invariant violation di 68 run (`COMPARISON.md`).
- **Lock memblokir event loop.** Selama menunggu lock (maksimal `BUSY_TIMEOUT_MS`), proses tidak melayani apa pun.
- **Satu host.** SQLite lokal, lease berbasis jam lokal.
- **Polling** dengan latency mulai job maksimal sekitar `POLL_MS`.
- **Metrik O(n), tanpa retensi** untuk `jobs`, `job_events`, dan file laporan.
- **Side effect non-idempotent** (email, pembayaran) tidak aman. Butuh outbox + dedupe key.

## Trigger untuk membuka ulang keputusan

- Worker harus jalan di lebih dari satu host → PostgreSQL dengan `SKIP LOCKED`.
- Log `database is locked` (`worker_loop_error`, `job_state_write_failed`) muncul berulang pada beban normal, atau POST p95 > 100 ms → ukur ulang, pertimbangkan Postgres.
- `health.oldestReadyPendingAgeMs` naik terus pada beban normal, padahal kerja per job ringan → batas satu penulis tercapai.
- `health.oldestReadyPendingAgeMs` naik terus dan kerja per job berat → tambah worker dulu.
- Ada side effect ke sistem luar → outbox table dulu, belum broker.
- `npm run check` melaporkan `report_missing` setelah crash host → terapkan fsync.
