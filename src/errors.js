// Error class = kategori kegagalan yang dicatat di storage dan metrik.
// retryable menentukan apakah attempt berikutnya boleh dijadwalkan.

export class TaskError extends Error {
  constructor(message, errorClass, retryable) {
    super(message);
    this.name = 'TaskError';
    this.errorClass = errorClass;
    this.retryable = retryable;
  }
}

/** Dependency sementara gagal; aman diulang karena output idempotent. */
export class TransientError extends TaskError {
  constructor(message) {
    super(message, 'TRANSIENT', true);
  }
}

/** Input/data rusak; mengulang tidak akan mengubah hasil. */
export class PermanentError extends TaskError {
  constructor(message) {
    super(message, 'PERMANENT', false);
  }
}

/** Attempt melewati JOB_TIMEOUT_MS. */
export class TimeoutError extends TaskError {
  constructor(ms) {
    super(`Attempt melewati batas waktu ${ms} ms`, 'TIMEOUT', true);
  }
}

/**
 * Filesystem gagal saat menulis laporan.
 * Hanya kode yang mungkin pulih sendiri (disk penuh, I/O, file descriptor habis) yang di-retry.
 * Salah konfigurasi (path bukan direktori, permission) langsung FAILED supaya cepat terlihat.
 */
const RETRYABLE_FS_CODES = new Set(['ENOSPC', 'EIO', 'EMFILE', 'ENFILE', 'EBUSY', 'EAGAIN']);
export class StorageError extends TaskError {
  constructor(cause) {
    const code = cause?.code ?? 'UNKNOWN';
    super(`Gagal menulis laporan (${code}): ${cause?.message ?? cause}`, 'STORAGE', RETRYABLE_FS_CODES.has(code));
    this.code = code;
  }
}

/** Worker kehilangan lease (sudah diambil worker lain). Worker ini wajib berhenti tanpa menulis status. */
export class LeaseLostError extends TaskError {
  constructor() {
    super('Lease hilang, job sudah diambil worker lain', 'LEASE_LOST', false);
  }
}

export function classify(err) {
  if (err instanceof TaskError) {
    return { errorClass: err.errorClass, retryable: err.retryable, message: err.message };
  }
  // Error tak dikenal (bug, I/O): diulang, tapi tetap dibatasi MAX_ATTEMPTS.
  return { errorClass: 'INTERNAL', retryable: true, message: String(err?.message ?? err) };
}

// ---- Error HTTP (dipakai API) ----

export class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export class ValidationError extends HttpError {
  constructor(message) {
    super(400, 'VALIDATION', message);
  }
}

export class ConflictError extends HttpError {
  constructor(message) {
    super(409, 'IDEMPOTENCY_CONFLICT', message);
  }
}

/** Client memutus koneksi sebelum request selesai dibaca. Bukan error server. */
export class ClientAbortedError extends Error {
  constructor() {
    super('Client memutus koneksi sebelum body selesai dikirim');
  }
}

export class BackpressureError extends HttpError {
  constructor(pending, max) {
    super(429, 'QUEUE_FULL', `Antrean penuh (${pending}/${max} PENDING). Coba lagi nanti.`, {
      'retry-after': '1',
    });
  }
}
