import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readAdminEnv, adminConfigStatus } from './admin-readonly-config.mjs';

const seal = 'c6a3bbbdb4fc1a80ef383928daa86e205069a650d297807c530e051ef0ab4161';
const folder = path.resolve('.backups/v2-card-flow-release-2026-11-09T13-47-53-313Z');
const root = path.join(folder, 'release');
const activeProductionId = 'dpl_HxedAqfQ3g2hDGUu3drTXCgTNCAS';
const rollbackTargetId = 'dpl_GCL76P1a8iXKYHHFX8zhgaRjbuGf';
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

const evidence = path.resolve('.backups/v2-candidate-deployment-' + new Date().toISOString().replace(/[:.]/g, '-'));
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
  { path: '/admin-v2.html', expected: 200 },
  { path: '/r/iKRb7_7PyK6kg4Ye7EqvOhYu', expected: 302 },
  { path: '/pembeli/mulai.html', expected: 200 }
];

console.log('Running preflight checks on production domain...');
for (const check of baselineChecks) {
  const res = await get(origin + check.path);
  if (res.status !== check.expected) {
    throw Error(`Preflight check failed on ${check.path}: expected ${check.expected}, got ${res.status}`);
  }
}
console.log('All preflight checks on production passed.');

// 3. Deploy candidate with --skip-domain
console.log('Deploying prebuilt candidate with --skip-domain...');
const deployEnv = {
  BUYER_PILOT_ENABLED: 'true',
  BUYER_INTEGRATION_ENABLED: 'true',
  BUYER_GOOGLE_ENABLED: 'true',
  BUYER_APP_ORIGIN: origin,
  CARD_PUBLIC_ORIGIN: origin,
  BUYER_RESTRICTED_APP: 'false',
  BUYER_FIRST_CLAIM_ENABLED: 'true',
  BUYER_REQUIRE_ACTIVATION_TOKEN: 'false',
  ADMIN_V2_PRODUCTION_ENABLED: 'true',
  ADMIN_V2_READONLY_PRODUCTION: 'true',
  ADMIN_V2_GENERATE_ENABLED: 'true',
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
attempt.status = 'CANDIDATE_DEPLOYED_READY_FOR_TESTS';
save();
console.log('Production domain confirmed untouched:', checkProdAfter.id);
console.log('\nCANDIDATE DEPLOYMENT SUCCESSFUL:');
console.log(JSON.stringify(attempt.candidate, null, 2));
