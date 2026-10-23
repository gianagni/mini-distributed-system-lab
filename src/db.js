import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Satu file SQLite dipakai bersama oleh proses API dan worker.
// WAL: pembaca tidak memblokir penulis. busy_timeout: tunggu lock sebentar, jangan langsung gagal.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  idempotency_key  TEXT UNIQUE,
  request_hash     TEXT NOT NULL,
  type             TEXT NOT NULL,
  payload          TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL,
  lease_owner      TEXT,
  lease_expires_at INTEGER,
  next_run_at      INTEGER NOT NULL,
  error_class      TEXT,
  error_message    TEXT,
  result           TEXT,
  created_at       INTEGER NOT NULL,
  first_started_at INTEGER,
  started_at       INTEGER,
  finished_at      INTEGER,
  exec_ms          INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (status, next_run_at);

CREATE TABLE IF NOT EXISTS job_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL REFERENCES jobs(id),
  attempt     INTEGER NOT NULL,
  event       TEXT NOT NULL,
  worker_id   TEXT,
  error_class TEXT,
  message     TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS job_events_job ON job_events (job_id, id);
`;

export function openDb(path, { busyTimeoutMs = 1000 } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Catatan: node:sqlite sinkron. Menunggu lock memblokir seluruh event loop proses ini.
  db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0};`);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/**
 * Transaksi BEGIN IMMEDIATE: ambil write lock di awal supaya
 * dua worker tidak bisa meng-claim job yang sama.
 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ROLLBACK gagal berarti transaksi sudah batal; error asli yang dilempar.
    }
    throw err;
  }
}

/**
 * SQLITE_BUSY: gagal mendapat lock dalam busy_timeout. Busy handler SQLite tidak adil
 * (tidak ada antrean FIFO), jadi dengan banyak worker yang polling agresif, satu worker
 * sesekali kalah terus dan melewati batas walaupun setiap transaksi pendek (AUDIT P2-11).
 */
export function isBusyError(err) {
  return err?.errcode === 5 || /database is locked/i.test(err?.message ?? '');
}

const cache = new WeakMap();

/** Prepared statement di-cache per koneksi. */
export function stmt(db, sql) {
  let m = cache.get(db);
  if (!m) {
    m = new Map();
    cache.set(db, m);
  }
  let s = m.get(sql);
  if (!s) {
    s = db.prepare(sql);
    m.set(sql, s);
  }
  return s;
}
