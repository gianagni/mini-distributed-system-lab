# Konsep: Cara Sistem Ini Bekerja

Dokumen belajar. Setiap klaim menunjuk ke kode atau test yang membuktikannya.

## 1. Kenapa worker dipisah dari API?

API harus selalu cepat menjawab "job lu sudah diterima, ini id-nya". Worker mengerjakan bagian yang lambat dan rawan gagal.

Kalau digabung dalam satu proses:
- Kerja CPU (agregasi laporan) memblokir event loop, jadi request lain ikut lambat.
- Kalau worker crash (bug, kehabisan memori, `kill -9`), API ikut mati.

Dengan dua proses, worker bisa mati tanpa API ikut mati. Test `worker di-kill -9 saat RUNNING` membuktikan API tetap melayani. Worker juga bisa ditambah tanpa menyentuh API.

Yang **tidak** dipisah: codebase, storage, dan deployment. Pemisahan hanya untuk isolasi kegagalan, bukan karena "microservices".

## 2. Kenapa SQLite cukup untuk MVP?

Tabel `jobs` berfungsi sebagai queue. Tiga sifat SQLite yang kita andalkan:
- **Transaksi ACID:** claim job dan pencatatan event terjadi utuh, atau tidak sama sekali.
- **`BEGIN IMMEDIATE`:** hanya satu proses yang boleh menulis pada satu waktu. Dua worker tidak mungkin mengubah job yang sama secara bersamaan.
- **WAL mode:** pembaca (`GET /jobs`, `/metrics`) tidak menunggu penulis.

Batasnya terukur di eksperimen drain pada dua mesin. Untuk job ringan, menambah worker **tidak** menaikkan throughput secara linear: 1.29x di sandbox, bahkan 0.76x di InstaBox `nanad`. Semua claim antre di satu kunci tulis. Untuk job yang banyak menunggu I/O, throughput naik hampir linear. Artinya SQLite cukup selama kerja per job jauh lebih mahal daripada claim-nya. Itu berlaku untuk laporan, tapi tidak untuk jutaan job mikro.

SQLite **tidak** cocok kalau worker ada di beberapa mesin. File SQLite tidak boleh dibagi lewat network filesystem.

## 3. Bagaimana job berpindah status?

```
            POST /jobs
                |
                v
           +---------+   claim (lease)    +---------+   commit hasil + sha256   +-----------+
           | PENDING | -----------------> | RUNNING | ------------------------> | SUCCEEDED |
           +---------+                    +---------+                           +-----------+
              ^   ^                         |   |   |
              |   | gagal & boleh retry     |   |   | gagal final (PERMANENT, STORAGE permanen,
              |   +--- (next_run_at=backoff)+   |   |  atau attempt habis)
              |                                 |   v
              |  lease kedaluwarsa (worker      |  +--------+
              +--- mati), attempt masih ada ----+  | FAILED |
                 (langsung di-claim ulang)          +--------+
                 lease kedaluwarsa & attempt habis ---> FAILED (WORKER_LOST)
```

Aturan yang dijaga `src/store.js` dan diperiksa `src/consistency.js`:
- `attempts` hanya naik saat claim, dan tidak pernah melebihi `max_attempts`.
- Setiap attempt di-claim tepat satu kali (`attempt_claimed_twice` harus 0).
- `SUCCEEDED` punya `result`, tepat satu event `succeeded`, dan file laporan dengan sha256 yang cocok.
- `FAILED` punya `error_class` dan tidak punya `result`.
- Job final tidak memegang lease.

## 4. Bagaimana transaksi dan fencing bekerja?

**Transaksi** mencegah dua worker mengambil job yang sama:

```sql
BEGIN IMMEDIATE;                       -- ambil kunci tulis; worker lain menunggu
SELECT ... WHERE status='PENDING' ...  -- pilih satu job
UPDATE jobs SET status='RUNNING', attempts=attempts+1, lease_owner='w1', lease_expires_at=now+5s;
INSERT INTO job_events (... 'claimed' ...);
COMMIT;
```

**Lease** adalah "kontrak sewa" berwaktu. Worker memperpanjangnya lewat heartbeat setiap 1 detik. Kalau heartbeat berhenti, lease kedaluwarsa dan job boleh diambil worker lain.

