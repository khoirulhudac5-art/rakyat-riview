import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const html = await readFile(new URL('../aktivasi.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function setup(fetcher) {
  const elements = new Map();
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    elements.set(id, { value: '', textContent: '', disabled: false, handlers: {},
      addEventListener(name, handler) { this.handlers[name] = handler; },
      reset() { this.didReset = true; }
    });
  }
  const calls = [];
  vm.runInNewContext(script, {
    document: { getElementById: id => { assert.ok(elements.has(id), `Missing ID ${id}`); return elements.get(id); } },
    fetch: async (url, options) => { calls.push({ url, options }); return fetcher(url, options); }
  });
  return { get: id => elements.get(id), calls };
}

test('activation redesign preserves the original script and field constraints exactly', () => {
  assert.equal(createHash('sha256').update(script).digest('hex'), '47117f7dabd7eacfab50e7c0f13cfbbe432b5af717b74d2534af34f627aaf772');
  for (const id of ['cardCode', 'activationCode', 'businessName', 'reviewUrl', 'pin']) {
    assert.match(html, new RegExp(`<input[^>]*id="${id}"[^>]*\\brequired\\b`));
  }
  assert.match(html, /id="pin"[^>]*type="password"[^>]*minlength="6"/);
  assert.match(html, /id="reviewUrl"[^>]*type="url"/);
  assert.match(html, /id="convertButton"/);
});

test('conversion: empty, success, server error, network error, and input reset', async () => {
  const page = setup(async () => ({ ok: true, json: async () => ({ review_url: 'https://search.google.com/local/writereview?placeid=ChISynthetic' }) }));
  await page.get('convertButton').handlers.click();
  assert.equal(page.calls.length, 0);
  assert.match(page.get('convertResult').textContent, /Masukkan link/);
  page.get('reviewUrl').value = ' https://maps.app.goo.gl/synthetic ';
  await page.get('convertButton').handlers.click();
  assert.equal(page.calls[0].url, '/api/convert-review');
  assert.deepEqual(JSON.parse(page.calls[0].options.body), { maps_url: 'https://maps.app.goo.gl/synthetic' });
  assert.match(page.get('convertResult').textContent, /Berhasil/);
  assert.match(page.get('reviewUrl').value, /search.google.com/);
  page.get('reviewUrl').handlers.input();
  assert.equal(page.get('convertResult').textContent, '');
  for (const fetcher of [async () => ({ ok: false, json: async () => ({ error: 'Synthetic failure' }) }), async () => { throw Error('offline'); }]) {
    const failed = setup(fetcher);
    failed.get('reviewUrl').value = 'https://maps.app.goo.gl/synthetic';
    await failed.get('convertButton').handlers.click();
    assert.match(failed.get('convertResult').textContent, /Synthetic failure|Gagal menghubungi/);
    assert.equal(failed.get('convertButton').disabled, false);
  }
});

test('activation preserves payload, raw PIN, success reset, and failure recovery', async () => {
  for (const outcome of ['success', 'rejected', 'offline']) {
    const page = setup(async () => {
      if (outcome === 'offline') throw Error('offline');
      return { ok: outcome === 'success', json: async () => ({ success: outcome === 'success', message: 'Synthetic rejection' }) };
    });
    for (const [id, value] of Object.entries({ cardCode: ' 002 ', activationCode: ' synthetic-code ', businessName: ' Synthetic shop ', reviewUrl: ' https://www.google.com/maps ', pin: ' synthetic-pin ' })) page.get(id).value = value;
    let prevented = false;
    await page.get('activationForm').handlers.submit.call(page.get('activationForm'), { preventDefault() { prevented = true; } });
    assert.ok(prevented);
    assert.equal(page.calls[0].url, '/api/activate-card');
    assert.equal(page.calls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(page.calls[0].options.body), { card_code: '002', activation_code: 'synthetic-code', business_name: 'Synthetic shop', review_url: 'https://www.google.com/maps', pin: ' synthetic-pin ' });
    assert.equal(page.get('activateButton').disabled, false);
    assert.equal(Boolean(page.get('activationForm').didReset), outcome === 'success');
    assert.match(page.get('result').textContent, outcome === 'success' ? /berhasil diaktifkan/ : outcome === 'rejected' ? /Synthetic rejection/ : /Gagal terhubung/);
  }
});

test('pending conversion and activation disable their buttons until completion', async () => {
  let resolve;
  const page = setup(() => new Promise(done => { resolve = done; }));
  page.get('reviewUrl').value = 'https://maps.app.goo.gl/synthetic';
  const pending = page.get('convertButton').handlers.click();
  assert.equal(page.get('convertButton').disabled, true);
  assert.match(page.get('convertResult').textContent, /Sedang/);
  resolve({ ok: true, json: async () => ({ review_url: 'https://www.google.com/maps' }) });
  await pending;
  const activation = page.get('activationForm').handlers.submit.call(page.get('activationForm'), { preventDefault() {} });
  assert.equal(page.get('activateButton').disabled, true);
  assert.match(page.get('result').textContent, /Sedang/);
  resolve({ ok: false, json: async () => ({}) });
  await activation;
  assert.equal(page.get('activateButton').disabled, false);
});
