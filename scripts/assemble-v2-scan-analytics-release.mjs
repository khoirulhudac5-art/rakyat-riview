import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readAdminEnv } from './admin-readonly-config.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const previousRelease = path.resolve('.backups/v2-dashboard-release-2026-11-09T18-54-28-165Z');
const previousOutput = path.join(previousRelease, 'release/.vercel/output');

const folder = path.resolve('.backups/v2-scan-analytics-release-' + new Date().toISOString().replace(/[:.]/g, '-'));
const root = path.join(folder, 'release');
const output = path.join(root, '.vercel/output');

fs.mkdirSync(output, { recursive: true });

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

console.log('1. Copying baseline output from:', previousOutput);
copyDir(previousOutput, output);

// Copy project.json
fs.mkdirSync(path.join(root, '.vercel'), { recursive: true });
fs.copyFileSync(path.join(previousRelease, 'release/.vercel/project.json'), path.join(root, '.vercel/project.json'));

// 2. Overlay backend functions
console.log('2. Overlaying updated buyer & pilot functions...');
fs.copyFileSync('api/buyer.js', path.join(output, 'functions/api/buyer.js.func/api/buyer.js'));
fs.copyFileSync('api/buyer.js', path.join(output, 'functions/api/buyer-status.js.func/api/buyer.js'));
fs.copyFileSync('api/buyer-google.js', path.join(output, 'functions/api/buyer-google.js.func/api/buyer-google.js'));
fs.copyFileSync('lib/buyer-service.mjs', path.join(output, 'functions/api/buyer.js.func/lib/buyer-service.mjs'));
fs.copyFileSync('lib/buyer-service.mjs', path.join(output, 'functions/api/buyer-status.js.func/lib/buyer-service.mjs'));
fs.copyFileSync('lib/buyer-service.mjs', path.join(output, 'functions/api/buyer-google.js.func/lib/buyer-service.mjs'));
fs.copyFileSync('lib/buyer-service.mjs', path.join(output, 'functions/api/pilot-redirect.js.func/lib/buyer-service.mjs'));
fs.copyFileSync('api/pilot-redirect.js', path.join(output, 'functions/api/pilot-redirect.js.func/api/pilot-redirect.js'));
fs.copyFileSync('lib/public-pilot.mjs', path.join(output, 'functions/api/pilot-redirect.js.func/lib/public-pilot.mjs'));

// Admin backend overlays
const adminFuncLib = path.join(output, 'functions/api/admin-v2-readonly.js.func/internal-admin/lib');
if (fs.existsSync(adminFuncLib)) {
  fs.copyFileSync('lib/admin-production.mjs', path.join(adminFuncLib, 'admin-production.mjs'));
  fs.copyFileSync('lib/admin-readonly.mjs', path.join(adminFuncLib, 'admin-readonly.mjs'));
  fs.copyFileSync('lib/card-code.mjs', path.join(adminFuncLib, 'card-code.mjs'));
}

// 3. Create card-redirect.js.func
console.log('3. Creating card-redirect.js.func...');
const cardRedirectFunc = path.join(output, 'functions/api/card-redirect.js.func');
copyDir(path.join(output, 'functions/api/pilot-redirect.js.func'), cardRedirectFunc);
// Update .vc-config.json
const vcConfig = JSON.parse(fs.readFileSync(path.join(cardRedirectFunc, '.vc-config.json'), 'utf8'));
vcConfig.handler = 'api/card-redirect.js';
fs.writeFileSync(path.join(cardRedirectFunc, '.vc-config.json'), JSON.stringify(vcConfig, null, 2));
// Copy api/card-redirect.js and lib/buyer-service.mjs
fs.copyFileSync('api/card-redirect.js', path.join(cardRedirectFunc, 'api/card-redirect.js'));
fs.copyFileSync('lib/buyer-service.mjs', path.join(cardRedirectFunc, 'lib/buyer-service.mjs'));

