// Exactly one promotion execution for candidate dpl_ESTkbP9VmNQHjmonvR9iC5omey3k.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {verifyAdminArtifact} from './deploy-admin-production.mjs';
import {runAdminSessionPostflight} from './admin-postflight-diagnostics.mjs';

const project = 'prj_BdqElWlwjelD7zwY6pPZiABHYX9E';
const team = 'team_sbndPkxC8tcwQtlNLm0rN3Yg';
const candidate = 'dpl_ESTkbP9VmNQHjmonvR9iC5omey3k';
const reader = 'dpl_6bSToPRzkLAtApYtqXTMn4jkXwiy';
const release = path.resolve('.backups/admin-production-release-2026-11-09T07-53-01-451Z');
const cwd = path.join(release, 'release');
const output = path.join(cwd, '.vercel/output');
const origin = 'https://rakyat-riview.vercel.app';
const binary = path.resolve('.local-tools/npm-cache/_npx/69f9afb961c37556/node_modules/vercel/dist/vc.js');
const sha = (b, algorithm = 'sha256') => createHash(algorithm).update(b).digest('hex');

export function observedState(s) {
  if (s.active?.projectId !== project || s.projectId !== project || s.active?.state !== 'READY') return 'UNKNOWN';
  if (s.active.id === reader && s.productionTarget === reader) return 'READER';
  if (s.active.id === candidate && s.productionTarget === candidate) return 'CANDIDATE';
  return 'UNKNOWN';
}

export function reconcileExit(exitCode, state, baselinePass) {
  if (state === 'READER' && baselinePass) return 'READER_VERIFIED';
  if (state === 'CANDIDATE' && baselinePass) return 'CANDIDATE_VERIFIED';
  return 'NOT_VERIFIED';
}

async function cli(args, timeout = 90000) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [binary, ...args], {cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({exitCode: null, timedOut: true});
    }, timeout);
    child.stdout.on('data', b => stdout += b);
    child.stderr.on('data', () => {});
    child.on('error', () => finish({exitCode: 127, startFailed: true}));
    child.on('close', exitCode => {
      let data;
      try { data = JSON.parse(stdout); } catch {}
      const timedOut = /timeout|timed out|timed_out/i.test([data?.reason, data?.message, data?.error?.code, data?.error?.message].filter(x => typeof x === 'string').join(' '));
      finish({exitCode, data, timedOut});
    });
  });
}

async function api(url) {
  const r = await cli(['api', url, '--method', 'GET', '--scope', 'rakprem']);
  if (r.exitCode !== 0 || !r.data) throw Error('READ_ONLY_METADATA_FAILED');
  return r.data;
}

const dep = d => ({id: d.id, projectId: d.projectId, state: d.readyState, aliases: d.alias || []});

async function observe(envHash) {
  const [active, p, e] = await Promise.all([
    api('/v13/deployments/rakyat-riview.vercel.app'),
    api('/v9/projects/' + project),
    api('/v10/projects/' + project + '/env?decrypt=false')
  ]);
  const metadata = (e.envs || []).map(x => ({id: x.id, key: x.key, target: x.target, type: x.type, updatedAt: x.updatedAt})).sort((a, b) => a.id.localeCompare(b.id));
  const hash = sha(JSON.stringify(metadata));
  return {
    at: new Date().toISOString(),
    active: dep(active),
    projectId: p.id,
    accountId: p.accountId,
    productionTarget: p.targets?.production?.id,
    autoAssignCustomDomains: p.autoAssignCustomDomains,
    environmentMetadataSHA256: hash,
    environmentUnchanged: envHash ? hash === envHash : true
  };
}

async function get(route, headers = {}) {
  const r = await fetch(origin + route, {headers, redirect: 'manual', signal: AbortSignal.timeout(20000)});
  return {status: r.status, headers: r.headers, body: await r.text(), location: r.headers.get('location')};
}

