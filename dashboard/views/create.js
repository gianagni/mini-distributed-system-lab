import { html, postJson, shortId, toString } from '../lib.js';

// Form pembuatan job. Request diteruskan dashboard ke POST /jobs milik API apa adanya:
// validasi, idempotency, dan backpressure tetap milik API. Form ini tidak memvalidasi ulang
// kecuali batas input HTML biasa, supaya pesan error yang terlihat adalah pesan API.

const PRESETS = [
  {
    id: 'transient2',
    label: 'Transient 2×',
    expect: 'Gagal TRANSIENT di attempt 1 dan 2, sukses di attempt 3. Lihat jeda backoff di timeline.',
    simulate: { failTransientTimes: 2 },
  },
  {
    id: 'transientAll',
    label: 'Transient terus',
    expect: 'Gagal di setiap attempt, berhenti di MAX_ATTEMPTS: FAILED TRANSIENT.',
    simulate: { failTransientTimes: 10 },
  },
  {
    id: 'permanent',
    label: 'Permanent',
    expect: 'FAILED PERMANENT di attempt 1, tanpa retry.',
    simulate: { failPermanent: true },
  },
  {
    id: 'slow',
    label: 'Lambat 5 s',
    expect: 'RUNNING ±5 s. Amati sisa lease diperpanjang heartbeat di Overview. Coba kill -9 worker di tengahnya.',
    simulate: { delayMs: 5000 },
  },
  {
    id: 'hang',
    label: 'Hang',
    expect: 'Tidak pernah selesai sendiri; dihentikan JOB_TIMEOUT_MS (default 30 s) lalu di-retry: FAILED TIMEOUT.',
    simulate: { hang: true },
  },
  {
    id: 'crash',
    label: 'Crash setelah tulis',
    expect:
      'Worker yang mengerjakan BUNUH DIRI (SIGKILL) setelah menulis file, sebelum commit. Job di-reclaim setelah LEASE_MS oleh worker lain atau worker yang di-restart (npm run lab me-restart otomatis).',
    simulate: { crashAfterWriteTimes: 1 },
    danger: true,
  },
];

