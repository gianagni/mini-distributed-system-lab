// Shell dashboard: router hash, poller, indikator kesegaran data.
// Data selalu snapshot dari server (polling), bukan push. UI menyebutnya apa adanya.
import { ApiError, applyVars, esc, fmtClock, getJson, html, readPref, toString, writePref } from './lib.js';
import overview from './views/overview.js';
import jobs from './views/jobs.js';
import job from './views/job.js';
import create from './views/create.js';

const POLL_OPTIONS = [0, 1000, 2000, 5000, 10000];
const root = document.getElementById('view');
const freshness = document.getElementById('freshness');
const banner = document.getElementById('banner');
const pollSelect = document.getElementById('poll');
const themeBtn = document.getElementById('theme');

const app = {
  meta: null,
  pollMs: Number(readPref('pollMs', '2000')),
  lastOkAt: null,
  failingSince: null,
};
if (!POLL_OPTIONS.includes(app.pollMs)) app.pollMs = 2000;

// ---- theme ----
const THEMES = ['auto', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  themeBtn.textContent = `Tema: ${t}`;
}
let theme = readPref('theme', 'auto');
if (!THEMES.includes(theme)) theme = 'auto';
applyTheme(theme);
themeBtn.addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  writePref('theme', theme);
  applyTheme(theme);
});

// ---- routing ----
function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/overview';
  const [path, qs = ''] = h.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs));
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'jobs' && parts[1]) return { view: job, params: { id: parts[1] }, query, nav: 'jobs' };
  if (parts[0] === 'jobs') return { view: jobs, params: {}, query, nav: 'jobs' };
  if (parts[0] === 'new') return { view: create, params: {}, query, nav: 'new' };
  return { view: overview, params: {}, query, nav: 'overview' };
}

export function navigate(hash) {
  if (location.hash === hash) refresh();
  else location.hash = hash;
}

let current = null;
let token = 0;
let timer = null;
let inflight = null;

