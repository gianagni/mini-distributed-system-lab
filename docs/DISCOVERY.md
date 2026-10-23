# Discovery: Mini Distributed System (Capstone Bab 10)

Label bukti mengikuti Bab 0: **ILUSTRASI** = skenario yang kita bangun untuk belajar, **ASUMSI** = belum diverifikasi dengan user nyata, **TERUKUR** = ada di `EXPERIMENT-RESULTS.md`.

## Problem
Membuat laporan pesanan (agregasi ribuan order) terlalu lama untuk dijawab dalam satu request HTTP. Kalau dikerjakan sinkron, request bisa timeout, user mengulang, dan laporan dihitung dua kali. (ILUSTRASI)

## User
Admin toko digital kecil (puluhan sampai ratusan order per hari) yang butuh rekap periodik. (ILUSTRASI, ASUMSI)

## Current process
Admin klik "buat laporan", browser menunggu sampai selesai. Kalau gagal, tidak ada jejak: admin tidak tahu apakah laporan sedang dibuat, gagal, atau perlu diulang. (ILUSTRASI)

## Pain point
1. Request panjang rentan timeout dan klik ulang (duplikasi kerja).
2. Kegagalan diam-diam: proses mati di tengah jalan tanpa status.
3. Tidak ada angka: berapa yang gagal, kenapa, berapa lama.

## Desired process
Admin mengirim permintaan, langsung dapat `jobId` (202). Status bisa dicek: `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`. Kegagalan sementara di-retry otomatis dengan batas. Kegagalan final punya error class yang jelas. Operator bisa melihat metrik.

## Roles
| Role | Kebutuhan |
|---|---|
| Admin (client API) | Kirim job, cek status, ambil hasil |
| Worker (proses) | Ambil job, kerjakan, laporkan hasil/gagal |
| Operator | Lihat metrik dan log untuk mendeteksi masalah |

## Rules
- R1. Satu permintaan dengan `Idempotency-Key` yang sama hanya membuat satu job. Key sama dengan isi berbeda ditolak (409).
- R2. Satu job hanya dikerjakan satu worker pada satu waktu (lease).
- R3. Worker yang mati tidak membuat job macet selamanya: lease kedaluwarsa, job diambil alih.
- R4. Retry hanya untuk error yang aman diulang (TRANSIENT, TIMEOUT, INTERNAL, WORKER_LOST, dan STORAGE yang bisa pulih sendiri seperti disk penuh), maksimal `MAX_ATTEMPTS`.
- R5. Hasil job idempotent: mengerjakan ulang job yang sama menghasilkan file laporan yang identik byte per byte.
- R6. Status hanya boleh ditulis pemilik lease yang sah (fencing).
- R7. Antrean dibatasi (`MAX_PENDING`); kalau penuh, API menolak dengan 429.
- R8. Fault injection (`payload.simulate`) hanya aktif dengan `ALLOW_FAULT_INJECTION=1` di API **dan** worker, dan hanya di HOST loopback.
- R9. Database adalah sumber kebenaran. File laporan sah hanya bila job `SUCCEEDED` dan sha256 file cocok dengan `result.sha256`.
- R10. API hanya mendengar di loopback secara default karena tanpa autentikasi.
- R11. Tidak ada silent failure: setiap kegagalan berakhir sebagai status + error class, atau log `error`, lalu pulih lewat lease.

## Data
- `jobs`: status, attempts, lease, jadwal retry, error class, hasil, timestamp.
- `job_events`: riwayat append-only per attempt (created, claimed, retry_scheduled, lease_expired, succeeded, failed, stale_*).
- File laporan `REPORT_DIR/<jobId>.json`. Checksum-nya disimpan di `jobs.result`.
- Data order dummy dibangkitkan dari `seed`, jadi tidak ada data pribadi.

## MVP
Dua proses Node.js (API, worker) dan satu file SQLite. Tanpa UI, tanpa broker, tanpa dependency eksternal. Lihat `ADR-001-architecture.md`.

## UI
Tidak ada UI. Antarmuka berupa HTTP JSON (`POST /jobs`, `GET /jobs/:id`, `GET /metrics`, `GET /healthz`) dan log JSON per baris. Sesuai brief: fokus reliability dan observability.

## Implementation
Iterasi 1-4 di `REPORT.md`, hardening di `AUDIT.md`. Bukti uji: `npm test`. Bukti metrik: `npm run experiment`. Bukti konsistensi: `npm run check`.

## Pertanyaan terbuka
- Q1. Berapa ukuran laporan dan frekuensi nyata? Jawabannya menentukan apakah SQLite tetap cukup. (ASUMSI)
- Q2. Apakah hasil laporan perlu dikirim (email/webhook)? Kalau ya, side effect itu tidak idempotent dan butuh outbox + dedupe key.
- Q3. Siapa yang boleh membuat job? API ini belum punya autentikasi dan hanya cocok untuk localhost (dijaga validasi config).
- Q4. Berapa lama laporan dan riwayat event harus disimpan? Belum ada retensi.
