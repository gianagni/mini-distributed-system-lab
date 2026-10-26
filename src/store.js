import { stmt, tx } from './db.js';
import { BackpressureError, ConflictError } from './errors.js';

// State machine:
//   PENDING --claim--> RUNNING --sukses--> SUCCEEDED
//   RUNNING --gagal & boleh retry--> PENDING (next_run_at = now + backoff)
//   RUNNING --gagal final--> FAILED
//   RUNNING (lease kedaluwarsa) --reclaim--> RUNNING (attempt baru) atau FAILED (WORKER_LOST)
//
// Fencing: setiap tulisan status oleh worker wajib cocok dengan (lease_owner, attempts).
// Worker "zombie" yang lease-nya sudah diambil worker lain tidak bisa menimpa status.

export function addEvent(db, { jobId, attempt, event, workerId = null, errorClass = null, message = null, at }) {
  stmt(
    db,
    `INSERT INTO job_events (job_id, attempt, event, worker_id, error_class, message, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(jobId, attempt, event, workerId, errorClass, message, at);
}

export function getJob(db, id) {
  return stmt(db, 'SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
}

export function getEvents(db, id) {
  return stmt(
    db,
    `SELECT attempt, event, worker_id, error_class, message, at
     FROM job_events WHERE job_id = ? ORDER BY id`,
  ).all(id);
}

export function createJob(db, { id, type, payload, idempotencyKey, requestHash, maxAttempts, maxPending, now }) {
  return tx(db, () => {
    if (idempotencyKey) {
      const existing = stmt(db, 'SELECT * FROM jobs WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new ConflictError('Idempotency-Key sudah dipakai untuk request dengan isi berbeda');
        }
        return { job: existing, created: false };
      }
    }
    // Backpressure: tolak job baru kalau antrean sudah melewati kapasitas.
    const { n: pending } = stmt(db, "SELECT COUNT(*) AS n FROM jobs WHERE status = 'PENDING'").get();
    if (pending >= maxPending) throw new BackpressureError(pending, maxPending);

    stmt(
      db,
      `INSERT INTO jobs (id, idempotency_key, request_hash, type, payload, status, max_attempts, next_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
    ).run(id, idempotencyKey ?? null, requestHash, type, JSON.stringify(payload), maxAttempts, now, now);
    addEvent(db, { jobId: id, attempt: 0, event: 'created', at: now });
    return { job: getJob(db, id), created: true };
  }, 'create');
}

/**
 * Ambil satu job siap jalan secara atomik.
 * recovery=true: job RUNNING dengan lease kedaluwarsa dianggap worker-nya mati dan diambil alih.
 *
 * `now` boleh berupa angka atau fungsi. Fungsi dievaluasi SETELAH write lock didapat (AUDIT C-2):
 * kalau waktu diambil sebelum BEGIN IMMEDIATE menunggu lock, lease yang diberikan memendek sebesar
 * waktu tunggu itu (terukur: 600 ms menjadi 266 ms setelah menunggu 334 ms).
 */
export function claimNext(db, { workerId, leaseMs, recovery, now: nowArg }) {
  return tx(db, () => claimInTx(db, { workerId, leaseMs, recovery, now: at(nowArg) }), 'claim');
}

/** Isi claimNext; harus dipanggil di dalam transaksi tulis. */
function claimInTx(db, { workerId, leaseMs, recovery, now }) {
  // Loop berhenti: setiap iterasi yang tidak return mengubah satu job RUNNING menjadi FAILED.
  for (;;) {
    const row = stmt(
      db,
      `SELECT * FROM jobs
       WHERE (status = 'PENDING' AND next_run_at <= :now)
          OR (:recovery = 1 AND status = 'RUNNING' AND lease_expires_at < :now)
       ORDER BY next_run_at, created_at
       LIMIT 1`,
    ).get({ now, recovery: recovery ? 1 : 0 });
    if (!row) return null;

    if (row.status === 'RUNNING') {
      addEvent(db, {
        jobId: row.id,
        attempt: row.attempts,
        event: 'lease_expired',
        workerId: row.lease_owner,
        errorClass: 'WORKER_LOST',
        message: 'Worker berhenti mengirim heartbeat (mati atau macet)',
        at: now,
      });
      if (row.attempts >= row.max_attempts) {
        stmt(
          db,
          `UPDATE jobs SET status = 'FAILED', lease_owner = NULL, lease_expires_at = NULL,
             error_class = 'WORKER_LOST', error_message = :msg, finished_at = :now
           WHERE id = :id`,
        ).run({ id: row.id, now, msg: `Worker hilang pada attempt ${row.attempts}/${row.max_attempts}` });
        addEvent(db, { jobId: row.id, attempt: row.attempts, event: 'failed', errorClass: 'WORKER_LOST', at: now });
        continue;
      }
    }

    const claimed = stmt(
      db,
      `UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, lease_owner = :workerId,
         lease_expires_at = :leaseUntil, started_at = :now,
         first_started_at = COALESCE(first_started_at, :now)
       WHERE id = :id
       RETURNING *`,
    ).get({ id: row.id, workerId, leaseUntil: now + leaseMs, now });
    addEvent(db, { jobId: claimed.id, attempt: claimed.attempts, event: 'claimed', workerId, at: now });
    return claimed;
  }
}

function at(now) {
  return typeof now === 'function' ? now() : now;
}