// 4. Overlay static files
console.log('4. Overlaying updated static files...');
const staticFiles = [
  { src: 'preview.html', dest: 'static/preview.html' },
  { src: 'assets/buyer-preview.js', dest: 'static/assets/buyer-preview.js' },
  { src: 'pembeli/account.js', dest: 'static/pembeli/account.js' },
  { src: 'pembeli/account.css', dest: 'static/pembeli/account.css' },
  { src: 'pembeli/experience.css', dest: 'static/pembeli/experience.css' },
  { src: 'pembeli/experience.mjs', dest: 'static/pembeli/experience.mjs' },
  { src: 'pembeli/mulai.html', dest: 'static/pembeli/mulai.html' },
  { src: 'pembeli/wizard.mjs', dest: 'static/pembeli/wizard.mjs' },
  { src: 'pembeli/drafts.mjs', dest: 'static/pembeli/drafts.mjs' },
  { src: 'pembeli/maps.mjs', dest: 'static/pembeli/maps.mjs' },
  { src: 'pembeli/review-fallback.mjs', dest: 'static/pembeli/review-fallback.mjs' },
  { src: 'pembeli/auth-callback.html', dest: 'static/pembeli/auth-callback.html' },
  { src: 'pembeli/auth-callback.mjs', dest: 'static/pembeli/auth-callback.mjs' },
  { src: 'pembeli/auth-callback.html', dest: 'static/auth-callback.html' },
  { src: 'pembeli/auth-callback.mjs', dest: 'static/auth-callback.mjs' },
  { src: 'assets/buyer.js', dest: 'static/assets/buyer.js' },
  { src: 'assets/buyer.css', dest: 'static/assets/buyer.css' },
  { src: 'assets/rakyat-review-logo.png', dest: 'static/assets/rakyat-review-logo.png' },
  { src: 'dashboard.html', dest: 'static/dashboard.html' },
  { src: 'kartu.html', dest: 'static/kartu.html' },
  { src: 'index.html', dest: 'static/index.html' },
  { src: 'pembeli/index.html', dest: 'static/pembeli/index.html' },
  { src: 'admin-v2.html', dest: 'static/admin-v2.html' },
  { src: 'assets/admin-v2.js', dest: 'static/assets/admin-v2.js' },
  { src: 'assets/admin-v2.css', dest: 'static/assets/admin-v2.css' },
  { src: 'r/001/index.html', dest: 'static/r/001/index.html' }
];

for (const f of staticFiles) {
  const d = path.join(output, f.dest);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(f.src, d);
}

// 5. Update .vercel/output/config.json
console.log('5. Updating routing configuration in config.json...');
const configJsonPath = path.join(output, 'config.json');
const configJson = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));

// Insert api/card-redirect route before pilot-redirect or update-card
const routes = configJson.routes;

// Add static cache control header route
if (!routes.some(r => r.src === '^/assets/(.*)$' && r.headers)) {
  routes.unshift({
    src: '^/assets/(.*)$',
    headers: { 'cache-control': 'public, max-age=86400, stale-while-revalidate=604800' },
    continue: true
  });
}

// Add clean URL rewrites for auth-callback
const callbackRoutes = [
  { src: '^/pembeli/auth-callback(?:/)?$', dest: '/pembeli/auth-callback.html', check: true },
  { src: '^/auth-callback(?:\\.html|/)?$', dest: '/pembeli/auth-callback.html', check: true }
];
for (const cr of callbackRoutes) {
  if (!routes.some(r => r.src === cr.src)) {
    const fsIdx = routes.findIndex(r => r.handle === 'filesystem');
    routes.splice(fsIdx !== -1 ? fsIdx + 1 : 1, 0, cr);
  }
}

if (!routes.some(r => r.src === '^/api/card-redirect$')) {
  const insertIdx = routes.findIndex(r => r.src === '^/api/pilot-redirect$');
  routes.splice(insertIdx !== -1 ? insertIdx : routes.length - 4, 0, {
    src: '^/api/card-redirect$',
    dest: '/api/card-redirect.js',
    check: true
  });
}

