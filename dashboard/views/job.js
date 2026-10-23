import { ERROR_CLASS_INFO, faultBadge, fmtClock, fmtIso, fmtMs, getJson, html, raw, statusBadge } from '../lib.js';

// Detail job. Timeline digambar dari `timeline` yang diturunkan server (src/timeline.js)
// dari job_events asli; tabel event mentah di bawahnya adalah sumber kebenaran.

const OUTCOME = {
  succeeded: 'sukses',
  retry_scheduled: 'gagal → retry',
  failed: 'gagal final',
  worker_lost: 'worker hilang',
  running: 'berjalan',
  unknown: 'tanpa event akhir',
};

const EVENT_INFO = {
  created: 'Job masuk antrean (ditulis API).',
  claimed: 'Worker mengambil lease; attempt dimulai.',
  succeeded: 'Commit SUCCEEDED, di-fence dengan (lease_owner, attempts).',
  retry_scheduled: 'Attempt gagal tapi boleh diulang: kembali ke PENDING dengan backoff.',
  failed: 'Status final FAILED.',
  lease_expired: 'Lease kedaluwarsa, DIDETEKSI saat worker lain claim. Waktu ini waktu deteksi, bukan waktu worker mati.',
  stale_completion_rejected: 'Fencing: worker zombie mencoba commit sukses untuk attempt basi, ditolak.',
  stale_failure_rejected: 'Fencing: worker zombie mencoba menulis gagal untuk attempt basi, ditolak.',
};

const FLASH = {
  202: '202 Accepted: job baru dibuat lewat POST /jobs. Halaman ini polling untuk menampilkan perubahan status.',
  200: '200 OK: Idempotency-Key ini sudah dipakai dengan isi yang sama. API mengembalikan job yang sudah ada, tidak ada job baru.',
};

