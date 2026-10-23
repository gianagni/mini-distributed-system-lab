# Verifikasi Evidence dan Perbandingan: InstaBox `nanad` vs Sandbox

Tanggal: 2026-10-22. Evidence InstaBox dijalankan oleh pemilik proyek di mesin `nanad` (brief awal menyebut mesin `nadia`; dokumen ini memakai nama sesuai laporan dan nama file evidence). Claude tidak punya akses langsung ke InstaBox. Semua angka di bawah diturunkan dari file JSON, bukan disalin manual.

## 1. Evidence

| File | SHA-256 |
|---|---|
| `evidence/nanad/EXPERIMENT-RESULTS.nanad-3reps.md` | `7832d1651f3f3caf25f72d8809a168c197117cb47fb5aece1c830b7028ceb2fb` |
| `evidence/nanad/experiment-results.nanad-3reps.json` | `08819fb497b3862bae6767fd550c0838f1f9640185aa5e9bbb1688a4e82ba7f3` |
| ZIP yang diuji (dilaporkan) | `0510838dedf51f75236b21b053e8aa8be16fe087e8730778eb7f971675e478cb` |

Kedua file evidence disimpan tanpa perubahan.

## 2. Hasil verifikasi

| Pemeriksaan | Hasil |
|---|---|
| SHA-256 ZIP yang dilaporkan vs ZIP yang dibangun dari commit `abb9371` | **Cocok.** Kode yang diuji di `nanad` identik dengan kode final. JSON mencatat "versi kode tidak diketahui" karena hasil unzip bukan git checkout; hash ZIP menutup celah itu. |
| Markdown vs JSON | **Identik byte per byte** dengan output `renderMarkdown()` (dari `scripts/experiment.js` commit `abb9371`) yang dijalankan ulang pada JSON. Markdown adalah render dari JSON, tidak ada angka yang diedit di salah satunya. |
| Konsistensi internal JSON (15 run ablation, 18 run drain, 1 run POST) | **Lulus.** Untuk setiap run: sukses+gagal+macet = 200; jumlah per kategori = plan seed 42; jumlah error class = jumlah gagal; macet = antrean siap + RUNNING tersisa; total attempt = 200 + retry + lease diambil alih (improved) dan 200 - job tak pernah di-claim (baseline); `jobsPerSec = round(n/drainMs*1000)`; drain I/O >= batas teoritis n*20 ms/k; 0 violation; 0 sukses ganda. |
| Test 58/58 di `nanad` | **Dilaporkan, belum bisa diverifikasi:** log `npm test` tidak dilampirkan. |
| Identitas mesin | JSON: Linux 6.18.54-instabox x64, 4 CPU "AMD EPYC", RAM 8 GiB, Node v22.23.3. Konsisten dengan laporan. Nama mesin tidak tercatat di JSON. |

**Kesalahan faktual yang ditemukan (di dokumentasi Claude, bukan di data).** Kolom "Reclaim lease" di output eksperimen menghitung event `lease_expired`. Pada konfigurasi "lease recovery saja" (`MAX_ATTEMPTS=1`), 2 job itu tidak dijalankan ulang, melainkan menjadi `FAILED WORKER_LOST`. Buktinya: `failedByErrorClass.WORKER_LOST` = 2 = nilai kolom itu di ketiga repetisi. Laporan sebelumnya menulis "lease recovery saja menyelamatkan 2 job itu", dan itu salah. Recovery saja mengubah job macet menjadi kegagalan yang terlihat. Label di `scripts/experiment.js` sudah diperbaiki untuk run berikutnya. File evidence (sandbox dan `nanad`) tetap memakai label lama.

## 3. Perbandingan

| | sandbox | nanad |
|---|---|---|
| Node | v22.22.0 | v22.23.3 |
| CPU | 4 x Intel(R) Xeon(R) Processor @ 2.80GHz | 4 x AMD EPYC |
| RAM (GiB) | 16 | 8 |
| Kernel | 6.18.44-fc-v140 | 6.18.54-instabox |
| Versi kode | git fbef7e4 | tidak diketahui (bukan git checkout) |
| Repetisi | 3 | 3 |
| Dijalankan | 2026-10-22T17:04:15.133Z | 2026-10-22T18:37:19.736Z |

**Ablation** (median (min-max) dari repetisi):

| Konfigurasi | Sukses sandbox | Sukses nanad | Macet sandbox | Macet nanad | p50 e2e sandbox | p50 e2e nanad | p95 e2e sandbox | p95 e2e nanad | Final (ms) sandbox | Final (ms) nanad |
|---|---|---|---|---|---|---|---|---|---|---|
| Baseline | 99 (99-125) | 125 (99-125) | 50 (12-51) | 12 (12-51) | 2009 | 2077 | 5693 | 5843 | tidak pernah | tidak pernah |
| + retry saja | 128 (102-129) | 125 (99-125) | 68 (67-94) | 71 (71-97) | 2565 | 2370 | 6298 | 6142 | tidak pernah | tidak pernah |
| + timeout saja | 125 (125-126) | 126 (125-127) | 2 (2-2) | 2 (2-2) | 2593 | 2488 | 4833 | 4844 | tidak pernah | tidak pernah |
| + lease recovery saja | 100 (98-124) | 124 (99-125) | 49 (10-49) | 10 (10-49) | 2007 | 2086 | 5566 | 5842 | tidak pernah | tidak pernah |
| Semua (improved) | 192 (192-192) | 192 (192-192) | 0 (0-0) | 0 (0-0) | 3633 | 3741 | 7989 | 7854 | 10490 (10439-10663) | 10275 (9928-10324) |

