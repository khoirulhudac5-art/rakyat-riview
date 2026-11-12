import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const project = 'prj_BdqElWlwjelD7zwY6pPZiABHYX9E';
const scope = 'rakprem';
const candidate = 'dpl_EXmyu7nn4byNTbpRApXCrZRRfm7k';
const baseline = 'dpl_3jws4ArwnvoRJAWVG9JT1Rraq5G1';
const releaseFolder = path.resolve('.backups/v2-short-code-release-2026-11-09T16-12-13-130Z');
const root = path.join(releaseFolder, 'release');
const origin = 'https://rakyat-riview.vercel.app';
const binary = path.resolve('.local-tools/npm-cache/_npx/69f9afb961c37556/node_modules/vercel/dist/vc.js');
const psqlBin = path.resolve('.backups/tooling/pgsql/bin');
const expectedSeal = 'bfbacd7d7a1f28911376f8d93b661cabd16ad434b58d2b874ba842d9f0366080';

const pilotCard = 'iKRb7_7PyK6kg4Ye7EqvOhYu';
const existingV2Card = '1jb6cDk5ABDpacSkkHsq5T8i';
const sampleShortCode = 'K7M2PX8A';

const sha = b => createHash('sha256').update(b).digest('hex');

async function psql(query) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-promote-short-code'
  };

  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(psqlBin, 'psql.exe'),
      ['-X', '-q', '-w', '-t', '-A', '-c', query],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '', err = '';
    child.stdout.on('data', x => out += x);
    child.stderr.on('data', x => err += x);
    child.on('close', code => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`psql failed (${code}): ${err}`));
    });
  });
}

