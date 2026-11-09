// Exactly one deployment candidate execution for permanent URL fix.
// Uses --skip-domain. Never promotes. Never touches production domain.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readAdminEnv, adminConfigStatus} from './admin-readonly-config.mjs';
import {verifyLocal} from './deploy-pilot-closed.mjs';

const seal = '252ee38b5babc5249361371bc127fa073b9f3ac11285e9df17ba96cee316929c';
const folder = path.resolve('.backups/admin-production-release-2026-11-09T08-55-58-624Z');
const root = path.join(folder, 'release');
const activeProductionId = 'dpl_ESTkbP9VmNQHjmonvR9iC5omey3k';
const readerRollbackId = 'dpl_6bSToPRzkLAtApYtqXTMn4jkXwiy';
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

const evidence = path.resolve('.backups/admin-candidate-deployment-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(evidence, {recursive: true});

const attempt = {
  status: 'CANDIDATE_DEPLOYMENT_STARTING',
  at: new Date().toISOString(),
  project,
  activeProductionId,
  readerRollbackId,
  seal,
  evidence
};
const save = () => fs.writeFileSync(path.join(evidence, 'RESULT.json'), JSON.stringify(attempt, null, 2));
save();

async function cli(args, timeout = 300000, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      cwd: root,
      env: {...process.env, ...env},
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
    child.on('error', err => {
      if (!done) { done = true; clearTimeout(timer); reject(err); }
    });
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({code, stdout: stdout.trim(), stderr: stderr.trim()});
    });
  });
}

const api = async url => {
  const res = await cli(['api', url, '--method', 'GET', '--scope', scope]);
  if (res.code !== 0) throw Error('API ' + url + ' failed: ' + res.stderr);
  try { return JSON.parse(res.stdout); } catch { throw Error('API ' + url + ' returned non-JSON: ' + res.stdout.slice(0, 200)); }
};

// 1. Verify active production deployment
console.log('Verifying current active production deployment...');
const currentProd = await api('/v13/deployments/rakyat-riview.vercel.app');
if (currentProd.id !== activeProductionId || currentProd.readyState !== 'READY') {
  throw Error(`Active production deployment mismatch: expected ${activeProductionId} READY, got ${currentProd.id} (${currentProd.readyState})`);
}
attempt.beforeProduction = {
  id: currentProd.id,
  readyState: currentProd.readyState,
  url: currentProd.url
};
save();
console.log('Active production confirmed:', currentProd.id, '(' + currentProd.readyState + ')');

// 2. Preflight baseline checks
async function get(url, headers = {}) {
  const r = await fetch(url, {headers, redirect: 'manual', signal: AbortSignal.timeout(20000)});
  return {status: r.status, body: await r.text(), location: r.headers.get('location')};
}

const baselineChecks = [
  {path: '/', expected: 200},
  {path: '/admin.html', expected: 200},
  {path: '/admin-v2.html', expected: 200},
  {path: '/aktivasi.html', expected: 200},
  {path: '/r/iKRb7_7PyK6kg4Ye7EqvOhYu', expected: 302},
  {path: '/dashboard.html', expected: 200},
  {path: '/kartu.html', expected: 200},
  {path: '/pembeli/index.html', expected: 200},
  {path: '/api/buyer?action=session', expected: 401},
  {path: '/api/v2-admin?action=session', expected: 401}
];

console.log('Running preflight baseline checks on production domain...');
const preflightResults = [];
for (const c of baselineChecks) {
  const r = await get(origin + c.path);
  if (r.status !== c.expected) throw Error(`Preflight check failed on ${c.path}: expected ${c.expected}, got ${r.status}`);
  preflightResults.push({path: c.path, status: r.status, pass: true});
}
attempt.preflight = {status: 'ALL_PREFLIGHT_PASS', count: preflightResults.length, checks: preflightResults};
save();
console.log('All', preflightResults.length, 'preflight checks PASSED.');

// 3. Deploy candidate with --skip-domain
console.log('Deploying release candidate with --skip-domain...');
const deployEnv = {
  ...verifyLocal(),
  ADMIN_V2_READONLY_PRODUCTION: 'true',
  ADMIN_V2_ORIGIN: origin,
  ADMIN_V2_READ_CONTRACT_READY: 'true'
};

const deployArgs = [
  'deploy',
  '--prebuilt',
  '--prod',
  '--skip-domain',
  '--scope', scope,
  '--cwd', root,
  '--yes'
];
for (const [k, v] of Object.entries(deployEnv)) deployArgs.push('--env', `${k}=${v}`);
deployArgs.push('--env', 'SUPABASE_SERVICE_ROLE_KEY', '--env', 'ADMIN_V2_SESSION_SECRET');

let deployRes;
try {
  deployRes = await cli(deployArgs, 300000, {
    ADMIN_V2_SESSION_SECRET: privateConfig.ADMIN_SESSION_SECRET,
    SUPABASE_SERVICE_ROLE_KEY: privateConfig.SUPABASE_SECRET_KEY
  });
} catch (e) {
  attempt.status = 'DEPLOYMENT_COMMAND_FAILED';
  attempt.error = e.message;
  save();
  throw e;
}

console.log('Deploy command exited with code:', deployRes.code);
attempt.deployOutput = {code: deployRes.code, stdout: deployRes.stdout, stderr: deployRes.stderr};
save();

