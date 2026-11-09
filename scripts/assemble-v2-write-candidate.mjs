import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha = b => createHash('sha256').update(b).digest('hex');
const previousRelease = path.resolve('.backups/admin-production-release-2026-11-09T11-36-06-192Z');
const previousOutput = path.join(previousRelease, 'release/.vercel/output');

const folder = path.resolve('.backups/admin-production-release-' + new Date().toISOString().replace(/[:.]/g, '-'));
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

console.log('Copying baseline output from:', previousOutput);
copyDir(previousOutput, output);

// Copy project.json
fs.mkdirSync(path.join(root, '.vercel'), { recursive: true });
fs.copyFileSync(path.join(previousRelease, 'release/.vercel/project.json'), path.join(root, '.vercel/project.json'));

// Overlay updated backend modules into functions
console.log('Overlaying updated backend modules into admin-v2-readonly.js.func and buyer.js.func...');
fs.copyFileSync(
  'lib/admin-readonly.mjs',
  path.join(output, 'functions/api/admin-v2-readonly.js.func/internal-admin/lib/admin-readonly.mjs')
);
fs.copyFileSync(
  'lib/admin-production.mjs',
  path.join(output, 'functions/api/admin-v2-readonly.js.func/internal-admin/lib/admin-production.mjs')
);
fs.copyFileSync(
  'api/buyer.js',
  path.join(output, 'functions/api/buyer.js.func/api/buyer.js')
);

// Overlay static files
console.log('Overlaying static files...');
const staticFiles = [
  { src: 'admin-v2.html', dest: 'static/admin-v2.html' },
  { src: 'assets/admin-v2.js', dest: 'static/assets/admin-v2.js' },
  { src: 'assets/admin-v2.css', dest: 'static/assets/admin-v2.css' },
  { src: 'assets/qrcode.mjs', dest: 'static/assets/qrcode.mjs' },
  { src: 'assets/zip.mjs', dest: 'static/assets/zip.mjs' },
  { src: 'pembeli/mulai.html', dest: 'static/pembeli/mulai.html' },
  { src: 'pembeli/wizard.mjs', dest: 'static/pembeli/wizard.mjs' },
  { src: 'pembeli/drafts.mjs', dest: 'static/pembeli/drafts.mjs' },
  { src: 'r/001/index.html', dest: 'static/r/001/index.html' }
];

for (const f of staticFiles) {
  const d = path.join(output, f.dest);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(f.src, d);
}

// Planned environment variables including ADMIN_V2_GENERATE_ENABLED
const plannedEnv = {
  BUYER_PILOT_ENABLED: 'true',
  BUYER_INTEGRATION_ENABLED: 'true',
  BUYER_GOOGLE_ENABLED: 'true',
  BUYER_APP_ORIGIN: 'https://rakyat-riview.vercel.app',
  CARD_PUBLIC_ORIGIN: 'https://rakyat-riview.vercel.app',
  BUYER_RESTRICTED_APP: 'false',
  BUYER_FIRST_CLAIM_ENABLED: 'true',
  BUYER_REQUIRE_ACTIVATION_TOKEN: 'false',
  ADMIN_V2_PRODUCTION_ENABLED: 'true',
  ADMIN_V2_READONLY_PRODUCTION: 'true',
  ADMIN_V2_GENERATE_ENABLED: 'true',
  ADMIN_V2_ORIGIN: 'https://rakyat-riview.vercel.app',
  ADMIN_V2_READ_CONTRACT_READY: 'true',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_6-p6upj0Amrndlkgxp27iA_SuAwYxpn'
};

fs.writeFileSync(path.join(folder, 'PLANNED-DEPLOYMENT-ENV.json'), JSON.stringify(plannedEnv, null, 2));
fs.writeFileSync(
  path.join(root, '.vercel/.env.production.local'),
  Object.entries(plannedEnv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
);

function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.isSymbolicLink()) throw Error('Artifact symlink');
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
  rollback: 'dpl_GCL76P1a8iXKYHHFX8zhgaRjbuGf',
  files
};

const manifestPath = path.join(folder, 'ARTIFACT-MANIFEST.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const seal = sha(fs.readFileSync(manifestPath));

console.log(JSON.stringify({
  success: true,
  folder,
  seal,
  totalFiles: files.length,
  rollbackBaseline: manifest.rollback
}, null, 2));
