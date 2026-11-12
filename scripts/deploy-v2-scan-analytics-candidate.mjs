import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readAdminEnv, adminConfigStatus } from './admin-readonly-config.mjs';

const seal = '40f3d6a1c4f2821584058d344b691c68cdca199af6b9a0e7080d93a7d75cafee';
const folder = path.resolve('.backups/v2-scan-analytics-release-2026-11-11T16-11-10-861Z');
const root = path.join(folder, 'release');
const activeProductionId = 'dpl_83V3fRAtHEBSenc7eFBYkTCwXtcF';
const origin = 'https://rakyat-riview.vercel.app';
const project = 'prj_BdqElWlwjelD7zwY6pPZiABHYX9E';
const scope = 'rakprem';
const binary = path.resolve('.local-tools/npm-cache/_npx/69f9afb961c37556/node_modules/vercel/dist/vc.js');
const sha = b => createHash('sha256').update(b).digest('hex');

const artifactManifest = path.join(folder, 'ARTIFACT-MANIFEST.json');
if (!fs.existsSync(artifactManifest) || sha(fs.readFileSync(artifactManifest)) !== seal) {
  throw Error('Artifact seal mismatch');
}

const privateConfig = readAdminEnv('.env.admin-readonly');
if (!adminConfigStatus(privateConfig).ready) throw Error('Private backend config unavailable');