const expectedRoutes = [
  {path: '/', expected: 200},
  {path: '/admin.html', expected: 200},
  {path: '/admin-login.html', expected: 200},
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

async function baseline() {
  const checks = [];
  for (const b of expectedRoutes) {
    const r = await get(b.path);
    const pass = r.status === b.expected && (b.expected !== 302 || r.location?.includes('placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'));
    checks.push({path: b.path, status: r.status, pass});
  }
  return checks;
}

export async function main() {
  if (process.argv[2] !== '--approved-one-promotion') throw Error('Explicit promotion-only approval required');
  const folder = path.resolve('.backups/admin-promotion-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(folder);
  let promoted = false;

  const report = {
    status: 'PREFLIGHT',
    at: new Date().toISOString(),
    candidate,
    rollback: reader,
    project,
    promoteInvocations: 0,
    rollbackInvocations: 0,
    deployInvocations: 0,
    adminLoginPerformed: false,
    databaseChanges: false,
    observations: [],
    checks: []
  };
  const save = () => fs.writeFileSync(path.join(folder, 'RESULT.json'), JSON.stringify(report, null, 2));
  const progress = stage => console.log(JSON.stringify({stage, folder}));
  save();

  async function poll(wanted) {
    for (let n = 0; n < 5; n++) {
      try {
        const s = await observe(report.environmentMetadataSHA256);
        report.observations.push(s);
        save();
        if (observedState(s) === wanted) return s;
      } catch {
        report.metadataReadFailed = true;
        save();
      }
      if (n < 4) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return report.observations.at(-1);
  }

  async function recover() {
    report.phase = 'RECOVERY_RECONCILIATION';
    save();
    let s;
    try {
      s = await observe(report.environmentMetadataSHA256);
      report.observations.push(s);
      save();
    } catch {
      report.status = 'RECOVERY_STATE_UNKNOWN_STOP';
      return;
    }
    if (observedState(s) === 'CANDIDATE') {
      fs.writeFileSync(path.join(folder, 'ROLLBACK-ATTEMPT.json'), JSON.stringify({at: new Date().toISOString(), target: reader}), {flag: 'wx'});
      report.rollbackInvocations = 1;
      save();
      progress('APPROVED_READER_ROLLBACK');
      const r = await cli(['rollback', reader, '--scope', 'rakprem', '--cwd', cwd, '--yes', '--json', '--timeout', '60s'], 90000);
      report.rollbackCLI = {exitCode: r.exitCode, timedOut: !!r.timedOut, startFailed: !!r.startFailed};
      save();
      s = await poll('READER');
    } else if (observedState(s) !== 'READER') {
      report.status = 'RECOVERY_UNEXPECTED_ACTIVE_DEPLOYMENT_STOP';
      return;
    }
    if (observedState(s) !== 'READER') {
      report.status = 'RECOVERY_NOT_VERIFIED_STOP_NO_RETRY';
      return;
    }
    report.recoveryBaseline = await baseline();
    const pass = report.recoveryBaseline.every(c => c.pass);
    report.status = reconcileExit(report.rollbackCLI?.exitCode, observedState(s), pass) === 'READER_VERIFIED' ? 'FAILED_POSTFLIGHT_READER_VERIFIED' : 'RECOVERY_BASELINE_FAILED_STOP';
  }

  try {
    // 1. Verify artifact and preflight
    verifyAdminArtifact();
    const [c, r, teams] = await Promise.all([
      api('/v13/deployments/' + candidate),
      api('/v13/deployments/' + reader),
      api('/v2/teams')
    ]);
    if (c.id !== candidate || c.projectId !== project || c.readyState !== 'READY' || c.target !== 'production') {
      throw Error('CANDIDATE_NOT_READY');
    }
    if (r.id !== reader || r.projectId !== project || r.readyState !== 'READY') {
      throw Error('READER_NOT_READY');
    }
    if (!teams.teams?.some(t => t.id === team && t.slug === 'rakprem')) {
      throw Error('TEAM_MISMATCH');
    }

    const before = await observe();
    report.observations.push(before);
    report.environmentMetadataSHA256 = before.environmentMetadataSHA256;
    if (observedState(before) !== 'READER') throw Error('ACTIVE_NOT_READER');

    report.preflightBaseline = await baseline();
    if (!report.preflightBaseline.every(c => c.pass)) throw Error('BASELINE_DRIFT');

    fs.writeFileSync(path.join(release, 'APPROVED-ONE-PROMOTION.json'), JSON.stringify({at: new Date().toISOString(), candidate, reader, project, evidence: folder}), {flag: 'wx'});
    report.phase = 'PROMOTE';
    report.promoteInvocations = 1;
    save();
    promoted = true;
    progress('PREFLIGHT_PASS_PROMOTING_ONCE');

    // 2. Promote candidate ONCE
    const action = await cli(['promote', candidate, '--scope', 'rakprem', '--cwd', cwd, '--yes', '--json', '--timeout', '60s'], 90000);
    report.promotionCLI = {exitCode: action.exitCode, timedOut: !!action.timedOut, startFailed: !!action.startFailed};
    save();

    // 3. Poll for candidate to become active
    const active = await poll('CANDIDATE');
    if (observedState(active) !== 'CANDIDATE') throw Error('PROMOTION_NOT_ACTIVE');

    report.phase = 'ADMIN_SESSION_POSTFLIGHT';
    save();
    progress('CANDIDATE_ACTIVE_CHECKING_ANONYMOUS_SESSION');

    // 4. Test GET /api/v2-admin?action=session on canonical production domain
    const anonymous = await runAdminSessionPostflight(report, () => get('/api/v2-admin?action=session'), save);
    const check = (name, pass) => {
      report.checks.push({name, pass: !!pass});
      save();
      if (!pass) throw Error('HTTP_CHECK_FAILED: ' + name);
    };

    // Anonymous session MUST be 401
    check('Admin anonymous session HTTP 401', anonymous.status === 401);
    const profile = JSON.parse(anonymous.body);
    check('Admin real read-only mode', profile.mode === 'admin_readonly' && profile.data_source === 'supabase' && profile.read_only === true && profile.capabilities?.create === false && profile.capabilities?.reset === false);
    check('Admin no-store response', (anonymous.headers.get('cache-control') || '').includes('no-store'));
    const cookie = anonymous.headers.get('set-cookie') || '';
    check('Admin secure cookie clearing', cookie.startsWith('__Host-rr_admin_v2=;') && ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=0'].every(x => cookie.includes(x)));

    // 5. Test baseline routes on canonical domain
    report.postflightBaseline = await baseline();
    check('all V1/buyer/redirect baseline checks', report.postflightBaseline.every(c => c.pass));

    // 6. Test Admin static assets on canonical domain
    for (const f of ['admin-v2.html', 'assets/admin-v2.js', 'assets/admin-v2.css']) {
      const response = await get('/' + f);
      check('Admin asset ' + f, response.status === 200 && sha(response.body) === sha(fs.readFileSync(path.join(output, 'static', f))));
      if (f === 'admin-v2.html') {
        check('Admin framing blocked', (response.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));
      }
    }

    // 7. Security rejection checks
    for (const c of ['rr_buyer_a=not-an-admin', '__Host-rr_admin_v2=forged']) {
      for (const act of ['cards', 'audit']) {
        check('Non-Admin ' + act + ' denied', (await get('/api/v2-admin?action=' + act, {Cookie: c})).status === 401);
      }
    }
    check('Cross-origin denied', (await get('/api/v2-admin?action=session', {Origin: 'https://outside.example'})).status === 403);

    for (const f of ['/.env.admin-readonly', '/.env.backup', '/lib/admin-production.mjs', '/internal-admin/lib/admin-production.mjs', '/scripts/deploy-admin-production.mjs']) {
      check('Private path ' + f, [403, 404].includes((await get(f)).status));
    }

    const final = await observe(report.environmentMetadataSHA256);
    report.observations.push(final);
    if (observedState(final) !== 'CANDIDATE') throw Error('FINAL_ACTIVE_DRIFT');

    report.phase = 'COMPLETE';
    report.status = 'PROMOTION_POSTFLIGHT_PASS_MANUAL_LOGIN_PENDING';
  } catch (err) {
    report.failedAt = new Date().toISOString();
    report.failure = {phase: report.phase || 'PREFLIGHT', error: err.message, category: report.adminSessionPostflight?.category || 'CONTROLLED_CHECK_FAILED'};
    save();
    if (promoted) {
      progress('CRITICAL_CHECK_FAILED_RECONCILING_READER_RECOVERY');
      try { await recover(); } catch { report.status = 'RECOVERY_INCOMPLETE_STOP_NO_RETRY'; }
    } else {
      report.status = 'PREFLIGHT_FAILED_NO_PROMOTION';
    }
  }

  report.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({
    status: report.status,
    folder,
    promoteInvocations: report.promoteInvocations,
    rollbackInvocations: report.rollbackInvocations,
    adminSessionStatus: report.adminSessionPostflight?.status,
    active: report.observations.at(-1)?.active?.id
  }, null, 2));

  if (report.status !== 'PROMOTION_POSTFLIGHT_PASS_MANUAL_LOGIN_PENDING') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
