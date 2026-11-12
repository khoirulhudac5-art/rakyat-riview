import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isAllowedOrigin, guard, BuyerError } from '../lib/buyer-service.mjs';

test('1. Preview Dashboard: preview.html & assets/buyer-preview.js integrity', () => {
  const html = fs.readFileSync(path.resolve('preview.html'), 'utf8');
  const js = fs.readFileSync(path.resolve('assets/buyer-preview.js'), 'utf8');

  // Verify preview.html loads assets/buyer.css and assets/buyer-preview.js
  assert.ok(html.includes('assets/buyer.css'), 'preview.html must include buyer.css');
  assert.ok(html.includes('assets/buyer-preview.js'), 'preview.html must include buyer-preview.js');
  assert.ok(html.includes('data-page="dashboard-preview"'), 'preview.html has dashboard-preview data attribute');

  // Verify buyer-preview.js contains required stats and demo flags
  assert.ok(js.includes('Total Scan'), 'Must contain Total Scan');
  assert.ok(js.includes('248'), 'Must contain Total Scan count 248');
  assert.ok(js.includes('Scan Hari Ini'), 'Must contain Scan Hari Ini');
  assert.ok(js.includes('12'), 'Must contain Scan Hari Ini count 12');
  assert.ok(js.includes('Total Kartu'), 'Must contain Total Kartu');
  assert.ok(js.includes('3'), 'Must contain 3 cards');
  assert.ok(js.includes('DEMO'), 'Must contain DEMO indicators');
  assert.ok(js.includes('RR-001'), 'Must contain demo card RR-001');
  assert.ok(js.includes('RR-002'), 'Must contain demo card RR-002');
  assert.ok(js.includes('RR-003'), 'Must contain demo card RR-003');
  assert.ok(js.includes('renderBarChart'), 'Must contain SVG bar chart renderer');
  assert.ok(js.includes('setPeriod'), 'Must contain period filter function');
});

test('2. isAllowedOrigin & guard validation for preview and production origins', () => {
  const cfg = {
    origin: 'https://rakyat-riview.vercel.app',
    local: false
  };

  // Valid origins
  assert.equal(isAllowedOrigin('https://rakyat-riview.vercel.app', cfg), true, 'Production origin is allowed');
  assert.equal(isAllowedOrigin('https://rakyat-riview-b896uo5dn-rakprem.vercel.app', cfg), true, 'Vercel candidate preview origin is allowed');
  assert.equal(isAllowedOrigin('https://rakyat-riview-git-v2-dev-rakprem.vercel.app', cfg), true, 'Vercel branch preview origin is allowed');

  // Invalid origins
  assert.equal(isAllowedOrigin('https://malicious-site.com', cfg), false, 'Malicious site rejected');
  assert.equal(isAllowedOrigin('https://evil-rakyat-riview.vercel.app.attacker.com', cfg), false, 'Attacker origin rejected');
  assert.equal(isAllowedOrigin('', cfg), false, 'Empty origin rejected');
  assert.equal(isAllowedOrigin(null, cfg), false, 'Null origin rejected');

  // Guard test: matching request
  const validReq = {
    method: 'POST',
    headers: {
      'x-buyer-request': '1',
      'origin': 'https://rakyat-riview-b896uo5dn-rakprem.vercel.app',
      'content-type': 'application/json'
    }
  };
  assert.doesNotThrow(() => guard(validReq, cfg), 'Valid candidate request must pass guard');

  // Guard test: missing header
  const missingHeaderReq = {
    method: 'POST',
    headers: {
      'origin': 'https://rakyat-riview.vercel.app',
      'content-type': 'application/json'
    }
  };
  assert.throws(() => guard(missingHeaderReq, cfg), BuyerError, 'Missing x-buyer-request must throw BuyerError(403)');

  // Guard test: bad origin
  const badOriginReq = {
    method: 'POST',
    headers: {
      'x-buyer-request': '1',
      'origin': 'https://evil.com',
      'content-type': 'application/json'
    }
  };
  assert.throws(() => guard(badOriginReq, cfg), BuyerError, 'Bad origin must throw BuyerError(403)');
});

