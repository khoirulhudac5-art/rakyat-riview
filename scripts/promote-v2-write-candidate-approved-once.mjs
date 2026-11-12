import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const project = 'prj_BdqElWlwjelD7zwY6pPZiABHYX9E';
const scope = 'rakprem';
const candidate = 'dpl_HxedAqfQ3g2hDGUu3drTXCgTNCAS';
const baseline = 'dpl_GCL76P1a8iXKYHHFX8zhgaRjbuGf';
const safeRollbackTarget = 'dpl_ESTkbP9VmNQHjmonvR9iC5omey3k';
const releaseFolder = path.resolve('.backups/admin-production-release-2026-11-09T12-06-09-009Z');
const root = path.join(releaseFolder, 'release');
const origin = 'https://rakyat-riview.vercel.app';
const binary = path.resolve('.local-tools/npm-cache/_npx/69f9afb961c37556/node_modules/vercel/dist/vc.js');
const expectedSeal = 'aba1f6867cc43eba343d8861b939b4e7f7c797450e6b7873a444eafef3b9c728';
const sha = b => createHash('sha256').update(b).digest('hex');

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
  const evidence = path.resolve('.backups/admin-promotion-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(evidence, { recursive: true });

  const report = {
    status: 'PROMOTION_STARTING',
    at: new Date().toISOString(),
    candidate,
    baseline,
    safeRollbackTarget,
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

  let promoted = false;

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

    // 3. Verify baseline deployment is READY and active
    console.log('3. Verifying baseline deployment...');
    const baselineData = await api('/v13/deployments/' + baseline);
    check('Baseline deployment exists and READY', baselineData.id === baseline && (baselineData.state === 'READY' || baselineData.readyState === 'READY'));
    const initialObs = await observe();
    check('Baseline is currently serving production', initialObs.active?.id === baseline);

    // 4. Execute Promotion of candidate deployment
    console.log(`4. Promoting candidate ${candidate} to production domain...`);
    report.promoteInvocations++;
    report.status = 'PROMOTING';
    save();

    const promoteRes = await cli(['promote', candidate, '--scope', scope, '--yes']);
    report.promoteCLI = promoteRes;
    save();
    if (promoteRes.exitCode !== 0) throw Error('Promotion command failed: ' + promoteRes.stderr);
    promoted = true;

    // Wait for edge sync
    console.log('Waiting for edge sync (8s)...');
    await new Promise(r => setTimeout(r, 8000));

    // 5. Verify active deployment is now candidate
    console.log('5. Verifying active production deployment...');
    let postState = await observe();
    for (let i = 0; i < 15; i++) {
      if (postState.active?.id === candidate) break;
      await new Promise(r => setTimeout(r, 2000));
      postState = await observe();
    }
    check('Candidate is now active on production domain', postState.active?.id === candidate);
    report.afterPromotion = postState;
    save();

    // 6. Post-promotion HTTP regression checks
    console.log('6. Running post-promotion HTTP regressions...');

    // A. Root page
    const rRoot = await get('/');
    check('Home page HTTP 200', rRoot.status === 200);

    // B. Admin V2 HTML
    const rAdminV2 = await get('/admin-v2.html');
    check('Admin V2 HTML shell HTTP 200', rAdminV2.status === 200 && rAdminV2.body.includes('Admin V2'));

    // C. Buyer activation wizard
    const rBuyerMulai = await get('/pembeli/mulai.html');
    check('Buyer activation page HTTP 200', rBuyerMulai.status === 200 && rBuyerMulai.body.includes('Token Aktivasi Rahasia'));

    // D. Pilot card HTTP 302 to Google Review
    const rPilot = await get('/r/iKRb7_7PyK6kg4Ye7EqvOhYu');
    check('Pilot card redirect HTTP 302', rPilot.status === 302 && rPilot.location === 'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE');

    // E. Anonymous Admin V2 session: must be HTTP 401 with write capabilities
    const rAdminSession = await get('/api/v2-admin?action=session');
    check('Anonymous Admin V2 session HTTP 401', rAdminSession.status === 401);
    check('Admin V2 mode is admin_production', rAdminSession.json?.mode === 'admin_production');
    check('Admin V2 read_only is false', rAdminSession.json?.read_only === false);
    check('Admin V2 capability create is true', rAdminSession.json?.capabilities?.create === true);
    check('Admin V2 capability reissue is true', rAdminSession.json?.capabilities?.reissue === true);
    check('Admin V2 capability idempotent_create is true', rAdminSession.json?.capabilities?.idempotent_create === true);

    // F. Mutation without session: must be rejected with HTTP 401
    const rCreateAnon = await post('/api/v2-admin?action=create', { quantity: 1, request_id: '00000000-0000-0000-0000-000000000000' });
    check('Anonymous create rejected with HTTP 401', rCreateAnon.status === 401);

    const rReissueAnon = await post('/api/v2-admin?action=reissue-token', { card_code: 'iKRb7_7PyK6kg4Ye7EqvOhYu' });
    check('Anonymous reissue rejected with HTTP 401', rReissueAnon.status === 401);

    // G. Buyer session: HTTP 401
    const rBuyerSession = await get('/api/buyer?action=session');
    check('Anonymous buyer session HTTP 401', rBuyerSession.status === 401);

    // H. Static shells intact
    const rAdminV1 = await get('/admin.html');
    check('Admin V1 HTML shell HTTP 200', rAdminV1.status === 200);

    const rDashboard = await get('/dashboard.html');
    check('Buyer dashboard HTTP 200', rDashboard.status === 200);

    report.status = 'PROMOTION_SUCCESS';
    save();
    console.log('\n========================================');
    console.log('PROMOTION TO PRODUCTION COMPLETED SUCCESSFULLY!');
    console.log('Active Deployment:', candidate);
    console.log('Domain: https://rakyat-riview.vercel.app');
    console.log('All checks PASSED.');
    console.log('========================================');

  } catch (err) {
    console.error('\nPROMOTION ERROR:', err.message);
    report.status = 'PROMOTION_FAILED';
    report.error = err.message;
    save();

    if (promoted) {
      console.log('Regresion failed after promotion. Initiating automatic rollback...');
      try {
        await rollbackToBaseline();
      } catch (rbErr) {
        console.error('CRITICAL: Rollback failed:', rbErr.message);
      }
    }
    process.exit(1);
  }
}

main().catch(console.error);
