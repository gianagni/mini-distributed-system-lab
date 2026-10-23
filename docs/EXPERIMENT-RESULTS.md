# Hasil Eksperimen

Dibangkitkan otomatis oleh `npm run experiment`. Data mentah: `experiment-results.json`.

- Dijalankan: 2026-10-22T17:04:15.133Z sampai 2026-10-22T17:09:20.608Z
- Environment: Node v22.22.0, linux 6.18.44-fc-v140 x64, 4 CPU (Intel(R) Xeon(R) Processor @ 2.80GHz), RAM 16 GiB
- Versi kode: git fbef7e4
- Repetisi per konfigurasi: 3. Angka ditulis sebagai median (min-max) kalau lebih dari satu repetisi.
- Konfigurasi bersama: `{"LEASE_MS":"1000","HEARTBEAT_MS":"250","BUSY_TIMEOUT_MS":"300","BACKOFF_BASE_MS":"100","BACKOFF_CAP_MS":"1000","POLL_MS":"20","ALLOW_FAULT_INJECTION":"1","MAX_PENDING":"100000"}`

## 1. Ablation: kontribusi retry, timeout, dan lease recovery

Workload: 200 job dari seed 42 (komposisi: clean 127, transient1 50, transient2 15, permanent 4, hang 4). 3 worker. Pada t=0.8 s w1 di-kill -9 (diganti w4 pada t=1.0 s), pada t=1.6 s w2 di-kill -9 (diganti w5 pada t=1.8 s). Batas tunggu 15 s. "Macet" = belum final saat batas tunggu.

| Konfigurasi | RECOVERY / MAX_ATTEMPTS / JOB_TIMEOUT_MS | Sukses | Gagal | Macet | Semua final dalam (ms) | Total attempt | Retry | Reclaim lease | p50 / p95 end-to-end sukses (ms) |
|---|---|---|---|---|---|---|---|---|---|
| Baseline | 0 / 1 / 0 | 99 (99-125) | 51 (50-63) | 50 (12-51) | tidak pernah | 154 (154-193) | 0 (0-0) | 0 (0-0) | 2009 / 5693 |
| + retry saja | 0 / 3 / 0 | 128 (102-129) | 4 (4-4) | 68 (67-94) | tidak pernah | 199 (160-199) | 61 (49-62) | 0 (0-0) | 2565 / 6298 |
| + timeout saja | 0 / 1 / 1000 | 125 (125-126) | 73 (72-73) | 2 (2-2) | tidak pernah | 200 (200-200) | 0 (0-0) | 0 (0-0) | 2593 / 4833 |
| + lease recovery saja | 1 / 1 / 0 | 100 (98-124) | 53 (51-66) | 49 (10-49) | tidak pernah | 154 (154-193) | 0 (0-0) | 2 (2-2) | 2007 / 5566 |
| Semua (improved) | 1 / 3 / 1000 | 192 (192-192) | 8 (8-8) | 0 (0-0) | 10490 (10439-10663) | 289 (289-290) | 87 (87-88) | 2 (2-2) | 3633 / 7989 |

**Efek ke antrean dan deteksi job macet (median):**

| Konfigurasi | Puncak antrean siap | Antrean siap tersisa | Job RUNNING tersisa | ...dengan lease kedaluwarsa | Umur RUNNING tertua (ms) | Umur antrean siap tertua (ms) |
|---|---|---|---|---|---|---|
| Baseline | 182 | 46 | 5 | 2 | 14066 | 14636 |
| + retry saja | 184 | 63 | 5 | 2 | 14135 | 14637 |
| + timeout saja | 181 | 0 | 2 | 2 | 13912 | - |
| + lease recovery saja | 178 | 46 | 3 | 0 | 14067 | 14640 |
| Semua (improved) | 184 | 0 | 0 | 0 | - | - |

**Hasil per kategori job (repetisi pertama), format sukses / gagal / macet:**

| Kategori | n | Baseline | + retry saja | + timeout saja | + lease recovery saja | Semua (improved) |
|---|---|---|---|---|---|---|
| clean | 127 | 99 / 0 / 28 | 98 / 0 / 29 | 126 / 0 / 1 | 98 / 2 / 27 | 127 / 0 / 0 |
| transient1 | 50 | 0 / 33 / 17 | 4 / 0 / 46 | 0 / 50 / 0 | 0 / 34 / 16 | 50 / 0 / 0 |
| transient2 | 15 | 0 / 13 / 2 | 0 / 0 / 15 | 0 / 15 / 0 | 0 / 13 / 2 | 15 / 0 / 0 |
| permanent | 4 | 0 / 4 / 0 | 0 / 4 / 0 | 0 / 4 / 0 | 0 / 4 / 0 | 0 / 4 / 0 |
| hang | 4 | 0 / 0 / 4 | 0 / 0 / 4 | 0 / 3 / 1 | 0 / 0 / 4 | 0 / 4 / 0 |

**Kegagalan per error class (repetisi pertama):**

- Baseline: `{"PERMANENT":4,"TRANSIENT":46}`
- + retry saja: `{"PERMANENT":4}`
- + timeout saja: `{"PERMANENT":4,"TIMEOUT":3,"TRANSIENT":65}`
- + lease recovery saja: `{"PERMANENT":4,"TRANSIENT":47,"WORKER_LOST":2}`
- Semua (improved): `{"PERMANENT":4,"TIMEOUT":4}`

**Invariant:** 0 violation di 34 run (sukses ganda: 0). Warning yang muncul: `{"running_lease_expired":17}` (total semua repetisi ablation).

## 2. Drain capacity: antrean penuh, k worker

Job dimasukkan dulu tanpa worker, lalu k worker dinyalakan bersamaan. Waktu diukur dari worker pertama siap sampai job terakhir selesai (timestamp database). Semua proses berbagi CPU mesin yang sama dan satu file SQLite.

| Workload | Worker | Job | Drain (ms) | Job/detik |
|---|---|---|---|---|
| Ringan (orderCount=100, tanpa delay) | 1 | 1000 | 2466 (2021-2644) | 406 (378-495) |
| Ringan (orderCount=100, tanpa delay) | 2 | 1000 | 2197 (2192-2204) | 455 (454-456) |
| Ringan (orderCount=100, tanpa delay) | 4 | 1000 | 1914 (1908-2101) | 522 (476-524) |
| Menunggu I/O (delayMs=20) | 1 | 300 | 7187 (7146-7229) | 42 (41-42) |
| Menunggu I/O (delayMs=20) | 2 | 300 | 3690 (3595-3753) | 81 (80-83) |
| Menunggu I/O (delayMs=20) | 4 | 300 | 1853 (1853-1894) | 162 (158-162) |

## 3. Latency POST dari satu client berurutan

1000 POST berurutan, 2 worker aktif. p50 / p95 / p99 = 1.88 / 10.5 / 21.62 ms. Laju client 310 request/detik. Ini batas client berurutan, bukan kapasitas maksimum API.