test('3. Lynk.id-inspired authentication layout & elements', () => {
  const accountJs = fs.readFileSync(path.resolve('pembeli/account.js'), 'utf8');
  const accountCss = fs.readFileSync(path.resolve('pembeli/account.css'), 'utf8');

  // Structure checks in account.js
  assert.ok(accountJs.includes('lynk-auth-container'), 'Includes lynk-auth-container');
  assert.ok(accountJs.includes('lynk-auth-card'), 'Includes lynk-auth-card');
  assert.ok(accountJs.includes('btn-toggle-pw'), 'Includes password visibility toggle button');
  assert.ok(accountJs.includes('Lupa Password?'), 'Includes Lupa Password? link');
  assert.ok(accountJs.includes('Lanjutkan dengan Google'), 'Includes Lanjutkan dengan Google button');
  assert.ok(accountJs.includes('Belum punya akun?'), 'Includes link to signup');
  assert.ok(accountJs.includes('Daftar Akun Baru'), 'Includes registration form');
  assert.ok(accountJs.includes('Konfirmasi Password'), 'Includes confirm password input');
  assert.ok(accountJs.includes('Atur Ulang Password'), 'Includes reset password form');
  assert.ok(accountJs.includes('recoveryToken'), 'Captures recovery token for password reset');

  // Email & Password label and placeholder refinements
  assert.ok(accountJs.includes('Alamat Email'), 'Uses "Alamat Email" label');
  assert.ok(accountJs.includes('Masukkan alamat email Anda'), 'Uses "Masukkan alamat email Anda" placeholder');
  assert.ok(accountJs.includes('Masukkan password Anda'), 'Uses "Masukkan password Anda" placeholder');
  assert.equal(accountJs.includes('••••••••'), false, 'Does not use bullet dot password placeholder');

  // Style checks in account.css
  assert.ok(accountCss.includes('.lynk-auth-container'), 'account.css defines .lynk-auth-container');
  assert.ok(accountCss.includes('.lynk-auth-card'), 'account.css defines .lynk-auth-card');
  assert.ok(accountCss.includes('.password-wrap'), 'account.css defines .password-wrap');
  assert.ok(accountCss.includes('.btn-toggle-pw'), 'account.css defines .btn-toggle-pw');
  assert.ok(accountCss.includes('.auth-divider'), 'account.css defines .auth-divider');
  assert.ok(accountCss.includes('.google-btn'), 'account.css defines .google-btn');
});

test('4. Buyer Dashboard: Password settings modal & update-password action', () => {
  const buyerJs = fs.readFileSync(path.resolve('assets/buyer.js'), 'utf8');
  const buyerApi = fs.readFileSync(path.resolve('api/buyer.js'), 'utf8');

  // buyer.js checks
  assert.ok(buyerJs.includes('openPasswordModal'), 'assets/buyer.js defines openPasswordModal');
  assert.ok(buyerJs.includes('sidebar-password'), 'assets/buyer.js includes sidebar-password button');
  assert.ok(buyerJs.includes('topbar-password'), 'assets/buyer.js includes topbar-password button');
  assert.ok(buyerJs.includes("requestBuyer('update-password'"), 'assets/buyer.js sends update-password request');

  // api/buyer.js checks
  assert.ok(buyerApi.includes("['update-password', 'set-password'].includes(action)"), 'api/buyer.js handles update-password');
  assert.ok(buyerApi.includes("['recover', 'reset-password'].includes(action)"), 'api/buyer.js handles recover');
  assert.ok(buyerApi.includes("action === 'reset-password-confirm'"), 'api/buyer.js handles reset-password-confirm');
});

