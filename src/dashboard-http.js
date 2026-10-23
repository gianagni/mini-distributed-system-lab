import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isBusyError } from './db.js';
import { HttpError } from './errors.js';
import { ERROR_CLASSES, STATUSES, getJobDetail, getOverview, listJobs, parseCursor } from './readmodel.js';

// Proses dashboard: file statis + endpoint read-only + proxy POST /jobs ke API.
// Tidak pernah menulis ke database (koneksi readOnly). Lihat docs/REFERENCE-RESEARCH.md §8.

export const STATIC_DIR = fileURLToPath(new URL('../dashboard', import.meta.url));
const MAX_BODY_BYTES = 16 * 1024;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

/** Whitelist file statis dibaca sekali saat start. Path request tidak pernah menyentuh filesystem. */
export function loadStaticFiles(dir = STATIC_DIR) {
  const files = new Map();
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (TYPES[extname(entry.name)]) {
        const url = '/' + relative(dir, full).split(sep).join('/');
        files.set(url, { body: readFileSync(full), type: TYPES[extname(entry.name)] });
      }
    }
  };
  walk(dir);
  const index = files.get('/index.html');
  if (index) files.set('/', index);
  return files;
}

/**
 * Koneksi read-only yang dibuka saat dibutuhkan. Dibuka ulang kalau file database diganti
 * (mis. `npm run clean` lalu API membuat file baru), supaya dashboard tidak membaca inode lama.
 */
function createDbHandle(cfg) {
  let db = null;
  let ino = null;
  return {
    get() {
      let st;
      try {
        st = statSync(cfg.dbPath);
      } catch {
        this.close();
        throw new HttpError(503, 'DB_NOT_READY', `Database belum ada di ${cfg.dbPath}. Jalankan API dulu (npm run api).`);
      }
      if (db && st.ino !== ino) this.close();
      if (!db) {
        db = new DatabaseSync(cfg.dbPath, { readOnly: true });
        db.exec(`PRAGMA busy_timeout = ${Number(cfg.busyTimeoutMs) | 0};`);
        ino = st.ino;
      }
      return db;
    },
    close() {
      if (db) {
        try {
          db.close();
        } catch {
          // sudah tertutup
        }
      }
      db = null;
      ino = null;
    },
  };
}

async function readBody(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Body maksimal ${MAX_BODY_BYTES} byte`, { connection: 'close' });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Body maksimal ${MAX_BODY_BYTES} byte`, { connection: 'close' });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseListQuery(sp) {
  const status = sp.get('status') || null;
  if (status && !STATUSES.includes(status)) throw new HttpError(400, 'VALIDATION', `status harus salah satu: ${STATUSES.join(', ')}`);
  const errorClass = sp.get('errorClass') || null;
  if (errorClass && !ERROR_CLASSES.includes(errorClass)) {
    throw new HttpError(400, 'VALIDATION', `errorClass harus salah satu: ${ERROR_CLASSES.join(', ')}`);
  }
  const rawLimit = sp.get('limit');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'VALIDATION', 'limit harus integer 1..200');
  const rawBefore = sp.get('before');
  const before = rawBefore ? parseCursor(rawBefore) : null;
  if (rawBefore && !before) throw new HttpError(400, 'VALIDATION', 'before (cursor) tidak valid');
  return { status, errorClass, retried: sp.get('retried') === '1', limit, before };
}

