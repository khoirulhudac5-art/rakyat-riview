import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readAdminEnv } from './admin-readonly-config.mjs';

const candidateId = 'dpl_83V3fRAtHEBSenc7eFBYkTCwXtcF';
const baselineId = 'dpl_688bSUnLPMcAxBLatpP5Wg7biACV';
const scope = 'rakprem';
const prodOrigin = 'https://rakyat-riview.vercel.app';
const binary = path.resolve('.local-tools/npm-cache/_npx/69f9afb961c37556/node_modules/vercel/dist/vc.js');

const privateConfig = readAdminEnv('.env.admin-readonly');
if (!privateConfig.ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD not found in .env.admin-readonly');
}

const evidenceFolder = path.resolve('.backups/production-promotion-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(evidenceFolder, { recursive: true });

const logFile = path.join(evidenceFolder, 'PROMOTION_AUDIT.json');
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
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000), ...options });
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
  console.log('======================================================');
  console.log('     RAKYAT REVIEW V2 — FINAL PRODUCTION DEPLOYMENT   ');
  console.log('======================================================\n');

  // STEP 1: Verify Current Active Production Baseline
  record('1_CHECK_BASELINE', 'Verifying current production deployment...');
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

  console.log('\n>>> Production domain is now pointing to candidate deployment: ' + newProd.id);
  console.log('>>> Commencing comprehensive post-deployment verification...\n');

  // STEP 6: Post-Deploy Verification on Production

  // 6.1: Verify Inactive Card Routing (VZA4REV6 and TCXEEY8E)
  record('6_1_INACTIVE_CARD_TEST', 'Testing inactive card routing on production...');
  const inactiveCards = ['VZA4REV6', 'TCXEEY8E'];
  for (const cardCode of inactiveCards) {
    const rRes = await fetchWithRetry(`${prodOrigin}/r/${cardCode}`);
    record(`6_1_ROUTING_${cardCode}`, { status: rRes.status, location: rRes.location });
    if (rRes.status !== 302 || !rRes.location?.includes(`/pembeli/mulai.html?card=${cardCode}`)) {
      await rollback(`Inactive card ${cardCode} redirect failed: status ${rRes.status}, location ${rRes.location}`);
    }

    const sRes = await fetchWithRetry(`${prodOrigin}/api/buyer-status?card=${cardCode}`);
    let sBody = {};
    try { sBody = JSON.parse(sRes.body); } catch {}
    record(`6_1_STATUS_${cardCode}`, { status: sRes.status, body: sBody });
    if (sRes.status !== 200 || sBody.code !== cardCode || sBody.claim_allowed !== true) {
      await rollback(`Inactive card ${cardCode} buyer-status check failed: status ${sRes.status}, claim_allowed: ${sBody.claim_allowed}`);
    }
  }

  // 6.2: Verify Active Card Routing (BKE9VWK3)
  record('6_2_ACTIVE_CARD_TEST', 'Testing active card BKE9VWK3 routing on production...');
  const bkeStatus = await fetchWithRetry(`${prodOrigin}/api/buyer-status?card=BKE9VWK3`);
  let bkeBody = {};
  try { bkeBody = JSON.parse(bkeStatus.body); } catch {}
  record('6_2_BKE_STATUS', { status: bkeStatus.status, body: bkeBody });
  if (bkeStatus.status !== 200 || bkeBody.activation_state !== 'active') {
    await rollback(`Active card BKE9VWK3 status check failed: ${bkeStatus.body}`);
  }

  const bkeRedirect = await fetchWithRetry(`${prodOrigin}/r/BKE9VWK3`);
  record('6_2_BKE_REDIRECT', { status: bkeRedirect.status, location: bkeRedirect.location });
  if (bkeRedirect.status !== 302 || !bkeRedirect.location?.includes('google.com')) {
    await rollback(`Active card BKE9VWK3 did not redirect to Google Review! Location: ${bkeRedirect.location}`);
  }

  // 6.3: Verify Static Assets & Activation Pages
  record('6_3_ASSETS_TEST', 'Testing static assets & UI elements on production...');
  const mulaiRes = await fetchWithRetry(`${prodOrigin}/pembeli/mulai.html?card=VZA4REV6`);
  if (mulaiRes.status !== 200 || !mulaiRes.body.includes('Pembeli Baru') || !mulaiRes.body.includes('Sudah Punya Akun')) {
    await rollback('pembeli/mulai.html failed to serve V2 activation choices');
  }
  if (mulaiRes.body.includes('Kode Aktivasi (6 Digit)')) {
    await rollback('pembeli/mulai.html still contains legacy 6-digit PIN input!');
  }

  const dashRes = await fetchWithRetry(`${prodOrigin}/dashboard.html`);
  if (dashRes.status !== 200) await rollback('dashboard.html failed to load');

  const authCallbackRes = await fetchWithRetry(`${prodOrigin}/pembeli/auth-callback.html`);
  if (authCallbackRes.status !== 200) await rollback('pembeli/auth-callback.html failed to load');

  // 6.4: Admin V2 Login & Authentication
  record('6_4_ADMIN_TEST', 'Testing Admin V2 login and operations on production...');
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

  // 6.5: Archive and Restore Features on Production
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

  // 6.6: Card Generator on Production
  record('6_6_CARD_GENERATOR_TEST', 'Testing card creation on production...');
  const createRes = await fetchWithRetry(`${prodOrigin}/api/v2-admin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Request': '1',
      Cookie: sessionCookie,
      Origin: prodOrigin
    },
    body: JSON.stringify({
      action: 'create',
      quantity: 1,
      request_id: (await import('node:crypto')).randomUUID()
    })
  });
  let createData = {};
  try { createData = JSON.parse(createRes.body); } catch {}
  record('6_6_CREATE_RESULT', { status: createRes.status, cards: createData.cards });
  if (createRes.status !== 200 || !createData.cards?.[0]?.card_code) {
    await rollback('Failed to create new card on production: ' + JSON.stringify(createData));
  }
  const newlyCreated = createData.cards[0];
  record('6_6_NEW_CARD', { code: newlyCreated.card_code, url: newlyCreated.card_url });

  // Verify new card QR route on production
  const newCardRoute = await fetchWithRetry(`${prodOrigin}/r/${newlyCreated.card_code}`);
  record('6_6_NEW_CARD_ROUTE', { status: newCardRoute.status, location: newCardRoute.location });
  if (newCardRoute.status !== 302 || !newCardRoute.location?.includes(`/pembeli/mulai.html?card=${newlyCreated.card_code}`)) {
    await rollback(`Newly created card ${newlyCreated.card_code} QR route failed: status ${newCardRoute.status}`);
  }

  // 6.7: Buyer Authentication Edge Test
  record('6_7_BUYER_AUTH_TEST', 'Testing Buyer Auth error responses on production...');
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
  record('6_7_BAD_AUTH_RESULT', { status: badAuthRes.status, body: badAuthBody });
  if (badAuthRes.status !== 401 || !badAuthBody.error?.includes('Email atau password tidak sesuai')) {
    await rollback('Buyer auth did not return expected standardized Indonesian error message');
  }

  audit.status = 'PROMOTION_COMPLETE_AND_VERIFIED';
  audit.completedAt = new Date().toISOString();
  fs.writeFileSync(logFile, JSON.stringify(audit, null, 2));

  console.log('\n======================================================');
  console.log('   PRODUCTION PROMOTION COMPLETED & 100% VERIFIED!    ');
  console.log('   Production URL: ' + prodOrigin);
  console.log('   Active Deployment: ' + candidateId);
  console.log('   Rollback Available: ' + baselineId);
  console.log('   Audit Log: ' + logFile);
  console.log('======================================================\n');
}

main().catch(err => {
  console.error('\nPROMOTION RUNTIME ERROR:', err);
  process.exit(1);
});
