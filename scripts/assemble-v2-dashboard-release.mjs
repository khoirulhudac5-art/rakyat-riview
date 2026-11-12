import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha = b => createHash('sha256').update(b).digest('hex');
const previousRelease = path.resolve('.backups/v2-short-code-release-2026-11-09T16-12-13-130Z');
const previousOutput = path.join(previousRelease, 'release/.vercel/output');

const folder = path.resolve('.backups/v2-dashboard-release-' + new Date().toISOString().replace(/[:.]/g, '-'));
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
console.log('2. Overlaying updated buyer functions...');
fs.copyFileSync('api/buyer.js', path.join(output, 'functions/api/buyer.js.func/api/buyer.js'));
fs.copyFileSync('api/buyer.js', path.join(output, 'functions/api/buyer-status.js.func/api/buyer.js'));

// 3. Overlay static files
console.log('3. Overlaying updated static files...');
const staticFiles = [
  { src: 'assets/buyer.js', dest: 'static/assets/buyer.js' },
  { src: 'assets/buyer.css', dest: 'static/assets/buyer.css' },
  { src: 'dashboard.html', dest: 'static/dashboard.html' },
  { src: 'kartu.html', dest: 'static/kartu.html' }
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
  rollback: 'dpl_EXmyu7nn4byNTbpRApXCrZRRfm7k',
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
