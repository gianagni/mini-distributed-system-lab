# Hasil Eksperimen

Dibangkitkan otomatis oleh `npm run experiment`. Data mentah: `experiment-results.json`.

- Dijalankan: 2026-10-22T18:37:19.736Z sampai 2026-10-22T18:41:40.482Z
- Environment: Node v22.23.3, linux 6.18.54-instabox x64, 4 CPU (AMD EPYC), RAM 8 GiB
- Versi kode: tidak diketahui (bukan git checkout)
- Repetisi per konfigurasi: 3. Angka ditulis sebagai median (min-max) kalau lebih dari satu repetisi.
- Konfigurasi bersama: `{"LEASE_MS":"1000","HEARTBEAT_MS":"250","BUSY_TIMEOUT_MS":"300","BACKOFF_BASE_MS":"100","BACKOFF_CAP_MS":"1000","POLL_MS":"20","ALLOW_FAULT_INJECTION":"1","MAX_PENDING":"100000"}`

## 1. Ablation: kontribusi retry, timeout, dan lease recovery

Workload: 200 job dari seed 42 (komposisi: clean 127, transient1 50, transient2 15, permanent 4, hang 4). 3 worker. Pada t=0.8 s w1 di-kill -9 (diganti w4 pada t=1.0 s), pada t=1.6 s w2 di-kill -9 (diganti w5 pada t=1.8 s). Batas tunggu 15 s. "Macet" = belum final saat batas tunggu.

| Konfigurasi | RECOVERY / MAX_ATTEMPTS / JOB_TIMEOUT_MS | Sukses | Gagal | Macet | Semua final dalam (ms) | Total attempt | Retry | Reclaim lease | p50 / p95 end-to-end sukses (ms) |
|---|---|---|---|---|---|---|---|---|---|
| Baseline | 0 / 1 / 0 | 125 (99-125) | 63 (50-63) | 12 (12-51) | tidak pernah | 193 (154-193) | 0 (0-0) | 0 (0-0) | 2077 / 5843 |
| + retry saja | 0 / 3 / 0 | 125 (99-125) | 4 (4-4) | 71 (71-97) | tidak pernah | 193 (154-194) | 59 (46-60) | 0 (0-0) | 2370 / 6142 |
| + timeout saja | 0 / 1 / 1000 | 126 (125-127) | 72 (71-73) | 2 (2-2) | tidak pernah | 200 (200-200) | 0 (0-0) | 0 (0-0) | 2488 / 4844 |
| + lease recovery saja | 1 / 1 / 0 | 124 (99-125) | 65 (52-66) | 10 (10-49) | tidak pernah | 193 (154-193) | 0 (0-0) | 2 (2-2) | 2086 / 5842 |
| Semua (improved) | 1 / 3 / 1000 | 192 (192-192) | 8 (8-8) | 0 (0-0) | 10275 (9928-10324) | 288 (288-290) | 86 (86-88) | 2 (2-2) | 3741 / 7854 |

**Efek ke antrean dan deteksi job macet (median):**

| Konfigurasi | Puncak antrean siap | Antrean siap tersisa | Job RUNNING tersisa | ...dengan lease kedaluwarsa | Umur RUNNING tertua (ms) | Umur antrean siap tertua (ms) |
|---|---|---|---|---|---|---|
| Baseline | 194 | 7 | 5 | 2 | 14133 | 14905 |
| + retry saja | 194 | 66 | 5 | 2 | 14199 | 14974 |
| + timeout saja | 194 | 0 | 2 | 2 | 14200 | - |
| + lease recovery saja | 194 | 7 | 3 | 0 | 13061 | 14964 |
| Semua (improved) | 196 | 0 | 0 | 0 | - | - |

**Hasil per kategori job (repetisi pertama), format sukses / gagal / macet:**

| Kategori | n | Baseline | + retry saja | + timeout saja | + lease recovery saja | Semua (improved) |
|---|---|---|---|---|---|---|
| clean | 127 | 125 / 0 / 2 | 124 / 0 / 3 | 126 / 0 / 1 | 125 / 0 / 2 | 127 / 0 / 0 |
| transient1 | 50 | 0 / 44 / 6 | 1 / 0 / 49 | 0 / 50 / 0 | 0 / 45 / 5 | 50 / 0 / 0 |
| transient2 | 15 | 0 / 15 / 0 | 0 / 0 / 15 | 0 / 15 / 0 | 0 / 15 / 0 | 15 / 0 / 0 |
| permanent | 4 | 0 / 4 / 0 | 0 / 4 / 0 | 0 / 4 / 0 | 0 / 4 / 0 | 0 / 4 / 0 |
| hang | 4 | 0 / 0 / 4 | 0 / 0 / 4 | 0 / 3 / 1 | 0 / 1 / 3 | 0 / 4 / 0 |

**Kegagalan per error class (repetisi pertama):**

- Baseline: `{"PERMANENT":4,"TRANSIENT":59}`
- + retry saja: `{"PERMANENT":4}`
- + timeout saja: `{"PERMANENT":4,"TIMEOUT":3,"TRANSIENT":65}`
- + lease recovery saja: `{"PERMANENT":4,"TRANSIENT":59,"WORKER_LOST":2}`
- Semua (improved): `{"PERMANENT":4,"TIMEOUT":4}`

**Invariant:** 0 violation di 34 run (sukses ganda: 0). Warning yang muncul: `{"running_lease_expired":18}` (total semua repetisi ablation).

## 2. Drain capacity: antrean penuh, k worker

Job dimasukkan dulu tanpa worker, lalu k worker dinyalakan bersamaan. Waktu diukur dari worker pertama siap sampai job terakhir selesai (timestamp database). Semua proses berbagi CPU mesin yang sama dan satu file SQLite.

| Workload | Worker | Job | Drain (ms) | Job/detik |
|---|---|---|---|---|
| Ringan (orderCount=100, tanpa delay) | 1 | 1000 | 212 (203-221) | 4717 (4525-4926) |
| Ringan (orderCount=100, tanpa delay) | 2 | 1000 | 239 (229-256) | 4184 (3906-4367) |
| Ringan (orderCount=100, tanpa delay) | 4 | 1000 | 280 (251-305) | 3571 (3279-3984) |
| Menunggu I/O (delayMs=20) | 1 | 300 | 6267 (6234-6303) | 48 (48-48) |
| Menunggu I/O (delayMs=20) | 2 | 300 | 3125 (3117-3145) | 96 (95-96) |
| Menunggu I/O (delayMs=20) | 4 | 300 | 1563 (1557-1579) | 192 (190-193) |

## 3. Latency POST dari satu client berurutan

1000 POST berurutan, 2 worker aktif. p50 / p95 / p99 = 0.27 / 1.42 / 3.64 ms. Laju client 2157 request/detik. Ini batas client berurutan, bukan kapasitas maksimum API.
