import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha = b => createHash('sha256').update(b).digest('hex');
const previousRelease = path.resolve('.backups/admin-production-release-2026-11-09T12-06-09-009Z');
const previousOutput = path.join(previousRelease, 'release/.vercel/output');

const folder = path.resolve('.backups/v2-card-flow-release-' + new Date().toISOString().replace(/[:.]/g, '-'));
const root = path.join(folder, 'release');
const output = path.join(root, '.vercel/output');

fs.mkdirSync(output, { recursive: true });

// 1. Copy base tree from verified release
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

// Also copy project.json
fs.mkdirSync(path.join(root, '.vercel'), { recursive: true });
fs.copyFileSync(path.join(previousRelease, 'release/.vercel/project.json'), path.join(root, '.vercel/project.json'));

// 2. Overlay updated backend functions
console.log('Overlaying updated backend functions...');
fs.copyFileSync('api/buyer.js', path.join(output, 'functions/api/buyer.js.func/api/buyer.js'));
fs.copyFileSync('api/buyer.js', path.join(output, 'functions/api/buyer-status.js.func/api/buyer.js'));
fs.copyFileSync('api/buyer-status.js', path.join(output, 'functions/api/buyer-status.js.func/api/buyer-status.js'));

// 3. Overlay updated static files
console.log('Overlaying updated static files...');
const staticFiles = [
  { src: 'r/001/index.html', dest: 'static/r/001/index.html' },
  { src: 'pembeli/mulai.html', dest: 'static/pembeli/mulai.html' },
  { src: 'pembeli/wizard.mjs', dest: 'static/pembeli/wizard.mjs' },
  { src: 'pembeli/drafts.mjs', dest: 'static/pembeli/drafts.mjs' },
  { src: 'admin-v2.html', dest: 'static/admin-v2.html' },
  { src: 'assets/admin-v2.js', dest: 'static/assets/admin-v2.js' },
  { src: 'assets/admin-v2.css', dest: 'static/assets/admin-v2.css' },
  { src: 'assets/qrcode.mjs', dest: 'static/assets/qrcode.mjs' },
  { src: 'assets/zip.mjs', dest: 'static/assets/zip.mjs' }
];

for (const f of staticFiles) {
  const d = path.join(output, f.dest);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(f.src, d);
}

// 4. Planned environment variables
const plannedEnv = JSON.parse(fs.readFileSync(path.join(previousRelease, 'PLANNED-DEPLOYMENT-ENV.json'), 'utf8'));

fs.writeFileSync(path.join(folder, 'PLANNED-DEPLOYMENT-ENV.json'), JSON.stringify(plannedEnv, null, 2));
fs.writeFileSync(path.join(root, '.vercel/.env.production.local'), Object.entries(plannedEnv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

// 5. Generate ARTIFACT-MANIFEST.json
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
