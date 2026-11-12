import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');

async function psql(query) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-promote-v2-card-flow'
  };

  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(psqlBin, 'psql.exe'),
      ['-X', '-q', '-w', '-A', '-c', query],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '', err = '';
    child.stdout.on('data', x => out += x);
    child.stderr.on('data', x => err += x);
    child.on('close', code => {
      if (code === 0) resolve(out.trim());
      else reject(Error(`psql failed (${code}): ${err}`));
    });
  });
}

const project = 'prj_BdqElWlwjelD7zwY6pPZiABHYX9E';
const scope = 'rakprem';
const candidate = 'dpl_3jws4ArwnvoRJAWVG9JT1Rraq5G1';
const baseline = 'dpl_HxedAqfQ3g2hDGUu3drTXCgTNCAS';
const releaseFolder = path.resolve('.backups/v2-card-flow-release-2026-11-09T13-47-53-313Z');
const root = path.join(releaseFolder, 'release');
const origin = 'https://rakyat-riview.vercel.app';
const binary = path.resolve('.local-tools/npm-cache/_npx/69f9afb961c37556/node_modules/vercel/dist/vc.js');
const expectedSeal = 'c6a3bbbdb4fc1a80ef383928daa86e205069a650d297807c530e051ef0ab4161';
const sha = b => createHash('sha256').update(b).digest('hex');

const targetCard = '1jb6cDk5ABDpacSkkHsq5T8i';
const pilotCard = 'iKRb7_7PyK6kg4Ye7EqvOhYu';

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
  if (r.exitCode !== 0 || !r.data) throw Error('Vercel API query failed: ' + url + ' (' + r.stderr + ')');
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
  const evidence = path.resolve('.backups/v2-promotion-' + new Date().toISOString().replace(/[:.]/g, '-'));
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

  const check = (name, pass) => {
    report.checks.push({ name, pass: !!pass });
    save();
    console.log(`[CHECK] ${name}: ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) throw Error('CRITICAL_CHECK_FAILED: ' + name);
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
    // 1. Verify artifact seal
    console.log('1. Verifying release artifact seal...');
    const manifestBytes = fs.readFileSync(path.join(releaseFolder, 'ARTIFACT-MANIFEST.json'));
    const manifestSeal = sha(manifestBytes);
    check('Release artifact seal matches', manifestSeal === expectedSeal);

    // 2. Verify candidate status is READY
    console.log('2. Verifying candidate deployment status...');
    const candidateData = await api('/v13/deployments/' + candidate);
    check('Candidate deployment exists and READY', candidateData.id === candidate && (candidateData.state === 'READY' || candidateData.readyState === 'READY'));

    // 3. Verify baseline deployment is active
    console.log('3. Verifying baseline deployment...');
    const initialObs = await observe();
    check('Baseline is currently serving production', initialObs.active?.id === baseline);

    // 4. Promote candidate
    console.log(`4. Promoting candidate ${candidate} to production domain...`);
    report.promoteInvocations++;
    report.status = 'PROMOTING';
    save();

    const promoteRes = await cli(['promote', candidate, '--scope', scope, '--yes']);
    report.promoteCLI = promoteRes;
    save();
    console.log('Promote CLI exit code:', promoteRes.exitCode, promoteRes.stdout);
    check('Promote CLI exited with 0', promoteRes.exitCode === 0);

    // Wait for DNS/routing update
    console.log('Waiting 6s for routing propagation...');
    await new Promise(r => setTimeout(r, 6000));

    // 5. Verify active deployment on production domain
    console.log('5. Verifying active production deployment...');
    const postObs = await observe();
    report.activeAfterPromote = postObs;
    save();
    console.log('Serving production now:', postObs.active?.id);
    check('Candidate is now serving production domain', postObs.active?.id === candidate);

    // 6. Postflight Verification on Live Production Domain
    console.log('\n--- Postflight Checks on https://rakyat-riview.vercel.app ---');

    // 6a. Pilot card HTTP 302 to Google Review
    const pilotLive = await get('/r/' + pilotCard);
    console.log('Pilot redirect status:', pilotLive.status, 'Location:', pilotLive.location);
    check('Pilot card returns HTTP 302 to Google Review', pilotLive.status === 302 && pilotLive.location?.includes('search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'));

    // 6b. V2 card routing page
    const v2PageLive = await get('/r/' + targetCard);
    console.log('V2 card /r/' + targetCard + ' status:', v2PageLive.status);
    check('V2 card page loads HTTP 200 with buyer_v2_public_card_status', v2PageLive.status === 200 && v2PageLive.body.includes('buyer_v2_public_card_status'));

    // 6c. /api/buyer-status for V2 card
    const v2StatusLive = await get('/api/buyer-status?card=' + targetCard);
    console.log('V2 card /api/buyer-status status:', v2StatusLive.status, 'JSON:', JSON.stringify(v2StatusLive.json));
    check('V2 card status is claim_allowed: true & inactive', v2StatusLive.status === 200 && v2StatusLive.json?.code === targetCard && v2StatusLive.json?.claim_allowed === true && v2StatusLive.json?.activation_state === 'inactive');

    // 6d. Buyer activation page
    const mulaiLive = await get('/pembeli/mulai.html?card=' + targetCard);
    console.log('Buyer wizard page status:', mulaiLive.status);
    check('Buyer wizard loads HTTP 200 with token input', mulaiLive.status === 200 && mulaiLive.body.includes('id="token"'));

    // 6e. Admin V2 page & Anonymous protection
    const adminPage = await get('/admin-v2.html');
    check('Admin V2 page loads HTTP 200', adminPage.status === 200 && adminPage.body.includes('Admin V2'));

    const anonAdmin = await get('/api/v2-admin?action=session');
    console.log('Anonymous admin session status:', anonAdmin.status);
    check('Anonymous admin session returns HTTP 401', anonAdmin.status === 401);

    const anonBuyerClaim = await post('/api/buyer', {
      action: 'first-claim',
      card_code: targetCard,
      activation_token: 'dummy-token',
      business_name: 'Test',
      review_url: 'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'
    }, { origin, 'x-buyer-request': '1' });
    console.log('Anonymous buyer claim status:', anonBuyerClaim.status);
    check('Anonymous buyer claim returns HTTP 401 or 403', [401, 403].includes(anonBuyerClaim.status));

    // 7. Verify Database Card State Unchanged
    console.log('\n--- Database Integrity Verification ---');
    const dbRaw = await psql(`
      SELECT json_build_object(
        'total_cards', (SELECT count(*) FROM public.card),
        'is_unclaimed', (SELECT v2_activated_at IS NULL FROM public.card WHERE card_code = '${targetCard}')
      )::text;
    `);
    console.log('Database integrity check result:', dbRaw);
    let dbParsed = {};
    try {
      // psql unaligned mode might include header line
      const lines = dbRaw.split(/\r?\n/).filter(l => l.trim().startsWith('{'));
      dbParsed = JSON.parse(lines[0] || dbRaw);
    } catch (e) {
      console.warn('JSON parse warning:', e.message);
    }
    check('Database total cards is 9 and target card is unclaimed', dbParsed.total_cards === 9 && dbParsed.is_unclaimed === true);

    report.status = 'PROMOTION_SUCCESSFUL_VERIFIED';
    save();
    console.log('\n=== PROMOTION & ALL LIVE CHECKS COMPLETED WITH 100% PASS ===');
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
