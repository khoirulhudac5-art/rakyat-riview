import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readAdminEnv } from './admin-readonly-config.mjs';

const candidateId = 'dpl_4V8MDojBf1gFG27Zz69wmkgP6cBD';
const baselineId = 'dpl_83V3fRAtHEBSenc7eFBYkTCwXtcF';
const scope = 'rakprem';
const prodOrigin = 'https://rakyat-riview.vercel.app';
const binary = path.resolve('.local-tools/npm-cache/_npx/69f9afb961c37556/node_modules/vercel/dist/vc.js');

const privateConfig = readAdminEnv('.env.admin-readonly');
if (!privateConfig.ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD not found in .env.admin-readonly');
}

const evidenceFolder = path.resolve('.backups/final-production-promotion-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(evidenceFolder, { recursive: true });

const logFile = path.join(evidenceFolder, 'FINAL_PROMOTION_AUDIT.json');
const audit = {
  timestamp: new Date().toISOString(),
  candidateId,
  baselineId,
  scope,
  prodOrigin,
  status: 'STARTING',
  steps: []
};

function record(step, data) {
  console.log(`[${step}]`, typeof data === 'string' ? data : JSON.stringify(data));
  audit.steps.push({ step, time: new Date().toISOString(), data });
  fs.writeFileSync(logFile, JSON.stringify(audit, null, 2));
}

async function cli(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => {
      done = true;
      child.kill();
      reject(new Error(`CLI timeout after ${timeout}ms: ${args.join(' ')}`));
    }, timeout);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`CLI error (${code}): ${err || out}`));
    });
  });
}

async function api(endpoint) {
  const raw = await cli(['api', endpoint, '--scope', scope]);
  try { return JSON.parse(raw); } catch { throw new Error('API non-JSON: ' + raw.slice(0, 200)); }
}

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

