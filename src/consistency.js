import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Pemeriksa invariant antara status job, riwayat event, dan file laporan.
//   violations = pelanggaran kontrak (bug atau kerusakan data). Harus 0.
//   warnings   = kondisi yang diizinkan desain tapi perlu diketahui operator
//                (file yatim dari job FAILED, file .tmp sisa crash, job macet).
//
// Dipakai oleh test, eksperimen, dan `npm run check`.
//
// Semua query database dibaca dalam SATU read transaction (snapshot WAL). Tanpa itu,
// pemeriksaan saat worker aktif melihat tabel jobs dan job_events dari waktu berbeda
// dan melaporkan violation palsu (ditemukan di eksperimen, lihat AUDIT P2-10).
// File laporan dibaca SETELAH snapshot, jadi file untuk job yang di snapshot masih
// aktif adalah keadaan normal (ditulis sebelum commit), bukan orphan.

const TERMINAL = new Set(['SUCCEEDED', 'FAILED']);

export function checkConsistency(db, reportDir, { now = Date.now() } = {}) {
  const violations = [];
  const warnings = [];
  const v = (jobId, rule, detail = '') => violations.push({ jobId, rule, detail });
  const w = (jobId, rule, detail = '') => warnings.push({ jobId, rule, detail });

  db.exec('BEGIN');
  let jobs;
  let succeededEvents;
  let claimRows;
  try {
    ({ jobs, succeededEvents, claimRows } = readSnapshot(db));
  } finally {
    db.exec('COMMIT');
  }

  const claims = new Map();
  for (const r of claimRows) {
    if (r.n > 1) v(r.job_id, 'attempt_claimed_twice', `attempt ${r.attempt} di-claim ${r.n}x`);
    claims.set(r.job_id, (claims.get(r.job_id) ?? 0) + 1);
  }

  for (const j of jobs) {
    const hasLease = j.lease_owner !== null || j.lease_expires_at !== null;
    const nSucceeded = succeededEvents.get(j.id) ?? 0;

    if (j.attempts < 0 || j.attempts > j.max_attempts) v(j.id, 'attempts_out_of_range', `${j.attempts}/${j.max_attempts}`);
    if ((claims.get(j.id) ?? 0) !== j.attempts) {
      v(j.id, 'claims_mismatch', `attempts=${j.attempts}, attempt yang di-claim=${claims.get(j.id) ?? 0}`);
    }
    if (TERMINAL.has(j.status)) {
      if (hasLease) v(j.id, 'terminal_with_lease');
      if (j.finished_at === null) v(j.id, 'terminal_without_finished_at');
    } else if (j.finished_at !== null) v(j.id, 'active_with_finished_at');

    if (j.status === 'PENDING' && hasLease) v(j.id, 'pending_with_lease');
    if (j.status === 'RUNNING') {
      if (!hasLease) v(j.id, 'running_without_lease');
      else if (j.lease_expires_at < now) w(j.id, 'running_lease_expired', `kedaluwarsa ${now - j.lease_expires_at} ms lalu`);
    }
    if (j.status !== 'SUCCEEDED' && j.result !== null) v(j.id, 'result_without_success', j.status);
    if (j.status === 'FAILED' && j.error_class === null) v(j.id, 'failed_without_error_class');

    if (j.status === 'SUCCEEDED') {
      if (nSucceeded !== 1) v(j.id, 'succeeded_event_count', `${nSucceeded}`);
      if (j.error_class !== null) v(j.id, 'succeeded_with_error');
      let result = null;
      try {
        result = JSON.parse(j.result);
      } catch {
        v(j.id, 'result_not_json');
      }
      if (result) {
        const path = join(reportDir, result.reportFile ?? '');
        if (!result.reportFile || !existsSync(path)) {
          v(j.id, 'report_missing', path);
        } else {
          const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
          if (actual !== result.sha256) v(j.id, 'report_checksum_mismatch', `db=${result.sha256} file=${actual}`);
        }
      }
    } else if (nSucceeded !== 0) {
      v(j.id, 'succeeded_event_without_status', j.status);
    }
  }

  // File di REPORT_DIR yang bukan hasil sah.
  if (existsSync(reportDir)) {
    const byId = new Map(jobs.map((j) => [j.id, j]));
    for (const name of readdirSync(reportDir)) {
      if (name.endsWith('.tmp')) {
        w(name.slice(0, 36), 'temp_file_left', name);
        continue;
      }
      const m = name.match(/^([0-9a-f-]{36})\.json$/);
      const job = m ? byId.get(m[1]) : null;
      if (!job) w(null, 'unknown_file', name);
      else if (job.status === 'FAILED') w(job.id, 'orphan_report', 'file ada, status FAILED');
      else if (job.status !== 'SUCCEEDED') w(job.id, 'report_before_commit', `file ada, status ${job.status}`);
    }
  }

  return { checkedJobs: jobs.length, violations, warnings };
}

function readSnapshot(db) {
  const jobs = db.prepare('SELECT * FROM jobs').all();
  const succeededEvents = new Map(
    db
      .prepare("SELECT job_id, COUNT(*) AS n FROM job_events WHERE event = 'succeeded' GROUP BY job_id")
      .all()
      .map((r) => [r.job_id, r.n]),
  );
  const claimRows = db
    .prepare("SELECT job_id, attempt, COUNT(*) AS n FROM job_events WHERE event = 'claimed' GROUP BY job_id, attempt")
    .all();
  return { jobs, succeededEvents, claimRows };
}