export default {
  title: ({ params }) => `Job ${params.id.slice(0, 8)}`,
  load: ({ params, signal }) => getJson(`/api/jobs/${encodeURIComponent(params.id)}`, { signal }),

  render(d, { query }) {
    const j = d.job;
    const tl = d.timeline;
    const now = d.generatedAt;
    const pendingNote = j.status === 'PENDING' && j.nextRunAt > now ? `retry ${fmtMs(j.nextRunAt - now)} lagi` : '';
    return html`
      <p class="small"><a href="#/jobs">← Jobs</a></p>
      <h1 class="page-title">Job <code class="id">${j.id}</code></h1>
      <div class="badges">${statusBadge(j.status, pendingNote)} ${faultBadge(j.faultInjected)} <span class="badge plain">${j.type}</span>
        ${j.idempotencyKey ? html`<span class="badge plain" title="Idempotency-Key">key: <code>${j.idempotencyKey}</code></span>` : ''}</div>
      ${FLASH[query.created] ? html`<div class="notice good" role="status">${FLASH[query.created]}</div>` : ''}

      <div class="stats">
        ${stat('Attempts', `${j.attempts}/${j.maxAttempts}`)}
        ${stat('End-to-end', fmtMs(tl.totals.endToEndMs), j.finishedAt ? 'created → finished' : 'belum selesai')}
        ${stat('Queue wait', fmtMs(tl.totals.queueWaitMs), 'created → claim pertama')}
        ${stat('Total eksekusi', fmtMs(tl.totals.execMs), 'semua attempt yang sudah berakhir')}
        ${stat('Total jeda retry', fmtMs(tl.totals.retryWaitMs), 'backoff + menunggu worker')}
        ${stat('Ditolak fencing', tl.totals.staleWritesRejected, 'tulisan worker zombie')}
      </div>

      ${failurePanel(j, now)}

      <section class="panel" aria-labelledby="h-tl">
        <h2 id="h-tl">Execution timeline</h2>
        ${timeline(tl, j, d.events, now)}
      </section>

      <section class="panel" aria-labelledby="h-att">
        <h2 id="h-att">Attempts &amp; retry history</h2>
        ${tl.attempts.length === 0
          ? html`<p class="muted">Belum ada attempt. Job menunggu worker.</p>`
          : html`<div class="scroll-x" data-scroll-key="att"><table class="attempts">
              <thead><tr><th>#</th><th>Worker</th><th>Jeda sebelum</th><th>Mulai</th><th class="r">Durasi</th><th>Hasil</th><th>Error</th><th class="r">Backoff dijadwalkan</th></tr></thead>
              <tbody>${tl.attempts.map((a) => attemptRow(a, tl))}</tbody>
            </table></div>`}
      </section>

      <section class="panel" aria-labelledby="h-ev">
        <h2 id="h-ev">Event log <small class="muted">${d.events.length} baris dari tabel job_events, urut id</small></h2>
        <div class="scroll-x" data-scroll-key="ev"><table class="events">
          <thead><tr><th>seq</th><th class="r">+ms</th><th>Waktu</th><th>Attempt</th><th>Event</th><th>Worker</th><th>Error</th><th>Pesan</th></tr></thead>
          <tbody>${d.events.map(
            (e) => html`<tr class="ev-${e.event}">
              <td class="muted">${e.seq}</td>
              <td class="r">${e.at - tl.start}</td>
              <td><time datetime="${fmtIso(e.at)}" title="${fmtIso(e.at)}">${fmtClock(e.at, true)}</time></td>
              <td>${e.attempt}</td>
              <td><code title="${EVENT_INFO[e.event] ?? ''}">${e.event}</code></td>
              <td>${e.workerId ? html`<code>${e.workerId}</code>` : html`<span class="muted">–</span>`}</td>
              <td>${e.errorClass ? html`<code class="ec">${e.errorClass}</code>` : ''}</td>
              <td class="msg">${e.message ?? ''}</td>
            </tr>`,
          )}</tbody>
        </table></div>
        <details data-key="evinfo"><summary>Arti setiap event</summary>
          <dl class="defs">${Object.entries(EVENT_INFO).map(([k, v]) => html`<dt><code>${k}</code></dt><dd>${v}</dd>`)}</dl>
        </details>
      </section>

      <div class="grid-2">
        <section class="panel"><h2>Payload</h2><pre>${JSON.stringify(j.payload, null, 2)}</pre></section>
        <section class="panel"><h2>Result</h2>${j.result
          ? html`<pre>${JSON.stringify(j.result, null, 2)}</pre><p class="muted small">sha256 dari isi file laporan. <code>npm run check</code> memverifikasi file vs database.</p>`
          : html`<p class="muted">Belum ada. Result hanya ditulis bersamaan dengan commit SUCCEEDED.</p>`}</section>
      </div>`;
  },
};

function stat(label, value, sub = '') {
  return html`<div class="stat"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${sub ? html`<span class="stat-sub">${sub}</span>` : ''}</div>`;
}

function failurePanel(j, now) {
  if (!j.error) return '';
  const final = j.status === 'FAILED';
  const level = final ? 'critical' : 'warning';
  return html`<section class="panel failure lvl-border-${level}" aria-labelledby="h-fail">
    <h2 id="h-fail">${final ? 'Alasan gagal (final)' : 'Error attempt terakhir (akan di-retry)'}</h2>
    <p><code class="ec">${j.error.class}</code> ${j.error.message}</p>
    <p class="muted small">${ERROR_CLASS_INFO[j.error.class] ?? 'Error class tidak dikenal.'}</p>
    ${!final && j.nextRunAt
      ? html`<p class="small">Attempt berikutnya boleh jalan mulai ${fmtClock(j.nextRunAt, true)} (${j.nextRunAt > now ? `${fmtMs(j.nextRunAt - now)} lagi` : 'sudah lewat, menunggu worker bebas'}).</p>`
      : ''}
    ${j.faultInjected ? html`<p class="small">Job ini memakai <code>payload.simulate</code>: kegagalan ini disengaja.</p>` : ''}
  </section>`;
}