if (deployRes.code !== 0) {
  throw Error('Vercel deploy command failed: ' + deployRes.stderr);
}

// 4. Query Vercel API for the newly created candidate deployment
console.log('Querying latest deployment record from Vercel API...');
const recentDeps = await api('/v6/deployments?projectId=' + project + '&limit=3');
const candidateDep = recentDeps.deployments?.[0];
if (!candidateDep) throw Error('No deployments found in project query');

attempt.candidate = {
  id: candidateDep.uid || candidateDep.id,
  url: candidateDep.url,
  state: candidateDep.state,
  created: candidateDep.created,
  name: candidateDep.name
};
save();
console.log('Candidate ID:', attempt.candidate.id);
console.log('Candidate URL:', attempt.candidate.url);
console.log('Candidate state:', attempt.candidate.state);

// 5. Verify production domain did NOT move
console.log('Verifying production domain was not altered...');
const checkProdAfter = await api('/v13/deployments/rakyat-riview.vercel.app');
if (checkProdAfter.id !== activeProductionId) {
  throw Error(`CRITICAL: Production domain moved! Expected ${activeProductionId}, got ${checkProdAfter.id}`);
}
attempt.productionPreserved = true;
attempt.productionStillActiveId = checkProdAfter.id;
save();
console.log('Production domain confirmed untouched:', checkProdAfter.id);

// 6. Test candidate endpoints via Vercel CLI curl (bypassing Vercel Deployment Protection)
const candidateOrigin = 'https://' + attempt.candidate.url;
console.log('Testing candidate endpoints at', candidateOrigin, '...');

async function vcCurl(route, flags = []) {
  const r = await cli(['curl', route, '--deployment', candidateOrigin, '--scope', scope, ...flags]);
  return r;
}

const candidateProbes = [];

// Static page probe
console.log('Testing candidate /admin-v2.html...');
const adminV2Page = await vcCurl('/admin-v2.html');
const hasHtml = adminV2Page.stdout.includes('<!doctype html>') && adminV2Page.stdout.includes('Admin V2');
candidateProbes.push({
  endpoint: '/admin-v2.html',
  pass: hasHtml,
  snippet: adminV2Page.stdout.slice(0, 150)
});

// Static JS probe (checking for permanentUrl fix presence)
console.log('Testing candidate /assets/admin-v2.js...');
const adminV2Js = await vcCurl('/assets/admin-v2.js');
const hasPermanentUrlFix = adminV2Js.stdout.includes('permanentUrl') && adminV2Js.stdout.includes('location.origin===canonical');
candidateProbes.push({
  endpoint: '/assets/admin-v2.js',
  hasPermanentUrlFix,
  pass: hasPermanentUrlFix
});

// Pilot redirect probe
console.log('Testing candidate /r/iKRb7_7PyK6kg4Ye7EqvOhYu redirect...');
const pilotRedirect = await vcCurl('/r/iKRb7_7PyK6kg4Ye7EqvOhYu', ['-I']);
const is302 = pilotRedirect.stdout.includes('302 Found') || pilotRedirect.stdout.includes('HTTP/1.1 302') || pilotRedirect.stdout.includes('HTTP/2 302');
const hasGoogleReview = pilotRedirect.stdout.includes('placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE');
candidateProbes.push({
  endpoint: '/r/iKRb7_7PyK6kg4Ye7EqvOhYu',
  is302,
  hasGoogleReview,
  pass: is302 && hasGoogleReview,
  headersSnippet: pilotRedirect.stdout.slice(0, 250)
});

// API Session probe on candidate hostname
// Note: validateRequest enforces req.headers.host === 'rakyat-riview.vercel.app'.
// Calling from candidate deployment returns HTTP 403 ("Permintaan Admin harus berasal dari website yang sama.").
// It MUST return mode: "admin_readonly" and capabilities: { list: true, audit: true } to prove config passed.
console.log('Testing candidate /api/v2-admin?action=session...');
const sessionRes = await vcCurl('/api/v2-admin?action=session');
let parsedSession = {};
try { parsedSession = JSON.parse(sessionRes.stdout.slice(sessionRes.stdout.indexOf('{'))); } catch {}
const hostOriginRejected = parsedSession.error === 'Permintaan Admin harus berasal dari website yang sama.';
const configPassed = parsedSession.mode === 'admin_readonly' && parsedSession.capabilities?.list === true;
candidateProbes.push({
  endpoint: '/api/v2-admin?action=session',
  hostOriginRejected,
  configPassed,
  pass: hostOriginRejected && configPassed,
  responseSnippet: JSON.stringify(parsedSession)
});

attempt.candidateProbes = candidateProbes;
const allPassed = candidateProbes.every(p => p.pass);
attempt.status = allPassed ? 'CANDIDATE_DEPLOYED_AND_ALL_VERIFIED' : 'CANDIDATE_DEPLOYED_PROBES_INCOMPLETE';
attempt.finishedAt = new Date().toISOString();
save();

console.log(JSON.stringify({
  status: attempt.status,
  candidateId: attempt.candidate.id,
  candidateUrl: attempt.candidate.url,
  productionStillActive: attempt.productionStillActiveId,
  probes: candidateProbes
}, null, 2));