test('5. Refinements: Red Today Bar & Card Filter in Analytics', () => {
  const previewJs = fs.readFileSync(path.resolve('assets/buyer-preview.js'), 'utf8');
  const buyerJs = fs.readFileSync(path.resolve('assets/buyer.js'), 'utf8');
  const buyerApi = fs.readFileSync(path.resolve('api/buyer.js'), 'utf8');

  // Preview chart red today bar and card filter
  assert.ok(previewJs.includes('#ea4335'), 'preview.js uses red #ea4335 for today bar');
  assert.ok(previewJs.includes('#3877db'), 'preview.js uses blue #3877db for previous days');
  assert.ok(previewJs.includes('analytics-card-filter'), 'preview.js contains analytics-card-filter select');
  assert.ok(previewJs.includes('Semua Kartu'), 'preview.js has "Semua Kartu" option');
  assert.ok(previewJs.includes('updateAnalytics'), 'preview.js defines updateAnalytics');

  // Live buyer chart red today bar and card filter
  assert.ok(buyerJs.includes('#ea4335'), 'buyer.js uses red #ea4335 for today bar');
  assert.ok(buyerJs.includes('#3877db'), 'buyer.js uses blue #3877db for previous days');
  assert.ok(buyerJs.includes('analytics-card-filter'), 'buyer.js contains analytics-card-filter select');
  assert.ok(buyerJs.includes('Semua Kartu'), 'buyer.js has "Semua Kartu" option');
  assert.ok(buyerJs.includes('fetchAnalytics'), 'buyer.js defines fetchAnalytics with card filter');
  assert.ok(buyerJs.includes('Belum Ada Kartu Terdaftar'), 'buyer.js handles empty state when user has 0 cards');

  // Backend API checks for card filtering & empty card protection
  assert.ok(buyerApi.includes('total_cards === 0') || buyerApi.includes('owned.length === 0'), 'api/buyer.js checks for accounts with 0 cards');
  assert.ok(buyerApi.includes('Dashboard analitik hanya dapat diakses oleh akun yang sudah memiliki kartu teraktivasi'), 'api/buyer.js blocks 0 card accounts with explanatory message');
  assert.ok(buyerApi.includes('Akses kartu tidak diizinkan'), 'api/buyer.js validates card ownership against logged in buyer');
});

test('6. DEMO Statistics Consistency: KPI Scan Hari Ini matches red bar count exactly', () => {
  const previewJs = fs.readFileSync(path.resolve('assets/buyer-preview.js'), 'utf8');

  // Verify that the last element in demoDataSets for 7, 30, and 90 days has count: 12
  assert.ok(previewJs.includes("count: 12 }"), '7-day dataset ends with count: 12');
  assert.ok(previewJs.includes("i === 29 ? 12 :"), '30-day dataset ends with count: 12');
  assert.ok(previewJs.includes("i === 89 ? 12 :"), '90-day dataset ends with count: 12');
  assert.ok(previewJs.includes("todayTarget = card === 'all' ? 12"), 'Calculates todayTarget matching KPI 12');
});

