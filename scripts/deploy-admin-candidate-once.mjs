// Exactly one deployment candidate execution. Uses --skip-domain. Never promotes.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {cli, snapshot, verifyLocal} from './deploy-pilot-closed.mjs';
import {readAdminEnv, adminConfigStatus} from './admin-readonly-config.mjs';

const seal = '6c27c56032e42e3b88e3e4759ce8efd541510b11db201b0adf53fe992429a68a';
const folder = path.resolve('.backups/admin-production-release-2026-11-09T07-53-01-451Z');
const root = path.join(folder, 'release');
const rollback = 'dpl_6bSToPRzkLAtApYtqXTMn4jkXwiy';
const origin = 'https://rakyat-riview.vercel.app';
const project = 'prj_BdqElWlwjelD7zwY6pPZiABHYX9E';
const scope = 'rakprem';
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
  rollback,
  seal,
  evidence
};
const save = () => fs.writeFileSync(path.join(evidence, 'RESULT.json'), JSON.stringify(attempt, null, 2));
save();

// 1. Verify snapshot: current must be reader-ready rollback target
const before = await snapshot();
if (before.current.id !== rollback || before.current.state !== 'READY') {
  throw Error('Current production is not the approved reader-ready rollback target');
}
attempt.before = before;
save();

// 2. Preflight baseline checks
async function get(url, headers = {}) {
  const r = await fetch(url, {headers, redirect: 'manual', signal: AbortSignal.timeout(20000)});
  return {status: r.status, body: await r.text(), location: r.headers.get('location')};
}

const baselineChecks = [
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

const preflightResults = [];
for (const c of baselineChecks) {
  const r = await get(origin + c.path);
  if (r.status !== c.expected) throw Error(`Preflight check failed on ${c.path}: expected ${c.expected}, got ${r.status}`);
  preflightResults.push({path: c.path, status: r.status, pass: true});
}
attempt.preflight = {status: 'ALL_PREFLIGHT_PASS', count: preflightResults.length};
save();

// 3. Deploy candidate with --skip-domain
const env = {
  ...verifyLocal(),
  ADMIN_V2_READONLY_PRODUCTION: 'true',
  ADMIN_V2_ORIGIN: origin,
  ADMIN_V2_READ_CONTRACT_READY: 'true'
};

const args = [
  'deploy',
  '--prebuilt',
  '--prod',
  '--skip-domain',
  '--project', project,
  '--scope', scope,
  '--cwd', root,
  '--yes',
  '--json'
];
for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`);
args.push('--env', 'SUPABASE_SERVICE_ROLE_KEY', '--env', 'ADMIN_V2_SESSION_SECRET');

console.log('Deploying candidate with --skip-domain...');
let depResult;
try {
  depResult = await cli(args, 480000, {
    SUPABASE_SERVICE_ROLE_KEY: privateConfig.SUPABASE_SECRET_KEY,
    ADMIN_V2_SESSION_SECRET: privateConfig.ADMIN_SESSION_SECRET
  });
} catch (e) {
  attempt.status = 'DEPLOYMENT_COMMAND_FAILED';
  attempt.error = e.message;
  save();
  throw e;
}

attempt.candidate = {
  id: depResult.id || depResult.uid,
  url: depResult.url,
  readyState: depResult.readyState || depResult.state,
  target: depResult.target,
  alias: depResult.alias || []
};
save();

console.log('Candidate deployed:', attempt.candidate.id, 'readyState:', attempt.candidate.readyState, 'url:', attempt.candidate.url);

// 4. Verify production domain was NOT moved
const liveCheck = await snapshot();
if (liveCheck.current.id !== rollback) {
  throw Error('CRITICAL: Production domain moved unexpectedly!');
}
attempt.productionStillRollback = true;
save();

// 5. Test candidate endpoint
const candidateHost = attempt.candidate.url.startsWith('http') ? attempt.candidate.url : 'https://' + attempt.candidate.url;
const bypassSecret = 'u7bk0rhzgYpkg6qLTJowfvL2aPx1paN1';

console.log('Testing candidate session endpoint at:', candidateHost + '/api/v2-admin?action=session');
const sessionProbe = await get(candidateHost + '/api/v2-admin?action=session', {
  'x-vercel-protection-bypass': bypassSecret,
  'Host': 'rakyat-riview.vercel.app'
});

let parsedBody;
try { parsedBody = JSON.parse(sessionProbe.body); } catch { parsedBody = {raw: sessionProbe.body.slice(0, 200)}; }

attempt.sessionProbe = {
  status: sessionProbe.status,
  body: parsedBody
};

console.log('Candidate session status:', sessionProbe.status);
console.log('Candidate session body:', JSON.stringify(parsedBody));

if (sessionProbe.status === 401) {
  attempt.status = 'CANDIDATE_POSTFLIGHT_PASS_401_CONFIRMED';
  attempt.candidateReady = true;
  console.log('SUCCESS: Candidate returned HTTP 401 as required.');
} else {
  attempt.status = 'CANDIDATE_POSTFLIGHT_FAILED';
  attempt.candidateReady = false;
  console.log('FAILURE: Candidate returned HTTP', sessionProbe.status, 'instead of 401.');
}

attempt.finishedAt = new Date().toISOString();
save();

console.log(JSON.stringify({
  status: attempt.status,
  candidateId: attempt.candidate.id,
  candidateUrl: attempt.candidate.url,
  sessionStatus: sessionProbe.status,
  productionStillSafe: attempt.productionStillRollback,
  evidence
}, null, 2));