export default {
  title: () => 'Buat job',
  // Tidak polling: form tidak boleh di-reset saat user mengetik.
  shell({ app }) {
    const lab = Boolean(app.meta?.faultInjectionPanel);
    return html`
      <h1 class="page-title">Buat job</h1>
      <div class="grid-2 wide-left">
        <form class="panel form" id="job-form" novalidate>
          <h2>order_report</h2>
          <div class="field-row">
            <label>orderCount <input name="orderCount" type="number" min="1" max="200000" step="1" value="1000" required></label>
            <label>seed <input name="seed" type="number" min="0" max="2147483647" step="1" value="1" required></label>
          </div>
          <label>Idempotency-Key <span class="muted small">(opsional, [A-Za-z0-9._:-], 1-128)</span>
            <span class="input-group"><input name="key" type="text" maxlength="128" placeholder="mis. rekap-001" autocomplete="off" spellcheck="false">
            <button type="button" class="secondary" id="gen-key">Generate</button></span>
          </label>
          <label>Jumlah request <span class="muted small">(1-100, dikirim berurutan; dengan key, request ke-2 dst. memakai key-2, key-3, …)</span>
            <input name="count" type="number" min="1" max="100" step="1" value="1">
          </label>

          ${lab
            ? html`<fieldset class="lab" id="lab">
                <legend>⚠ Fault injection (lab)</legend>
                <p class="small">Aktif karena dashboard dijalankan dengan <code>ALLOW_FAULT_INJECTION=1</code>. API dan worker tetap memeriksa flag mereka sendiri; kalau API menolak, pesannya muncul di bawah.</p>
                <div class="presets" role="group" aria-label="Skenario">
                  <button type="button" class="secondary" data-preset="">Tanpa fault</button>
                  ${PRESETS.map((p) => html`<button type="button" class="secondary${p.danger ? ' danger' : ''}" data-preset="${p.id}">${p.label}</button>`)}
                </div>
                <p class="small expect" id="expect">Tanpa fault injection: job normal.</p>
                <div class="field-row">
                  <label>delayMs <input name="delayMs" type="number" min="0" max="60000" step="1" value="0"></label>
                  <label>failTransientTimes <input name="failTransientTimes" type="number" min="0" max="10" step="1" value="0"></label>
                  <label>crashAfterWriteTimes <input name="crashAfterWriteTimes" type="number" min="0" max="10" step="1" value="0"></label>
                </div>
                <div class="field-row">
                  <label class="check"><input name="failPermanent" type="checkbox"> failPermanent</label>
                  <label class="check"><input name="hang" type="checkbox"> hang</label>
                </div>
              </fieldset>`
            : html`<p class="muted small">Fault injection mati (default aman). Untuk eksperimen: <code>npm run lab -- --fault-injection</code>. Lihat RUNBOOK.</p>`}

          <details data-key="preview"><summary>Request yang akan dikirim</summary><pre id="preview"></pre></details>
          <div class="actions"><button type="submit" id="submit">Kirim ke POST /jobs</button></div>
        </form>

        <aside class="panel">
          <h2>Hasil</h2>
          <div id="result"><p class="muted">Respons API akan muncul di sini, termasuk status HTTP aslinya.</p></div>
          <h3>Arti status</h3>
          <dl class="defs small">
            <dt>202</dt><dd>Job baru dibuat.</dd>
            <dt>200</dt><dd>Replay: Idempotency-Key sama, isi sama. Job lama dikembalikan.</dd>
            <dt>400</dt><dd>Validasi gagal (atau fault injection ditolak API).</dd>
            <dt>409</dt><dd>Key sudah dipakai untuk isi berbeda.</dd>
            <dt>429</dt><dd>Antrean penuh (MAX_PENDING). Backpressure bekerja.</dd>
            <dt>502</dt><dd>Dashboard tidak bisa menghubungi API.</dd>
          </dl>
        </aside>
      </div>`;
  },

  bindShell(root, ctx) {
    const form = root.querySelector('#job-form');
    const preview = root.querySelector('#preview');
    const result = root.querySelector('#result');
    const num = (name) => Number(form.elements[name]?.value);

    const buildBody = () => {
      const payload = { orderCount: num('orderCount'), seed: num('seed') };
      if (form.elements.delayMs) {
        const s = {};
        for (const k of ['delayMs', 'failTransientTimes', 'crashAfterWriteTimes']) if (num(k) > 0) s[k] = num(k);
        for (const k of ['failPermanent', 'hang']) if (form.elements[k].checked) s[k] = true;
        if (Object.keys(s).length) payload.simulate = s;
      }
      return { type: 'order_report', payload };
    };
    const update = () => {
      const key = form.elements.key.value.trim();
      preview.textContent = `POST /jobs${key ? `\nIdempotency-Key: ${key}` : ''}\n\n${JSON.stringify(buildBody(), null, 2)}`;
    };
    form.addEventListener('input', update);
    update();

    root.querySelector('#gen-key').addEventListener('click', () => {
      form.elements.key.value = `ui-${crypto.randomUUID().slice(0, 13)}`;
      update();
    });

    for (const b of root.querySelectorAll('[data-preset]')) {
      b.addEventListener('click', () => {
        const p = PRESETS.find((x) => x.id === b.dataset.preset);
        const s = p?.simulate ?? {};
        for (const k of ['delayMs', 'failTransientTimes', 'crashAfterWriteTimes']) form.elements[k].value = s[k] ?? 0;
        for (const k of ['failPermanent', 'hang']) form.elements[k].checked = Boolean(s[k]);
        root.querySelector('#expect').textContent = p ? `Ekspektasi: ${p.expect}` : 'Tanpa fault injection: job normal.';
        for (const o of root.querySelectorAll('[data-preset]')) o.classList.toggle('active', o === b);
        update();
      });
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = root.querySelector('#submit');
      const count = Math.min(100, Math.max(1, Math.trunc(num('count')) || 1));
      const key = form.elements.key.value.trim();
      const body = buildBody();
      btn.disabled = true;
      result.innerHTML = '<p class="muted">Mengirim…</p>';
      const responses = [];
      try {
        for (let i = 0; i < count; i++) {
          const k = key ? (i === 0 ? key : `${key}-${i + 1}`) : null;
          responses.push(await postJson('/api/jobs', body, k ? { 'idempotency-key': k } : {}));
        }
      } catch (err) {
        responses.push({ status: 0, body: { error: { code: 'NETWORK', message: err.message } } });
      } finally {
        btn.disabled = false;
      }
      if (count === 1 && (responses[0].status === 202 || responses[0].status === 200)) {
        ctx.navigate(`#/jobs/${responses[0].body.id}?created=${responses[0].status}`);
        return;
      }
      result.innerHTML = toString(summary(responses));
    });
  },
};

function summary(responses) {
  const byStatus = {};
  for (const r of responses) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const last = responses[responses.length - 1];
  const ok = responses.filter((r) => r.status === 202 || r.status === 200);
  return html`
    <p>${Object.entries(byStatus).map(([s, n]) => html`<span class="badge http-${String(s)[0]}xx">${s === '0' ? 'network' : s} × ${n}</span> `)}</p>
    ${last.body?.error
      ? html`<p><code>${last.body.error.code}</code> ${last.body.error.message}${last.retryAfter ? html` <span class="muted">(Retry-After: ${last.retryAfter} s)</span>` : ''}</p>`
      : ''}
    ${ok.length
      ? html`<p class="small">Job: ${ok.slice(0, 20).map((r) => html`<a href="#/jobs/${r.body.id}"><code>${shortId(r.body.id)}</code></a> `)}${ok.length > 20 ? `… +${ok.length - 20}` : ''}</p>
         <p><a class="button" href="#/jobs">Lihat daftar job →</a></p>`
      : ''}
    <details data-key="raw"><summary>Body respons terakhir</summary><pre>${JSON.stringify(last.body, null, 2)}</pre></details>`;
}

// Diekspor untuk test: setiap preset harus lolos validateJobRequest milik API.
export { PRESETS };