// Update /r/:code routes to point to /api/card-redirect.js?code=$1
for (const r of routes) {
  if (r.src === '^/r(?:/([^/]+?))$' || r.src === '^/r(?:/([^/]+?))/$') {
    r.dest = '/api/card-redirect.js?code=$1';
  }
}

fs.writeFileSync(configJsonPath, JSON.stringify(configJson, null, 2));

// 6. Planned environment variables
const plannedEnv = JSON.parse(fs.readFileSync(path.join(previousRelease, 'PLANNED-DEPLOYMENT-ENV.json'), 'utf8'));
const privateConfig = readAdminEnv('.env.admin-readonly');

const fullEnv = {
  ...plannedEnv,
  SUPABASE_URL: privateConfig.SUPABASE_URL || 'https://svuagnobufhfpgzmsyxx.supabase.co',
  SUPABASE_SECRET_KEY: privateConfig.SUPABASE_SECRET_KEY,
  SUPABASE_SERVICE_ROLE_KEY: privateConfig.SUPABASE_SECRET_KEY,
  ADMIN_PASSWORD: privateConfig.ADMIN_PASSWORD,
  ADMIN_V2_PASSWORD: privateConfig.ADMIN_PASSWORD,
  ADMIN_SESSION_SECRET: privateConfig.ADMIN_SESSION_SECRET,
  ADMIN_V2_SESSION_SECRET: privateConfig.ADMIN_SESSION_SECRET,
  ADMIN_V2_PRODUCTION_ENABLED: 'true',
  ADMIN_V2_READONLY_PRODUCTION: 'true',
  ADMIN_V2_GENERATE_ENABLED: 'true',
  ADMIN_V2_ORIGIN: 'https://rakyat-riview.vercel.app',
  ADMIN_V2_READ_CONTRACT_READY: 'true'
};

fs.writeFileSync(path.join(folder, 'PLANNED-DEPLOYMENT-ENV.json'), JSON.stringify(plannedEnv, null, 2));
fs.writeFileSync(path.join(root, '.vercel/.env.production.local'), Object.entries(plannedEnv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

// Inject fullEnv into all function .vc-config.json files
const funcsDir = path.join(output, 'functions/api');
for (const entry of fs.readdirSync(funcsDir, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.endsWith('.func')) {
    const vcCfgPath = path.join(funcsDir, entry.name, '.vc-config.json');
    if (fs.existsSync(vcCfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(vcCfgPath, 'utf8'));
      cfg.environment = { ...cfg.environment, ...fullEnv };
      fs.writeFileSync(vcCfgPath, JSON.stringify(cfg, null, 2));
    }
  }
}

// 7. Generate ARTIFACT-MANIFEST.json
function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.isSymbolicLink()) throw new Error('Artifact symlink');
    return e.isDirectory() ? walk(path.join(dir, e.name), prefix + e.name + '/') : [prefix + e.name];
  });
}

const files = walk(output).sort().map(file => {
  const bytes = fs.readFileSync(path.join(output, file));
  return { file, bytes: bytes.length, sha256: sha(bytes) };
});

const manifest = {
  projectId: 'prj_BdqElWlwjelD7zwY6pPZiABHYX9E',
  orgId: 'team_sbndPkxC8tcwQtlNLm0rN3Yg',
  rollback: 'dpl_688bSUnLPMcAxBLatpP5Wg7biACV',
  files
};

const manifestPath = path.join(folder, 'ARTIFACT-MANIFEST.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const seal = sha(fs.readFileSync(manifestPath));

const result = {
  success: true,
  folder,
  root,
  seal,
  fileCount: files.length,
  rollback: manifest.rollback
};

fs.writeFileSync(path.join(folder, 'RELEASE_INFO.json'), JSON.stringify(result, null, 2));
console.log('\n=== RELEASE PACKAGE ASSEMBLED ===');
console.log('Folder:', folder);
console.log('Seal:', seal);
console.log('Files:', files.length);
console.log('Rollback target:', manifest.rollback);
