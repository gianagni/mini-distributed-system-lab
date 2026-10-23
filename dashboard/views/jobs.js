import { esc, faultBadge, fmtAgo, fmtClock, fmtIso, fmtMs, getJson, html, shortId, statusBadge } from '../lib.js';

const STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'];
const ERROR_CLASSES = ['TRANSIENT', 'TIMEOUT', 'WORKER_LOST', 'INTERNAL', 'STORAGE', 'PERMANENT'];

function buildHash(q) {
  const sp = new URLSearchParams();
  for (const k of ['status', 'errorClass', 'retried', 'before']) if (q[k]) sp.set(k, q[k]);
  const s = sp.toString();
  return `#/jobs${s ? `?${s}` : ''}`;
}

export default {
  title: ({ query }) => (query.status ? `Jobs ${query.status}` : 'Jobs'),

  // Filter dirender sekali per navigasi (di luar area yang di-refresh polling),
  // supaya select/checkbox tidak kehilangan fokus setiap poll.
  shell({ query }) {
    return html`
      <h1 class="page-title">Jobs</h1>
      <div class="filters" role="search">
        <nav class="tabs" aria-label="Filter status" data-slot="tabs"></nav>
        <label>Error class
          <select name="errorClass">
            <option value="">Semua</option>
            ${ERROR_CLASSES.map((c) => html`<option value="${c}" ${query.errorClass === c ? 'selected' : ''}>${c}</option>`)}
          </select>
        </label>
        <label class="check"><input type="checkbox" name="retried" ${query.retried === '1' ? 'checked' : ''}> Hanya yang attempt &gt; 1</label>
      </div>
      <div data-slot="body"></div>`;
  },

  bindShell(root, ctx) {
    const q = ctx.query;
    root.querySelector('select[name=errorClass]').addEventListener('change', (e) => {
      ctx.navigate(buildHash({ ...q, errorClass: e.target.value, before: '' }));
    });
    root.querySelector('input[name=retried]').addEventListener('change', (e) => {
      ctx.navigate(buildHash({ ...q, retried: e.target.checked ? '1' : '', before: '' }));
    });
  },

  load({ query, signal }) {
    const sp = new URLSearchParams({ limit: '50' });
    for (const k of ['status', 'errorClass', 'retried', 'before']) if (query[k]) sp.set(k, query[k]);
    return getJson(`/api/jobs?${sp}`, { signal });
  },

  render(d, { query, root }) {
    renderTabs(root.querySelector('[data-slot=tabs]'), d.counts, query);
    const now = d.generatedAt;
    const filtered = query.status || query.errorClass || query.retried;
    return html`
      ${query.before ? html`<p class="small"><a href="${buildHash({ ...query, before: '' })}">← kembali ke yang terbaru</a> · halaman lama tidak menampilkan job yang dibuat setelahnya</p>` : ''}
      ${d.items.length === 0
        ? html`<div class="panel"><p class="muted">${filtered ? 'Tidak ada job yang cocok dengan filter ini.' : 'Belum ada job.'} <a href="#/new">Buat job</a>.</p></div>`
        : html`<div class="scroll-x panel flush" data-scroll-key="jobs"><table class="jobs">
            <thead><tr>
              <th scope="col">Job</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Error terakhir</th>
              <th scope="col">Dibuat</th><th scope="col" class="r">End-to-end</th><th scope="col" class="r">Queue wait</th><th scope="col" class="r">Exec terakhir</th>
            </tr></thead>
            <tbody>${d.items.map((j) => row(j, now))}</tbody>
          </table></div>`}
      ${d.nextCursor ? html`<p><a class="button" href="${buildHash({ ...query, before: d.nextCursor })}">Lebih lama →</a></p>` : ''}
      <p class="muted small">Diurutkan dari yang terbaru. Latency hanya terisi setelah tahapnya terjadi. Status PENDING dengan error berarti attempt sebelumnya gagal dan retry sudah dijadwalkan.</p>`;
  },
};

function renderTabs(el, counts, query) {
  const total = Object.values(counts.byStatus).reduce((a, b) => a + b, 0);
  const tab = (status, label, n) => {
    const active = (query.status || '') === status;
    return `<a href="${esc(buildHash({ ...query, status, before: '' }))}" class="tab${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}>${esc(label)} <span class="count">${esc(n)}</span></a>`;
  };
  el.innerHTML = [tab('', 'Semua', total), ...STATUSES.map((s) => tab(s, s, counts.byStatus[s]))].join('');
}

function row(j, now) {
  const pendingNote = j.status === 'PENDING' && j.nextRunAt !== null && j.nextRunAt > now ? `retry ${fmtMs(j.nextRunAt - now)} lagi` : '';
  return html`<tr>
    <td><a href="#/jobs/${j.id}"><code>${shortId(j.id)}</code></a> ${faultBadge(j.faultInjected)}<div class="muted small">${j.type} · ${j.orderCount ?? '?'} order</div></td>
    <td>${statusBadge(j.status, pendingNote)}${j.lease ? html`<div class="muted small">lease <code>${j.lease.owner}</code></div>` : ''}</td>
    <td>${attemptDots(j)}</td>
    <td>${j.error ? html`<code class="ec">${j.error.class}</code><div class="muted small clip" title="${j.error.message}">${j.error.message}</div>` : html`<span class="muted">–</span>`}</td>
    <td><time datetime="${fmtIso(j.createdAt)}" title="${fmtIso(j.createdAt)}">${fmtClock(j.createdAt)}</time><div class="muted small">${fmtAgo(j.createdAt, now)}</div></td>
    <td class="r">${fmtMs(j.latency.endToEndMs)}</td>
    <td class="r">${fmtMs(j.latency.queueWaitMs)}</td>
    <td class="r">${fmtMs(j.latency.lastAttemptExecMs)}</td>
  </tr>`;
}

/** n/max dengan titik: terisi = attempt terpakai. Teks tetap ada (tidak bergantung warna). */
function attemptDots(j) {
  const dots = [];
  for (let i = 1; i <= j.maxAttempts; i++) dots.push(html`<span class="dot${i <= j.attempts ? ' used' : ''}"></span>`);
  return html`<span class="dots" aria-hidden="true">${dots}</span> <span>${j.attempts}/${j.maxAttempts}</span>`;
}
