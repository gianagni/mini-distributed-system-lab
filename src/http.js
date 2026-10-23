import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { ClientAbortedError, HttpError, ValidationError } from './errors.js';
import { createHostGuard } from './hostguard.js';
import { computeMetrics } from './metrics.js';
import { createJob, getEvents, getJob } from './store.js';
import { validateJobRequest } from './task.js';

const MAX_BODY_BYTES = 16 * 1024;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export function serializeJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    payload: JSON.parse(job.payload),
    result: job.result ? JSON.parse(job.result) : null,
    error: job.error_class ? { class: job.error_class, message: job.error_message } : null,
    createdAt: iso(job.created_at),
    firstStartedAt: iso(job.first_started_at),
    finishedAt: iso(job.finished_at),
    nextRunAt: job.status === 'PENDING' ? iso(job.next_run_at) : null,
    lastAttemptExecMs: job.exec_ms,
  };
}

function payloadTooLarge() {
  // connection: close supaya sisa body yang belum dibaca tidak diproses di koneksi ini.
  return new HttpError(413, 'PAYLOAD_TOO_LARGE', `Body maksimal ${MAX_BODY_BYTES} byte`, { connection: 'close' });
}

/** `application/json`, boleh dengan parameter (`; charset=utf-8`), tanpa membedakan huruf besar/kecil. */
export function isJsonContentType(value) {
  return typeof value === 'string' && /^\s*application\/json\s*(;|$)/i.test(value);
}

async function readJson(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw payloadTooLarge();
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw payloadTooLarge();
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Stream request error di sini berarti koneksi putus di tengah body.
    throw new ClientAbortedError();
  }
  // CSRF (lihat AUDIT S-1): browser boleh mengirim POST lintas situs tanpa preflight CORS hanya
  // untuk text/plain, form-urlencoded, dan multipart. Dengan mewajibkan application/json, setiap
  // request lintas situs dari browser harus lewat preflight OPTIONS, dan API tidak pernah
  // menyetujuinya (tanpa header CORS). Dicek SETELAH body dibaca supaya perilaku 408/413/client
  // aborted yang sudah diuji tidak berubah; tetap sebelum JSON di-parse dan job dibuat.
  if (!isJsonContentType(req.headers['content-type'])) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type harus application/json');
  }
  if (size === 0) throw new ValidationError('Body kosong');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('Body bukan JSON valid');
  }
}

export function createApiServer({ db, cfg, log }) {
  const guard = createHostGuard({ bindHost: cfg.host, allowedHosts: cfg.allowedHosts ?? [] });

  async function route(req, pathname, send) {
    const method = req.method;

    if (pathname === '/healthz') {
      if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Gunakan GET');
      db.prepare('SELECT 1').get();
      return send(200, { ok: true });
    }

    if (pathname === '/metrics') {
      if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Gunakan GET');
      return send(200, computeMetrics(db));
    }

    if (pathname === '/jobs') {
      if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Gunakan POST');
      const key = req.headers['idempotency-key'];
      if (key !== undefined && !IDEMPOTENCY_KEY_RE.test(key)) {
        throw new ValidationError('Idempotency-Key harus 1-128 karakter [A-Za-z0-9._:-]');
      }
      const body = await readJson(req);
      // Request browser dari origin lain (AUDIT S-2). Setelah readJson supaya urutan 408/413/415
      // yang sudah diuji tidak berubah; tetap sebelum validasi dan sebelum job dibuat.
      if (!guard.sameOriginOk(req)) throw new HttpError(403, 'CROSS_ORIGIN', 'Request dari origin lain ditolak');
      const { type, payload } = validateJobRequest(body, { allowFaultInjection: cfg.allowFaultInjection });
      const requestHash = createHash('sha256').update(JSON.stringify({ type, payload })).digest('hex');
      const { job, created } = createJob(db, {
        id: randomUUID(),
        type,
        payload,
        idempotencyKey: key ?? null,
        requestHash,
        maxAttempts: cfg.maxAttempts,
        maxPending: cfg.maxPending,
        now: Date.now(),
      });
      if (created) log.info('job_created', { jobId: job.id, type, withIdempotencyKey: key !== undefined });
      else log.info('job_deduplicated', { jobId: job.id });
      return send(created ? 202 : 200, serializeJob(job), { location: `/jobs/${job.id}` });
    }

    const m = pathname.match(/^\/jobs\/([^/]+)$/);
    if (m) {
      if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Gunakan GET');
      const job = JOB_ID_RE.test(m[1]) ? getJob(db, m[1]) : null;
      if (!job) throw new HttpError(404, 'NOT_FOUND', 'Job tidak ditemukan');
      const events = getEvents(db, job.id).map((e) => ({
        attempt: e.attempt,
        event: e.event,
        workerId: e.worker_id,
        errorClass: e.error_class,
        message: e.message,
        at: iso(e.at),
      }));
      return send(200, { ...serializeJob(job), events });
    }

    throw new HttpError(404, 'NOT_FOUND', 'Route tidak ditemukan');
  }

  // Batas waktu request: client lambat (atau slowloris) tidak boleh menahan koneksi 5 menit (default Node).
  const server = createServer({
    requestTimeout: cfg.requestTimeoutMs,
    headersTimeout: cfg.requestTimeoutMs,
    connectionsCheckingInterval: Math.min(1000, cfg.requestTimeoutMs),
  });

  server.on('request', async (req, res) => {
    const t0 = performance.now();
    let path = '(invalid)';
    let status = 500;
    const send = (code, body, headers = {}) => {
      status = code;
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(body));
    };
    try {
      // DNS rebinding (AUDIT S-2): Host harus nama yang memang dipakai untuk mencapai API ini.
      // Dicek sebelum apa pun, termasuk GET, karena halaman hasil rebinding bisa MEMBACA respons.
      // connection: close supaya body yang belum dibaca tidak diproses di koneksi ini.
      if (!guard.hostOk(req.headers.host, server.address()?.port)) {
        log.warn('host_rejected', { method: req.method, host: String(req.headers.host ?? '').slice(0, 100) });
        throw new HttpError(403, 'BAD_HOST', 'Host header tidak diizinkan. Akses lewat 127.0.0.1/localhost atau tambahkan ke ALLOWED_HOSTS.', {
          connection: 'close',
        });
      }
      // Parsing URL di DALAM try: path seperti "//[" membuat new URL() melempar error.
      // Dulu ini di luar try dan satu request bisa mematikan proses API.
      try {
        path = new URL(req.url, 'http://localhost').pathname;
      } catch {
        throw new HttpError(400, 'BAD_URL', 'URL tidak valid');
      }
      await route(req, path, send);
    } catch (err) {
      if (err instanceof ClientAbortedError) {
        status = 499; // konvensi nginx: client menutup koneksi
        log.warn('client_aborted', { method: req.method, path });
        res.destroy();
      } else if (err instanceof HttpError) {
        send(err.status, { error: { code: err.code, message: err.message } }, err.headers);
      } else {
        log.error('http_unhandled_error', { path, message: err.message, stack: err.stack });
        send(500, { error: { code: 'INTERNAL', message: 'Kesalahan internal' } });
      }
    } finally {
      log.info('http_request', {
        method: req.method,
        path,
        status,
        durationMs: Math.round((performance.now() - t0) * 100) / 100,
      });
    }
  });
  return server;
}