export function createDashboardServer({ cfg, log, staticFiles = loadStaticFiles() }) {
  const dbh = createDbHandle(cfg);
  let apiHealth = { at: 0, value: null };

  async function checkApi() {
    if (Date.now() - apiHealth.at < 3000 && apiHealth.value) return apiHealth.value;
    let value;
    try {
      const r = await fetch(`${cfg.apiUrl}/healthz`, { signal: AbortSignal.timeout(1500) });
      value = { ok: r.ok, status: r.status };
    } catch (err) {
      value = { ok: false, status: null, message: err.cause?.code ?? err.name };
    }
    apiHealth = { at: Date.now(), value };
    return value;
  }

  // DNS rebinding: halaman dari domain lain yang di-resolve ke 127.0.0.1 akan mengirim Host domain itu.
  function checkHost(req, server) {
    if (cfg.allowRemote) return;
    const port = server.address()?.port;
    const allowed = new Set(['127.0.0.1', 'localhost', '[::1]', cfg.host].map((h) => `${h}:${port}`));
    if (!allowed.has(String(req.headers.host ?? '').toLowerCase())) {
      throw new HttpError(403, 'BAD_HOST', 'Host header tidak dikenal. Buka dashboard lewat 127.0.0.1 atau localhost.');
    }
  }

  // CSRF: wajib JSON (cross-origin JSON butuh preflight CORS yang tidak pernah kita jawab),
  // dan Origin/Sec-Fetch-Site (kalau dikirim browser) harus same-origin.
  function checkSameOrigin(req) {
    const ct = String(req.headers['content-type'] ?? '');
    if (!/^application\/json\b/i.test(ct)) {
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type harus application/json');
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${req.headers.host}`) {
      throw new HttpError(403, 'CROSS_ORIGIN', 'Request dari origin lain ditolak');
    }
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      throw new HttpError(403, 'CROSS_ORIGIN', 'Request dari origin lain ditolak');
    }
  }

  async function proxyCreateJob(req, send) {
    checkSameOrigin(req);
    const key = req.headers['idempotency-key'];
    if (key !== undefined && !IDEMPOTENCY_KEY_RE.test(key)) {
      throw new HttpError(400, 'VALIDATION', 'Idempotency-Key harus 1-128 karakter [A-Za-z0-9._:-]');
    }
    const body = await readBody(req);
    let r;
    try {
      r = await fetch(`${cfg.apiUrl}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
        body,
        signal: AbortSignal.timeout(cfg.requestTimeoutMs),
      });
    } catch (err) {
      throw new HttpError(
        502,
        'API_UNREACHABLE',
        `API tidak bisa dihubungi di ${cfg.apiUrl} (${err.cause?.code ?? err.name}). Jalankan npm run api.`,
      );
    }
    // Status dan body API diteruskan apa adanya: 202 baru, 200 replay, 400/409/413/429 error.
    const text = await r.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new HttpError(502, 'API_BAD_RESPONSE', `API mengembalikan body bukan JSON (status ${r.status})`);
    }
    const headers = { 'x-upstream': 'api' };
    const retryAfter = r.headers.get('retry-after');
    if (retryAfter) headers['retry-after'] = retryAfter;
    log.info('job_proxied', { status: r.status, jobId: payload?.id ?? null, withIdempotencyKey: key !== undefined });
    return send(r.status, payload, headers);
  }

  async function route(req, url, send, server) {
    const { pathname } = url;
    const method = req.method;
    checkHost(req, server);

    if (!pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Gunakan GET');
      const file = staticFiles.get(pathname);
      if (!file) throw new HttpError(404, 'NOT_FOUND', 'File tidak ditemukan');
      return send(200, file.body, { 'content-type': file.type, 'cache-control': 'no-cache' }, true);
    }

    if (pathname === '/api/meta') {
      if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Gunakan GET');
      let db = 'ok';
      try {
        dbh.get();
      } catch (err) {
        db = err.code ?? 'ERROR';
      }
      return send(200, {
        generatedAt: Date.now(),
        apiUrl: cfg.apiUrl,
        dbPath: cfg.dbPath,
        faultInjectionPanel: cfg.allowFaultInjection,
        db,
        api: await checkApi(),
      });
    }

    if (pathname === '/api/overview') {
      if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Gunakan GET');
      const data = getOverview(dbh.get());
      return send(200, { ...data, api: await checkApi() });
    }

    if (pathname === '/api/jobs') {
      if (method === 'POST') return proxyCreateJob(req, send);
      if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Gunakan GET atau POST');
      return send(200, listJobs(dbh.get(), parseListQuery(url.searchParams)));
    }

    const m = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (m) {
      if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Gunakan GET');
      const detail = JOB_ID_RE.test(m[1]) ? getJobDetail(dbh.get(), m[1]) : null;
      if (!detail) throw new HttpError(404, 'NOT_FOUND', 'Job tidak ditemukan');
      return send(200, detail);
    }

    throw new HttpError(404, 'NOT_FOUND', 'Route tidak ditemukan');
  }

  const server = createServer({
    requestTimeout: cfg.requestTimeoutMs,
    headersTimeout: cfg.requestTimeoutMs,
    connectionsCheckingInterval: Math.min(1000, cfg.requestTimeoutMs),
  });

  server.on('request', async (req, res) => {
    const t0 = performance.now();
    let path = '(invalid)';
    let status = 500;
    const send = (code, body, headers = {}, raw = false) => {
      status = code;
      res.writeHead(code, {
        ...SECURITY_HEADERS,
        ...(raw ? {} : { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }),
        ...headers,
      });
      res.end(req.method === 'HEAD' ? undefined : raw ? body : JSON.stringify(body));
    };
    try {
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        throw new HttpError(400, 'BAD_URL', 'URL tidak valid');
      }
      path = url.pathname;
      await route(req, url, send, server);
    } catch (err) {
      if (err instanceof HttpError) {
        send(err.status, { error: { code: err.code, message: err.message } }, err.headers);
      } else if (isBusyError(err)) {
        // Read-only jarang kena lock (WAL), tapi bisa saat checkpoint/recovery. Bukan error dashboard.
        send(503, { error: { code: 'DB_BUSY', message: 'Database sedang sibuk, coba lagi' } }, { 'retry-after': '1' });
      } else if (req.destroyed || err?.code === 'ECONNRESET' || err?.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        status = 499;
        res.destroy();
      } else {
        log.error('dashboard_unhandled_error', { path, message: err.message, stack: err.stack });
        send(500, { error: { code: 'INTERNAL', message: 'Kesalahan internal dashboard' } });
      }
    } finally {
      // GET sukses tidak dicatat: UI polling tiap beberapa detik dan akan membanjiri log.
      if (req.method !== 'GET' || status >= 400) {
        log.info('http_request', {
          method: req.method,
          path,
          status,
          durationMs: Math.round((performance.now() - t0) * 100) / 100,
        });
      }
    }
  });
  server.on('close', () => dbh.close());
  return server;
}
