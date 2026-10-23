import { faultBadge, fmtAgo, fmtMs, getJson, html, raw, shortId, statusBadge } from '../lib.js';

// Overview: semua angka dari GET /api/overview (computeMetrics yang sama dengan GET /metrics
// di API, plus job RUNNING dan worker yang terlihat di event).

export default {
  title: () => 'Overview',
  load: ({ signal }) => getJson('/api/overview', { signal }),
  render(d) {
    const m = d.metrics;
    const now = d.generatedAt;
    return html`
      ${apiNotice(d.api)}
      <section aria-labelledby="h-status">
        <h2 id="h-status" class="section-title">Status job <small class="muted">${m.jobs.total} total</small></h2>
        <div class="tiles">
          ${tile('PENDING', m.jobs.byStatus.PENDING, `${m.health.pendingReady} siap · ${m.health.pendingInBackoff} menunggu backoff`)}
          ${tile('RUNNING', m.jobs.byStatus.RUNNING, `${d.running.length} lease aktif`)}
          ${tile('SUCCEEDED', m.jobs.byStatus.SUCCEEDED, 'commit final')}
          ${tile('FAILED', m.jobs.byStatus.FAILED, 'attempt habis atau permanen')}
        </div>
      </section>

      <div class="grid-2">
        <section class="panel" aria-labelledby="h-health">
          <h2 id="h-health">Kesehatan antrean</h2>
          <dl class="kv">
            ${healthRow(
              'Lease kedaluwarsa (RUNNING)',
              m.health.runningWithExpiredLease,
              m.health.runningWithExpiredLease > 0 ? 'critical' : 'good',
              m.health.runningWithExpiredLease > 0
                ? 'Ada worker mati/macet. Job akan diambil alih saat worker lain claim (kecuali RECOVERY=0).'
                : 'Semua job RUNNING masih punya lease yang hidup.',
            )}
            ${healthRow(
              'Queue lag (PENDING siap tertua)',
              fmtMs(m.health.oldestReadyPendingAgeMs),
              m.health.oldestReadyPendingAgeMs > 5000 ? 'warning' : 'neutral',
              'Berapa lama job yang SUDAH boleh jalan menunggu worker. Job yang sengaja menunggu backoff tidak dihitung.',
            )}
            ${healthRow(
              'Attempt berjalan paling lama',
              fmtMs(m.health.oldestRunningAgeMs),
              'neutral',
              'Mendeteksi job hang yang heartbeat-nya masih hidup. Bandingkan dengan JOB_TIMEOUT_MS.',
            )}
            ${healthRow('PENDING menunggu backoff', m.health.pendingInBackoff, 'neutral', 'Retry terjadwal, belum waktunya jalan.')}
          </dl>
        </section>

        <section class="panel" aria-labelledby="h-rel">
          <h2 id="h-rel">Reliability</h2>
          <dl class="kv">
            ${healthRow(
              'Job dengan sukses ganda',
              m.counters.duplicateSuccessJobs,
              m.counters.duplicateSuccessJobs === 0 ? 'good' : 'critical',
              'Invariant: harus selalu 0. Dihitung dari event succeeded per job.',
            )}
            ${healthRow('Retry dijadwalkan', m.counters.retriesScheduled, 'neutral', 'Event retry_scheduled (attempt gagal yang boleh diulang).')}
            ${healthRow('Worker hilang terdeteksi', m.counters.workerLost, 'neutral', 'Event lease_expired: lease diambil alih saat claim berikutnya.')}
            ${healthRow(
              'Tulisan basi ditolak (fencing)',
              m.counters.staleWritesRejected,
              'neutral',
              'Worker zombie mencoba menulis hasil attempt yang sudah diambil alih, dan ditolak.',
            )}
          </dl>
        </section>
      </div>

      <section class="panel" aria-labelledby="h-lat">
        <h2 id="h-lat">Latency <small class="muted">hanya job SUCCEEDED (${m.latencyMs.endToEnd.count} job), nearest-rank</small></h2>
        <div class="scroll-x" data-scroll-key="lat">
          <table class="num">
            <thead><tr><th scope="col">Metrik</th><th>p50</th><th>p95</th><th>p99</th><th>max</th></tr></thead>
            <tbody>
              ${latRow('End-to-end (created → finished)', m.latencyMs.endToEnd)}
              ${latRow('Queue wait (created → claim pertama)', m.latencyMs.queueWait)}
              ${latRow('Eksekusi attempt terakhir', m.latencyMs.lastAttemptExec)}
            </tbody>
          </table>
        </div>
      </section>

      <div class="grid-2">
        <section class="panel" aria-labelledby="h-ec">
          <h2 id="h-ec">FAILED per error class</h2>
          ${bars(m.failedByErrorClass, (k) => `#/jobs?status=FAILED&errorClass=${encodeURIComponent(k)}`, 'Belum ada job FAILED.')}
        </section>
        <section class="panel" aria-labelledby="h-att">
          <h2 id="h-att">Attempts per job selesai</h2>
          ${bars(
            Object.fromEntries(Object.entries(m.attemptsHistogram).map(([k, v]) => [`${k} attempt`, v])),
            null,
            'Belum ada job selesai.',
          )}
          <p class="muted small">Job dengan attempt &gt; 1 pernah di-retry atau di-reclaim. <a href="#/jobs?retried=1">Lihat daftarnya</a>.</p>
        </section>
      </div>

      <section class="panel" aria-labelledby="h-run">
        <h2 id="h-run">Sedang RUNNING <small class="muted">${d.running.length} job</small></h2>
        ${d.running.length === 0
          ? html`<p class="muted">Tidak ada job yang sedang berjalan.</p>`
          : html`<div class="scroll-x" data-scroll-key="run"><table>
              <thead><tr><th>Job</th><th>Worker (lease owner)</th><th>Attempt</th><th>Berjalan</th><th>Sisa lease</th></tr></thead>
              <tbody>${d.running.map((j) => runningRow(j, now))}</tbody>
            </table></div>`}
      </section>

      <section class="panel" aria-labelledby="h-wk">
        <h2 id="h-wk">Worker yang terlihat di event</h2>
        <p class="muted small">Bukan liveness check. Worker idle tidak menulis event, jadi tidak muncul di sini. Kolom "lease hilang" ditulis worker lain saat mengambil alih.</p>
        ${d.workers.length === 0
          ? html`<p class="muted">Belum ada worker yang menulis event.</p>`
          : html`<div class="scroll-x" data-scroll-key="wk"><table class="num-right">
              <thead><tr><th>Worker</th><th>Event terakhir</th><th>Claim</th><th>Sukses</th><th>Gagal/retry</th><th>Lease hilang</th><th>Ditolak fencing</th><th>Memegang</th></tr></thead>
              <tbody>${d.workers.map(
                (w) => html`<tr>
                  <td><code>${w.workerId}</code></td>
                  <td>${fmtAgo(w.lastEventAt, now)}</td>
                  <td>${w.claims}</td><td>${w.succeeded}</td><td>${w.failures}</td>
                  <td>${w.leasesLost}</td><td>${w.staleRejected}</td>
                  <td>${w.runningNow.length ? w.runningNow.map((id) => html`<a href="#/jobs/${id}"><code>${shortId(id)}</code></a> `) : '–'}</td>
                </tr>`,
              )}</tbody>
            </table></div>`}
      </section>

      <section class="panel" aria-labelledby="h-recent">
        <h2 id="h-recent">Job terbaru <a class="small" href="#/jobs">semua →</a></h2>
        ${d.recent.length === 0
          ? html`<p class="muted">Belum ada job. <a href="#/new">Buat job pertama</a>.</p>`
          : html`<div class="scroll-x" data-scroll-key="recent"><table>
              <thead><tr><th>Job</th><th>Status</th><th>Attempts</th><th>Dibuat</th><th>End-to-end</th></tr></thead>
              <tbody>${d.recent.map(
                (j) => html`<tr>
                  <td><a href="#/jobs/${j.id}"><code>${shortId(j.id)}</code></a> ${faultBadge(j.faultInjected)}</td>
                  <td>${statusBadge(j.status)}</td>
                  <td>${j.attempts}/${j.maxAttempts}</td>
                  <td>${fmtAgo(j.createdAt, now)}</td>
                  <td>${fmtMs(j.latency.endToEndMs)}</td>
                </tr>`,
              )}</tbody>
            </table></div>`}
      </section>
    `;
  },
};

function apiNotice(api) {
  if (!api || api.ok) return '';
  return html`<div class="notice warning" role="status">⚠ API tidak menjawab <code>/healthz</code> (${api.message ?? `HTTP ${api.status}`}). Data di bawah dibaca langsung dari SQLite dan tetap akurat, tapi job baru tidak bisa dibuat.</div>`;
}

function tile(status, n, sub) {
  return html`<a class="tile st-${status.toLowerCase()}" href="#/jobs?status=${status}">
    <span class="tile-label">${statusBadge(status)}</span>
    <span class="tile-value">${n}</span>
    <span class="tile-sub">${sub}</span>
  </a>`;
}

const LEVEL_ICON = { good: '✓', critical: '✕', warning: '!', neutral: '' };
function healthRow(label, value, level, help) {
  return html`<div class="kv-row">
    <dt>${label}<span class="help">${help}</span></dt>
    <dd class="lvl-${level}">${LEVEL_ICON[level] ? raw(`<span aria-hidden="true">${LEVEL_ICON[level]}</span> `) : ''}${value}</dd>
  </div>`;
}

function latRow(label, s) {
  return html`<tr><th scope="row">${label}</th><td>${fmtMs(s.p50)}</td><td>${fmtMs(s.p95)}</td><td>${fmtMs(s.p99)}</td><td>${fmtMs(s.max)}</td></tr>`;
}

/** Bar horizontal satu seri: nilai selalu ditulis sebagai teks, warna tidak membawa arti sendiri. */
function bars(obj, hrefFor, empty) {
  const entries = Object.entries(obj);
  if (entries.length === 0) return html`<p class="muted">${empty}</p>`;
  const max = Math.max(...entries.map(([, v]) => v));
  return html`<ul class="bars">${entries.map(([k, v]) => {
    const label = hrefFor ? html`<a href="${hrefFor(k)}">${k}</a>` : k;
    return html`<li><span class="bar-label">${label}</span><span class="bar-track"><span class="bar-fill" data-vars="--w:${((v / max) * 100).toFixed(1)}%"></span></span><span class="bar-value">${v}</span></li>`;
  })}</ul>`;
}

function runningRow(j, now) {
  const rem = j.lease.remainingMs;
  const expired = rem < 0;
  return html`<tr class="${expired ? 'row-critical' : ''}">
    <td><a href="#/jobs/${j.id}"><code>${shortId(j.id)}</code></a> ${faultBadge(j.faultInjected)}</td>
    <td><code>${j.lease.owner}</code></td>
    <td>${j.attempts}/${j.maxAttempts}</td>
    <td>${fmtMs(now - j.startedAt)}</td>
    <td class="${expired ? 'lvl-critical' : 'lvl-good'}">${expired ? raw(`✕ kedaluwarsa ${fmtMs(-rem)} lalu`) : fmtMs(rem)}</td>
  </tr>`;
}