const evidence = path.resolve('.backups/v2-scan-analytics-deployment-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(evidence, { recursive: true });

const attempt = {
  status: 'CANDIDATE_DEPLOYMENT_STARTING',
  at: new Date().toISOString(),
  project,
  activeProductionId,
  seal,
  evidence,
  checks: []
};
const save = () => fs.writeFileSync(path.join(evidence, 'RESULT.json'), JSON.stringify(attempt, null, 2));
save();

async function cli(args, timeout = 300000, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      cwd: root,
      env: { ...process.env, NODE_OPTIONS: '--dns-result-order=ipv4first', ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => {
      done = true;
      child.kill();
      reject(Error('CLI timeout after ' + timeout + 'ms'));
    }, timeout);
    child.stdout.on('data', b => stdout += b);
    child.stderr.on('data', b => stderr += b);
    child.on('error', err => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

const api = async url => {
  const res = await cli(['api', url, '--method', 'GET', '--scope', scope]);
  if (res.code !== 0) throw Error('API ' + url + ' failed: ' + res.stderr);
  try { return JSON.parse(res.stdout); } catch { throw Error('API ' + url + ' returned non-JSON: ' + res.stdout.slice(0, 200)); }
};

async function get(url, headers = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      return { status: r.status, body: await r.text(), location: r.headers.get('location') };
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function vcCurl(candidateUrl, route, flags = []) {
  try {
    const res = await get(candidateUrl + route);
    return { code: 0, status: res.status, body: res.body, location: res.location };
  } catch {
    return new Promise((resolve) => {
      const child = spawn('curl.exe', ['-4', '-s', '-w', '\nHTTP_STATUS:%{http_code}', candidateUrl + route, ...flags], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '', err = '', done = false;
      const timer = setTimeout(() => {
        done = true;
        child.kill();
        resolve({ code: 1, status: 504, body: 'CLI timeout' });
      }, 25000);
      child.stdout.on('data', b => out += b);
      child.stderr.on('data', b => err += b);
      child.on('close', code => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const lines = out.trim().split(/\r?\n/);
        const statusLine = lines.pop() || '';
        const statusMatch = statusLine.match(/HTTP_STATUS:(\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : (code === 0 ? 200 : 500);
        resolve({ code, status, body: lines.join('\n') });
      });
    });
  }
}

async function main() {
  console.log('=== DEPLOYING V2 SCAN ANALYTICS CANDIDATE (--skip-domain) ===\n');

  // 1. Verify active production deployment
  console.log('1. Verifying current active production deployment...');
  const currentProd = await api('/v13/deployments/rakyat-riview.vercel.app');
  if (currentProd.id !== activeProductionId) {
    throw Error(`Active production deployment mismatch: expected ${activeProductionId}, got ${currentProd.id}`);
  }
  console.log('Active production confirmed:', currentProd.id, '(' + currentProd.readyState + ')');

  // 2. Deploy candidate with --skip-domain
  console.log('\n2. Deploying candidate with --prebuilt --prod --skip-domain...');
  attempt.status = 'DEPLOYING_CANDIDATE';
  save();

  let deployRes;
  for (let dTry = 1; dTry <= 3; dTry++) {
    deployRes = await cli(['deploy', '--prebuilt', '--prod', '--skip-domain', '--scope', scope]);
    if (deployRes.code === 0) break;
    console.log(`Deploy attempt ${dTry} failed (${deployRes.stderr}). Retrying in 3s...`);
    await new Promise(r => setTimeout(r, 3000));
  }
  if (deployRes.code !== 0) {
    throw Error('Candidate deploy command failed: ' + deployRes.stderr);
  }

  let candidateUrl = '';
  let candidateId = '';

  try {
    const jsonOut = JSON.parse(deployRes.stdout);
    candidateUrl = jsonOut.deployment?.url || '';
    candidateId = jsonOut.deployment?.id || '';
  } catch {
    candidateUrl = deployRes.stdout.trim().split(/\r?\n/).pop()?.trim() || '';
  }

  if (!candidateUrl?.startsWith('https://')) {
    throw Error('Candidate deploy did not return URL: ' + deployRes.stdout);
  }

  console.log('Candidate deployment URL:', candidateUrl);
  attempt.candidateUrl = candidateUrl;
  save();

  // 3. Resolve candidate deployment metadata
  if (!candidateId) {
    const candidateHost = new URL(candidateUrl).hostname;
    const candidateMeta = await api(`/v13/deployments/${candidateHost}`);
    candidateId = candidateMeta.id;
  }
  console.log('Candidate Deployment ID:', candidateId);
  attempt.candidateId = candidateId;
  save();

  // 4. Verify production domain was NOT modified
  console.log('\n3. Verifying production domain was untouched...');
  const prodCheck = await api('/v13/deployments/rakyat-riview.vercel.app');
  if (prodCheck.id !== activeProductionId) {
    throw Error('CRITICAL ERROR: Production domain changed unexpectedly!');
  }
  console.log('Production domain still serves:', prodCheck.id, '(SAFE)');

  // 5. Test Candidate Deployment
  console.log('\n4. Verifying Candidate Assets and Endpoints via vc curl...');

  const candDash = await vcCurl(candidateUrl, '/dashboard.html');
  console.log('Candidate /dashboard.html status:', candDash.status);
  if (candDash.status !== 200) throw Error('Candidate /dashboard.html returned ' + candDash.status);

  const candPreview = await vcCurl(candidateUrl, '/preview.html');
  console.log('Candidate /preview.html status:', candPreview.status);
  if (candPreview.status !== 200 || !candPreview.body.includes('Preview Dashboard')) {
    throw Error('Candidate /preview.html returned invalid content');
  }

  const candPreviewJs = await vcCurl(candidateUrl, '/assets/buyer-preview.js');
  console.log('Candidate /assets/buyer-preview.js status:', candPreviewJs.status);
  if (candPreviewJs.status !== 200 || !candPreviewJs.body.includes('demoUser') || !candPreviewJs.body.includes('#ea4335') || !candPreviewJs.body.includes('analytics-card-filter')) {
    throw Error('Candidate /assets/buyer-preview.js returned invalid content or missing red today bar / card filter');
  }

  const candAccountJs = await vcCurl(candidateUrl, '/pembeli/account.js');
  console.log('Candidate /pembeli/account.js status:', candAccountJs.status);
  if (candAccountJs.status !== 200 || !candAccountJs.body.includes('lynk-auth-container') || !candAccountJs.body.includes('Alamat Email') || candAccountJs.body.includes('••••••••')) {
    throw Error('Candidate /pembeli/account.js does not contain Lynk.id auth container or refined email/password placeholders');
  }

  const candJs = await vcCurl(candidateUrl, '/assets/buyer.js');
  console.log('Candidate /assets/buyer.js status:', candJs.status);
  if (
    candJs.status !== 200 ||
    !candJs.body.includes('renderBarChart') ||
    !candJs.body.includes('card-scan-badge') ||
    !candJs.body.includes('Total Scan') ||
    !candJs.body.includes('Scan Hari Ini') ||
    !candJs.body.includes('#ea4335') ||
    !candJs.body.includes('analytics-card-filter')
  ) {
    throw Error('Candidate /assets/buyer.js does not contain scan analytics code, red today bar or card selector');
  }

  const candCss = await vcCurl(candidateUrl, '/assets/buyer.css');
  console.log('Candidate /assets/buyer.css status:', candCss.status);
  if (candCss.status !== 200 || !candCss.body.includes('filter-pills') || !candCss.body.includes('card-scan-badge')) {
    throw Error('Candidate /assets/buyer.css does not contain analytics styles');
  }

  const candMulai = await vcCurl(candidateUrl, '/pembeli/mulai.html');
  console.log('Candidate /pembeli/mulai.html status:', candMulai.status);
  if (candMulai.status !== 200 || !candMulai.body.includes('Pembeli Baru') || !candMulai.body.includes('Sudah Punya Akun') || !candMulai.body.includes('choice-blue') || !candMulai.body.includes('choice-yellow')) {
    throw Error('Candidate /pembeli/mulai.html does not contain revised blue/yellow buyer activation choice cards');
  }

  const candRedirect = await vcCurl(candidateUrl, '/r/LBWJJDA8', ['-I']);
  console.log('Candidate /r/LBWJJDA8 status:', candRedirect.status);
  if (candRedirect.status !== 302) {
    throw Error('Candidate /r/LBWJJDA8 expected HTTP 302, got ' + candRedirect.status);
  }

  const candPilot = await vcCurl(candidateUrl, '/r/iKRb7_7PyK6kg4Ye7EqvOhYu', ['-I']);
  console.log('Candidate /r/iKRb7_7PyK6kg4Ye7EqvOhYu status:', candPilot.status);
  if (candPilot.status !== 302) {
    throw Error('Candidate pilot card expected HTTP 302, got ' + candPilot.status);
  }

  const candAnon = await vcCurl(candidateUrl, '/api/buyer?action=analytics');
  console.log('Candidate anonymous analytics rejection:', candAnon.status);
  if (candAnon.status !== 401) {
    throw Error('Candidate /api/buyer?action=analytics expected 401, got ' + candAnon.status);
  }

  // 6. Admin V2 Diagnostics & Authentication Verification
  console.log('\n5. Verifying Admin V2 on Candidate Deployment...');
  const candAdminHtml = await vcCurl(candidateUrl, '/admin-v2.html');
  console.log('Candidate /admin-v2.html status:', candAdminHtml.status);
  if (candAdminHtml.status !== 200 || !candAdminHtml.body.includes('admin-app')) {
    throw Error('Candidate /admin-v2.html returned invalid content');
  }

  // Verify anonymous session returns 401 (NOT 503)
  const candAdminSession = await fetch(candidateUrl + '/api/v2-admin?action=session', {
    headers: {
      Host: new URL(candidateUrl).host,
      Origin: candidateUrl
    }
  });
  const sessionBody = await candAdminSession.json();
  console.log('Candidate /api/v2-admin?action=session status:', candAdminSession.status, 'body:', sessionBody);
  if (candAdminSession.status === 503) {
    throw Error('Admin V2 still returns 503: ' + sessionBody.error);
  }
  if (candAdminSession.status !== 401) {
    throw Error('Candidate /api/v2-admin?action=session expected 401, got ' + candAdminSession.status);
  }

  // Verify Admin Login with real password from .env.admin-readonly
  const candAdminLogin = await fetch(candidateUrl + '/api/v2-admin', {
    method: 'POST',
    headers: {
      Host: new URL(candidateUrl).host,
      Origin: candidateUrl,
      'X-Admin-Request': '1',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ action: 'login', password: privateConfig.ADMIN_PASSWORD })
  });
  const loginBody = await candAdminLogin.json();
  console.log('Candidate /api/v2-admin login status:', candAdminLogin.status, 'success:', loginBody.success);
  if (candAdminLogin.status !== 200 || loginBody.success !== true) {
    throw Error('Candidate admin login failed with status ' + candAdminLogin.status + ': ' + (loginBody.error || 'unknown'));
  }
  const setCookie = candAdminLogin.headers.get('set-cookie');
  if (!setCookie || !setCookie.includes('__Host-rr_admin_v2=')) {
    throw Error('Candidate admin login did not return session cookie');
  }

  // Verify authenticated session with cookie
  const authSession = await fetch(candidateUrl + '/api/v2-admin?action=session', {
    headers: {
      Host: new URL(candidateUrl).host,
      Origin: candidateUrl,
      Cookie: setCookie.split(';')[0]
    }
  });
  const authBody = await authSession.json();
  console.log('Candidate authenticated session check:', authSession.status, 'authenticated:', authBody.authenticated);
  if (authSession.status !== 200 || authBody.authenticated !== true) {
    throw Error('Candidate authenticated session check failed');
  }

  // Verify list cards with cookie
  const listCards = await fetch(candidateUrl + '/api/v2-admin?action=cards', {
    headers: {
      Host: new URL(candidateUrl).host,
      Origin: candidateUrl,
      Cookie: setCookie.split(';')[0]
    }
  });
  const listBody = await listCards.json();
  console.log('Candidate cards list check:', listCards.status, 'total cards:', listBody.cards?.length);
  if (listCards.status !== 200 || !Array.isArray(listBody.cards)) {
    throw Error('Candidate cards list check failed');
  }

  // Verify cards are strictly sorted by created_at ASC
  for (let i = 1; i < listBody.cards.length; i++) {
    const prev = new Date(listBody.cards[i - 1].created_at).getTime();
    const curr = new Date(listBody.cards[i].created_at).getTime();
    if (prev > curr) {
      throw Error(`Cards not sorted by created_at ASC! Card ${listBody.cards[i-1].card_code} (${listBody.cards[i-1].created_at}) > Card ${listBody.cards[i].card_code} (${listBody.cards[i].created_at})`);
    }
  }
  console.log('Verified: All cards are strictly sorted by created_at ASC (oldest at top, newest at bottom).');

  // Verify Admin JS and CSS assets contain order number and batch copy / QR functionality
  const candAdminJs = await vcCurl(candidateUrl, '/assets/admin-v2.js');
  if (!candAdminJs.body.includes('formatOrderNumber') || !candAdminJs.body.includes('data-batch-copy') || !candAdminJs.body.includes('data-batch-qr') || !candAdminJs.body.includes('RAKYAT-REVIEW-')) {
    throw Error('Candidate /assets/admin-v2.js does not contain order number or batch copy/qr handlers!');
  }
  const candAdminCss = await vcCurl(candidateUrl, '/assets/admin-v2.css');
  if (!candAdminCss.body.includes('card-order-num')) {
    throw Error('Candidate /assets/admin-v2.css does not contain card-order-num styling!');
  }
  console.log('Verified: Candidate /assets/admin-v2.js and /assets/admin-v2.css contain order number & batch actions.');

  // Verify Admin JS and CSS assets contain archive functionality
  if (!candAdminJs.body.includes('is_archived') || !candAdminJs.body.includes('data-archive-open') || !candAdminJs.body.includes('data-restore-card') || !candAdminJs.body.includes('archive-dialog')) {
    throw Error('Candidate /assets/admin-v2.js does not contain archive and restore handlers!');
  }
  if (!candAdminCss.body.includes('action-dropdown') || !candAdminCss.body.includes('menu-dropdown-wrap')) {
    throw Error('Candidate /assets/admin-v2.css does not contain action-dropdown styling!');
  }
  console.log('Verified: Candidate /assets/admin-v2.js and /assets/admin-v2.css contain archive features & dropdown styling.');

  // Test Archive & Restore functionality on candidate API
  console.log('\nTesting Archive & Restore actions on Candidate...');
  const testCardToArchive = 'BW8TRBLC';
  const archiveRes = await fetch(candidateUrl + '/api/v2-admin', {
    method: 'POST',
    headers: {
      Host: new URL(candidateUrl).host,
      Origin: candidateUrl,
      'X-Admin-Request': '1',
      'Content-Type': 'application/json',
      Cookie: setCookie.split(';')[0]
    },
    body: JSON.stringify({ action: 'archive', card_code: testCardToArchive })
  });
  const archiveBody = await archiveRes.json();
  console.log('Candidate archive response:', archiveRes.status, archiveBody);
  if (archiveRes.status !== 200 || archiveBody.success !== true) {
    throw Error('Candidate archive failed: ' + JSON.stringify(archiveBody));
  }

  // Verify list cards marks testCardToArchive as is_archived: true
  const listAfterArchive = await fetch(candidateUrl + '/api/v2-admin?action=cards', {
    headers: {
      Host: new URL(candidateUrl).host,
      Origin: candidateUrl,
      Cookie: setCookie.split(';')[0]
    }
  });
  const listAfterArchiveBody = await listAfterArchive.json();
  const archivedCardEntry = listAfterArchiveBody.cards?.find(c => c.card_code === testCardToArchive);
  if (!archivedCardEntry || archivedCardEntry.is_archived !== true) {
    throw Error('Expected card ' + testCardToArchive + ' to have is_archived: true after archiving, got: ' + JSON.stringify(archivedCardEntry));
  }
  console.log('Verified: Card ' + testCardToArchive + ' is marked as is_archived: true in candidate API.');

  // Verify QR/NFC routing still functions normally while archived
  const archivedCardRedirect = await vcCurl(candidateUrl, `/r/${testCardToArchive}`, ['-I']);
  console.log(`Candidate /r/${testCardToArchive} status:`, archivedCardRedirect.status, 'location:', archivedCardRedirect.location);
  if (archivedCardRedirect.status !== 302 || !archivedCardRedirect.location?.includes(`/pembeli/mulai.html?card=${testCardToArchive}`)) {
    throw Error(`Candidate /r/${testCardToArchive} redirect broken while archived!`);
  }
  console.log('Verified: Permanent QR/NFC link still functions normally while card is archived.');

  // Test Restore card
  const restoreRes = await fetch(candidateUrl + '/api/v2-admin', {
    method: 'POST',
    headers: {
      Host: new URL(candidateUrl).host,
      Origin: candidateUrl,
      'X-Admin-Request': '1',
      'Content-Type': 'application/json',
      Cookie: setCookie.split(';')[0]
    },
    body: JSON.stringify({ action: 'restore', card_code: testCardToArchive })
  });
  const restoreBody = await restoreRes.json();
  console.log('Candidate restore response:', restoreRes.status, restoreBody);
  if (restoreRes.status !== 200 || restoreBody.success !== true) {
    throw Error('Candidate restore failed: ' + JSON.stringify(restoreBody));
  }

  // Verify list cards marks testCardToArchive as is_archived: false
  const listAfterRestore = await fetch(candidateUrl + '/api/v2-admin?action=cards', {
    headers: {
      Host: new URL(candidateUrl).host,
      Origin: candidateUrl,
      Cookie: setCookie.split(';')[0]
    }
  });
  const listAfterRestoreBody = await listAfterRestore.json();
  const restoredCardEntry = listAfterRestoreBody.cards?.find(c => c.card_code === testCardToArchive);
  if (!restoredCardEntry || restoredCardEntry.is_archived === true) {
    throw Error('Expected card ' + testCardToArchive + ' to have is_archived: false after restoring, got: ' + JSON.stringify(restoredCardEntry));
  }
  console.log('Verified: Card ' + testCardToArchive + ' is restored to is_archived: false in candidate API.');

  // 7. Verify V2 Card Activation Endpoint & HTML
  console.log('\n6. Verifying V2 Card Activation Flow on Candidate...');
  const candMulaiHtml = await vcCurl(candidateUrl, '/pembeli/mulai.html?card=BKE9VWK3');
  if (candMulaiHtml.status !== 200 || candMulaiHtml.body.includes('Kode Aktivasi (6 Digit)')) {
    throw Error('Candidate /pembeli/mulai.html still contains 6-digit activation code input!');
  }
  if (!candMulaiHtml.body.includes('btn-start-activation')) {
    throw Error('Candidate /pembeli/mulai.html missing btn-start-activation!');
  }
  if (!candMulaiHtml.body.includes('Akun Anda Sudah Terhubung') || !candMulaiHtml.body.includes('Hubungkan Kartu ke Akun Saya')) {
    throw Error('Candidate /pembeli/mulai.html missing Section 5 Connected Account UI elements!');
  }
  if (!candMulaiHtml.body.includes('href="/assets/buyer.css"') || !candMulaiHtml.body.includes('href="/pembeli/account.css"') || !candMulaiHtml.body.includes('href="/pembeli/experience.css"')) {
    throw Error('Candidate /pembeli/mulai.html does not use root-absolute paths for CSS!');
  }

  // Verify wizard.mjs syntax using node --input-type=module --check
  const candWizardJs = await vcCurl(candidateUrl, '/pembeli/wizard.mjs');
  if (candWizardJs.status !== 200) {
    throw Error('Candidate /pembeli/wizard.mjs returned ' + candWizardJs.status);
  }
  await new Promise((resolve, reject) => {
    const ch = spawn(process.execPath, ['--input-type=module', '--check'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let errOut = '';
    ch.stderr.on('data', d => errOut += d);
    ch.on('close', code => {
      if (code === 0) {
        console.log('Candidate wizard.mjs parsed successfully with zero syntax errors!');
        resolve();
      } else {
        reject(Error('Candidate /pembeli/wizard.mjs has syntax error: ' + errOut));
      }
    });
    ch.stdin.write(candWizardJs.body);
    ch.stdin.end();
  });

  // 8. Verify TCXEEY8E and Global /r/ Routing
  console.log('\n7. Verifying Global /r/ Routing on Inactive Card TCXEEY8E...');
  const candTcRedirect = await vcCurl(candidateUrl, '/r/TCXEEY8E', ['-I']);
  console.log('Candidate /r/TCXEEY8E status:', candTcRedirect.status, 'location:', candTcRedirect.location);
  if (candTcRedirect.status !== 302 || !candTcRedirect.location?.includes('/pembeli/mulai.html?card=TCXEEY8E')) {
    throw Error('Candidate /r/TCXEEY8E expected 302 to /pembeli/mulai.html?card=TCXEEY8E, got status ' + candTcRedirect.status + ' location ' + candTcRedirect.location);
  }

  // 9. Verify Admin V2 Card Creation on Candidate
  console.log('\n8. Generating a new test card via Admin V2 on Candidate...');
  const adminCreateRes = await fetch(candidateUrl + '/api/v2-admin', {
    method: 'POST',
    headers: {
      Host: new URL(candidateUrl).host,
      Origin: candidateUrl,
      'X-Admin-Request': '1',
      'Content-Type': 'application/json',
      Cookie: setCookie.split(';')[0]
    },
    body: JSON.stringify({
      action: 'create',
      quantity: 1,
      request_id: (await import('node:crypto')).randomUUID()
    })
  });
  const adminCreateBody = await adminCreateRes.json();
  console.log('Candidate Admin Create response:', adminCreateRes.status, adminCreateBody);
  if (adminCreateRes.status !== 200 || !adminCreateBody.cards?.[0]?.card_code) {
    throw Error('Admin card creation failed on candidate: ' + JSON.stringify(adminCreateBody));
  }
  const newCard = adminCreateBody.cards[0];
  console.log('New Admin Card generated:', newCard.card_code, 'card_url:', newCard.card_url);
  if (!newCard.card_url.includes(new URL(candidateUrl).host)) {
    throw Error('Generated card_url did not use candidate host! Got: ' + newCard.card_url);
  }

  // Verify the new card's /r/ redirect
  const newCardRedirect = await vcCurl(candidateUrl, `/r/${newCard.card_code}`, ['-I']);
  console.log(`Candidate /r/${newCard.card_code} status:`, newCardRedirect.status, 'location:', newCardRedirect.location);
  if (newCardRedirect.status !== 302 || !newCardRedirect.location?.includes(`/pembeli/mulai.html?card=${newCard.card_code}`)) {
    throw Error(`Candidate /r/${newCard.card_code} expected 302 to /pembeli/mulai.html?card=${newCard.card_code}`);
  }

  // 10. Verify Auth Callback HTML, Script & Route Aliases
  console.log('\n9. Verifying Auth Callback & Session Endpoints...');
  const candAuthCallback = await vcCurl(candidateUrl, '/pembeli/auth-callback.html');
  if (candAuthCallback.status !== 200 || !candAuthCallback.body.includes('auth-callback.mjs')) {
    throw Error('Candidate /pembeli/auth-callback.html missing or invalid!');
  }

  // Verify clean URL and aliases do NOT 404
  const callbackPathsToTest = [
    '/pembeli/auth-callback',
    '/pembeli/auth-callback/',
    '/auth-callback.html',
    '/auth-callback'
  ];
  for (const path of callbackPathsToTest) {
    const res = await vcCurl(candidateUrl, path);
    console.log(`Candidate ${path} status:`, res.status);
    if (res.status !== 200 || !res.body.includes('auth-callback.mjs')) {
      throw Error(`Candidate route ${path} failed with status ${res.status}! Expected 200 OK.`);
    }
  }
  console.log('Verified: All auth-callback route variations return HTTP 200 OK with no 404s.');

  // Verify buyer signin with bad credentials gives standardized Indonesian message
  const candBadLogin = await fetch(candidateUrl + '/api/buyer', {
    method: 'POST',
    headers: {
      Host: new URL(candidateUrl).host,
      Origin: candidateUrl,
      'X-Buyer-Request': '1',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ action: 'signin', email: 'nonexistent_test@example.com', password: 'wrongpassword123' })
  });
  const badLoginBody = await candBadLogin.json();
  console.log('Candidate /api/buyer bad login response:', candBadLogin.status, badLoginBody);
  if (candBadLogin.status !== 401 || !badLoginBody.error?.includes('Email atau password tidak sesuai')) {
    throw Error('Candidate /api/buyer did not return expected standardized error on invalid credentials: ' + JSON.stringify(badLoginBody));
  }

  // Verify active card BKE9VWK3 redirects directly to Google Review
  console.log('\nChecking active card BKE9VWK3 routing and status...');
  const candCardStatus = await vcCurl(candidateUrl, '/api/buyer-status?card=BKE9VWK3');
  console.log('Candidate /api/buyer-status?card=BKE9VWK3 status:', candCardStatus.status);
  const cardStatusBody = JSON.parse(candCardStatus.body);
  if (candCardStatus.status !== 200 || cardStatusBody.code !== 'BKE9VWK3' || cardStatusBody.activation_state !== 'active') {
    throw Error('Candidate /api/buyer-status for active card returned unexpected response: ' + candCardStatus.body);
  }

  const candBkeRedirect = await vcCurl(candidateUrl, '/r/BKE9VWK3', ['-I']);
  console.log('Candidate /r/BKE9VWK3 status:', candBkeRedirect.status, 'location:', candBkeRedirect.location);
  if (candBkeRedirect.status !== 302 || !candBkeRedirect.location?.includes('google.com')) {
    throw Error('Candidate /r/BKE9VWK3 expected 302 to Google Review, got location ' + candBkeRedirect.location);
  }

  // Verify inactive card TCXEEY8E status has claim_allowed: true
  const candTcStatus = await vcCurl(candidateUrl, '/api/buyer-status?card=TCXEEY8E');
  const tcStatusBody = JSON.parse(candTcStatus.body);
  console.log('Candidate /api/buyer-status?card=TCXEEY8E status:', candTcStatus.status, 'claim_allowed:', tcStatusBody.claim_allowed);
  if (candTcStatus.status !== 200 || tcStatusBody.code !== 'TCXEEY8E' || tcStatusBody.claim_allowed !== true) {
    throw Error('Candidate /api/buyer-status for TCXEEY8E unexpected response: ' + candTcStatus.body);
  }

  const candNotFound = await vcCurl(candidateUrl, '/api/buyer-status?card=INVALIDCODE99');
  console.log('Candidate /api/buyer-status?card=INVALIDCODE99 status:', candNotFound.status);
  if (candNotFound.status !== 404) {
    throw Error('Candidate expected 404 for invalid card, got ' + candNotFound.status);
  }

  attempt.status = 'CANDIDATE_READY_FOR_PROMOTION_APPROVAL';
  attempt.completedAt = new Date().toISOString();
  save();

  console.log('\n======================================================');
  console.log('   CANDIDATE DEPLOYMENT SUCCESSFUL & FULLY VERIFIED    ');
  console.log('   Candidate ID: ' + candidateId);
  console.log('   Candidate URL: ' + candidateUrl);
  console.log('   Active Production remains: ' + activeProductionId);
  console.log('======================================================\n');
}

main().catch(err => {
  console.error('\nDEPLOYMENT FAILED:', err.message);
  process.exit(1);
});
