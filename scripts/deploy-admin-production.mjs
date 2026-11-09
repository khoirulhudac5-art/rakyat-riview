// Prepared rollout. Requires a new explicit approval; never run as part of build.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
import {cli,snapshot,verifyLocal} from './deploy-pilot-closed.mjs';import {readAdminEnv,adminConfigStatus} from './admin-readonly-config.mjs';
import {runAdminSessionPostflight} from './admin-postflight-diagnostics.mjs';
const folder=path.resolve('.backups/admin-production-release-2026-11-09T07-53-01-451Z'),root=path.join(folder,'release'),out=path.join(root,'.vercel/output'),seal='6c27c56032e42e3b88e3e4759ce8efd541510b11db201b0adf53fe992429a68a';
const rollback='dpl_6bSToPRzkLAtApYtqXTMn4jkXwiy',origin='https://rakyat-riview.vercel.app',project='prj_BdqElWlwjelD7zwY6pPZiABHYX9E',scope='rakprem';
const sha=b=>createHash('sha256').update(b).digest('hex');
function walk(dir,prefix=''){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{if(e.isSymbolicLink())throw Error('Artifact symlink');return e.isDirectory()?walk(path.join(dir,e.name),prefix+e.name+'/'):[prefix+e.name];});}
export function verifyAdminArtifact({releaseFolder=folder,artifactSeal=seal}={}){
 const selected=path.resolve(releaseFolder),output=path.join(selected,'release/.vercel/output');
 if(path.dirname(selected)!==path.resolve('.backups')||!path.basename(selected).startsWith('admin-production-release-'))throw Error('Invalid Admin release directory');
 verifyLocal();const bytes=fs.readFileSync(path.join(selected,'ARTIFACT-MANIFEST.json'));if(sha(bytes)!==artifactSeal)throw Error('Approved Admin artifact seal changed');
 const m=JSON.parse(bytes);if(m.projectId!==project||m.orgId!=='team_sbndPkxC8tcwQtlNLm0rN3Yg'||m.rollback!==rollback)throw Error('Project/rollback mismatch');
 const sourceManifest=JSON.parse(fs.readFileSync(path.join(selected,'MANIFEST.json')));
 for(const s of sourceManifest.backendSources)if(sha(fs.readFileSync(s.file))!==s.sha256)throw Error('Backend source changed; rebuild and review a new artifact before deployment');
 if(JSON.stringify(walk(output).sort())!==JSON.stringify(m.files.map(f=>f.file).sort()))throw Error('Artifact file-set drift');
 for(const f of m.files)if(path.resolve(output,f.file).startsWith(output+path.sep)&&sha(fs.readFileSync(path.join(output,f.file)))===f.sha256){}else throw Error('Artifact content drift');
 return true;
}
async function get(route){const r=await fetch(origin+route,{redirect:'manual',signal:AbortSignal.timeout(20000)});return {status:r.status,body:await r.text(),location:r.headers.get('location'),headers:r.headers};}
async function baseline(){const b=[];for(const route of ['/','/admin.html','/admin-login.html','/aktivasi.html','/r/RRROUTECHECK0000000000000','/r/iKRb7_7PyK6kg4Ye7EqvOhYu']){const r=await get(route);if(r.status!==(route.endsWith('iKRb7_7PyK6kg4Ye7EqvOhYu')?302:200))throw Error('Production HTTP baseline not healthy');b.push({route,status:r.status,hash:sha(r.body),locationHash:r.location?sha(r.location):null});}return b;}
async function compareHTTP(b){for(const x of b){const r=await get(x.route);if(r.status!==x.status||sha(r.body)!==x.hash||(r.location?sha(r.location):null)!==x.locationHash)throw Error('V1/pilot HTTP regression');}}
async function main(){
 if(process.argv[2]==='--check-artifact'){verifyAdminArtifact();console.log(JSON.stringify({status:'ARTIFACT_VERIFIED_OFFLINE',seal,productionAccessed:false}));return;}
 if(process.argv[2]!=='--approved-admin-readonly-deployment')throw Error('New explicit deployment approval required');
 verifyAdminArtifact();const privateConfig=readAdminEnv('.env.admin-readonly');if(!adminConfigStatus(privateConfig).ready)throw Error('Private backend config unavailable');
 const before=await snapshot();if(before.current.id!==rollback||before.current.state!=='READY')throw Error('Current production deployment drift; stop');
 const reader=await cli(['api','/v13/deployments/'+rollback,'--method','GET','--scope',scope]);if(reader.readyState!=='READY')throw Error('Reader-ready rollback unavailable');
 const b=await baseline(),evidence=path.resolve('.backups/admin-production-deployment-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(evidence);
 const attempt={status:'APPROVED_DEPLOYMENT_ATTEMPTED',at:new Date().toISOString(),project,rollback,seal,before,baseline:b,productionDatabaseChanges:false};
 const save=()=>fs.writeFileSync(path.join(evidence,'RESULT.json'),JSON.stringify(attempt,null,2));save();
 const env={...verifyLocal(),ADMIN_V2_READONLY_PRODUCTION:'true',ADMIN_V2_ORIGIN:origin,ADMIN_V2_READ_CONTRACT_READY:'true'};
 const args=['deploy','--prebuilt','--prod','--project',project,'--scope',scope,'--cwd',root,'--yes','--json'];for(const [k,v] of Object.entries(env))args.push('--env',k+'='+v);args.push('--env','SUPABASE_SERVICE_ROLE_KEY','--env','ADMIN_V2_SESSION_SECRET');
 // Private values live only in the spawned CLI environment, never argv or disk.
 let attempted=false;
 try{
  attempted=true;await cli(args,480000,{SUPABASE_SERVICE_ROLE_KEY:privateConfig.SUPABASE_SECRET_KEY,ADMIN_V2_SESSION_SECRET:privateConfig.ADMIN_SESSION_SECRET});
  const after=await snapshot();if(after.current.id===rollback||after.current.state!=='READY'||after.projectEnvironmentMetadataSHA256!==before.projectEnvironmentMetadataSHA256)throw Error('Deployment/project environment postflight failed');attempt.deployment=after.current;
  await compareHTTP(b);
  for(const f of ['admin-v2.html','assets/admin-v2.js','assets/admin-v2.css']){const r=await get('/'+f);if(r.status!==200||sha(r.body)!==sha(fs.readFileSync(path.join(out,'static',f))))throw Error('Admin public artifact mismatch');}
  const anonymous=await runAdminSessionPostflight(attempt,()=>get('/api/v2-admin?action=session'),save);
  // Latest approval reserves all Admin login to the owner. Never submit a password.
  attempt.httpChecks=[...b.map(x=>({name:'V1/pilot unchanged '+x.route,pass:true})),...['admin-v2.html','assets/admin-v2.js','assets/admin-v2.css'].map(f=>({name:'Admin static hash '+f,pass:true})),{name:'anonymous session denied',pass:true}];
  const check=(name,pass)=>{attempt.httpChecks.push({name,pass:!!pass});if(!pass)throw Error('HTTP postflight failed: '+name);};
  const profile=JSON.parse(anonymous.body);check('real read-only profile with writes disabled',profile.mode==='admin_readonly'&&profile.data_source==='supabase'&&profile.read_only===true&&profile.capabilities?.create===false&&profile.capabilities?.reset===false);
  const clearing=anonymous.headers.get('set-cookie')||'';check('dedicated cookie clearing is hardened',clearing.startsWith('__Host-rr_admin_v2=;')&&['Secure','HttpOnly','SameSite=Strict','Path=/','Max-Age=0'].every(s=>clearing.includes(s)));
  for(const cookie of ['rr_buyer_a=not-an-admin','__Host-rr_admin_v2=forged'])for(const action of ['cards','audit']){const r=await fetch(origin+'/api/v2-admin?action='+action,{headers:{Cookie:cookie},redirect:'manual',signal:AbortSignal.timeout(20000)});check('non-Admin denied '+action+' '+(cookie.startsWith('rr_buyer')?'buyer':'forged'),r.status===401);}
  const cross=await fetch(origin+'/api/v2-admin?action=session',{headers:{Origin:'https://outside.example'},redirect:'manual',signal:AbortSignal.timeout(20000)});check('cross-origin rejected',cross.status===403);
  for(const action of ['create','reset','ready','recover']){const r=await fetch(origin+'/api/v2-admin',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Admin-Request':'1'},body:JSON.stringify({action}),redirect:'manual',signal:AbortSignal.timeout(20000)});check('unauthenticated '+action+' denied',r.status===401);}
  for(const route of ['/dashboard.html','/kartu.html','/pembeli/index.html','/pembeli/mulai.html','/pembeli/oauth.html'])check('buyer page '+route,(await get(route)).status===200);
  const mode=await get('/api/buyer?action=mode'),buyer=JSON.parse(mode.body);check('buyer remains pilot without demo or owner edit',mode.status===200&&buyer.mode==='pilot'&&!buyer.fixture&&buyer.capabilities?.update===false);
  for(const route of ['/.env.admin-readonly','/.env.backup','/lib/admin-production.mjs','/internal-admin/lib/admin-production.mjs','/scripts/deploy-admin-production.mjs'])check('private path denied '+route,[403,404].includes((await get(route)).status));
  const page=await get('/admin-v2.html');check('Admin page CSP prevents framing',page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));check('no private values in Admin public assets',!(await Promise.all(['admin-v2.html','assets/admin-v2.js','assets/admin-v2.css'].map(async f=>(await get('/'+f)).body))).some(body=>[privateConfig.ADMIN_PASSWORD,privateConfig.ADMIN_SESSION_SECRET,privateConfig.SUPABASE_SECRET_KEY].some(value=>body.includes(value))));
  verifyAdminArtifact();attempt.adminLoginPerformed=false;attempt.authenticatedInventoryAudit='PENDING_OWNER_MANUAL_LOGIN';attempt.status='ADMIN_READONLY_DEPLOYMENT_PUBLIC_POSTFLIGHT_PASS_MANUAL_LOGIN_PENDING';attempt.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:attempt.status,evidence,deployment:attempt.deployment.id,checks:attempt.httpChecks.length,seal,adminLoginPerformed:false,productionDatabaseChanges:false}));
 }catch{
  // JSON/CLI exception messages can contain body snippets or secrets unknown locally.
  // Keep the safe response projection above; never persist raw exception messages.
  attempt.status='DEPLOYMENT_OR_POSTFLIGHT_FAILED';attempt.failedAt=new Date().toISOString();attempt.reason=attempt.adminSessionPostflight&&attempt.adminSessionPostflight.status!==401?'ADMIN_SESSION_POSTFLIGHT_FAILED':'DEPLOYMENT_OR_POSTFLIGHT_FAILED_SENSITIVE_DETAILS_SUPPRESSED';save();
  if(attempted){try{await cli(['rollback',rollback,'--yes','--json','--scope',scope,'--cwd',root],240000);const restored=await snapshot();if(restored.current.id!==rollback||restored.current.state!=='READY'||restored.projectEnvironmentMetadataSHA256!==before.projectEnvironmentMetadataSHA256)throw Error();await compareHTTP(b);attempt.status='READER_READY_ROLLBACK_VERIFIED';}catch{attempt.status='ROLLBACK_NOT_VERIFIED_STOP_MANUAL_INVESTIGATION';}}
  attempt.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:attempt.status,evidence,productionDatabaseChanges:false}));process.exitCode=1;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)try{await main();}catch{console.log(JSON.stringify({status:'STOPPED_BEFORE_DEPLOYMENT',reason:'Approval, artifact, target, environment or preflight guard failed; no automatic retry'}));process.exitCode=1;}