**Fencing** mencegah worker lama menimpa hasil worker baru. Setiap tulisan status wajib cocok dengan pemilik dan nomor attempt:

```sql
UPDATE jobs SET status='SUCCEEDED', ...
WHERE id=? AND status='RUNNING' AND lease_owner='w1' AND attempts=1;
-- 0 baris berubah => attempt ini sudah basi => hasil ditolak (stale_completion_rejected)
```

Nomor attempt adalah *fencing token*. Walaupun worker baru memakai `WORKER_ID` yang sama (test restart total), nomor attempt-nya berbeda.

## 5. Kenapa retry bisa berbahaya?

Retry mengubah satu kegagalan menjadi beberapa permintaan. Saat dependency sedang kewalahan, retry menambah bebannya (*retry amplification*), lalu dependency makin lambat, lalu makin banyak retry. Karena itu:

- **Bounded:** maksimal 3 attempt. Kegagalan yang bertahan muncul sebagai `FAILED` yang terlihat, bukan disembunyikan.
- **Backoff eksponensial + full jitter:** jeda acak `0..min(cap, base*2^(n-1))`. Retry dari banyak job tidak datang serempak.
- **Hanya error yang aman diulang:** `PERMANENT` dan `STORAGE` permanen (salah path/permission) langsung `FAILED`.
- **Hanya untuk kerja idempotent:** retry boleh karena laporan deterministik. Kirim email atau tagih kartu kredit **tidak** boleh di-retry dengan cara ini.

Eksperimen ablation menunjukkan sisi gelap lain. "Retry saja" tanpa timeout membuat job hang memegang worker lebih lama, sehingga lebih banyak job lain macet. Mekanisme reliability saling bergantung.

## 6. Apa yang sebenarnya terjadi saat worker mati?

Kasus `kill -9` di tengah job (test `worker di-kill -9 saat RUNNING`):
1. Worker mati. Tidak ada kode yang sempat berjalan, jadi status job tetap `RUNNING` dengan `lease_owner=w1`.
2. Tidak ada heartbeat lagi. Setelah `LEASE_MS`, `lease_expires_at < now`.
3. Worker lain (atau worker yang di-restart) menjalankan `claimNext`. Kueri claim juga memilih `RUNNING` yang lease-nya kedaluwarsa. Event `lease_expired` (error class `WORKER_LOST`) dicatat, lalu job di-claim ulang dengan `attempts=2`.
4. Kalau attempt sudah habis, job menjadi `FAILED WORKER_LOST`, bukan macet selamanya.

Kasus crash **setelah** file ditulis tapi **sebelum** commit (test `crash setelah file ditulis...`):
- File laporan sudah ada, status masih `RUNNING`. File ini belum sah.
- Attempt berikutnya menulis ulang file dengan isi byte-per-byte identik, lalu commit `SUCCEEDED` + sha256.
- Kalau attempt habis, job `FAILED` dan file tertinggal sebagai **file yatim**. `npm run check` melaporkannya sebagai warning `orphan_report`. Sumber kebenaran selalu database.

Inilah arti **at-least-once**: kerja bisa terjadi lebih dari sekali, tapi hasil yang di-commit tepat satu, dan efeknya aman karena idempotent. Sistem ini **tidak** exactly-once.

Kasus worker **macet** (bukan mati, test `worker zombie`): worker berhenti lebih lama dari lease, job diambil alih, lalu worker lama bangun. Heartbeat pertamanya gagal (`lease_lost`) dan ia berhenti tanpa menulis status. Kalaupun sempat menulis file, isinya identik.

## 7. Kenapa belum perlu message broker?

Broker (RabbitMQ, Kafka, Redis queue) menyelesaikan masalah yang belum kita punya:
- Throughput tinggi lintas banyak mesin: kita satu mesin, puluhan sampai ratusan job.
- Fan-out ke banyak konsumen: kita punya satu jenis konsumen.

Broker justru menambah masalah baru:
- **Dual write:** status job di database, pesan di broker. Kalau salah satu gagal, keduanya tidak sinkron. Solusinya (outbox pattern) butuh tabel di database lagi.
- Satu sistem lagi untuk dijalankan, dimonitor, di-backup, dan di-debug saat dini hari.

Dengan tabel sebagai queue, status job dan antrean adalah **data yang sama dalam satu transaksi**. Trigger untuk membuka ulang keputusan ini ada di ADR-001.
