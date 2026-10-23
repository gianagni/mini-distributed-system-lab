import { createHash } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PermanentError, StorageError, TransientError, ValidationError } from './errors.js';

// Tugas dummy: membuat laporan pesanan dari data acak ber-seed.
// Isi file deterministik untuk job yang sama (tanpa timestamp), jadi menulis ulang
// file laporan pada retry atau oleh worker zombie menghasilkan byte yang identik.
//
// Kontrak file vs database:
//   1. File ditulis DULU (tmp + rename atomik), BARU status SUCCEEDED di-commit beserta sha256 file.
//   2. Commit database adalah titik "selesai". File tanpa status SUCCEEDED bukan hasil yang sah.
//   3. Crash di antara 1 dan 2: job di-retry, file ditulis ulang dengan isi sama.
//   4. Kalau attempt habis, file yatim (orphan) bisa tertinggal untuk job FAILED.
//      `npm run check` melaporkannya sebagai warning.

export const JOB_TYPES = ['order_report'];

const LIMITS = {
  orderCount: [1, 200_000],
  seed: [0, 2 ** 31 - 1],
  delayMs: [0, 60_000],
  failTransientTimes: [0, 10],
  crashAfterWriteTimes: [0, 10],
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function onlyKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new ValidationError(`Field tidak dikenal di ${where}: ${k}`);
  }
}

function intInRange(value, [min, max], field, def) {
  if (value === undefined) return def;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} harus integer ${min}..${max}`);
  }
  return value;
}

function bool(value, field) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new ValidationError(`${field} harus boolean`);
  return value;
}

/** Validasi body POST /jobs. Return bentuk ternormalisasi (urutan key tetap, untuk hash idempotency). */
export function validateJobRequest(body, { allowFaultInjection }) {
  if (!isPlainObject(body)) throw new ValidationError('Body harus objek JSON');
  onlyKeys(body, ['type', 'payload'], 'body');
  if (!JOB_TYPES.includes(body.type)) {
    throw new ValidationError(`type harus salah satu: ${JOB_TYPES.join(', ')}`);
  }
  const p = body.payload ?? {};
  if (!isPlainObject(p)) throw new ValidationError('payload harus objek');
  onlyKeys(p, ['orderCount', 'seed', 'simulate'], 'payload');

  const payload = {
    orderCount: intInRange(p.orderCount, LIMITS.orderCount, 'payload.orderCount', 1000),
    seed: intInRange(p.seed, LIMITS.seed, 'payload.seed', 1),
  };

  if (p.simulate !== undefined) {
    // Fault injection adalah fitur uji. Di luar eksperimen harus mati.
    if (!allowFaultInjection) {
      throw new ValidationError('payload.simulate hanya diizinkan bila ALLOW_FAULT_INJECTION=1');
    }
    const s = p.simulate;
    if (!isPlainObject(s)) throw new ValidationError('payload.simulate harus objek');
    onlyKeys(
      s,
      ['delayMs', 'failTransientTimes', 'failPermanent', 'hang', 'crashAfterWriteTimes'],
      'payload.simulate',
    );
    payload.simulate = {
      delayMs: intInRange(s.delayMs, LIMITS.delayMs, 'payload.simulate.delayMs', 0),
      failTransientTimes: intInRange(s.failTransientTimes, LIMITS.failTransientTimes, 'payload.simulate.failTransientTimes', 0),
      failPermanent: bool(s.failPermanent, 'payload.simulate.failPermanent'),
      hang: bool(s.hang, 'payload.simulate.hang'),
      // Worker bunuh diri (SIGKILL) setelah file ditulis, sebelum commit database.
      crashAfterWriteTimes: intInRange(
        s.crashAfterWriteTimes,
        LIMITS.crashAfterWriteTimes,
        'payload.simulate.crashAfterWriteTimes',
        0,
      ),
    };
  }
  return { type: body.type, payload };
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildOrderReport(orderCount, seed) {
  const rand = mulberry32(seed);
  const byStatus = {
    PAID: { count: 0, amount: 0 },
    REFUNDED: { count: 0, amount: 0 },
    CANCELLED: { count: 0, amount: 0 },
  };
  const paidByDay = new Array(30).fill(0);
  for (let i = 0; i < orderCount; i++) {
    const r = rand();
    const status = r < 0.8 ? 'PAID' : r < 0.9 ? 'REFUNDED' : 'CANCELLED';
    const amount = 10_000 + Math.floor(rand() * 1_990_001);
    const day = Math.floor(rand() * 30);
    byStatus[status].count += 1;
    byStatus[status].amount += amount;
    if (status === 'PAID') paidByDay[day] += amount;
  }
  let busiest = 0;
  for (let d = 1; d < 30; d++) if (paidByDay[d] > paidByDay[busiest]) busiest = d;
  return {
    orderCount,
    seed,
    currency: 'IDR',
    byStatus,
    netRevenue: byStatus.PAID.amount - byStatus.REFUNDED.amount,
    busiestDay: { day: busiest + 1, paidAmount: paidByDay[busiest] },
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/**
 * Tulis file secara atomik: tmp lalu rename. Pembaca tidak pernah melihat file setengah jadi.
 * Kalau gagal di tengah jalan, file tmp dihapus dan error dibungkus StorageError.
 * Catatan: tidak ada fsync, jadi saat listrik padam file yang baru di-rename bisa hilang
 * walaupun commit SQLite tetap ada. `npm run check` akan mendeteksi kondisi itu.
 */
export async function writeFileAtomic(dir, name, content, tmpSuffix) {
  const finalPath = join(dir, name);
  const tmpPath = `${finalPath}.${tmpSuffix}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, content);
    await rename(tmpPath, finalPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw new StorageError(err);
  }
}

export async function runOrderReport(job, { signal, reportDir, attempt, allowFaultInjection }) {
  const { orderCount, seed, simulate } = job.payload;
  // Pertahanan lapis kedua: worker sendiri juga harus mengizinkan fault injection.
  if (simulate && !allowFaultInjection) {
    throw new PermanentError('payload.simulate ditolak: worker ini berjalan tanpa ALLOW_FAULT_INJECTION=1');
  }
  if (simulate?.delayMs) await sleep(simulate.delayMs, signal);
  if (simulate?.hang) await waitForAbort(signal);
  if (simulate?.failPermanent) throw new PermanentError('Simulasi: data sumber rusak');
  if (attempt <= (simulate?.failTransientTimes ?? 0)) {
    throw new TransientError(`Simulasi: dependency sementara gagal pada attempt ${attempt}`);
  }

  const report = buildOrderReport(orderCount, seed);
  signal.throwIfAborted();

  const content = JSON.stringify({ jobId: job.id, ...report }, null, 2);
  const reportFile = `${job.id}.json`;
  await writeFileAtomic(reportDir, reportFile, content, `${process.pid}.${attempt}`);

  if (attempt <= (simulate?.crashAfterWriteTimes ?? 0)) {
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {}); // tidak pernah lanjut
  }

  return {
    reportFile,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
    orderCount: report.orderCount,
    netRevenue: report.netRevenue,
  };
}

export const TASKS = { order_report: runOrderReport };