function setNav(nav) {
  for (const a of document.querySelectorAll('[data-nav]')) {
    a.classList.toggle('active', a.dataset.nav === nav);
    if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function mount() {
  clearTimeout(timer);
  inflight?.abort();
  token++;
  const route = parseHash();
  current = { ...route, data: null };
  setNav(route.nav);
  document.title = `${route.view.title(route)} · Reliability Lab`;
  const ctx = context();
  root.innerHTML = toString(route.view.shell ? route.view.shell(ctx) : html`<div data-slot="body"></div>`);
  route.view.bindShell?.(root, ctx);
  const body = root.querySelector('[data-slot="body"]');
  if (route.view.load) {
    body.innerHTML = '<p class="muted">Memuat…</p>';
    refresh();
  } else {
    setFreshness();
  }
}

function context() {
  return { ...current, app, navigate, refresh, root };
}

// Simpan state UI kecil (details terbuka, scroll horizontal) supaya polling tidak mengganggu pembaca.
function captureUi(el) {
  const open = new Set([...el.querySelectorAll('details[data-key][open]')].map((d) => d.dataset.key));
  const scroll = new Map([...el.querySelectorAll('[data-scroll-key]')].map((d) => [d.dataset.scrollKey, d.scrollLeft]));
  return { open, scroll };
}
function restoreUi(el, s) {
  for (const d of el.querySelectorAll('details[data-key]')) {
    if (s.open.has(d.dataset.key)) d.open = true;
  }
  for (const d of el.querySelectorAll('[data-scroll-key]')) {
    if (s.scroll.has(d.dataset.scrollKey)) d.scrollLeft = s.scroll.get(d.dataset.scrollKey);
  }
}

export async function refresh() {
  if (!current?.view.load) return;
  clearTimeout(timer);
  inflight?.abort();
  const my = ++token;
  const ac = new AbortController();
  inflight = ac;
  const view = current.view;
  try {
    const data = await view.load({ ...context(), signal: ac.signal });
    if (my !== token) return;
    current.data = data;
    app.lastOkAt = data?.generatedAt ?? Date.now();
    app.failingSince = null;
    banner.hidden = true;
    const body = root.querySelector('[data-slot="body"]');
    const ui = captureUi(body);
    body.innerHTML = toString(view.render(data, context()));
    applyVars(body);
    restoreUi(body, ui);
    view.bind?.(body, context());
  } catch (err) {
    if (err.name === 'AbortError' || my !== token) return;
    app.failingSince ??= Date.now();
    const body = root.querySelector('[data-slot="body"]');
    if (err instanceof ApiError && err.status === 404) {
      body.innerHTML = toString(html`<div class="panel"><h2>Tidak ditemukan</h2><p>${err.message}</p></div>`);
    } else if (!current.data) {
      body.innerHTML = toString(errorPanel(err));
    } else {
      // Data lama tetap tampil, tapi ditandai stale. Tidak pernah diam-diam.
      banner.hidden = false;
      banner.innerHTML = `⚠ Gagal memperbarui: ${esc(err.message)}. Data di bawah adalah snapshot ${esc(fmtClock(app.lastOkAt))} dan mungkin sudah usang.`;
    }
  } finally {
    if (my === token) {
      inflight = null;
      setFreshness();
      schedule();
    }
  }
}

function errorPanel(err) {
  const hint =
    err.code === 'DB_NOT_READY'
      ? html`<p>Database belum dibuat. Jalankan <code>npm run api</code> (atau <code>npm run lab</code>), lalu halaman ini akan memuat sendiri.</p>`
      : err.status === undefined
        ? html`<p>Dashboard server tidak bisa dihubungi. Apakah <code>npm run dashboard</code> masih berjalan?</p>`
        : '';
  return html`<div class="panel error-panel"><h2>Tidak bisa memuat data</h2><p><code>${err.code ?? err.name}</code> ${err.message}</p>${hint}</div>`;
}

function schedule() {
  clearTimeout(timer);
  if (!current?.view.load || app.pollMs === 0 || document.hidden) return;
  if (current.view.shouldPoll && !current.view.shouldPoll(current.data)) return;
  timer = setTimeout(refresh, app.pollMs);
}

function setFreshness() {
  const polling = current?.view.load
    ? app.pollMs === 0
      ? 'Polling mati'
      : document.hidden
        ? 'Polling dijeda (tab tersembunyi)'
        : current.view.shouldPoll && !current.view.shouldPoll(current.data)
          ? 'Polling berhenti (job selesai)'
          : `Polling tiap ${app.pollMs / 1000} s`
    : 'Halaman statis';
  const snap = app.lastOkAt ? `snapshot server ${fmtClock(app.lastOkAt)}` : 'belum ada snapshot';
  freshness.classList.toggle('stale', Boolean(app.failingSince));
  freshness.textContent = app.failingSince
    ? `⚠ Gagal sejak ${fmtClock(app.failingSince)} · ${snap}`
    : `${polling} · ${snap}`;
}

// ---- poll control ----
pollSelect.innerHTML = POLL_OPTIONS.map(
  (ms) => `<option value="${ms}"${ms === app.pollMs ? ' selected' : ''}>${ms === 0 ? 'Mati' : `${ms / 1000} s`}</option>`,
).join('');
pollSelect.addEventListener('change', () => {
  app.pollMs = Number(pollSelect.value);
  writePref('pollMs', String(app.pollMs));
  setFreshness();
  if (app.pollMs > 0) refresh();
  else clearTimeout(timer);
});
document.getElementById('refresh').addEventListener('click', () => refresh());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
  else clearTimeout(timer);
  setFreshness();
});

// ---- start ----
async function loadMeta() {
  try {
    app.meta = await getJson('/api/meta');
  } catch {
    app.meta = null;
  }
  document.getElementById('lab-badge').hidden = !app.meta?.faultInjectionPanel;
}
window.addEventListener('hashchange', mount);
loadMeta().finally(mount);
