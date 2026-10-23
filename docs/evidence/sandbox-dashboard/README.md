# Evidence: dashboard + security gate (sandbox Linux)

Lingkungan: sandbox Linux x86_64, 4 CPU, Node v22.22.0, Chromium 141.0.7390.37 headless (Playwright global, **bukan** dependency repo). Tanggal: 2026-10-23. Ini evidence fase dashboard; evidence capstone di `docs/evidence/nanad/` tidak disentuh.

| File | Isi |
|---|---|
| `rebinding-before-071dc0a.txt` | Reproduksi DNS rebinding (AUDIT S-2) pada commit sebelum perbaikan |
| `rebinding-after.txt` | Skenario yang sama setelah perbaikan |
| `test-repeat/baseline-071dc0a-summary.json` | 30 run `npm run test:repeat` pada commit sebelum perbaikan U-1 |
| `test-repeat/baseline-071dc0a-run-022-FAILED.log` | Log TAP lengkap satu-satunya run yang gagal (AUDIT U-1) |
| `test-repeat/final-*-summary.json` | Pengulangan pada kode final (lihat AUDIT U-1) |
| `browser-smoke.txt` | Output mentah skenario browser pada kode final |
| `screenshots/` | Tangkapan layar dari skenario browser (data asli dari run itu) |
| `harness/` | Script Playwright yang menghasilkan semua di atas |

## Menjalankan ulang harness

Harness ini untuk Linux (`run.mjs` mencari PID worker lewat `/proc`; `rebind-run.sh` memakai bash + curl). Di Windows, pakai checklist manual di `docs/VALIDATION-PLAN.md`. Butuh Playwright terpasang di luar repo (`npm i -g playwright`, lalu set `PLAYWRIGHT` ke `.../playwright/index.js`) dan Chromium-nya. Jalankan dari root repo.

```bash
export PLAYWRIGHT=$(npm root -g)/playwright/index.js OUT=/tmp/lab-evidence
mkdir -p $OUT/shots
# Lab untuk skenario UI (port dipakai harness: API 3921, dashboard 3922, forward 4922):
DB_PATH=$OUT/jobs.db REPORT_DIR=$OUT/reports PORT=3921 DASHBOARD_PORT=3922 ALLOWED_HOSTS=127.0.0.1:4922 \
  node scripts/lab.js --workers 2 --fault-injection & echo $! > $OUT/lab.pid
node docs/evidence/sandbox-dashboard/harness/run.mjs $OUT/shots
node docs/evidence/sandbox-dashboard/harness/forward.mjs 4922 3922 allowed $OUT/shots/fwd.png
node docs/evidence/sandbox-dashboard/harness/forward.mjs 4923 3922 denied $OUT/shots/fwd-denied.png
node docs/evidence/sandbox-dashboard/harness/claims.mjs $(cat $OUT/lab.pid) $OUT   # menghentikan lab di akhir

# DNS rebinding (butuh salinan src/ + dashboard/ dari commit yang diuji di <srcdir>):
bash docs/evidence/sandbox-dashboard/harness/rebind-run.sh <srcdir> LABEL
```

`rebind-browser.mjs` memetakan `rebind.test` ke 127.0.0.1 di Chromium dan menyajikan HTML penyerang untuk load pertama, meniru keadaan setelah DNS rebinding. Dengan `NO_PNA=1`, fitur Private Network Access Chromium dimatikan **di browser penyerang saja** untuk meniru browser tanpa fitur itu (Firefox, Safari, Chrome lama). Pemeriksaan di server tidak pernah dimatikan.