/**
 * Jalankan tulisan status `body(now)` dalam satu transaksi. Dengan `andClaim` ({ leaseMs, recovery }),
 * transaksi yang sama juga meng-claim job berikutnya untuk worker ini dan hasilnya { value, next }
 * (AUDIT C-3): di bawah kontensi 58-83% claim terjadi tepat setelah commit status oleh worker yang
 * sama, jadi menggabungkannya menghapus satu commit ber-fsync per job tanpa mengubah durabilitas
 * (keduanya tetap di-commit sebelum dipakai; atomik: dua-duanya atau tidak sama sekali).
 */
function stateWrite(db, label, { workerId, now, busyMs, andClaim }, body) {
  return tx(
    db,
    () => {
      const t = at(now); // satu transaksi, satu waktu (setelah lock didapat)
      const value = body(t);
      if (!andClaim) return value;
      return { value, next: claimInTx(db, { workerId, leaseMs: andClaim.leaseMs, recovery: andClaim.recovery, now: t }) };
    },
    label,
    busyMs,
  );
}

/**
 * Perpanjang lease (fenced). Return batas lease baru yang TERSIMPAN di database, atau false kalau
 * lease sudah bukan milik worker ini.
 *
 * Transaksi BEGIN IMMEDIATE (sebelumnya UPDATE autocommit) supaya `now` berupa fungsi bisa
 * dievaluasi SETELAH write lock didapat, sama seperti claimNext (AUDIT C-3): dulu `now` diambil
 * sebelum menunggu lock, jadi lease yang diberikan memendek sebesar waktu tunggu heartbeat itu sendiri
 * (emulasi Windows: heartbeat yang menunggu lock 305 ms hanya memberi lease ±295 ms dari 600). Pola lock sama: UPDATE
 * autocommit juga mengambil write lock dan commit ber-fsync.
 */
export function extendLease(db, { id, workerId, attempt, leaseMs, now, busyMs }) {
  return tx(
    db,
    () => {
      const row = stmt(
        db,
        `UPDATE jobs SET lease_expires_at = :until
         WHERE id = :id AND status = 'RUNNING' AND lease_owner = :workerId AND attempts = :attempt
         RETURNING lease_expires_at`,
      ).get({ until: at(now) + leaseMs, id, workerId, attempt });
      return row ? row.lease_expires_at : false;
    },
    'heartbeat',
    busyMs,
  );
}

/**
 * Tandai sukses (fenced). false = attempt ini sudah basi, hasil ditolak.
 * `now` boleh fungsi: dievaluasi setelah lock didapat, supaya finished_at dan waktu event mencerminkan
 * kapan status benar-benar berubah, bukan kapan mulai menunggu lock (AUDIT C-3).
 */
export function completeAttempt(db, { id, workerId, attempt, result, execMs, now, busyMs, andClaim }) {
  return stateWrite(db, 'complete', { workerId, now, busyMs, andClaim }, (now) => {
    const r = stmt(
      db,
      `UPDATE jobs SET status = 'SUCCEEDED', result = ?, finished_at = ?, exec_ms = ?,
         lease_owner = NULL, lease_expires_at = NULL, error_class = NULL, error_message = NULL
       WHERE id = ? AND status = 'RUNNING' AND lease_owner = ? AND attempts = ?`,
    ).run(JSON.stringify(result), now, execMs, id, workerId, attempt);
    if (r.changes === 0) {
      addEvent(db, { jobId: id, attempt, event: 'stale_completion_rejected', workerId, at: now });
      return false;
    }
    addEvent(db, { jobId: id, attempt, event: 'succeeded', workerId, at: now });
    return true;
  });
}

/**
 * Catat attempt gagal (fenced). Jadwalkan retry atau tandai FAILED.
 * Return null kalau attempt sudah basi.
 */
export function failAttempt(db, { id, workerId, attempt, errorClass, message, retryable, backoffMs, execMs, now, busyMs, andClaim }) {
  return stateWrite(db, 'fail', { workerId, now, busyMs, andClaim }, (now) => {
    const job = stmt(
      db,
      `SELECT attempts, max_attempts FROM jobs
       WHERE id = ? AND status = 'RUNNING' AND lease_owner = ? AND attempts = ?`,
    ).get(id, workerId, attempt);
    if (!job) {
      addEvent(db, { jobId: id, attempt, event: 'stale_failure_rejected', workerId, errorClass, message, at: now });
      return null;
    }
    if (retryable && job.attempts < job.max_attempts) {
      const nextRunAt = now + backoffMs;
      stmt(
        db,
        `UPDATE jobs SET status = 'PENDING', next_run_at = ?, lease_owner = NULL, lease_expires_at = NULL,
           error_class = ?, error_message = ?, exec_ms = ?
         WHERE id = ?`,
      ).run(nextRunAt, errorClass, message, execMs, id);
      addEvent(db, {
        jobId: id,
        attempt,
        event: 'retry_scheduled',
        workerId,
        errorClass,
        message: `${message} (retry dalam ${backoffMs} ms)`,
        at: now,
      });
      return { status: 'PENDING', nextRunAt };
    }
    stmt(
      db,
      `UPDATE jobs SET status = 'FAILED', finished_at = ?, lease_owner = NULL, lease_expires_at = NULL,
         error_class = ?, error_message = ?, exec_ms = ?
       WHERE id = ?`,
    ).run(now, errorClass, message, execMs, id);
    addEvent(db, { jobId: id, attempt, event: 'failed', workerId, errorClass, message, at: now });
    return { status: 'FAILED' };
  });
}