**Drain capacity** (median job/detik, rasio terhadap 1 worker di environment yang sama):

| Workload | Worker | sandbox | nanad | nanad / sandbox |
|---|---|---|---|---|
| light | 1 | 406 (1.00x) | 4717 (1.00x) | 11.62x |
| light | 2 | 455 (1.12x) | 4184 (0.89x) | 9.20x |
| light | 4 | 522 (1.29x) | 3571 (0.76x) | 6.84x |
| io | 1 | 42 (1.00x) | 48 (1.00x) | 1.14x |
| io | 2 | 81 (1.93x) | 96 (2.00x) | 1.19x |
| io | 4 | 162 (3.86x) | 192 (4.00x) | 1.19x |

**POST berurutan dari satu client (ms):**

| | sandbox | nanad |
|---|---|---|
| postP50 | 1.88 | 0.27 |
| postP95 | 10.5 | 1.42 |
| postP99 | 21.62 | 3.64 |
| clientRatePerSec | 310 | 2157 |

**Invariant:** sandbox: 0 violation di 34 run, sukses ganda 0. nanad: 0 violation di 34 run, sukses ganda 0.

Tabel di atas dihasilkan oleh:
```bash
node scripts/compare-results.js docs/experiment-results.json sandbox \
  docs/evidence/nanad/experiment-results.nanad-3reps.json nanad
```

## 4. Interpretasi

**Correctness: sama di kedua environment.**
- Konfigurasi lengkap: 192 sukses / 8 gagal / 0 macet di 6 dari 6 repetisi (3 per environment), dengan error class yang sama (4 `PERMANENT`, 4 `TIMEOUT`).
- 0 invariant violation dan 0 sukses ganda di 68 run.

**Konfigurasi parsial bimodal di kedua environment.** Per repetisi, job macet:
- baseline: sandbox 51/50/12, nanad 12/12/51;
- recovery saja: sandbox 49/10/49, nanad 10/10/49;
- retry saja: sandbox 94/68/67, nanad 71/97/71.

Kedua environment menunjukkan dua mode yang sama. Median mengikuti mode yang kebetulan menang 2 dari 3 repetisi:
- sandbox: baseline median 50 macet;
- nanad: baseline median 12 macet.

Perbedaan median ini **bukan** perbedaan environment. Yang bisa disimpulkan hanya rentangnya.

**Latency end-to-end ablation hampir sama** (p50 improved 3633 vs 3741 ms, beda sekitar 3%). Latency ini didominasi delay simulasi, backoff, dan timeout job hang, bukan storage.

**Operasi yang berat di storage jauh lebih cepat di `nanad`.**
- POST p50: 0.27 vs 1.88 ms.
- Drain job ringan 1 worker: 4717 vs 406 job/detik (11.6x).

Setiap claim dan commit adalah transaksi SQLite (WAL, `synchronous=FULL`, ada fsync), dan eksperimen menyimpan database di `os.tmpdir()`.

*Hipotesis, belum diverifikasi:* fsync di `/tmp` milik `nanad` jauh lebih murah, misalnya karena tmpfs atau disk dengan write cache. Kalau benar, angka throughput `nanad` tidak mewakili database di disk persisten. Cara memeriksanya: `df -T /tmp "$(pwd)/data"` di `nanad`.

**Concurrency:**
- Job yang menunggu I/O naik linear di kedua environment (4 worker: 3.86x dan 4.00x).
- Job ringan **tidak** naik linear di keduanya: sandbox 1.29x, `nanad` 0.76x (lebih lambat dengan 4 worker).
- Arah keduanya sama, dan konsisten dengan batas satu penulis SQLite.
- Besarnya 0.76x belum bisa diatribusikan sepenuhnya ke kontensi lock. Drain di `nanad` hanya berlangsung 0.2-0.3 detik, sehingga ongkos booting 3 proses Node tambahan di 4 vCPU ikut terukur, dan waktu start tiap worker tidak tercatat di JSON.
- Untuk memisahkan keduanya, ulangi drain dengan N jauh lebih besar (perlu menambah opsi N di script; belum dilakukan).

## 5. Dampak ke keputusan arsitektur

Tidak ada temuan yang mengubah ADR-001. Data `nanad` memperkuat dua hal:
1. Correctness tidak bergantung pada environment.
2. Menambah worker tidak membantu job yang murah per-claim.

Data `nanad` juga menambah satu batasan untuk dicatat: angka throughput sangat bergantung pada biaya fsync storage, jadi tidak boleh dipindahkan antar mesin tanpa diukur ulang.
