import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readAdminEnv, adminConfigStatus } from './admin-readonly-config.mjs';

const seal = 'eae8416959825b7bf9c023d345df1a10495867c884e4077c5b4aceb7321b4493';
const folder = path.resolve('.backups/admin-production-release-2026-11-09T11-36-06-192Z');
const root = path.join(folder, 'release');
const activeProductionId = 'dpl_GCL76P1a8iXKYHHFX8zhgaRjbuGf';
const rollbackTargetId = 'dpl_ESTkbP9VmNQHjmonvR9iC5omey3k';
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
fs.mkdirSync(evidence, { recursive: true });

const attempt = {
  status: 'CANDIDATE_DEPLOYMENT_STARTING',
  at: new Date().toISOString(),
  project,
  activeProductionId,
  rollbackTargetId,
  seal,
  evidence
};
const save = () => fs.writeFileSync(path.join(evidence, 'RESULT.json'), JSON.stringify(attempt, null, 2));
save();

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
  const r = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  return { status: r.status, body: await r.text(), location: r.headers.get('location') };
}

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

// 2. Preflight baseline checks on live production domain
const baselineChecks = [
  { path: '/', expected: 200 },
  { path: '/admin.html', expected: 200 },
  { path: '/admin-v2.html', expected: 200 },
  { path: '/aktivasi.html', expected: 200 },
  { path: '/r/iKRb7_7PyK6kg4Ye7EqvOhYu', expected: 302 },
  { path: '/dashboard.html', expected: 200 },
  { path: '/kartu.html', expected: 200 },
  { path: '/pembeli/index.html', expected: 200 },
  { path: '/api/buyer?action=session', expected: 401 },
  { path: '/api/v2-admin?action=session', expected: 401 }
];

console.log('Running preflight baseline checks on production domain...');
const preflightResults = [];
for (const c of baselineChecks) {
  const r = await get(origin + c.path);
  if (r.status !== c.expected) throw Error(`Preflight check failed on ${c.path}: expected ${c.expected}, got ${r.status}`);
  preflightResults.push({ path: c.path, status: r.status, pass: true });
}
attempt.preflight = { status: 'ALL_PREFLIGHT_PASS', count: preflightResults.length, checks: preflightResults };
save();
console.log('All', preflightResults.length, 'preflight checks PASSED.');

// 3. Deploy candidate with --skip-domain
console.log('Deploying release candidate with --skip-domain...');
const deployEnv = {
  BUYER_PILOT_ENABLED: 'true',
  BUYER_INTEGRATION_ENABLED: 'true',
  BUYER_GOOGLE_ENABLED: 'true',
  BUYER_APP_ORIGIN: origin,
  CARD_PUBLIC_ORIGIN: origin,
  BUYER_RESTRICTED_APP: 'false',
  BUYER_FIRST_CLAIM_ENABLED: 'true',
  BUYER_REQUIRE_ACTIVATION_TOKEN: 'false',
  ADMIN_V2_READONLY_PRODUCTION: 'true',
  ADMIN_V2_ORIGIN: origin,
  ADMIN_V2_READ_CONTRACT_READY: 'true',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_6-p6upj0Amrndlkgxp27iA_SuAwYxpn'
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
attempt.deployOutput = { code: deployRes.code, stdout: deployRes.stdout, stderr: deployRes.stderr };
save();

if (deployRes.code !== 0) {
  throw Error('Vercel deploy command failed: ' + deployRes.stderr);
}

// 4. Query Vercel API for newly created candidate deployment
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

// 5. Verify production domain was NOT altered
console.log('Verifying production domain was not altered...');
const checkProdAfter = await api('/v13/deployments/rakyat-riview.vercel.app');
if (checkProdAfter.id !== activeProductionId) {
  throw Error(`CRITICAL: Production domain moved! Expected ${activeProductionId}, got ${checkProdAfter.id}`);
}
attempt.productionPreserved = true;
attempt.productionStillActiveId = checkProdAfter.id;
save();
console.log('Production domain confirmed untouched:', checkProdAfter.id);

// 6. Test candidate endpoints via Vercel CLI curl
const candidateOrigin = 'https://' + attempt.candidate.url;
console.log('Testing candidate endpoints at', candidateOrigin, '...');

async function vcCurl(route, flags = []) {
  return await cli(['curl', route, '--deployment', candidateOrigin, '--scope', scope, ...flags]);
}

const candidateProbes = [];

// Static page: admin-v2.html
console.log('Testing candidate /admin-v2.html...');
const adminV2Page = await vcCurl('/admin-v2.html');
const hasAdminV2 = adminV2Page.stdout.includes('Admin V2') && adminV2Page.stdout.includes('batch-dialog') && adminV2Page.stdout.includes('reissue-dialog');
candidateProbes.push({
  endpoint: '/admin-v2.html',
  hasAdminV2,
  pass: hasAdminV2,
  snippet: adminV2Page.stdout.slice(0, 150)
});

// Static JS: assets/admin-v2.js
console.log('Testing candidate /assets/admin-v2.js...');
const adminV2Js = await vcCurl('/assets/admin-v2.js');
const hasBatchAndReissue = adminV2Js.stdout.includes('exportPhysicalProductionCsv') && adminV2Js.stdout.includes('openReissueDialog') && adminV2Js.stdout.includes('downloadQrZip');
candidateProbes.push({
  endpoint: '/assets/admin-v2.js',
  hasBatchAndReissue,
  pass: hasBatchAndReissue
});

// Static assets: qrcode.mjs & zip.mjs
console.log('Testing candidate /assets/qrcode.mjs and /assets/zip.mjs...');
const qrJs = await vcCurl('/assets/qrcode.mjs');
const zipJs = await vcCurl('/assets/zip.mjs');
candidateProbes.push({
  endpoint: '/assets/qrcode.mjs',
  pass: qrJs.stdout.includes('generateQrPngBlob')
});
candidateProbes.push({
  endpoint: '/assets/zip.mjs',
  pass: zipJs.stdout.includes('buildZip')
});

// Buyer activation page: /pembeli/mulai.html
console.log('Testing candidate /pembeli/mulai.html...');
const mulaiPage = await vcCurl('/pembeli/mulai.html');
const hasTokenInput = mulaiPage.stdout.includes('id="token"') && mulaiPage.stdout.includes('Token Aktivasi Rahasia');
candidateProbes.push({
  endpoint: '/pembeli/mulai.html',
  hasTokenInput,
  pass: hasTokenInput
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

// API Buyer session probe
console.log('Testing candidate /api/buyer?action=session...');
const buyerSessionRes = await vcCurl('/api/buyer?action=session');
const isBuyer401 = buyerSessionRes.stdout.includes('401') || buyerSessionRes.stdout.includes('Unauthorized') || buyerSessionRes.stdout.includes('"user":null') || buyerSessionRes.stdout.includes('Sesi akun');
candidateProbes.push({
  endpoint: '/api/buyer?action=session',
  pass: isBuyer401
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
  allProbesPass: allPassed,
  probes: candidateProbes
}, null, 2));
