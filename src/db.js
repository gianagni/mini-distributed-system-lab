import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

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

// Jejak transaksi tulis (AUDIT C-3, hanya untuk diagnosis, mati secara default): siapa memegang write
// lock, berapa lama menunggu, berapa lama memegang. Waktu absolut (ms epoch, presisi sub-ms) supaya
// jejak beberapa proses bisa digabung. Lihat enableTxTrace / scripts/lease-probe.js.
let txTrace = null;
const clock = () => performance.timeOrigin + performance.now();

/**
 * Aktifkan jejak transaksi untuk proses ini. Setiap flushMs, `emit(records)` dipanggil dengan
 * [label, mulai, tunggu lock ms, pegang lock ms, hasil, total ms] per tulisan. Hasil: 1 = mengubah /
 * mengembalikan sesuatu, 0 = kosong (null/false), -1 = BUSY, -2 = error lain. Untuk tulisan autocommit
 * (satu statement) tunggu dan pegang tidak bisa dipisah: keduanya null, hanya total.
 */
export function enableTxTrace(emit, flushMs = 250) {
  const buf = [];
  txTrace = (r) => buf.push(r);
  setInterval(() => {
    if (buf.length) emit(buf.splice(0));
  }, flushMs).unref();
}

/** Jalankan satu tulisan dan catat di jejak. `fn(acquired)`: panggil acquired() saat lock didapat. */
export function traced(label, fn) {
  if (!txTrace) return fn(() => {});
  const t0 = clock();
  let t1 = null;
  const rec = (outcome) => {
    const t2 = clock();
    const r2 = (x) => Math.round(x * 100) / 100;
    txTrace([label, r2(t0), t1 === null ? null : r2(t1 - t0), t1 === null ? null : r2(t2 - t1), outcome, r2(t2 - t0)]);
  };
  try {
    const r = fn(() => {
      t1 = clock();
    });
    rec(r === null || r === false ? 0 : 1);
    return r;
  } catch (err) {
    rec(isBusyError(err) ? -1 : -2);
    throw err;
  }
}

/**
 * Transaksi BEGIN IMMEDIATE: ambil write lock di awal supaya
 * dua worker tidak bisa meng-claim job yang sama.
 */
export function tx(db, fn, label = 'tx') {
  return traced(label, (acquired) => {
    db.exec('BEGIN IMMEDIATE');
    acquired();
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
  });
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
