// Regression test AUDIT S-1: CSRF lintas situs ke POST /jobs lewat "simple request" browser.
// Test lama tidak diubah. Perilaku browser dimodelkan dengan request yang persis dikirim
// Chromium (direproduksi dengan browser sungguhan, lihat AUDIT S-1).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isJsonContentType } from '../src/http.js';
import { report, setup } from './helpers.js';

const BODY = JSON.stringify({ type: 'order_report', payload: { orderCount: 5, seed: 1 } });

describe('isJsonContentType', () => {
  test('menerima application/json dengan parameter, menolak tipe lain dan tipe mirip', () => {
    for (const ok of ['application/json', 'application/json; charset=utf-8', 'Application/JSON', 'application/json;charset=UTF-8', ' application/json ']) {
      assert.equal(isJsonContentType(ok), true, ok);
    }
    for (const bad of [
      undefined,
      '',
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/jsonp',
      'application/json-seq',
      'application/vnd.api+json',
      'text/plain; application/json',
      'text/json',
    ]) {
      assert.equal(isJsonContentType(bad), false, String(bad));
    }
  });
});

describe('POST /jobs: Content-Type (proses API sungguhan)', () => {
  const raw = (s, headers, body = BODY) => fetch(`${s.api.url}/jobs`, { method: 'POST', headers, body });
  const total = async (s) => (await s.get('/metrics')).body.jobs.total;

  test('request sah tetap diterima: application/json dengan/ tanpa charset, huruf besar', async (t) => {
    const s = await setup(t, {}, { workers: 0 });
    assert.equal((await s.post(report())).status, 202);
    assert.equal((await raw(s, { 'content-type': 'application/json; charset=utf-8' })).status, 202);
    assert.equal((await raw(s, { 'content-type': 'Application/JSON' })).status, 202);
    assert.equal(await total(s), 3);
  });

  test('Content-Type tidak didukung: 415, tidak ada job, body error konsisten', async (t) => {
    const s = await setup(t, {}, { workers: 0 });
    for (const ct of [
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=----x',
      'application/jsonp',
      'text/plain; application/json',
    ]) {
      const r = await raw(s, { 'content-type': ct });
      assert.equal(r.status, 415, ct);
      assert.deepEqual(await r.json(), {
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type harus application/json' },
      });
    }
    // Tanpa Content-Type sama sekali (fetch memberi text/plain untuk body string; Blob kosong tidak).
    const none = await raw(s, {}, new Blob([BODY]));
    assert.equal(none.status, 415);
    assert.equal(await total(s), 0);
  });

  test('perilaku browser lintas situs: simple request ditolak, preflight tidak pernah disetujui', async (t) => {
    const s = await setup(t, {}, { workers: 0 });
    const evil = { origin: 'http://localhost:4801', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' };

    // 1) fetch(..., {mode:'no-cors'}) dengan body string: Chromium mengirim text/plain;charset=UTF-8.
    assert.equal((await raw(s, { ...evil, 'content-type': 'text/plain;charset=UTF-8' })).status, 415);

    // 2) <form enctype="text/plain"> tanpa JavaScript, trik duplicate key untuk menyerap "=".
    //    Body ini persis yang dikirim Chromium saat reproduksi; JSON-nya sendiri valid.
    const formBody = '{"type":"x=","type":"order_report","payload":{"orderCount":5,"seed":3}}\r\n';
    const formHeaders = { ...evil, 'sec-fetch-mode': 'navigate', 'content-type': 'text/plain' };
    assert.equal((await raw(s, formHeaders, formBody)).status, 415);
    // Dampak terburuk sebelum perbaikan: di mode lab (ALLOW_FAULT_INJECTION=1, aktif di env test),
    // situs lain bisa menyuruh worker bunuh diri atau hang. Sekarang ditolak sebelum validasi payload.
    const crash = JSON.stringify({ type: 'order_report', payload: { simulate: { crashAfterWriteTimes: 10 } } });
    assert.equal((await raw(s, { ...evil, 'content-type': 'text/plain;charset=UTF-8' }, crash)).status, 415);
    // Bukti bahwa yang menghentikan serangan adalah gerbang Content-Type, bukan parsing body.
    assert.equal((await raw(s, { 'content-type': 'application/json' }, formBody)).status, 202);
    assert.equal(await total(s), 1);

    // 3) fetch dengan application/json lintas situs memicu preflight. Browser hanya mengirim POST
    //    kalau preflight 2xx DAN mengizinkan origin. API tidak mengirim header CORS apa pun.
    const pre = await fetch(`${s.api.url}/jobs`, {
      method: 'OPTIONS',
      headers: { origin: evil.origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    assert.notEqual(Math.floor(pre.status / 100), 2, 'preflight tidak boleh sukses');
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
    assert.equal(pre.headers.get('access-control-allow-headers'), null);
    // Respons POST yang sah pun tidak membuka akses baca lintas origin.
    const ok = await s.post(report(undefined, 7));
    assert.equal(ok.headers.get('access-control-allow-origin'), null);
    assert.equal(await total(s), 2);
  });

  test('urutan pemeriksaan: 413 dan validasi key tetap lebih dulu; 415 tidak memakai Idempotency-Key', async (t) => {
    const s = await setup(t, {}, { workers: 0 });
    assert.equal((await raw(s, { 'content-type': 'text/plain' }, 'x'.repeat(17 * 1024))).status, 413);
    assert.equal((await raw(s, { 'content-type': 'text/plain', 'idempotency-key': 'spasi tidak boleh' })).status, 400);

    // Request yang ditolak 415 tidak boleh "mengunci" key: request sah berikutnya tetap job baru (202, bukan 200).
    assert.equal((await raw(s, { 'content-type': 'text/plain', 'idempotency-key': 'k-415' })).status, 415);
    const legit = await raw(s, { 'content-type': 'application/json', 'idempotency-key': 'k-415' });
    assert.equal(legit.status, 202);
    assert.equal(await total(s), 1);
  });
});