async function rollback(reason) {
  console.error('\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.error('CRITICAL: INITIATING AUTOMATIC ROLLBACK TO BASELINE!');
  console.error('Reason:', reason);
  console.error('Baseline ID:', baselineId);
  console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n');
  audit.status = 'ROLLING_BACK';
  audit.rollbackReason = reason;
  fs.writeFileSync(logFile, JSON.stringify(audit, null, 2));

  try {
    const rollRes = await cli(['promote', baselineId, '--scope', scope, '--yes']);
    console.log('Rollback promote output:', rollRes);
    await new Promise(r => setTimeout(r, 5000));
    const active = await api('/v13/deployments/rakyat-riview.vercel.app');
    console.log('Active deployment after rollback:', active.id);
    audit.status = 'ROLLED_BACK';
    audit.activeAfterRollback = active.id;
  } catch (err) {
    console.error('CRITICAL ROLLBACK FAILURE:', err);
    audit.status = 'ROLLBACK_FAILED';
    audit.rollbackError = err.message;
  }
  fs.writeFileSync(logFile, JSON.stringify(audit, null, 2));
  process.exit(1);
}

async function main() {
  console.log('========================================================');
  console.log('   RAKYAT REVIEW V2 — FINAL PRODUCTION PROMOTION       ');
  console.log('   Candidate to promote: ' + candidateId);
  console.log('   Rollback baseline: ' + baselineId);
  console.log('========================================================\n');

  // STEP 1: Verify Current Active Production Baseline
  record('1_CHECK_BASELINE', 'Verifying current production baseline...');
  const currentProd = await api('/v13/deployments/rakyat-riview.vercel.app');
  record('1_BASELINE_RESULT', { activeId: currentProd.id, readyState: currentProd.readyState });
  if (currentProd.id !== baselineId) {
    throw new Error(`Production baseline mismatch: expected ${baselineId}, got ${currentProd.id}`);
  }

  // STEP 2: Save Rollback Point
  record('2_SAVE_ROLLBACK_POINT', {
    target: baselineId,
    verifiedAt: new Date().toISOString(),
    rollbackScript: `vc promote ${baselineId} --scope ${scope} --yes`
  });
  fs.writeFileSync(path.join(evidenceFolder, 'ROLLBACK_POINT.json'), JSON.stringify({
    rollbackDeploymentId: baselineId,
    timestamp: new Date().toISOString(),
    productionUrl: prodOrigin
  }, null, 2));

  // STEP 3: Verify Candidate is Ready
  record('3_VERIFY_CANDIDATE', `Checking candidate ${candidateId}...`);
  const candMeta = await api(`/v13/deployments/${candidateId}`);
  record('3_CANDIDATE_META', { id: candMeta.id, readyState: candMeta.readyState, url: candMeta.url });
  if (candMeta.readyState !== 'READY') {
    throw new Error(`Candidate ${candidateId} is not READY (state: ${candMeta.readyState})`);
  }

  // STEP 4: Promote Candidate to Production
  record('4_PROMOTING_CANDIDATE', `Promoting ${candidateId} to production domain...`);
  audit.status = 'PROMOTING';
  const promoteOut = await cli(['promote', candidateId, '--scope', scope, '--yes']);
  record('4_PROMOTE_OUTPUT', promoteOut);

  // Wait for edge propagation
  record('4_EDGE_PROPAGATION', 'Waiting 10s for edge cache and DNS routing...');
  await new Promise(r => setTimeout(r, 10000));

  // STEP 5: Verify Active Production Deployment ID
  record('5_VERIFY_ACTIVE', 'Verifying production domain deployment ID...');
  const newProd = await api('/v13/deployments/rakyat-riview.vercel.app');
  record('5_ACTIVE_RESULT', { activeId: newProd.id, readyState: newProd.readyState });
  if (newProd.id !== candidateId) {
    await rollback(`Production domain not serving candidate: expected ${candidateId}, got ${newProd.id}`);
  }

  console.log('\n>>> Production domain is now LIVE on deployment: ' + newProd.id);
  console.log('>>> Commencing comprehensive post-deployment verification...\n');

  // STEP 6: Post-Deploy Verification on Production

  // 6.1: Verify All Callback Routes (Clean URLs & Aliases)
  record('6_1_CALLBACK_ROUTES_TEST', 'Testing all callback route variations on production...');
  const callbackPaths = [
    '/pembeli/auth-callback.html',
    '/pembeli/auth-callback',
    '/pembeli/auth-callback/',
    '/auth-callback.html',
    '/auth-callback'
  ];
  for (const cp of callbackPaths) {
    const res = await fetchWithRetry(`${prodOrigin}${cp}`);
    record(`6_1_PATH_${cp}`, { status: res.status });
    if (res.status !== 200 || !res.body.includes('auth-callback.mjs')) {
      await rollback(`Callback path ${cp} failed on production! Status ${res.status}`);
    }
  }

  // 6.2: Verify Inactive Cards VZA4REV6 & TCXEEY8E
  record('6_2_INACTIVE_CARDS_TEST', 'Verifying inactive cards VZA4REV6 and TCXEEY8E...');
  const inactiveCards = ['VZA4REV6', 'TCXEEY8E'];
  for (const code of inactiveCards) {
    const statusRes = await fetchWithRetry(`${prodOrigin}/api/buyer-status?card=${code}`);
    let sBody = {};
    try { sBody = JSON.parse(statusRes.body); } catch {}
    record(`6_2_STATUS_${code}`, { status: statusRes.status, body: sBody });
    if (statusRes.status !== 200 || sBody.code !== code || sBody.claim_allowed !== true || sBody.activation_state !== 'inactive') {
      await rollback(`Inactive card ${code} status unexpected: ${statusRes.body}`);
    }

    const routeRes = await fetchWithRetry(`${prodOrigin}/r/${code}`);
    record(`6_2_ROUTE_${code}`, { status: routeRes.status, location: routeRes.location });
    if (routeRes.status !== 302 || !routeRes.location?.includes(`/pembeli/mulai.html?card=${code}`)) {
      await rollback(`Card ${code} redirect failed: ${routeRes.location}`);
    }
  }

  // 6.3: Verify Active Cards 5STKUQUN & BKE9VWK3
  record('6_3_ACTIVE_CARDS_TEST', 'Testing active cards 5STKUQUN and BKE9VWK3 on production...');
  const activeCards = ['5STKUQUN', 'BKE9VWK3'];
  for (const code of activeCards) {
    const actStatus = await fetchWithRetry(`${prodOrigin}/api/buyer-status?card=${code}`);
    let aBody = {};
    try { aBody = JSON.parse(actStatus.body); } catch {}
    record(`6_3_STATUS_${code}`, { status: actStatus.status, body: aBody });
    if (actStatus.status !== 200 || aBody.activation_state !== 'active' || aBody.claim_allowed !== false) {
      await rollback(`Active card ${code} status check failed: ${actStatus.body}`);
    }

    const actRedirect = await fetchWithRetry(`${prodOrigin}/r/${code}`);
    record(`6_3_REDIRECT_${code}`, { status: actRedirect.status, location: actRedirect.location });
    if (actRedirect.status !== 302 || !actRedirect.location?.includes('google.com')) {
      await rollback(`Active card ${code} did not redirect to Google Review! Location: ${actRedirect.location}`);
    }
  }

  // 6.4: Admin V2 Login & Operations
  record('6_4_ADMIN_TEST', 'Testing Admin V2 on production...');
  const adminPageRes = await fetchWithRetry(`${prodOrigin}/admin-v2.html`);
  if (adminPageRes.status !== 200) await rollback('admin-v2.html failed to load');

  const adminSessionAnon = await fetchWithRetry(`${prodOrigin}/api/v2-admin?action=session`);
  if (adminSessionAnon.status !== 401) {
    await rollback(`Admin anonymous session expected 401, got ${adminSessionAnon.status}`);
  }

  const adminLoginRes = await fetchWithRetry(`${prodOrigin}/api/v2-admin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Request': '1',
      Origin: prodOrigin
    },
    body: JSON.stringify({ action: 'login', password: privateConfig.ADMIN_PASSWORD })
  });
  let loginData = {};
  try { loginData = JSON.parse(adminLoginRes.body); } catch {}
  record('6_4_ADMIN_LOGIN', { status: adminLoginRes.status, success: loginData.success });
  if (adminLoginRes.status !== 200 || loginData.success !== true) {
    await rollback('Admin login failed on production: ' + JSON.stringify(loginData));
  }

  const setCookie = adminLoginRes.headers.get('set-cookie');
  if (!setCookie) await rollback('Admin login did not return session cookie');
  const sessionCookie = setCookie.split(';')[0];

  // Verify list cards and created_at ASC sort order
  const listRes = await fetchWithRetry(`${prodOrigin}/api/v2-admin?action=cards`, {
    headers: { Cookie: sessionCookie, Origin: prodOrigin }
  });
  let listData = {};
  try { listData = JSON.parse(listRes.body); } catch {}
  record('6_4_CARDS_LIST', { status: listRes.status, totalCards: listData.cards?.length });
  if (listRes.status !== 200 || !Array.isArray(listData.cards) || listData.cards.length === 0) {
    await rollback('Failed to list cards on production Admin');
  }

  for (let i = 1; i < listData.cards.length; i++) {
    const prev = new Date(listData.cards[i - 1].created_at).getTime();
    const curr = new Date(listData.cards[i].created_at).getTime();
    if (prev > curr) {
      await rollback(`Cards not sorted by created_at ASC on production! Card ${listData.cards[i-1].card_code} > ${listData.cards[i].card_code}`);
    }
  }

  // 6.5: Archive and Restore on Production
  record('6_5_ARCHIVE_RESTORE_TEST', 'Testing Archive and Restore on production...');
  const testArchiveCode = 'BW8TRBLC';
  const archiveRes = await fetchWithRetry(`${prodOrigin}/api/v2-admin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Request': '1',
      Cookie: sessionCookie,
      Origin: prodOrigin
    },
    body: JSON.stringify({ action: 'archive', card_code: testArchiveCode })
  });
  let archiveData = {};
  try { archiveData = JSON.parse(archiveRes.body); } catch {}
  record('6_5_ARCHIVE_RESULT', { status: archiveRes.status, success: archiveData.success });
  if (archiveRes.status !== 200 || archiveData.success !== true) {
    await rollback('Failed to archive card on production: ' + JSON.stringify(archiveData));
  }

  // Verify card has is_archived: true
  const listCheck1 = await fetchWithRetry(`${prodOrigin}/api/v2-admin?action=cards`, {
    headers: { Cookie: sessionCookie, Origin: prodOrigin }
  });
  const listCheck1Data = JSON.parse(listCheck1.body);
  const archivedCard = listCheck1Data.cards.find(c => c.card_code === testArchiveCode);
  if (!archivedCard || archivedCard.is_archived !== true) {
    await rollback(`Card ${testArchiveCode} not marked as archived in production list!`);
  }

  // Verify QR routing still functions normally while archived
  const archivedRedirect = await fetchWithRetry(`${prodOrigin}/r/${testArchiveCode}`);
  if (archivedRedirect.status !== 302 || !archivedRedirect.location?.includes(`/pembeli/mulai.html?card=${testArchiveCode}`)) {
    await rollback(`Archived card ${testArchiveCode} QR routing broken!`);
  }

  // Restore the card
  const restoreRes = await fetchWithRetry(`${prodOrigin}/api/v2-admin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Request': '1',
      Cookie: sessionCookie,
      Origin: prodOrigin
    },
    body: JSON.stringify({ action: 'restore', card_code: testArchiveCode })
  });
  let restoreData = {};
  try { restoreData = JSON.parse(restoreRes.body); } catch {}
  record('6_5_RESTORE_RESULT', { status: restoreRes.status, success: restoreData.success });
  if (restoreRes.status !== 200 || restoreData.success !== true) {
    await rollback('Failed to restore card on production: ' + JSON.stringify(restoreData));
  }

  // Verify card has is_archived: false
  const listCheck2 = await fetchWithRetry(`${prodOrigin}/api/v2-admin?action=cards`, {
    headers: { Cookie: sessionCookie, Origin: prodOrigin }
  });
  const listCheck2Data = JSON.parse(listCheck2.body);
  const restoredCard = listCheck2Data.cards.find(c => c.card_code === testArchiveCode);
  if (!restoredCard || restoredCard.is_archived === true) {
    await rollback(`Card ${testArchiveCode} not marked as restored in production list!`);
  }

  // 6.6: Buyer Auth Edge & Dashboard UI
  record('6_6_BUYER_DASHBOARD_TEST', 'Testing buyer dashboard & auth security...');
  const dashRes = await fetchWithRetry(`${prodOrigin}/dashboard.html`);
  if (dashRes.status !== 200) await rollback('dashboard.html failed to load');

  const accountCssRes = await fetchWithRetry(`${prodOrigin}/pembeli/account.css`);
  if (accountCssRes.status !== 200 || !accountCssRes.body.includes('account-edit') || !accountCssRes.body.includes('lynk-auth-container')) {
    await rollback('account.css missing responsive edit styles');
  }

  const badAuthRes = await fetchWithRetry(`${prodOrigin}/api/buyer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Buyer-Request': '1',
      Origin: prodOrigin
    },
    body: JSON.stringify({ action: 'signin', email: 'test_verify@example.com', password: 'badpassword123' })
  });
  let badAuthBody = {};
  try { badAuthBody = JSON.parse(badAuthRes.body); } catch {}
  record('6_6_BAD_AUTH_RESULT', { status: badAuthRes.status, body: badAuthBody });
  if (badAuthRes.status !== 401 || !badAuthBody.error?.includes('Email atau password tidak sesuai')) {
    await rollback('Buyer auth did not return expected standardized error message');
  }

  audit.status = 'PROMOTION_COMPLETE_AND_VERIFIED';
  audit.completedAt = new Date().toISOString();
  fs.writeFileSync(logFile, JSON.stringify(audit, null, 2));

  console.log('\n========================================================');
  console.log('   FINAL PRODUCTION PROMOTION COMPLETED & 100% VERIFIED!');
  console.log('   Production URL: ' + prodOrigin);
  console.log('   Active Deployment: ' + candidateId);
  console.log('   Rollback Available: ' + baselineId);
  console.log('   Audit Log: ' + logFile);
  console.log('========================================================\n');
}

main().catch(err => {
  console.error('\nPROMOTION RUNTIME ERROR:', err);
  process.exit(1);
});
