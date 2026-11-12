import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('1. Asset Optimization: Logo file size and Static Caching Headers', () => {
  const logoBytes = fs.readFileSync(path.resolve('assets/rakyat-review-logo.png')).length;
  assert.ok(logoBytes < 30000, `Logo must be optimized under 30 KB (was 1,072,501 bytes), current: ${logoBytes} bytes`);

  const vercelJson = JSON.parse(fs.readFileSync(path.resolve('vercel.json'), 'utf8'));
  assert.ok(Array.isArray(vercelJson.headers), 'vercel.json must define static caching headers');
  const assetHeader = vercelJson.headers.find(h => h.source === '/assets/(.*)');
  assert.ok(assetHeader, 'vercel.json must have caching rule for /assets/(.*)');
  const cc = assetHeader.headers.find(k => k.key.toLowerCase() === 'cache-control');
  assert.ok(cc?.value?.includes('max-age=86400'), 'Cache-Control header specifies max-age=86400');
});

test('2. Backend Performance: Single-request Dashboard & Streamlined Analytics', () => {
  const buyerApi = fs.readFileSync(path.resolve('api/buyer.js'), 'utf8');

  // Single-request consolidated dashboard endpoint
  assert.ok(buyerApi.includes("action === 'dashboard'"), 'api/buyer.js must support action=dashboard');
  assert.ok(buyerApi.includes("Promise.all(["), 'api/buyer.js loads cards and analytics concurrently');

  // Streamlined analytics without redundant buyer_v2_list_cards
  assert.ok(buyerApi.includes("action === 'analytics'"), 'api/buyer.js handles action=analytics');
  assert.ok(buyerApi.includes("buyer_v2_analytics"), 'api/buyer.js calls buyer_v2_analytics');
  assert.ok(buyerApi.includes("total_cards === 0"), 'api/buyer.js verifies ownership via total_cards');
});

test('3. Frontend UX & Stability: DOM Shell Caching, Section Navigation & Error Handling', () => {
  const buyerJs = fs.readFileSync(path.resolve('assets/buyer.js'), 'utf8');
  const previewJs = fs.readFileSync(path.resolve('assets/buyer-preview.js'), 'utf8');
  const buyerCss = fs.readFileSync(path.resolve('assets/buyer.css'), 'utf8');

  // Shell DOM caching (prevents layout shift on state changes)
  assert.ok(buyerJs.includes('existingNav'), 'buyer.js preserves navigation shell across renders');
  assert.ok(previewJs.includes('existingNav'), 'buyer-preview.js preserves navigation shell across renders');

  // Smooth section navigation
  assert.ok(buyerJs.includes('#analytics-section'), 'buyer.js includes link to #analytics-section');
  assert.ok(buyerJs.includes('#card-section'), 'buyer.js includes link to #card-section');
  assert.ok(buyerJs.includes('scrollIntoView'), 'buyer.js provides smooth section navigation');

  // Friendly error handling
  assert.ok(buyerJs.includes('Coba Lagi'), 'buyer.js provides a "Coba Lagi" retry button');
  assert.ok(buyerJs.includes('navigator.onLine'), 'buyer.js detects offline/online status');
  assert.ok(buyerJs.includes('Koneksi internet Anda terputus'), 'buyer.js has friendly offline message');
  assert.ok(buyerJs.includes('Sesi akun Anda telah berakhir'), 'buyer.js has friendly session expiry message');

  // Mobile polish in CSS
  assert.ok(buyerCss.includes('#analytics-card-filter'), 'buyer.css specifies styles for #analytics-card-filter');
  assert.ok(buyerCss.includes('text-overflow: ellipsis'), 'buyer.css ensures select does not overflow on small screens');
});

test('4. Card Redirect: Fast server-side 302 without client hops', () => {
  const redirectJs = fs.readFileSync(path.resolve('api/card-redirect.js'), 'utf8');
  assert.ok(redirectJs.includes('resolve_and_record_card_scan'), 'Uses resolve_and_record_card_scan');
  assert.ok(redirectJs.includes("res.status(302)"), 'Direct HTTP 302 redirect');
  assert.ok(redirectJs.includes('Location'), 'Sets Location header for instant redirect');
});
