// Helper bersama: escape HTML, format waktu/durasi, akses API dashboard.
// Semua teks dari database/API WAJIB lewat esc() sebelum masuk innerHTML.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Tagged template: nilai di-escape kecuali dibungkus raw(). Array digabung. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1];
  });
  return raw(out);
}
const RAW = Symbol('raw');
export const raw = (s) => ({ [RAW]: true, s: String(s) });
function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(render).join('');
  if (typeof v === 'object' && v[RAW]) return v.s;
  return esc(v);
}
export const toString = (v) => render(v);

export function fmtMs(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '–';
  const a = Math.abs(ms);
  const sign = ms < 0 ? '−' : '';
  if (a < 1000) return `${sign}${Math.round(a)} ms`;
  if (a < 60_000) return `${sign}${(a / 1000).toFixed(a < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(a / 60_000);
  const s = Math.round((a % 60_000) / 1000);
  if (m < 60) return `${sign}${m}m ${s}s`;
  return `${sign}${Math.floor(m / 60)}j ${m % 60}m`;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
export function fmtClock(epoch, withMs = false) {
  if (epoch === null || epoch === undefined) return '–';
  const d = new Date(epoch);
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withMs ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}
export const fmtIso = (epoch) => (epoch === null || epoch === undefined ? '' : new Date(epoch).toISOString());

/** "12 s lalu" relatif terhadap waktu snapshot server, bukan jam browser. */
export function fmtAgo(epoch, now) {
  if (epoch === null || epoch === undefined) return '–';
  return `${fmtMs(now - epoch)} lalu`;
}

export const shortId = (id) => String(id ?? '').slice(0, 8);

export class ApiError extends Error {
  constructor(status, code, message, body) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export async function getJson(path, { signal } = {}) {
  const r = await fetch(path, { headers: { accept: 'application/json' }, signal });
  let body = null;
  try {
    body = await r.json();
  } catch {
    // body bukan JSON
  }
  if (!r.ok) throw new ApiError(r.status, body?.error?.code ?? 'HTTP', body?.error?.message ?? `HTTP ${r.status}`, body);
  return body;
}

/** POST yang TIDAK melempar untuk status non-2xx: form perlu menampilkan 409/429 apa adanya. */
export async function postJson(path, payload, headers = {}) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await r.json();
  } catch {
    // body bukan JSON
  }
  return { status: r.status, body, retryAfter: r.headers.get('retry-after') };
}

export const STATUS_LABEL = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
};
const STATUS_ICON = { PENDING: '◷', RUNNING: '▶', SUCCEEDED: '✓', FAILED: '✕' };

export function statusBadge(status, extra = '') {
  return html`<span class="badge st-${String(status).toLowerCase()}"><span aria-hidden="true">${STATUS_ICON[status] ?? '•'}</span> ${STATUS_LABEL[status] ?? status}${extra ? raw(` <small>${esc(extra)}</small>`) : ''}</span>`;
}

export function faultBadge(on) {
  return on ? html`<span class="badge fault" title="payload.simulate: kegagalan ini disengaja (fault injection)">fault-injected</span>` : '';
}

// Sama dengan tabel error class di README.
export const ERROR_CLASS_INFO = {
  TRANSIENT: 'Dependency sementara gagal. Di-retry dengan backoff sampai MAX_ATTEMPTS.',
  TIMEOUT: 'Attempt melewati JOB_TIMEOUT_MS. Di-retry.',
  WORKER_LOST: 'Worker berhenti heartbeat (mati/macet). Job diambil alih worker lain; final kalau attempt habis.',
  INTERNAL: 'Error tak dikenal. Di-retry, tetap dibatasi MAX_ATTEMPTS.',
  STORAGE: 'Gagal menulis laporan. Retry hanya untuk ENOSPC/EIO/EMFILE/ENFILE/EBUSY/EAGAIN.',
  PERMANENT: 'Input/data rusak atau tidak diizinkan. Tidak di-retry.',
};

export function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}
export function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage diblokir: preferensi hanya untuk sesi ini
  }
}

/**
 * CSP melarang atribut style inline. Posisi/lebar dikirim lewat data-vars="--a:1%;--b:2px"
 * lalu dipasang lewat CSSOM (diizinkan CSP). Nilai hanya angka/unit dari kode kita sendiri.
 */
export function applyVars(el) {
  for (const node of el.querySelectorAll('[data-vars]')) {
    for (const pair of node.dataset.vars.split(';')) {
      const i = pair.indexOf(':');
      if (i > 0) node.style.setProperty(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
}
