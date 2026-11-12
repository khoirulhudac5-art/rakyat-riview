import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

import { readAdminEnv, adminConfigStatus } from './admin-readonly-config.mjs';

const seal = 'f4369de7ebc069a9961071c21207da7447246b74eb32ba1a484654921fb58b45';
const folder = path.resolve('.backups/v2-dashboard-release-2026-11-09T18-54-28-165Z');
const root = path.join(folder, 'release');
const activeProductionId = 'dpl_EXmyu7nn4byNTbpRApXCrZRRfm7k';
const origin = 'https://rakyat-riview.vercel.app';
const project = 'prj_BdqElWlwjelD7zwY6pPZiABHYX9E';
const scope = 'rakprem';
const binary = path.resolve('.local-tools/npm-cache/_npx/69f9afb961c37556/node_modules/vercel/dist/vc.js');
const psqlBin = path.resolve('.backups/tooling/pgsql/bin');
const sha = b => createHash('sha256').update(b).digest('hex');

const targetCard = 'LBWJJDA8';
const pilotCard = 'iKRb7_7PyK6kg4Ye7EqvOhYu';

async function psql(query, retries = 3) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=on -c lock_timeout=3000 -c statement_timeout=15000',
    PGAPPNAME: 'rr-verify-dashboard'
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
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
    } catch (e) {
      if (attempt === retries) throw e;
      console.warn(`[PSQL RETRY] Attempt ${attempt} failed: ${e.message}. Retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function cli(args, timeout = 300000, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => {
      done = true;
      child.kill();
      reject(new Error('CLI timeout after ' + timeout + 'ms'));
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
  if (res.code !== 0) throw new Error('API ' + url + ' failed: ' + res.stderr);
  try { return JSON.parse(res.stdout); } catch { throw new Error('API ' + url + ' returned non-JSON: ' + res.stdout.slice(0, 200)); }
};

async function get(url, headers = {}) {
  const r = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  let json = null;
  const body = await r.text();
  try { json = JSON.parse(body); } catch {}
  return { status: r.status, headers: r.headers, body, json, location: r.headers.get('location') };
}

async function post(url, body = {}, headers = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      'x-buyer-request': '1',
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
  console.log('=== V2 BUYER DASHBOARD CANDIDATE DEPLOYMENT & PROMOTION ===\n');

  const evidence = path.resolve('.backups/v2-dashboard-deploy-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(evidence, { recursive: true });

  const report = {
    status: 'STARTING',
    at: new Date().toISOString(),
    baseline: activeProductionId,
    project,
    evidence,
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

  // 1. Verify artifact seal
  console.log('1. Verifying release artifact seal...');
  const manifestBytes = fs.readFileSync(path.join(folder, 'ARTIFACT-MANIFEST.json'));
  const actualSeal = sha(manifestBytes);
  check('Artifact seal matches expected', actualSeal === seal, actualSeal.slice(0, 16));

  // 2. Verify active production deployment before release
  console.log('2. Verifying active production deployment...');
  const activeProd = await api('/v13/deployments/rakyat-riview.vercel.app');
  check('Active production deployment matches expected baseline', activeProd.id === activeProductionId, activeProd.id);

  // 3. Preflight database check
  console.log('3. Preflight database check...');
  const dbPreRaw = await psql(`
    SELECT json_build_object(
      'total_cards', (SELECT count(*) FROM public.card),
      'lbwjjda8_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = '${targetCard}'),
      'lbwjjda8_owner', (SELECT user_id FROM public.buyer_card_ownership WHERE card_code = '${targetCard}')
    )::text;
  `);
  const dbPre = JSON.parse(dbPreRaw.split(/\r?\n/).find(l => l.trim().startsWith('{')));
  check('Database total cards is 10', dbPre.total_cards === 10);
  check('Target card LBWJJDA8 is active', dbPre.lbwjjda8_active === true);
  check('Target card owner is recorded', dbPre.lbwjjda8_owner === '4ab200cb-2ccd-4a2e-90a3-85f7d16e5893');

  // 4. Candidate deployment
  const candidateId = 'dpl_688bSUnLPMcAxBLatpP5Wg7biACV';
  const candidateUrl = 'https://rakyat-riview-dlvf3sv0f-rakprem.vercel.app';
  console.log('\n4. Using verified candidate deployment:', candidateId, candidateUrl);
  report.candidateId = candidateId;
  report.candidateUrl = candidateUrl;
  save();

  async function vcCurl(route, flags = []) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [binary, 'curl', route, '--deployment', candidateUrl, '--scope', scope, '-s', '-w', '\nHTTP_STATUS:%{http_code}', ...flags], {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '', err = '', done = false;
      const timer = setTimeout(() => {
        done = true;
        child.kill();
        reject(new Error('CLI timeout'));
      }, 30000);
      child.stdout.on('data', b => out += b);
      child.stderr.on('data', b => err += b);
      child.on('close', code => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const lines = out.split('\n');
        const statusLine = lines.pop() || '';
        const statusMatch = statusLine.match(/HTTP_STATUS:(\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : (code === 0 ? 200 : 500);
        resolve({ code, status, body: lines.join('\n') });
      });
    });
  }

  // 5. Verification on Candidate Deployment
  console.log('\n--- 5. Verifying Candidate Deployment ---');
  const candDashboard = await vcCurl('/dashboard.html');
  check('Candidate /dashboard.html loads HTTP 200', candDashboard.status === 200);

  const candJs = await vcCurl('/assets/buyer.js');
  check(
    'Candidate /assets/buyer.js contains modern dashboard code',
    candJs.status === 200 &&
    candJs.body.includes('DASHBOARD PEMBELI') &&
    candJs.body.includes('google-alert-banner') &&
    candJs.body.includes('btn-logout')
  );

  const candCss = await vcCurl('/assets/buyer.css');
  check('Candidate /assets/buyer.css loads HTTP 200', candCss.status === 200 && candCss.body.includes('workspace-user-card'));

  const candAnon = await vcCurl('/api/buyer?action=session');
  check('Candidate rejects anonymous buyer session with HTTP 401', candAnon.status === 401);

  // 6. Promote Candidate to Production
  console.log(`\n6. Promoting candidate ${candidateId} to production domain...`);
  report.status = 'PROMOTING';
  save();

  const promoteRes = await cli(['promote', candidateId, '--scope', scope, '--yes']);
  check('Promote CLI exited with code 0', promoteRes.code === 0);

  console.log('Waiting 8s for edge propagation...');
  await new Promise(r => setTimeout(r, 8000));

  // 7. Verify Active Production Deployment
  console.log('7. Verifying active production deployment after promote...');
  const postProd = await api('/v13/deployments/rakyat-riview.vercel.app');
  check('Candidate is now serving production domain', postProd.id === candidateId, postProd.id);

  // 8. Live Postflight Verification on https://rakyat-riview.vercel.app
  console.log('\n--- 8. Live Production Verification (https://rakyat-riview.vercel.app) ---');

  const prodDash = await get(origin + '/dashboard.html');
  check('Production /dashboard.html loads HTTP 200', prodDash.status === 200);

  const prodKartu = await get(origin + '/kartu.html');
  check('Production /kartu.html loads HTTP 200 with redirect to dashboard', prodKartu.status === 200 && prodKartu.body.includes('/dashboard.html'));

  const prodJs = await get(origin + '/assets/buyer.js');
  check(
    'Production /assets/buyer.js contains refined dashboard logic',
    prodJs.status === 200 &&
    prodJs.body.includes('DASHBOARD PEMBELI') &&
    prodJs.body.includes('google-alert-banner') &&
    prodJs.body.includes('btn-copy') &&
    prodJs.body.includes('btn-logout')
  );

  const prodCss = await get(origin + '/assets/buyer.css');
  check('Production /assets/buyer.css contains mobile and responsive styles', prodCss.status === 200 && prodCss.body.includes('google-alert-banner'));

  // Pilot card redirect
  const pilotLive = await get(origin + '/r/' + pilotCard);
  check(
    'Pilot card redirects HTTP 302 to Google Review',
    pilotLive.status === 302 && pilotLive.location?.includes('search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE')
  );

  // Target card LBWJJDA8 routing page
  const targetLive = await get(origin + '/r/' + targetCard);
  check('Card LBWJJDA8 routing page loads HTTP 200', targetLive.status === 200);

  // Anonymous API protection
  const anonSession = await get(origin + '/api/buyer?action=session');
  check('Anonymous session rejected with HTTP 401', anonSession.status === 401);

  const anonCards = await get(origin + '/api/buyer?action=cards');
  check('Anonymous cards listing rejected with HTTP 401', anonCards.status === 401);

  const anonUpdate = await post(origin + '/api/buyer', {
    action: 'update',
    card_code: targetCard,
    business_name: 'Hacked',
    review_url: 'https://search.google.com/local/writereview?placeid=ChIJw73p24BC1i0R2jo9I4cr2qs'
  });
  check('Anonymous card update rejected with HTTP 401 or 403', [401, 403].includes(anonUpdate.status));

  // Admin V2 integrity
  const adminPage = await get(origin + '/admin-v2.html');
  check('Admin V2 page loads HTTP 200', adminPage.status === 200 && adminPage.body.includes('Admin V2'));

  // 9. Database Postflight Integrity Check
  console.log('\n--- 9. Database Integrity Postflight ---');
  const dbPostRaw = await psql(`
    SELECT json_build_object(
      'total_cards', (SELECT count(*) FROM public.card),
      'lbwjjda8_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = '${targetCard}'),
      'lbwjjda8_owner', (SELECT user_id FROM public.buyer_card_ownership WHERE card_code = '${targetCard}'),
      'pilot_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = '${pilotCard}')
    )::text;
  `);
  const dbPost = JSON.parse(dbPostRaw.split(/\r?\n/).find(l => l.trim().startsWith('{')));
  check('Postflight: Total cards remains exactly 10', dbPost.total_cards === 10);
  check('Postflight: Card LBWJJDA8 remains active', dbPost.lbwjjda8_active === true);
  check('Postflight: Card LBWJJDA8 ownership unchanged', dbPost.lbwjjda8_owner === '4ab200cb-2ccd-4a2e-90a3-85f7d16e5893');
  check('Postflight: Pilot card remains active', dbPost.pilot_active === true);

  // ACL assertion check
  await psql('SELECT rr_v2_test.assert_acl();');
  check('Postflight: rr_v2_test.assert_acl() passes', true);

  report.status = 'SUCCESSFUL_AND_VERIFIED';
  report.completedAt = new Date().toISOString();
  save();

  console.log('\n=============================================================');
  console.log('   V2 BUYER DASHBOARD DEPLOYED & VERIFIED TO PRODUCTION      ');
  console.log('   Active Deployment: ' + candidateId);
  console.log('   Production Domain: ' + origin);
  console.log('=============================================================');
}

main().catch(async err => {
  console.error('\nDEPLOYMENT FAILED:', err.message);
  process.exit(1);
});