async function cli(args, timeout = 90000) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [binary, ...args], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ exitCode: null, timedOut: true, stdout, stderr });
    }, timeout);
    child.stdout.on('data', b => stdout += b);
    child.stderr.on('data', b => stderr += b);
    child.on('error', err => finish({ exitCode: 127, startFailed: true, error: err.message }));
    child.on('close', exitCode => {
      let data;
      try { data = JSON.parse(stdout); } catch {}
      finish({ exitCode, data, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function api(url) {
  const r = await cli(['api', url, '--method', 'GET', '--scope', scope]);
  if (r.exitCode !== 0 || !r.data) throw new Error('Vercel API query failed: ' + url + ' (' + r.stderr + ')');
  return r.data;
}

const dep = d => ({ id: d.id || d.uid, projectId: d.projectId, state: d.readyState || d.state });

async function observe() {
  const [active, p] = await Promise.all([
    api('/v13/deployments/rakyat-riview.vercel.app'),
    api('/v9/projects/' + project)
  ]);
  return {
    at: new Date().toISOString(),
    active: dep(active),
    projectId: p.id,
    productionTarget: p.targets?.production?.id
  };
}

async function get(route, headers = {}) {
  const r = await fetch(origin + route, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  let json = null;
  const body = await r.text();
  try { json = JSON.parse(body); } catch {}
  return { status: r.status, headers: r.headers, body, json, location: r.headers.get('location') };
}

async function post(route, body = {}, headers = {}) {
  const r = await fetch(origin + route, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      'x-admin-request': '1',
      ...headers
    },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(20000)
  });
  let json = null;
  const text = await r.text();
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, body: text, json };
}

async function main() {
  const evidence = path.resolve('.backups/v2-short-code-promotion-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(evidence, { recursive: true });

  const report = {
    status: 'PROMOTION_STARTING',
    at: new Date().toISOString(),
    candidate,
    baseline,
    project,
    evidence,
    promoteInvocations: 0,
    rollbackInvocations: 0,
    checks: []
  };
  const save = () => fs.writeFileSync(path.join(evidence, 'RESULT.json'), JSON.stringify(report, null, 2));
  save();

  const check = (name, pass, note = '') => {
    report.checks.push({ name, pass: !!pass, note });
    save();
    console.log(`[CHECK] ${name}: ${pass ? 'PASS' : 'FAIL'} ${note ? '(' + note + ')' : ''}`);
    if (!pass) throw new Error('CRITICAL_CHECK_FAILED: ' + name);
  };

  async function rollbackToBaseline() {
    console.log('Initiating rollback to baseline', baseline, '...');
    report.rollbackInvocations++;
    save();
    const action = await cli(['promote', baseline, '--scope', scope, '--yes']);
    report.rollbackCLI = action;
    save();
    await new Promise(r => setTimeout(r, 6000));
    const finalState = await observe();
    const recovered = finalState.active?.id === baseline;
    report.rollbackSuccess = recovered;
    save();
    console.log('Rollback to', baseline, recovered ? 'SUCCEEDED' : 'FAILED');
    return recovered;
  }

  try {
    console.log('=== TAHAP 4: PRODUCTION RELEASE & VERIFICATION ===\n');

    // 1. Release artifact seal verification
    console.log('1. Verifying release artifact seal...');
    const manifestBytes = fs.readFileSync(path.join(releaseFolder, 'ARTIFACT-MANIFEST.json'));
    const manifestSeal = sha(manifestBytes);
    check('Release artifact seal matches expected', manifestSeal === expectedSeal, manifestSeal.slice(0, 16));

    // 2. Candidate deployment status verification
    console.log('2. Verifying candidate deployment status...');
    const candidateData = await api('/v13/deployments/' + candidate);
    check(
      'Candidate deployment exists and READY',
      candidateData.id === candidate && (candidateData.state === 'READY' || candidateData.readyState === 'READY'),
      `ID: ${candidateData.id}`
    );

    // 3. Baseline deployment status verification
    console.log('3. Verifying baseline deployment...');
    const initialObs = await observe();
    check('Baseline is currently serving production', initialObs.active?.id === baseline, `Active: ${initialObs.active?.id}`);

    // 4. Preflight Database State
    console.log('4. Verifying database state before promotion...');
    const preDbRaw = await psql(`
      SELECT json_build_object(
        'total_cards', (SELECT count(*) FROM public.card),
        'pilot_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = '${pilotCard}'),
        'target_unclaimed', (SELECT v2_activated_at IS NULL FROM public.card WHERE card_code = '${existingV2Card}'),
        'has_direct_gen_rpc', (SELECT count(*) = 1 FROM pg_proc WHERE proname = 'admin_generate_v2_cards_direct'),
        'has_direct_claim_rpc', (SELECT count(*) = 1 FROM pg_proc WHERE proname = 'buyer_claim_v2_direct')
      )::text;
    `);
    const preDb = JSON.parse(preDbRaw.split(/\r?\n/).find(l => l.trim().startsWith('{')));
    console.log('Database preflight status:', preDb);
    check('Preflight: Database total cards is 9', preDb.total_cards === 9);
    check('Preflight: Pilot card is active', preDb.pilot_active === true);
    check('Preflight: Existing V2 card is unclaimed', preDb.target_unclaimed === true);
    check('Preflight: Database has V2 direct generation RPC', preDb.has_direct_gen_rpc === true);
    check('Preflight: Database has V2 direct claim RPC', preDb.has_direct_claim_rpc === true);

    // 5. Promote candidate
    console.log(`\n5. Promoting candidate ${candidate} to production domain...`);
    report.promoteInvocations++;
    report.status = 'PROMOTING';
    save();

    const promoteRes = await cli(['promote', candidate, '--scope', scope, '--yes']);
    report.promoteCLI = promoteRes;
    save();
    console.log('Promote CLI output:', promoteRes.stdout || promoteRes.stderr);
    check('Promote CLI exited with code 0', promoteRes.exitCode === 0);

    // Wait for DNS/routing update
    console.log('Waiting 8s for edge propagation...');
    await new Promise(r => setTimeout(r, 8000));

    // 6. Verify active deployment on production domain
    console.log('6. Verifying active production deployment after promote...');
    const postObs = await observe();
    report.activeAfterPromote = postObs;
    save();
    console.log('Serving production now:', postObs.active?.id);
    check('Candidate is now serving production domain', postObs.active?.id === candidate);

    // 7. Postflight Checks on Live Production Domain
    console.log('\n--- 7. Live Production Verification (https://rakyat-riview.vercel.app) ---');

    // 7a. Home page
    const home = await get('/');
    check('Home page loads HTTP 200', home.status === 200);

    // 7b. Admin V2 page
    const adminPage = await get('/admin-v2.html');
    check('Admin V2 page loads HTTP 200', adminPage.status === 200 && adminPage.body.includes('Admin V2'));

    // 7c. Admin V2 JS bundle contains 2 download buttons (ZIP QR & CSV NFC)
    const adminJs = await get('/assets/admin-v2.js');
    check(
      'Admin V2 JS contains simplified 2-file download modal',
      adminJs.status === 200 &&
      adminJs.body.includes('Unduh ZIP QR Code') &&
      adminJs.body.includes('Unduh CSV Produksi Percetakan & NFC') &&
      !adminJs.body.includes('Unduh Master JSON')
    );

    // 7d. Buyer wizard page (/pembeli/mulai.html)
    const mulaiPage = await get('/pembeli/mulai.html?card=' + existingV2Card);
    check(
      'Buyer wizard page loads HTTP 200 with #card-code-display and NO token input',
      mulaiPage.status === 200 &&
      mulaiPage.body.includes('id="card-code-display"') &&
      !mulaiPage.body.includes('id="token"')
    );

    // 7e. Buyer wizard JS (/pembeli/wizard.mjs)
    const wizardJs = await get('/pembeli/wizard.mjs');
    check(
      'Buyer wizard JS loads HTTP 200 with auto card-code display',
      wizardJs.status === 200 &&
      wizardJs.body.includes('card-code-display')
    );

    // 7f. Dashboard page
    const dashboardPage = await get('/dashboard.html');
    check('Dashboard page loads HTTP 200', dashboardPage.status === 200);

    // 7g. Pilot Card Redirect (HTTP 302 to Google Review)
    const pilotLive = await get('/r/' + pilotCard);
    console.log('Pilot redirect status:', pilotLive.status, 'Location:', pilotLive.location);
    check(
      'Pilot card returns HTTP 302 to Google Review URL',
      pilotLive.status === 302 && pilotLive.location?.includes('search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE')
    );

    // 7h. Existing V2 Card routing (/r/1jb6cDk5ABDpacSkkHsq5T8i)
    const v2CardLive = await get('/r/' + existingV2Card);
    check(
      'Existing V2 card loads HTTP 200 with buyer_v2_public_card_status',
      v2CardLive.status === 200 && v2CardLive.body.includes('buyer_v2_public_card_status')
    );

    // 7i. Short Code Card routing (/r/K7M2PX8A)
    const shortCodeLive = await get('/r/' + sampleShortCode);
    check(
      'Sample 8-character short code loads HTTP 200 with buyer_v2_public_card_status',
      shortCodeLive.status === 200 && shortCodeLive.body.includes('buyer_v2_public_card_status')
    );

    // 7j. Buyer Status API for Existing V2 Card
    const v2StatusLive = await get('/api/buyer-status?card=' + existingV2Card);
    check(
      'Buyer status API returns claim_allowed: true & inactive',
      v2StatusLive.status === 200 &&
      v2StatusLive.json?.code === existingV2Card &&
      v2StatusLive.json?.claim_allowed === true &&
      v2StatusLive.json?.activation_state === 'inactive'
    );

    // 7k. Anonymous Admin Protection
    const anonAdminSession = await get('/api/v2-admin?action=session');
    check('Anonymous admin session is rejected with HTTP 401', anonAdminSession.status === 401);

    const anonAdminCreate = await post('/api/v2-admin?action=create', { quantity: 1 });
    check('Anonymous admin create is rejected with HTTP 401', anonAdminCreate.status === 401);

    // 7l. Anonymous Buyer Claim Protection
    const anonBuyerClaim = await post('/api/buyer', {
      action: 'first-claim',
      card_code: existingV2Card,
      business_name: 'Test Business',
      review_url: 'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'
    }, { origin, 'x-buyer-request': '1' });
    check('Anonymous buyer claim is rejected with HTTP 401 or 403', [401, 403].includes(anonBuyerClaim.status));

    // 8. Database Integrity Verification Post-Promotion
    console.log('\n--- 8. Database Integrity Verification Postflight ---');
    const postDbRaw = await psql(`
      SELECT json_build_object(
        'total_cards', (SELECT count(*) FROM public.card),
        'pilot_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = '${pilotCard}'),
        'target_unclaimed', (SELECT v2_activated_at IS NULL FROM public.card WHERE card_code = '${existingV2Card}'),
        'legacy_001_intact', (SELECT count(*) = 1 FROM public.card WHERE card_code = '001')
      )::text;
    `);
    const postDb = JSON.parse(postDbRaw.split(/\r?\n/).find(l => l.trim().startsWith('{')));
    console.log('Database postflight status:', postDb);
    check('Postflight: Database total cards remains exactly 9', postDb.total_cards === 9);
    check('Postflight: Pilot card remains active', postDb.pilot_active === true);
    check('Postflight: Existing V2 card remains unclaimed', postDb.target_unclaimed === true);
    check('Postflight: Legacy card 001 intact', postDb.legacy_001_intact === true);

    report.status = 'PROMOTION_SUCCESSFUL_VERIFIED';
    report.completedAt = new Date().toISOString();
    save();

    console.log('\n======================================================');
    console.log('   PRODUCTION PROMOTION COMPLETED WITH 100% PASS      ');
    console.log('   Active Deployment: ' + candidate);
    console.log('   Production Domain: ' + origin);
    console.log('======================================================');
  } catch (err) {
    console.error('\nPROMOTION RUN ENCOUNTERED AN ERROR:', err.message);
    report.status = 'PROMOTION_FAILED';
    report.error = err.message;
    save();

    if (report.activeAfterPromote?.active?.id === candidate) {
      console.log('Attempting emergency rollback to baseline...');
      await rollbackToBaseline();
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal promotion error:', err);
  process.exit(1);
});