function attemptRow(a, tl) {
  const w = tl.waits.find((x) => x.beforeAttempt === a.attempt);
  let waitText = '–';
  if (w) {
    waitText =
      w.kind === 'queue'
        ? `antre ${fmtMs(w.durationMs)}`
        : w.kind === 'reclaim'
          ? `reclaim ${fmtMs(w.durationMs)}`
          : w.backoffMs !== null
            ? `${fmtMs(w.durationMs)} (backoff ${fmtMs(w.backoffMs)} + antre ${fmtMs(w.queueAfterBackoffMs)})`
            : fmtMs(w.durationMs);
  }
  const outcome = OUTCOME[a.outcome] + (a.outcome === 'worker_lost' && a.finalFailure ? ' → FAILED' : '');
  return html`<tr>
    <td>${a.attempt}</td>
    <td>${a.workerId ? html`<code>${a.workerId}</code>` : '–'}</td>
    <td>${waitText}</td>
    <td class="nowrap">${a.claimedAt === null ? '–' : html`+${a.claimedAt - tl.start} ms`}</td>
    <td class="r">${fmtMs(a.durationMs)}${a.open ? ' …' : ''}${a.endIsDetection ? html`<div class="muted small">sampai deteksi</div>` : ''}</td>
    <td><span class="outcome out-${a.outcome}">${outcome}</span>${a.staleWrites.length ? html`<div class="small">◆ ${a.staleWrites.length} tulisan basi ditolak</div>` : ''}</td>
    <td>${a.errorClass ? html`<code class="ec">${a.errorClass}</code><div class="muted small msg">${a.message}</div>` : ''}</td>
    <td class="r">${a.backoffMs === null ? '–' : fmtMs(a.backoffMs)}</td>
  </tr>`;
}