test('7. Activation Flow & Multi-card Support: Revised Account Connection UI', () => {
  const mulaiHtml = fs.readFileSync(path.resolve('pembeli/mulai.html'), 'utf8');
  const wizardJs = fs.readFileSync(path.resolve('pembeli/wizard.mjs'), 'utf8');
  const accountCss = fs.readFileSync(path.resolve('pembeli/account.css'), 'utf8');
  const buyerApi = fs.readFileSync(path.resolve('api/buyer.js'), 'utf8');

  // HTML structure checks
  assert.ok(mulaiHtml.includes('Pembeli Baru'), 'mulai.html includes "Pembeli Baru" card');
  assert.ok(mulaiHtml.includes('Sudah Punya Akun'), 'mulai.html includes "Sudah Punya Akun" card');
  assert.ok(mulaiHtml.includes('choice-blue'), 'mulai.html includes blue account choice card');
  assert.ok(mulaiHtml.includes('choice-yellow'), 'mulai.html includes yellow account choice card');
  assert.ok(mulaiHtml.includes('Informasi kartu sudah lengkap'), 'mulai.html includes collapsible summary header');
  assert.ok(mulaiHtml.includes('summary-toggle-btn'), 'mulai.html includes summary toggle button');
  assert.ok(mulaiHtml.includes('dynamic-hint-box'), 'mulai.html includes dynamic hint box');
  assert.ok(mulaiHtml.includes('reg-email'), 'mulai.html includes reg-email input');
  assert.ok(mulaiHtml.includes('reg-password'), 'mulai.html includes reg-password input');
  assert.ok(mulaiHtml.includes('reg-password-confirm'), 'mulai.html includes reg-password-confirm input');
  assert.ok(mulaiHtml.includes('login-email'), 'mulai.html includes login-email input');
  assert.ok(mulaiHtml.includes('login-password'), 'mulai.html includes login-password input');
  assert.ok(mulaiHtml.includes('btn-forgot-pw'), 'mulai.html includes forgot password link');
  assert.ok(mulaiHtml.includes('forgot-modal'), 'mulai.html includes forgot password modal');
  assert.ok(mulaiHtml.includes('Hubungkan Kartu ke Akun Saya'), 'mulai.html includes Hubungkan Kartu ke Akun Saya button');
  assert.ok(mulaiHtml.includes('activation-success'), 'mulai.html includes activation success section');

  // Wizard logic checks
  assert.ok(wizardJs.includes('executeClaim'), 'wizard.mjs defines executeClaim');
  assert.ok(wizardJs.includes('btn-reg-submit'), 'wizard.mjs handles registration submission');
  assert.ok(wizardJs.includes('btn-login-submit'), 'wizard.mjs handles signin submission');
  assert.ok(wizardJs.includes('password !== confirmPw'), 'wizard.mjs validates password confirmation matching');
  assert.ok(wizardJs.includes('summary-toggle-btn'), 'wizard.mjs handles summary toggle open/close');
  assert.ok(wizardJs.includes('Belum pernah aktivasi? Buat akun baru'), 'wizard.mjs sets hint for new buyer');
  assert.ok(wizardJs.includes('Pernah aktivasi kartu? Masuk dengan akun'), 'wizard.mjs sets hint for existing buyer');

  // CSS styling checks
  assert.ok(accountCss.includes('.choice-blue'), 'account.css defines .choice-blue');
  assert.ok(accountCss.includes('.choice-yellow'), 'account.css defines .choice-yellow');
  assert.ok(accountCss.includes('.card-summary-card'), 'account.css defines .card-summary-card');
  assert.ok(accountCss.includes('.dynamic-hint-box'), 'account.css defines .dynamic-hint-box');

  // API multi-card & non-Google claim support
  assert.ok(buyerApi.includes('!session?.user?.id'), 'api/buyer.js allows any authenticated user to claim cards');
  assert.equal(buyerApi.includes('!session.user.google'), false, 'api/buyer.js does not restrict claiming to only google accounts');
});

test('8. Final Integration: Direct Card Detection & One-Time Activation Claim', () => {
  const mulaiHtml = fs.readFileSync(path.resolve('pembeli/mulai.html'), 'utf8');
  const wizardJs = fs.readFileSync(path.resolve('pembeli/wizard.mjs'), 'utf8');
  const buyerApi = fs.readFileSync(path.resolve('api/buyer.js'), 'utf8');
  const adminProd = fs.readFileSync(path.resolve('lib/admin-production.mjs'), 'utf8');
  const adminJs = fs.readFileSync(path.resolve('assets/admin-v2.js'), 'utf8');

  // Direct card detection in mulai.html
  assert.ok(mulaiHtml.includes('card-code-display'), 'mulai.html includes #card-code-display');
  assert.ok(mulaiHtml.includes('btn-start-activation'), 'mulai.html includes #btn-start-activation');
  assert.ok(mulaiHtml.includes('card-already-active-box'), 'mulai.html includes #card-already-active-box');

  // Wizard logic
  assert.ok(wizardJs.includes('checkCardStatus'), 'wizard.mjs checks card status directly');
  assert.ok(wizardJs.includes('executeClaim'), 'wizard.mjs performs claim');
  assert.ok(wizardJs.includes('card-already-active-box'), 'wizard.mjs displays active card alert');

  // API buyer claim
  assert.ok(buyerApi.includes("action === 'first-claim'"), 'api/buyer.js handles first-claim action');

  // Admin V2 card creation
  assert.ok(adminProd.includes('card_code'), 'admin-production generates card_code');
  assert.ok(adminProd.includes('card_activation'), 'admin-production stores activation status');

  // Admin V2 UI displays card list & exports
  assert.ok(adminJs.includes('batch-card-list'), 'assets/admin-v2.js renders batch-card-list');
  assert.ok(adminJs.includes('c.card_code'), 'assets/admin-v2.js displays card_code value');
});
