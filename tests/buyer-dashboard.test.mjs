import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/buyer.js', import.meta.url), 'utf8');

// Lightweight DOM adapter: verifies state/event logic, not browser layout or HTML validation.
function boot({ page = 'dashboard', query = '', storage = new Map(), blocked = false } = {}) {
  const elements = new Map();
  class Element {
    constructor() {
      this.value = ''; this.textContent = ''; this.dataset = {}; this.attributes = {};
      this.handlers = {}; this.disabled = false; this.checked = false;
      const classes = new Set();
      this.classList = { toggle(name) { if (classes.has(name)) { classes.delete(name); return false; } classes.add(name); return true; }, remove(name) { classes.delete(name); } };
    }
    set innerHTML(value) {
      this.html = value;
      for (const match of value.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
        const element = new Element();
        element.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
        elements.set(match[1], element);
      }
    }
    get innerHTML() { return this.html || ''; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    focus() { this.focused = true; }
  }
  elements.set('shell', new Element());
  const document = { body: { dataset: { page } }, getElementById: id => elements.get(id), querySelectorAll: () => [], contains: () => true };
  const context = vm.createContext({
    document, location: { search: query, href: '' }, URL, URLSearchParams, Intl, structuredClone,
    sessionStorage: { getItem: key => { if (blocked) throw Error('blocked'); return storage.get(key) || null; }, setItem: (key, value) => { if (blocked) throw Error('blocked'); storage.set(key, value); }, removeItem: key => storage.delete(key) },
    setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
    fetch() { throw Error('Network access forbidden in demo'); }
  });
  vm.runInContext(source, context);
  return { get: id => elements.get(id), storage };
}

test('dashboard renders synthetic totals, search, filters and demo states', () => {
  const { get } = boot();
  assert.match(get('view').innerHTML, /<div class="stat-value">2<\/div>/);
  assert.match(get('view').innerHTML, /<div class="stat-value">550<\/div>/);
  assert.match(get('view').innerHTML, /<div class="stat-value">509<\/div>/);
  get('search').oninput({ target: { value: 'senja' } });
  assert.match(get('card-list').innerHTML, /Studio Senja/);
  assert.doesNotMatch(get('card-list').innerHTML, /Kopi Ruang Pagi/);
  get('search').oninput({ target: { value: '' } });
  get('filter').onchange({ target: { value: 'pending' } });
  assert.match(get('card-list').innerHTML, /DEMO-103/);
  assert.match(get('card-list').innerHTML, />Aktivasi /);
  assert.doesNotMatch(get('card-list').innerHTML, />Kelola /);
  assert.doesNotMatch(get('card-list').innerHTML, /DEMO-101/);
  get('search').oninput({ target: { value: 'no-match' } });
  assert.match(get('card-list').innerHTML, /Tidak ada kartu/);
  get('demo-state').onchange({ target: { value: 'loading' } });
  assert.equal(get('view').attributes['aria-busy'], 'true');
  get('demo-state').onchange({ target: { value: 'empty' } });
  assert.match(get('view').innerHTML, /Belum ada kartu/);
  get('show-demo').onclick();
  get('demo-state').onchange({ target: { value: 'error' } });
  assert.match(get('view').innerHTML, /Data belum dapat dimuat/);
  get('retry').onclick();
  assert.match(get('view').innerHTML, /Aktivitas kartu/);
});

test('detail saves only synthetic session data and rejects untrusted URLs', async () => {
  const { get, storage } = boot({ page: 'detail', query: '?id=demo-101' });
  const submit = () => get('edit-form').handlers.submit({ preventDefault() {} });
  get('business-name').value = 'Nama contoh baru';
  get('review-url').value = 'https://www.google.com/maps';
  await submit();
  assert.equal(get('summary-name').textContent, 'Nama contoh baru');
  assert.match(get('save-message').textContent, /berhasil disimpan/);
  const saved = storage.get('rr-buyer-v2-synthetic-session');
  assert.ok(saved);
  get('business-name').value = 'Tidak boleh tersimpan';
  for (const url of ['https://google.com.evil.example/', 'javascript:alert(1)', 'https://user:pass@google.com/', 'http://google.com/']) {
    get('review-url').value = url;
    await submit();
    assert.match(get('save-message').className, /error/);
    assert.equal(storage.get('rr-buyer-v2-synthetic-session'), saved);
  }
  get('review-url').value = 'https://www.google.com/maps';
  get('simulate-failure').checked = true;
  await submit();
  assert.match(get('save-message').textContent, /belum disimpan/);
  assert.equal(get('summary-name').textContent, 'Nama contoh baru');
  assert.equal(get('save').disabled, false);
  const reloaded = boot({ storage });
  assert.match(reloaded.get('card-list').innerHTML, /Nama contoh baru/);
});

test('missing cards, pending cards, escaped content, blocked storage, and reset', async () => {
  assert.match(boot({ page: 'detail', query: '?id=missing' }).get('view').innerHTML, /Kartu tidak ditemukan/);
  assert.match(boot({ page: 'detail', query: '?id=demo-103' }).get('view').innerHTML, /tidak mengaktifkan kartu/);
  const storage = new Map([['rr-buyer-v2-synthetic-session', JSON.stringify({ 'demo-101': { name: '<img src=x onerror=alert(1)>', url: 'https://google.com/' } })]]);
  const escaped = boot({ storage });
  assert.match(escaped.get('card-list').innerHTML, /&lt;img/);
  assert.doesNotMatch(escaped.get('card-list').innerHTML, /<img/);
  escaped.get('reset-demo').onclick();
  assert.match(escaped.get('card-list').innerHTML, /Kopi Ruang Pagi/);
  assert.equal(storage.size, 0);
  const blocked = boot({ page: 'detail', blocked: true });
  await blocked.get('edit-form').handlers.submit({ preventDefault() {} });
  assert.match(blocked.get('save-message').textContent, /Penyimpanan sesi tidak tersedia/);
});