function timeline(tl, j, events, now) {
  // Sumbu waktu mencakup semua event (tulisan zombie bisa datang SETELAH job selesai)
  // dan jadwal retry berikutnya kalau ada.
  const lastEventAt = events.length ? Math.max(...events.map((e) => e.at)) : tl.start;
  const scheduled = j.status === 'PENDING' && j.nextRunAt > now ? j.nextRunAt : null;
  const t0 = tl.start;
  const t1 = Math.max(tl.end, lastEventAt, scheduled ?? 0, t0 + 1);
  const span = t1 - t0;
  const pct = (t) => Math.min(100, Math.max(0, ((t - t0) / span) * 100));
  const seg = (cls, from, to, title, extra = '') =>
    html`<span class="seg ${cls}" data-vars="--l:${pct(from).toFixed(3)}%;--w:${Math.max(0, pct(to) - pct(from)).toFixed(3)}%" title="${title}">${raw(extra)}</span>`;

  const waitSegs = (w) => {
    if (!w || w.durationMs <= 0) return '';
    if (w.kind === 'retry_wait' && w.backoffMs !== null) {
      const split = Math.min(w.from + w.backoffMs, w.to);
      return [
        seg('seg-backoff', w.from, split, `Backoff ${fmtMs(Math.min(w.backoffMs, w.durationMs))}${w.open ? ' (berjalan)' : ''}`),
        split < w.to ? seg('seg-queue', split, w.to, `Menunggu worker ${fmtMs(w.to - split)}${w.open ? ' (berjalan)' : ''}`) : '',
      ];
    }
    const label = w.kind === 'queue' ? 'Antre' : w.kind === 'reclaim' ? 'Jeda reclaim' : 'Jeda retry';
    return seg(w.kind === 'retry_wait' ? 'seg-backoff' : 'seg-queue', w.from, w.to, `${label} ${fmtMs(w.durationMs)}${w.open ? ' (berjalan)' : ''}`);
  };

  const rows = tl.attempts.map((a) => {
    const w = tl.waits.find((x) => x.beforeAttempt === a.attempt);
    const end = a.endedAt ?? (a.open ? now : a.claimedAt);
    const outcome = OUTCOME[a.outcome] + (a.outcome === 'worker_lost' && a.finalFailure ? ' → FAILED' : '');
    const execTitle = `Attempt ${a.attempt} · ${a.workerId ?? '?'} · ${fmtMs(a.durationMs)} · ${outcome}${a.endIsDetection ? ' (akhir = waktu deteksi oleh worker lain)' : ''}${a.errorClass ? ` · ${a.errorClass}` : ''}`;
    const stale = a.staleWrites.map(
      (s) =>
        html`<span class="mk mk-stale" data-vars="--l:${pct(s.at).toFixed(3)}%" title="Fencing menolak ${s.event} dari ${s.workerId ?? '?'} pada +${s.at - t0} ms"></span>`,
    );
    return html`<div class="tl-row">
      <div class="tl-label"><strong>Attempt ${a.attempt}</strong> <code>${a.workerId ?? '?'}</code>
        <span class="outcome out-${a.outcome}">${outcome}</span> <span class="muted">${fmtMs(a.durationMs)}${a.open ? ' …' : ''}</span></div>
      <div class="tl-track">
        ${waitSegs(w)}
        ${a.claimedAt !== null ? seg(`seg-exec out-${a.outcome}${a.endIsDetection ? ' detected' : ''}${a.open ? ' open' : ''}`, a.claimedAt, end, execTitle) : ''}
        ${stale}
      </div>
    </div>`;
  });

  // Jeda terbuka setelah attempt terakhir (job PENDING): belum ada baris attempt untuknya.
  const openWait = tl.waits.find((w) => w.open);
  if (openWait) {
    rows.push(html`<div class="tl-row">
      <div class="tl-label"><strong>Menunggu attempt ${openWait.beforeAttempt}</strong> <span class="muted">${fmtMs(openWait.durationMs)} …</span></div>
      <div class="tl-track">
        ${waitSegs(openWait)}
        ${scheduled ? seg('seg-scheduled', now, scheduled, `Dijadwalkan: boleh di-claim mulai +${scheduled - t0} ms (${fmtMs(scheduled - now)} lagi)`) : ''}
      </div>
    </div>`);
  }

  const ticks = [0, 25, 50, 75, 100].map(
    (p) => html`<span class="tick${p === 0 ? ' tick-first' : p === 100 ? ' tick-last' : ''}" data-vars="--l:${p}%">+${fmtMs((span * p) / 100)}</span>`,
  );
  const nowMarker = tl.open
    ? html`<span class="now-line" data-vars="--l:${pct(now).toFixed(3)}%" title="Snapshot server ${fmtClock(now, true)}"></span>`
    : '';

  return html`
    <div class="timeline" role="img" aria-label="Timeline attempt; detail angka ada di tabel Attempts dan Event log di bawah">
      <div class="tl-row tl-axis"><div class="tl-label muted small">mulai ${fmtClock(t0, true)}</div><div class="tl-track axis">${ticks}${nowMarker}</div></div>
      ${rows.length ? rows : html`<p class="muted">Belum ada event selain created.</p>`}
    </div>
    <ul class="legend small">
      <li><span class="sw seg-queue"></span> antre / menunggu worker</li>
      <li><span class="sw seg-backoff"></span> backoff</li>
      <li><span class="sw out-succeeded"></span> eksekusi → sukses</li>
      <li><span class="sw out-retry_scheduled"></span> eksekusi → gagal, retry</li>
      <li><span class="sw out-failed"></span> eksekusi → gagal final</li>
      <li><span class="sw out-worker_lost"></span> worker hilang: mati di suatu titik dalam rentang ini, ujung kanan = waktu deteksi</li>
      <li><span class="sw out-running"></span> berjalan</li>
      <li><span class="sw mk-stale-sw"></span> tulisan basi ditolak fencing</li>
      ${scheduled ? html`<li><span class="sw seg-scheduled"></span> jadwal retry (masa depan)</li>` : ''}
    </ul>
    ${tl.open ? html`<p class="muted small">Garis vertikal = snapshot server ${fmtClock(now, true)}. Bar yang masih berjalan berakhir di snapshot ini, bukan di waktu selesai.</p>` : ''}`;
}
