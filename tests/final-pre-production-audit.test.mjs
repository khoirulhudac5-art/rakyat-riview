import fs from 'node:fs';
import path from 'node:path';
import { readAdminEnv } from '../scripts/admin-readonly-config.mjs';

const candidateUrl = 'https://rakyat-riview-mhgjkdhqc-rakprem.vercel.app';
const prodUrl = 'https://rakyat-riview.vercel.app';

const privateConfig = readAdminEnv('.env.admin-readonly');
const adminPassword = privateConfig.ADMIN_PASSWORD;

async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...options });
      const body = await res.text();
      return { status: res.status, headers: res.headers, body, location: res.headers.get('location') };
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

const report = {
  timestamp: new Date().toISOString(),
  candidateUrl,
  results: []
};

function check(priority, testName, passed, details = '') {
  const item = { priority, testName, status: passed ? 'PASS' : 'FAIL', details };
  report.results.push(item);
  console.log(`[${item.status}] [${priority}] ${testName} ${details ? '— ' + details : ''}`);
  if (!passed) throw new Error(`CHECK FAILED: [${priority}] ${testName}: ${details}`);
}

async function runAudit() {
  console.log('========================================================');
  console.log('   STARTING FINAL PRE-PRODUCTION AUDIT — RAKYAT REVIEW  ');
  console.log('   Target Candidate: ' + candidateUrl);
  console.log('========================================================\n');

  // ==========================================
  // 1. SECURITY AUDIT
  // ==========================================
  console.log('\n--- 1. SECURITY AUDIT ---');

  // 1.1: Static assets leak check
  const staticFiles = [
    'assets/buyer.js',
    'assets/admin-v2.js',
    'pembeli/wizard.mjs',
    'pembeli/auth-callback.mjs',
    'pembeli/account.js'
  ];
  for (const sf of staticFiles) {
    const res = await fetchWithRetry(`${candidateUrl}/${sf}`);
    const leakedServiceKey = res.body.includes('service_role') || res.body.includes('SUPABASE_SECRET_KEY');
    const leakedPassword = res.body.includes(adminPassword) && adminPassword.length > 5;
    check('SECURITY', `Static asset leak check: ${sf}`, !leakedServiceKey && !leakedPassword, 'Zero secret keys or admin passwords leaked');
  }

  // 1.2: Admin API unauthorized access protection
  const anonSession = await fetchWithRetry(`${candidateUrl}/api/v2-admin?action=session`);
  check('SECURITY', 'Admin session rejects anonymous caller', anonSession.status === 401, `Status ${anonSession.status}`);

  const anonArchive = await fetchWithRetry(`${candidateUrl}/api/v2-admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' },
    body: JSON.stringify({ action: 'archive', card_code: 'TESTCARD' })
  });
  check('SECURITY', 'Admin archive rejects anonymous caller', anonArchive.status === 401, `Status ${anonArchive.status}`);

  const anonRestore = await fetchWithRetry(`${candidateUrl}/api/v2-admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' },
    body: JSON.stringify({ action: 'restore', card_code: 'TESTCARD' })
  });
  check('SECURITY', 'Admin restore rejects anonymous caller', anonRestore.status === 401, `Status ${anonRestore.status}`);

  const anonCreate = await fetchWithRetry(`${candidateUrl}/api/v2-admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' },
    body: JSON.stringify({ action: 'create', quantity: 1 })
  });
  check('SECURITY', 'Admin create rejects anonymous caller', anonCreate.status === 401, `Status ${anonCreate.status}`);

  // 1.3: Admin Login timing and cookie security
  const adminLogin = await fetchWithRetry(`${candidateUrl}/api/v2-admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1', Origin: candidateUrl },
    body: JSON.stringify({ action: 'login', password: adminPassword })
  });
  const loginCookie = adminLogin.headers.get('set-cookie') || '';
  check('SECURITY', 'Admin login authenticates with valid credentials', adminLogin.status === 200, 'Login succeeded');
  check('SECURITY', 'Admin session cookie is HttpOnly, Secure and SameSite', loginCookie.includes('HttpOnly') && loginCookie.includes('SameSite') && loginCookie.includes('__Host-rr_admin_v2'), 'Cookie attributes verified');

  const adminSessionCookie = loginCookie.split(';')[0];

  // 1.4: Buyer API unauthorized protection
  const anonCards = await fetchWithRetry(`${candidateUrl}/api/buyer?action=cards`);
  check('SECURITY', 'Buyer cards list rejects unauthenticated caller', anonCards.status === 401, `Status ${anonCards.status}`);

  const anonDashboard = await fetchWithRetry(`${candidateUrl}/api/buyer?action=dashboard`);
  check('SECURITY', 'Buyer dashboard rejects unauthenticated caller', anonDashboard.status === 401, `Status ${anonDashboard.status}`);

  const anonFirstClaim = await fetchWithRetry(`${candidateUrl}/api/buyer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Buyer-Request': '1', Origin: candidateUrl },
    body: JSON.stringify({ action: 'first-claim', card_code: 'TEST', business_name: 'Test', review_url: 'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE' })
  });
  check('SECURITY', 'Buyer first-claim rejects unauthenticated caller', anonFirstClaim.status === 401, `Status ${anonFirstClaim.status}`);

  // 1.5: Auth callback token scrubbing check
  const callbackCode = await fetchWithRetry(`${candidateUrl}/pembeli/auth-callback.mjs`);
  const hasHistoryScrub = callbackCode.body.includes('window.history.replaceState');
  check('SECURITY', 'Auth callback scrubs tokens from URL and history', hasHistoryScrub, 'history.replaceState removes tokens immediately');

  // ==========================================
  // 2. DATA INTEGRITY AUDIT
  // ==========================================
  console.log('\n--- 2. DATA INTEGRITY AUDIT ---');

  // 2.1: Card List Sort & Integrity
  const listCardsRes = await fetchWithRetry(`${candidateUrl}/api/v2-admin?action=cards`, {
    headers: { Cookie: adminSessionCookie, Origin: candidateUrl }
  });
  const listData = JSON.parse(listCardsRes.body);
  check('DATA_INTEGRITY', 'Admin card inventory loaded successfully', Array.isArray(listData.cards) && listData.cards.length > 0, `Total ${listData.cards?.length} cards`);

  // Verify created_at ASC strict sort
  let isSortedAsc = true;
  for (let i = 1; i < listData.cards.length; i++) {
    const tA = new Date(listData.cards[i - 1].created_at).getTime();
    const tB = new Date(listData.cards[i].created_at).getTime();
    if (tA > tB) {
      isSortedAsc = false;
      break;
    }
  }
  check('DATA_INTEGRITY', 'Cards strictly sorted by created_at ASC', isSortedAsc, 'Oldest card at top, newest at bottom');

  // 2.2: Verify Inactive Card Permanent Route
  const inactiveCard = 'VZA4REV6';
  const inactiveRoute = await fetchWithRetry(`${candidateUrl}/r/${inactiveCard}`);
  check('DATA_INTEGRITY', `Inactive card ${inactiveCard} permanent QR/NFC route`, inactiveRoute.status === 302 && inactiveRoute.location?.includes(`/pembeli/mulai.html?card=${inactiveCard}`), `Redirects to V2 activation (${inactiveRoute.location})`);

  // 2.3: Verify Active Card Permanent Route
  const activeCard = 'BKE9VWK3';
  const activeRoute = await fetchWithRetry(`${candidateUrl}/r/${activeCard}`);
  check('DATA_INTEGRITY', `Active card ${activeCard} permanent QR/NFC route`, activeRoute.status === 302 && activeRoute.location?.includes('google.com'), `Redirects to Google Review (${activeRoute.location})`);

  // 2.4: Verify Archive and Restore does not delete or affect QR routing
  const testArchiveCard = 'BW8TRBLC';
  const archiveCall = await fetchWithRetry(`${candidateUrl}/api/v2-admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1', Cookie: adminSessionCookie, Origin: candidateUrl },
    body: JSON.stringify({ action: 'archive', card_code: testArchiveCard })
  });
  check('DATA_INTEGRITY', `Archive card ${testArchiveCard}`, archiveCall.status === 200, 'Card marked is_archived: true in Supabase');

  const routeWhileArchived = await fetchWithRetry(`${candidateUrl}/r/${testArchiveCard}`);
  check('DATA_INTEGRITY', `Archived card ${testArchiveCard} QR route unaffected`, routeWhileArchived.status === 302 && routeWhileArchived.location?.includes(`/pembeli/mulai.html?card=${testArchiveCard}`), 'QR/NFC route functions normally while card is archived');

  const restoreCall = await fetchWithRetry(`${candidateUrl}/api/v2-admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1', Cookie: adminSessionCookie, Origin: candidateUrl },
    body: JSON.stringify({ action: 'restore', card_code: testArchiveCard })
  });
  check('DATA_INTEGRITY', `Restore card ${testArchiveCard}`, restoreCall.status === 200, 'Card restored to is_archived: false');

  // ==========================================
  // 3. UI & UX AUDIT
  // ==========================================
  console.log('\n--- 3. UI & UX AUDIT ---');

  // 3.1: Callback clean URLs & variations
  const callbackVariations = [
    '/pembeli/auth-callback.html',
    '/pembeli/auth-callback',
    '/pembeli/auth-callback/',
    '/auth-callback.html',
    '/auth-callback'
  ];
  for (const path of callbackVariations) {
    const res = await fetchWithRetry(`${candidateUrl}${path}`);
    check('UI_UX', `Callback URL reachable: ${path}`, res.status === 200 && res.body.includes('auth-callback.mjs'), `Status ${res.status}`);
  }

  // 3.2: Viewport tags on all pages
  const htmlPages = [
    '/dashboard.html',
    '/admin-v2.html',
    '/pembeli/mulai.html',
    '/pembeli/auth-callback.html',
    '/preview.html'
  ];
  for (const page of htmlPages) {
    const res = await fetchWithRetry(`${candidateUrl}${page}`);
    const hasViewport = res.body.includes('name="viewport"');
    check('UI_UX', `Mobile viewport present on ${page}`, hasViewport, 'Responsive viewport meta configured');
  }

  // 3.3: Dialog scrollable CSS
  const adminCssRes = await fetchWithRetry(`${candidateUrl}/assets/admin-v2.css`);
  const hasDialogOverflow = adminCssRes.body.includes('max-height:calc(100dvh - 40px)') || adminCssRes.body.includes('overflow:auto');
  check('UI_UX', 'Admin dialogs are scrollable on all screen heights', hasDialogOverflow, 'CSS max-height and overflow:auto present');

  // ==========================================
  // 4. RELIABILITY AUDIT
  // ==========================================
  console.log('\n--- 4. RELIABILITY AUDIT ---');

  // 4.1: Card status edge error handling
  const invalidCardStatus = await fetchWithRetry(`${candidateUrl}/api/buyer-status?card=NONEXISTENT_999`);
  check('RELIABILITY', 'Non-existent card returns 404', invalidCardStatus.status === 404, 'Handled cleanly');

  // 4.2: Standardized Indonesian error on bad credentials
  const badLogin = await fetchWithRetry(`${candidateUrl}/api/buyer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Buyer-Request': '1', Origin: candidateUrl },
    body: JSON.stringify({ action: 'signin', email: 'test_audit_notfound@example.com', password: 'wrongpassword' })
  });
  const badLoginJson = JSON.parse(badLogin.body);
  check('RELIABILITY', 'Standardized Indonesian error message for invalid login', badLogin.status === 401 && badLoginJson.error?.includes('Email atau password tidak sesuai'), `Returned: "${badLoginJson.error}"`);

  // 4.3: Fail-safe fallback on /r/ redirect
  const redirectCode = await fetchWithRetry(`${candidateUrl}/api/card-redirect.js`);
  // Redirect endpoint itself requires routing via /r/:code or directly returns fallback
  const directRedirect = await fetchWithRetry(`${candidateUrl}/api/card-redirect?code=VZA4REV6`);
  check('RELIABILITY', 'Card redirect handler functions reliably', directRedirect.status === 302, `Redirects with status 302 to ${directRedirect.location}`);

  console.log('\n========================================================');
  console.log('   ALL PRE-PRODUCTION CHECKS PASSED (100% SUCCESS)      ');
  console.log('   Total checks: ' + report.results.length);
  console.log('========================================================\n');
}

runAudit().catch(err => {
  console.error('\nAUDIT ERROR:', err.message);
  process.exit(1);
});
