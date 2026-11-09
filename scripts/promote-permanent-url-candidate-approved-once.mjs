// Exactly one promotion execution for candidate dpl_EppErAVYiwC8k3t1ZJWjY12rj3tX.
// Uses verified release artifact 252ee38b5babc5249361371bc127fa073b9f3ac11285e9df17ba96cee316929c.
// Approved by user request. Never creates a new deployment.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const project = 'prj_BdqElWlwjelD7zwY6pPZiABHYX9E';
const team = 'team_sbndPkxC8tcwQtlNLm0rN3Yg';
const scope = 'rakprem';
const candidate = 'dpl_GCL76P1a8iXKYHHFX8zhgaRjbuGf';
const baseline = 'dpl_ESTkbP9VmNQHjmonvR9iC5omey3k';
const readerFallback = 'dpl_6bSToPRzkLAtApYtqXTMn4jkXwiy';
const releaseFolder = path.resolve('.backups/admin-production-release-2026-11-09T08-55-58-624Z');
const root = path.join(releaseFolder, 'release');
const output = path.join(root, '.vercel/output');
const origin = 'https://rakyat-riview.vercel.app';
const binary = path.resolve('.local-tools/npm-cache/_npx/69f9afb961c37556/node_modules/vercel/dist/vc.js');
const expectedSeal = '252ee38b5babc5249361371bc127fa073b9f3ac11285e9df17ba96cee316929c';
const sha = b => createHash('sha256').update(b).digest('hex');

async function cli(args, timeout = 90000) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [binary, ...args], {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '', done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({exitCode: null, timedOut: true, stdout, stderr});
    }, timeout);
    child.stdout.on('data', b => stdout += b);
    child.stderr.on('data', b => stderr += b);
    child.on('error', err => finish({exitCode: 127, startFailed: true, error: err.message}));
    child.on('close', exitCode => {
      let data;
      try { data = JSON.parse(stdout); } catch {}
      finish({exitCode, data, stdout: stdout.trim(), stderr: stderr.trim()});
    });
  });
}

async function api(url) {
  const r = await cli(['api', url, '--method', 'GET', '--scope', scope]);
  if (r.exitCode !== 0 || !r.data) throw Error('Vercel API query failed: ' + url + ' (' + r.stderr + ')');
  return r.data;
}

const dep = d => ({id: d.id || d.uid, projectId: d.projectId, state: d.readyState || d.state, aliases: d.alias || []});

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

function observedState(s) {
  if (s.active?.projectId !== project || s.projectId !== project || s.active?.state !== 'READY') return 'UNKNOWN';
  if (s.active.id === baseline && s.productionTarget === baseline) return 'BASELINE';
  if (s.active.id === candidate && s.productionTarget === candidate) return 'CANDIDATE';
  return 'UNKNOWN';
}

async function get(route, headers = {}) {
  const r = await fetch(origin + route, {headers, redirect: 'manual', signal: AbortSignal.timeout(20000)});
  return {status: r.status, headers: r.headers, body: await r.text(), location: r.headers.get('location')};
}

const baselineChecks = [
  {path: '/', expected: 200},
  {path: '/admin.html', expected: 200},
  {path: '/admin-login.html', expected: 200},
  {path: '/admin-v2.html', expected: 200},
  {path: '/aktivasi.html', expected: 200},
  {path: '/r/RRROUTECHECK0000000000000', expected: 200},
  {path: '/r/iKRb7_7PyK6kg4Ye7EqvOhYu', expected: 302},
  {path: '/dashboard.html', expected: 200},
  {path: '/kartu.html', expected: 200},
  {path: '/pembeli/index.html', expected: 200},
  {path: '/pembeli/mulai.html', expected: 200},
  {path: '/pembeli/oauth.html', expected: 200},
  {path: '/api/buyer?action=mode', expected: 200},
  {path: '/api/buyer?action=session', expected: 401},
  {path: '/api/buyer?action=cards', expected: 401}
];

async function runRegression() {
  const results = [];
  for (const b of baselineChecks) {
    const r = await get(b.path);
    const pass = r.status === b.expected && (b.expected !== 302 || r.location?.includes('placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'));
    results.push({path: b.path, status: r.status, location: r.location, pass});
  }
  return results;
}

