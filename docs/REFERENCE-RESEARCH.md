# Reference Research: Interactive Reliability Engineering Lab

Tanggal: 2026-10-23. Branch: `feat/interactive-dashboard`. Tujuan: mempercepat pembuatan dashboard dengan meminjam **pola** dari produk matang, tanpa menyalin kode, aset, branding, atau desain.

Metode: repository referensi di-clone dangkal (read-only, tidak dijalankan) dan dibaca bagian data model, UI, dan konfigurasi keamanannya. Tidak ada satu baris kode referensi pun yang masuk ke repo ini. Semua implementasi di branch ini ditulis independen terhadap data model kita sendiri.

## 1. Sumber dan lisensi

| Produk | Repo & commit yang dibaca | Lisensi | Konsekuensi untuk kita |
|---|---|---|---|
| Bull Board | [felixmosh/bull-board](https://github.com/felixmosh/bull-board) `e3fca33` (2026-10-22) | MIT | Kode boleh dipakai dengan atribusi. **Tidak dipakai**: stack-nya React + Redis/BullMQ, tidak cocok dengan repo zero-dependency. Hanya konsep. |
| Inngest Dev Server | [inngest/inngest](https://github.com/inngest/inngest) `839d4d3` (2026-10-22) | **SSPL 1.0** + "Apache 2.0 Future License" (`LICENSE.md`) | SSPL bukan lisensi OSI. Menyalin/adaptasi kodenya membawa kewajiban SSPL. **Konsep saja**, nol kode, nol aset. |
| Chaos Mesh | [chaos-mesh/chaos-mesh](https://github.com/chaos-mesh/chaos-mesh) `9a80e21` (2026-10-23) | Apache 2.0 | Kode boleh dipakai dengan NOTICE. Tidak dipakai: Go + Kubernetes CRD. Hanya konsep untuk fase berikutnya. |

Yang dibaca:
- Bull Board: `packages/api/src/constants/statuses.ts`, `handlers/queues.ts` (`formatJob`, pagination), `types.ts` (`readOnlyMode`, `allowRetries`), `packages/ui/src/components/JobCard/Timeline/Timeline.tsx`, `hooks/useDetailsTabs.tsx`, `components/SettingsModal/SettingsModal.tsx` (polling interval).
- Inngest: `pkg/enums/history_type.go`, `ui/packages/components/src/RunDetailsV4/README.md` (arsitektur timeline), daftar komponen `RunDetailsV4/` (TimelineBar, ErrorInfo, StepInfo).
- Chaos Mesh: `api/v1alpha1/common_types.go` (`DesiredPhase`, `Record`, `RecordEvent`, pause annotation), `helm/chaos-mesh/values.yaml` (`securityMode`, `enableFilterNamespace`), daftar komponen `ui/app/src/components/` (EventsTimeline, NewExperiment, Token).

## 2. Audit repo kita (sebelum dashboard)

Baseline: `npm test` 58/58 lulus di sandbox (Node 22.22.0) sebelum perubahan apa pun.

### Endpoint (src/http.js)

| Endpoint | Isi | Catatan untuk dashboard |
|---|---|---|
| `POST /jobs` | Validasi, idempotency, backpressure 429 | Dipakai apa adanya oleh form (lewat proxy) |
| `GET /jobs/:id` | Job + `events` | Tidak menyertakan `lease_owner`, `lease_expires_at`, `started_at` |
| `GET /metrics` | Status, counter, error class, histogram attempts, p50/p95/p99, health | Cukup untuk overview |
| `GET /healthz` | `{ok:true}` | |
| `GET /jobs` | **405** (dikunci test `validasi input dan route`) | Tidak ada list job. Menambahkannya di API akan mengubah perilaku yang diuji |

### Schema (src/db.js)

- `jobs`: status, attempts/max_attempts, lease_owner/lease_expires_at, next_run_at, error_class/message, result, created_at, first_started_at, started_at (attempt terakhir), finished_at, exec_ms (attempt terakhir). Index hanya `(status, next_run_at)`.
- `job_events`: append-only, satu baris per transisi: `(attempt, event, worker_id, error_class, message, at)`.

### Job events yang benar-benar ditulis (src/store.js)

| Event | Attempt | Ditulis oleh | Arti |
|---|---|---|---|
| `created` | 0 | API | Job masuk antrean |
| `claimed` | n | worker (n) | Attempt n mulai, lease diambil |
| `succeeded` | n | worker (n) | Commit `SUCCEEDED` (fenced) |
| `retry_scheduled` | n | worker (n) | Gagal retryable; pesan diakhiri `(retry dalam X ms)` |
| `failed` | n | worker (n) **atau** worker lain saat reclaim | Final. Kalau `error_class=WORKER_LOST`, `worker_id` kosong |
| `lease_expired` | n | **worker lain** saat claim | Deteksi worker n mati. `worker_id` = pemilik lama, `at` = waktu deteksi, bukan waktu mati |
| `stale_completion_rejected` / `stale_failure_rejected` | n | worker zombie | Fencing menolak tulisan attempt basi |

### Worker lifecycle (src/worker.js, src/processor.js)

Loop polling → `claimNext` (BEGIN IMMEDIATE) → heartbeat `extendLease` tiap `HEARTBEAT_MS` → task dengan `AbortSignal` (timeout/lease lost) → `completeAttempt`/`failAttempt` (fenced). **Tidak ada registry worker**: worker idle tidak menulis apa pun ke database. Satu-satunya jejak worker adalah `lease_owner` dan `job_events.worker_id`.

### Temuan audit yang memengaruhi desain

1. **Retry history sudah lengkap di `job_events`.** Waktu tunggu antrean, durasi setiap attempt, backoff, dan penolakan fencing bisa diturunkan dari event asli. Tidak perlu tabel baru.
2. **Backoff hanya ada di teks pesan.** `retry_scheduled.message` diakhiri `(retry dalam X ms)`. Dashboard mem-parse ini; formatnya dikunci test baru supaya perubahan di `store.js` langsung ketahuan.
3. **Waktu kematian worker tidak diketahui.** `lease_expired.at` adalah waktu *deteksi* (saat worker lain claim). UI wajib menyebut ini, bukan menggambarnya sebagai waktu mati.
4. **CSRF di API yang sudah ada (temuan, tidak diubah).** `POST /jobs` tidak memeriksa `Content-Type`. Halaman web mana pun yang dibuka di browser mesin yang sama bisa mengirim `fetch('http://127.0.0.1:3000/jobs', {method:'POST', mode:'no-cors', body:'{"type":"order_report"}'})` (simple request `text/plain`, tanpa preflight) dan job akan dibuat. Dampak terbatas (job dummy, dibatasi `MAX_PENDING`), tapi nyata. Perbaikan yang diusulkan: tolak `Content-Type` selain `application/json` (415). **Tidak diterapkan** di branch ini karena mengubah perilaku API yang sedang dinilai; perlu keputusan pemilik. Dashboard sendiri sudah menerapkan proteksi ini (lihat §6).
5. Metrik O(n) per request. Dashboard yang polling tiap 2 detik menambah beban baca ini; dapat diterima di skala lab, dicatat sebagai batas.

## 3. Bedah Bull Board: pola queue monitoring

| Pola | Temuan dari kode | Keputusan | Alasan |
|---|---|---|---|
| Tab status dengan jumlah per status | `STATUSES` (waiting, active, completed, failed, delayed, ...) + counts per queue | **Ambil** | Pola paling cepat untuk "berapa job di mana". Status kita 4 + sub-status `PENDING` siap vs backoff |
| Polling interval yang bisa diatur, termasuk "mati" | `SettingsModal`: `[-1, 3, 5, 10, 20, 60, ...]` detik, `refetchInterval` react-query | **Ambil** | Jujur: data adalah snapshot, bukan push. Kita tampilkan "diperbarui HH:MM:SS" dan tanda stale saat request gagal |
| `readOnlyMode` per queue, tombol aksi disembunyikan | `QueueCard`, `JobCard`, `OverviewDropDownActions` | **Ambil, versi lebih ketat** | Bull Board menyembunyikan tombol di UI; server masih punya route mutasi. Kita: koneksi SQLite dashboard dibuka `readOnly`, jadi mutasi dicegah oleh SQLite, bukan konvensi |
| Job card: tab Data / Options / Logs / Error / Timeline | `useDetailsTabs` | **Ambil sebagian** | Kita tampilkan payload, result, error, attempts, raw events dalam satu halaman (lebih sedikit klik untuk belajar) |
| Timeline job | `Timeline.tsx`: dibangun dari 3 timestamp (`timestamp`, `processedOn`, `finishedOn`) | **Tolak modelnya** | BullMQ hanya menyimpan timestamp attempt terakhir, jadi retry history hilang. Event log kita jauh lebih kaya. Ini justru alasan memakai pola Inngest untuk timeline |
| Aksi retry/clean/promote/obliterate/pause | `handlers/*.ts` | **Tolak (MVP)** | Butuh transisi status baru di luar state machine yang sudah diuji. Kalau nanti dibutuhkan, harus lewat API dengan fencing, bukan dari dashboard |
| Historical metrics 90 hari, Redis stats, flows, schedulers | handlers `metricsHistory`, `redisStats`, `jobFlow` | **Tidak relevan** | Tidak ada Redis, tidak ada parent/child job, tidak ada repeatable job |
| Adapter multi-framework (express, fastify, ...) | `packages/*` | **Tidak relevan** | Satu runtime, `node:http` |

## 4. Bedah Inngest: execution timeline

| Pola | Temuan | Keputusan | Alasan |
|---|---|---|---|
| Timeline gaya Gantt: satu bar per step, posisi `startPercent`/`widthPercent` | `RunDetailsV4/README.md`, `TimelineBar` | **Ambil konsepnya** | Paling efektif untuk melihat attempt, jeda backoff, dan reclaim dalam satu sumbu waktu |
| Compound bar: memisahkan *queue time* vs *execution time* | README "Timing breakdowns" | **Ambil** | Kita punya: `created→claimed` (antre), `claimed→akhir` (eksekusi), `retry_scheduled→claimed` (backoff + antre) |
| Membedakan `StepErrored` (akan di-retry) vs `StepFailed` (permanen) | `history_type.go` | **Ambil** | Persis `retry_scheduled` vs `failed` kita. UI memberi label berbeda, bukan hanya warna |
| Raw history di samping visual | History reader + panel detail | **Ambil** | Timeline adalah turunan; tabel event mentah adalah sumber kebenaran dan selalu ditampilkan |
| TimeBrush (zoom/brush), nested span tak terbatas, AI metadata, linked runs | `TimeBrush`, `AIMetadata`, `LinkedRuns` | **Tolak** | Job kita maksimal beberapa attempt, tanpa step bersarang. Biaya UI tidak sebanding |
| Event-driven function, replay, cancel | Dev server | **Tolak** | Di luar semantik job kita |

## 5. Chaos Mesh: workflow eksperimen (untuk fase berikutnya)

Tidak diimplementasikan sekarang. Dicatat supaya fase berikutnya tidak mulai dari nol.

| Konsep | Temuan | Pemetaan ke lab ini |
|---|---|---|
| Experiment = spec deklaratif (selector, mode, action, duration) | CRD per jenis chaos | Kita sudah punya versi kecilnya: `payload.simulate` (per job). Fase berikut: eksperimen terhadap proses (kill worker, SIGSTOP, lock DB) |
| `DesiredPhase` Run/Stop + `Record` per target dengan event `Apply`/`Recover` dan counter | `common_types.go` | Model status eksperimen: diinginkan vs aktual, plus log inject/recover yang bisa diaudit |
| Pause lewat annotation | `experiment.chaos-mesh.org/pause` | Tombol pause eksperimen yang tidak menghapus riwayat |
| `securityMode: true` (dashboard minta token), `enableFilterNamespace` (hanya target yang di-opt-in) | `values.yaml` | **Prinsip yang kita ambil sekarang**: kontrol berbahaya terpisah dan opt-in. Fault injection hanya muncul di dashboard kalau `ALLOW_FAULT_INJECTION=1`, dan API + worker tetap memvalidasi sendiri |
| Kubernetes, chaos-daemon, CRD, RBAC generator | Seluruh arsitektur | **Tolak**. Satu host, proses Node biasa |

## 6. Feature mapping

| Fitur | Status | Catatan |
|---|---|---|
| Buat job (validasi, idempotency, 429) | **Existing** | `POST /jobs`. Dashboard mem-proxy request apa adanya; respons API diteruskan tanpa diubah |
| Detail job + event | **Existing** | `GET /jobs/:id` |
| Metrik agregat, latency p50/p95/p99, health antrean | **Existing** | `computeMetrics` dipakai ulang tanpa perubahan |
| Daftar job + filter status/error class + pagination | **Needs Extension** | Endpoint read-only baru di proses dashboard: `GET /api/jobs` (keyset pagination) |
| Timeline per attempt (antre, eksekusi, backoff, reclaim, fencing) | **Needs Extension** | `src/timeline.js`: fungsi murni dari event asli, diuji unit |
| Job yang sedang RUNNING + sisa lease | **Needs Extension** | Dari `lease_owner`/`lease_expires_at`; tidak terekspos di API lama |
| Worker yang terlihat | **Needs Extension (dengan label jujur)** | Hanya dari event. Worker idle **tidak terlihat**; bukan liveness check |
| Fault injection dari browser | **Needs Extension (opt-in)** | Panel lab hanya bila dashboard dijalankan dengan `ALLOW_FAULT_INJECTION=1` |
| Launcher satu perintah (API + worker + dashboard) | **Needs Extension** | `npm run lab`. Alasan utama: `WORKER_ID=w1 npm run worker` tidak jalan di cmd/PowerShell Windows |
| Retry/hapus/promote job dari UI | **Not Needed (MVP)** | Butuh transisi baru di state machine |
| Realtime push (SSE/WebSocket) | **Not Needed** | Polling jujur cukup; tidak ada event bus untuk di-push |
| Historical metrics, Redis stats, flows, schedulers | **Not Needed** | Tidak ada padanannya |
| Autentikasi/RBAC | **Not Needed (selama loopback)** | Dashboard loopback-only seperti API; non-loopback wajib `ALLOW_REMOTE=1` |
| Redis, BullMQ, Kafka, Kubernetes, cloud | **Not Needed** | Lihat ADR-001 |

## 7. UX yang paling membantu memahami concurrency, retry, fault tolerance

Diurutkan dari nilai belajar tertinggi:

1. **Timeline attempt dengan jeda berlabel.** Satu baris per attempt; jeda antre, jeda backoff (dengan nilai backoff yang dijadwalkan), dan titik reclaim terlihat di satu sumbu waktu. Membuat exponential backoff + jitter bisa dilihat, bukan hanya dibaca.
2. **Penanda fencing.** `stale_*_rejected` digambar pada baris attempt zombie, setelah attempt berikutnya mulai. Ini satu-satunya cara melihat "worker lama mencoba menulis dan ditolak" tanpa membaca log.
3. **Panel RUNNING dengan sisa lease.** Saat worker di-`kill -9`, sisa lease turun ke negatif, lalu job pindah ke worker lain. Mengamati lease recovery secara langsung.
4. **Health antrean dipisah: siap vs backoff.** `pendingReady` vs `pendingInBackoff` (pelajaran AUDIT P2-4: job yang sengaja menunggu bukan lag).
5. **Invariant yang terlihat.** `duplicateSuccessJobs` ditampilkan sebagai invariant yang harus 0, bukan sekadar angka.
6. **Respons HTTP apa adanya di form.** 202 vs 200 (replay idempotent) vs 409 vs 429 ditampilkan dengan artinya.
7. **Badge `fault-injected`.** Job dengan `payload.simulate` ditandai supaya kegagalan simulasi tidak dibaca sebagai kegagalan sungguhan.

## 8. Keputusan arsitektur frontend

### React + TypeScript: dievaluasi, ditolak untuk MVP

Argumen untuk: ekosistem komponen, type safety, pola yang dipakai ketiga referensi.

Argumen yang menentukan, melawan:
- Repo ini **zero dependency, tanpa `npm install`, tanpa build step**, dan itu bagian dari klaim reproducibility yang sudah dibuktikan di InstaBox `nanad`. React + TS + Vite menambah `node_modules` (ratusan paket), lockfile, akses registry npm, dan langkah build yang harus jalan sama di Windows dan InstaBox.
- Ukuran UI kecil: 4 halaman, 1 komponen visual non-trivial (timeline). Kompleksitas state rendah (satu poller, hash routing).
- Risiko supply chain dan drift versi melebihi manfaatnya untuk proyek belajar.

Pilihan: **JavaScript modern (ES modules) tanpa build, disajikan langsung oleh Node.** Kerugian yang diterima: tanpa type checker. Mitigasi: logika non-trivial (timeline, query) ada di server sebagai fungsi murni yang diuji `node:test`; browser hanya merender. Trigger untuk membuka ulang: UI tumbuh melewati ~10 view, atau butuh komponen interaktif kompleks (editor, grafik zoom), atau ada lebih dari satu kontributor frontend.

### Proses dashboard terpisah, bukan route di API

```
browser ──► dashboard (127.0.0.1:3100)
              ├─ GET  /, /assets/*       file statis (whitelist)
              ├─ GET  /api/overview      SQLite readOnly ─┐
              ├─ GET  /api/jobs          SQLite readOnly ─┼─ data/jobs.db  ◄── API + worker (penulis)
              ├─ GET  /api/jobs/:id      SQLite readOnly ─┘
              └─ POST /api/jobs   ──proxy──► API POST /jobs (validasi, idempotency, backpressure)
```

Alasan:
- **API tidak berubah sama sekali.** Semantik dan 58 test lama tidak tersentuh. `GET /jobs` tetap 405.
- **Read-only ditegakkan SQLite.** Koneksi dashboard `readOnly: true`; bug di dashboard tidak bisa mengubah state job. WAL: pembaca tidak memblokir penulis.
- **Isolasi kegagalan**, sama seperti alasan memisah worker (ADR-001): dashboard crash atau lambat (metrik O(n)) tidak mengganggu API.
- **Satu jalur tulis.** Pembuatan job tetap lewat API, jadi tidak ada logika validasi ganda.

Biaya: satu proses lagi. Dimitigasi `npm run lab`.

### Keamanan dashboard

- Bind loopback secara default; non-loopback wajib `ALLOW_REMOTE=1`; fault injection hanya di loopback (aturan yang sama dengan API).
- Header `Host` diperiksa (proteksi DNS rebinding untuk endpoint baca).
- `POST /api/jobs` wajib `Content-Type: application/json` (memaksa preflight CORS yang tidak pernah dijawab) dan `Origin` (kalau ada) harus sama dengan host dashboard.
- CSP `default-src 'self'`, tanpa inline script, `frame-ancestors 'none'`. Semua teks dari database di-escape sebelum dirender.
- File statis dari whitelist yang dibaca saat start, bukan dari path request (tidak ada path traversal).

## 9. Yang sengaja tidak diklaim

- **Bukan realtime.** UI polling (default 2 detik, bisa diubah atau dimatikan). Setiap layar menampilkan waktu snapshot dari server.
- **Worker list bukan liveness.** Hanya worker yang pernah menulis event.
- **Waktu kematian worker tidak diketahui**, hanya waktu deteksinya.
- **Metrik latency hanya dari job `SUCCEEDED`** (sama dengan `/metrics`), dan dilabeli begitu.

## 10. Quality gate (sandbox Linux x86_64, Node 22.22.0, 2026-10-23)

| Gate | Hasil | Bukti |
|---|---|---|
| Regression test lama tetap lulus | 58 test lama tidak diubah; `npm test` **71/71** (58 + 13 baru), diulang 3x berturut-turut tanpa gagal | `test/*.test.js` |
| API tidak berubah | `src/http.js`, `store.js`, `processor.js`, `worker.js`, `db.js` tidak disentuh. `GET /jobs` tetap 405 (dicek ulang di test dashboard) | `git diff main --stat` |
| Frontend terhubung ke backend nyata | Test integrasi: job dibuat lewat proxy dashboard, diproses worker sungguhan, event di `/api/jobs/:id` identik dengan `GET /jobs/:id` milik API | `test/dashboard.test.js` |
| User bisa membuat job dari browser | Chromium headless (Playwright global, bukan dependency repo): form → 202 → halaman detail | skenario browser, lihat bawah |
| Perubahan status teramati | Test: dashboard melihat ≥ 2 status berbeda untuk satu job; browser: PENDING → RUNNING → SUCCEEDED/FAILED | idem |
| Timeline dari event asli | `src/timeline.js` diuji dengan event yang ditulis `store.js` sungguhan (bukan fixture); format pesan backoff dikunci test | `test/dashboard.test.js` |
| Tanpa klaim realtime palsu / data dummy | UI menulis "Polling tiap N s · snapshot server HH:MM:SS"; saat gagal: "⚠ Gagal sejak …" dan data lama ditandai usang. Tidak ada data contoh di repo | `dashboard/app.js` |
| Read-only ditegakkan | Koneksi `readOnly: true`; test memastikan dashboard tidak membuat file DB | test "database belum ada" |
| Keamanan dashboard | Test: CSP, `Host` asing 403, `text/plain` 415, `Origin` asing 403, path traversal 404 | test "keamanan" |
| Dokumentasi setup | README, RUNBOOK §10 (Windows, InstaBox via SSH tunnel), `npm run doctor` memeriksa port dashboard | |

Skenario browser yang dijalankan terhadap `npm run lab -- --fault-injection` (2 worker), semuanya lewat UI:
transient 2× (sukses di attempt 3, backoff terlihat), lambat 5 s + `kill -9` worker pemegang lease (di-reclaim setelah lease habis, worker di-restart lab), permanent, transient terus (FAILED setelah 3 attempt), replay Idempotency-Key (202 lalu 200), konflik (409), crash setelah tulis (worker bunuh diri, job sukses di attempt 2), burst 20 job. Setelahnya `npm run check`: 26 job, 0 violation, 0 warning. Tanpa error JavaScript atau pelanggaran CSP di console (satu-satunya error console adalah log browser untuk respons 409 yang memang diharapkan). Viewport 390 px: tanpa scroll horizontal halaman.

Klaim RUNBOOK yang diverifikasi terpisah: `MAX_PENDING=5 --workers 0`, 10 request → 202×5, 429×5. `--workers 4`, 50 request → 50 SUCCEEDED tersebar ke 4 worker (18/11/11/10), sukses ganda 0, `npm run check` 0 violation.

Penanda fencing (`stale_*_rejected`) sulit dipicu lewat UI (heartbeat biasanya mendeteksi lease hilang lebih dulu, lihat AUDIT "Worker zombie"). Rendering-nya diperiksa visual dengan database sementara di luar repo yang dibuat lewat fungsi `store.js` asli, dan logikanya dikunci unit test.

**Belum diverifikasi:** Windows dan InstaBox `nanad` (dashboard, `npm run lab`, 13 test baru). Catatan Windows di RUNBOOK berdasarkan perilaku Node yang terdokumentasi, bukan percobaan.
