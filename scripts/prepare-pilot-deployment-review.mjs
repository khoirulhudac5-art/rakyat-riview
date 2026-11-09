// Offline allowlist overlay, NOT a standalone deployable application or a deployment command.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
export const clientFiles=[
 'dashboard.html','kartu.html','assets/buyer.css','assets/buyer.js','assets/buyer-account.mjs','assets/rakyat-review-logo.png',
 'pembeli/index.html','pembeli/aktivasi.html','pembeli/dashboard.html','pembeli/mulai.html','pembeli/oauth.html',
 'pembeli/account.css','pembeli/account.js','pembeli/experience.css','pembeli/experience.mjs','pembeli/maps.mjs','pembeli/drafts.mjs','pembeli/dashboard-data.mjs','pembeli/review-fallback.mjs','pembeli/wizard.mjs','pembeli/oauth.mjs'
];
export const serverFiles=['api/buyer.js','api/buyer-status.js','api/buyer-google.js','api/pilot-redirect.js','lib/buyer-service.mjs','lib/public-pilot.mjs','lib/restricted-app-adapter.mjs','lib/admin-session.mjs','lib/admin-buyer.mjs'];
const sum=b=>createHash('sha256').update(b).digest('hex');
export function secretMatches(files){
 const values=[];
 for(const file of ['.env.backup','.env.admin-readonly','.env.existing','.env.staging'])if(fs.existsSync(file)){
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
   const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);if(!m||!/SECRET|PASSWORD|TOKEN|DATABASE_URL|SERVICE_ROLE/.test(m[1]))continue;
   let s=m[2].trim().replace(/^(['"])(.*)\1$/,'$2');if(s.length>=12)values.push(s);
   if(/DATABASE_URL/.test(m[1]))try{const p=decodeURIComponent(new URL(s).password);if(p.length>=12)values.push(p);}catch{}
  }
 }
 return files.filter(f=>!f.endsWith('.png')).filter(f=>{const text=fs.readFileSync(f,'utf8');return values.some(v=>text.includes(v))||/sb_secret_[A-Za-z0-9_-]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)||(/\.(?:js|mjs)$/.test(f)&&/process\.env\.(?:SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|ADMIN_SESSION_SECRET|ADMIN_PASSWORD)/.test(text));});
}
export function prepare(){
 const folder=path.resolve('.backups/pilot-deployment-review-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(folder,{recursive:false});
 const secretFindings=secretMatches(clientFiles);if(secretFindings.length)throw Error('Public artifact secret check failed; no artifact copied');
 const files=[...clientFiles,...serverFiles,'vercel.json'];
 const entries=files.map(file=>{const b=fs.readFileSync(file),out=path.join(folder,'OVERLAY-NOT-DEPLOYABLE',file);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,b);return {file,sha256:sum(b),bytes:b.length,surface:clientFiles.includes(file)?'public-static':file==='vercel.json'?'routing':'server-only'};});
 const m={status:'NO_GO_PENDING_DEPLOYMENT_METADATA_AND_AUTH_CONFIG',standaloneDeployable:false,project_ref:'svuagnobufhfpgzmsyxx',domain:'https://rakyat-riview.vercel.app',card:'iKRb7_7PyK6kg4Ye7EqvOhYu',databaseFingerprint:'59f0d0d9a4fee9a96481e0630c7b74a7',databaseExpectedState:'closed',sourceBranch:'v2-development',publicSecretScan:'PASS',files:entries,
  protectedExisting:['index.html','admin.html','admin-login.html','aktivasi.html','supabase-config.js','r/001/index.html','api/activate-card.js','api/update-card.js','api/create-card.js','api/list-cards.js','api/admin-login.js','api/admin-logout.js','api/admin-session.js','api/convert-review.js'],
  preserveDeployedVersions:true,legacyBaseVerified:false,
  excluded:['.env*','.backups/**','.local-tools/**','.git/**','.agents/**','.codex/**','supabase/**','tests/**','scripts/**','*.md','admin-v2.html','assets/admin-v2*','api/admin-*-v2.js','api/v2-admin.js','pembeli/auth-check*','pembeli/claim-test*','pembeli/auth-wizard-test*'],
  notes:['Overlay must be merged into a verified CURRENT production source snapshot, never deployed alone or from this dirty workspace.','Public output must contain ONLY public-static entries plus verified unchanged V1 static files. Backend lib/API files belong to function bundles, not static output.','Preserve the deployed converter: its maps_url/review_url contract is compatible; do not include the newer local converter in this pilot deployment.','Server transitively imports existing Admin helpers; these are backend modules only, not new Admin routes.','Do not publish local preview servers, SQL, examples, reports or diagnostic pages.','Keep Vercel runtime/framework/build settings from verified current deployment. Do not invent a project ID or runtime version.']};
 fs.writeFileSync(path.join(folder,'MANIFEST.json'),JSON.stringify(m,null,2));console.log(JSON.stringify({folder,status:m.status,standaloneDeployable:false,publicFiles:clientFiles.length,serverFiles:serverFiles.length,routingFiles:1,publicSecretScan:'PASS',manifestSHA256:sum(fs.readFileSync(path.join(folder,'MANIFEST.json')))}));return m;
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1').replaceAll('/',path.sep))prepare();