export async function main() {
  const evidence = path.resolve('.backups/admin-promotion-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(evidence, {recursive: true});

  const report = {
    status: 'PROMOTION_STARTING',
    at: new Date().toISOString(),
    candidate,
    baseline,
    readerFallback,
    project,
    evidence,
    promoteInvocations: 0,
    rollbackInvocations: 0,
    checks: []
  };
  const save = () => fs.writeFileSync(path.join(evidence, 'RESULT.json'), JSON.stringify(report, null, 2));
  save();

  const check = (name, pass) => {
    report.checks.push({name, pass: !!pass});
    save();
    console.log(`[CHECK] ${name}: ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) throw Error('CRITICAL_CHECK_FAILED: ' + name);
  };

  async function pollState(targetState, maxSeconds = 30) {
    const start = Date.now();
    while (Date.now() - start < maxSeconds * 1000) {
      try {
        const s = await observe();
        report.lastObserved = s;
        save();
        if (observedState(s) === targetState) return s;
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
    return report.lastObserved;
  }

  async function rollbackToBaseline() {
    console.log('Initiating emergency rollback to baseline', baseline, '...');
    report.rollbackInvocations++;
    save();
    const action = await cli(['promote', baseline, '--scope', scope, '--yes']);
    report.rollbackCLI = action;
    save();
    // Wait for edge sync
    await new Promise(r => setTimeout(r, 8000));
    const finalState = await pollState('BASELINE', 20);
    const recovered = observedState(finalState) === 'BASELINE';
    report.rollbackSuccess = recovered;
    save();
    console.log('Rollback to', baseline, recovered ? 'SUCCEEDED' : 'FAILED');
    return recovered;
  }

  let promoted = false;

  try {
    // 1. Verify artifact seal
    console.log('Verifying release artifact seal...');
    const manifestPath = path.join(releaseFolder, 'ARTIFACT-MANIFEST.json');
    if (!fs.existsSync(manifestPath)) throw Error('Artifact manifest missing');
    const seal = sha(fs.readFileSync(manifestPath));
    check('Artifact seal matches expected SHA-256', seal === expectedSeal);

    // 2. Verify candidate status on Vercel
    console.log('Verifying candidate deployment', candidate, '...');
    const candidateData = await api('/v13/deployments/' + candidate);
    check('Candidate exists and matches project', candidateData.id === candidate && candidateData.projectId === project);
    check('Candidate state is READY', candidateData.readyState === 'READY');
    check('Candidate target is production', candidateData.target === 'production');

    // 3. Verify currently active production deployment
    console.log('Verifying current production baseline...');
    const currentObs = await observe();
    check('Production active deployment is baseline ' + baseline, currentObs.active.id === baseline);
    check('Production target is baseline ' + baseline, currentObs.productionTarget === baseline);

    // 4. Run preflight HTTP baseline
    console.log('Running preflight regression checks...');
    const preflight = await runRegression();
    check('All preflight regression routes pass', preflight.every(c => c.pass));
    report.preflightResults = preflight;
    save();

    // 5. Execute SINGLE promotion
    console.log('Executing ONE-TIME promotion of candidate', candidate, '...');
    report.promoteInvocations = 1;
    promoted = true;
    save();

    const promoteRes = await cli(['promote', candidate, '--scope', scope, '--yes']);
    report.promoteCLI = {
      exitCode: promoteRes.exitCode,
      stdout: promoteRes.stdout,
      stderr: promoteRes.stderr
    };
    save();
    console.log('Promote command exited with code:', promoteRes.exitCode);

    // 6. Wait for edge synchronization and poll state
    console.log('Waiting for edge routing synchronization...');
    await new Promise(r => setTimeout(r, 8000));

    const postState = await pollState('CANDIDATE', 30);
    check('Production target and active deployment updated to candidate ' + candidate, observedState(postState) === 'CANDIDATE');

    // 7. Postflight: Probe anonymous session on canonical domain
    console.log('Probing anonymous Admin V2 session on canonical domain...');
    let sessionRes = await get('/api/v2-admin?action=session');
    // Edge sync retry if needed
    if (sessionRes.status === 404 || sessionRes.status === 503) {
      console.log('Initial probe returned', sessionRes.status, '- waiting 5s for edge cache propagation...');
      await new Promise(r => setTimeout(r, 5000));
      sessionRes = await get('/api/v2-admin?action=session');
    }

    check('Admin V2 anonymous session returns HTTP 401 (not 403 or 503)', sessionRes.status === 401);
    const sessionProfile = JSON.parse(sessionRes.body);
    check('Admin V2 read-only profile intact', sessionProfile.mode === 'admin_readonly' && sessionProfile.read_only === true && sessionProfile.data_source === 'supabase');

    // 8. Postflight: Verify frontend production loads permanent URL fix
    console.log('Verifying production frontend static assets...');
    const adminJsRes = await get('/assets/admin-v2.js');
    check('Admin V2 JS returns HTTP 200', adminJsRes.status === 200);
    check('Admin V2 JS contains permanentUrl canonical fallback fix', adminJsRes.body.includes('location.origin===canonical') && adminJsRes.body.includes('permanentUrl'));

    const adminHtmlRes = await get('/admin-v2.html');
    check('Admin V2 HTML returns HTTP 200', adminHtmlRes.status === 200);
    check('Admin V2 HTML framing blocked via CSP', (adminHtmlRes.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));

    // 9. Postflight: Pilot 302 redirect & full regression suite
    console.log('Running postflight HTTP regression on canonical domain...');
    const postflight = await runRegression();
    report.postflightResults = postflight;
    save();
    check('All postflight regression checks pass (V1, V2, buyer, pilot 302)', postflight.every(c => c.pass));

    // 10. Security rejection checks
    const buyerDenied = await get('/api/v2-admin?action=cards', {Cookie: 'rr_buyer_a=not-an-admin'});
    check('Buyer cookie denied Admin inventory with 401', buyerDenied.status === 401);

    const crossOrigin = await get('/api/v2-admin?action=session', {Origin: 'https://outside.example'});
    check('Cross-origin request denied with 403', crossOrigin.status === 403);

    report.status = 'PROMOTION_SUCCESS_VERIFIED';
    report.finishedAt = new Date().toISOString();
    save();
    console.log('SUCCESS: Candidate', candidate, 'is live on https://rakyat-riview.vercel.app and fully verified!');
  } catch (err) {
    console.error('PROMOTION ERROR:', err.message);
    report.status = 'PROMOTION_FAILED';
    report.error = err.message;
    save();
    if (promoted) {
      await rollbackToBaseline();
    }
    process.exitCode = 1;
  }

  console.log(JSON.stringify({
    status: report.status,
    activeDeployment: report.lastObserved?.active?.id,
    checksPassed: report.checks.filter(c => c.pass).length,
    checksFailed: report.checks.filter(c => !c.pass).length,
    rollbackInvocations: report.rollbackInvocations,
    evidence
  }, null, 2));
}

await main();
