// Stage 1 only: identical prebuilt output + one private runtime alias. No SQL writes.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {verifyLocal,cli,snapshot as vercelSnapshot,smoke} from './deploy-pilot-closed.mjs';
import {snapshot as databaseSnapshot,compareSnapshots} from './public-pilot-live.mjs';
import {readAdminEnv} from './admin-readonly-config.mjs';
const expected='dpl_e2THSUZz1c5yH2Kf74oAPMJpJPGp',project='prj_BdqElWlwjelD7zwY6pPZiABHYX9E',org='team_sbndPkxC8tcwQtlNLm0rN3Yg';
const releaseFolder=path.resolve('.backups/pilot-release-2026-11-07T12-02-44-312Z'),root=path.join(releaseFolder,'release'),out=path.join(root,'.vercel/output');
const fingerprint='59f0d0d9a4fee9a96481e0630c7b74a7',seal='5c891b2b7222cb09cabd3835e400fdd52e29db87862fc682ff6458aa7c300e34';
const sha=b=>createHash('sha256').update(b).digest('hex');
function walk(dir,prefix=''){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{if(e.isSymbolicLink())throw Error('Artifact symlink not allowed');return e.isDirectory()?walk(path.join(dir,e.name),prefix+e.name+'/'):[prefix+e.name];});}
function exactArtifact(key){const env=verifyLocal(),m=JSON.parse(fs.readFileSync(path.join(releaseFolder,'ARTIFACT-MANIFEST.json')));if(JSON.stringify(walk(out).sort())!==JSON.stringify(m.files.map(f=>f.file).sort()))throw Error('Artifact file set drift');for(const f of m.files.filter(f=>f.file.startsWith('static/')))if(fs.readFileSync(path.join(out,f.file)).includes(Buffer.from(key)))throw Error('Private credential detected in static artifact');return env;}
async function db(){const r=await databaseSnapshot(true);if(r.state.fingerprint!==fingerprint)throw Error('Database fingerprint drift');return r;}
function summary(r){return {stage:r.state.stage,state:r.state.state,fingerprint:r.state.fingerprint,pilotFlags:r.control,permissionsExact:r.state.permissions_exact,cardReady:r.ready,anonymousPilotRows:r.anonymousPilotRows,readOnly:r.health.readonly};}
const args=process.argv;if(args[2]!=='--approved-stage1')throw Error('Explicit stage-1-only approval required');
const folder=path.resolve('.backups/pilot-reader-stage1-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(folder,{recursive:false});
let key='',attempted=false;let report={status:'STAGE1_PREFLIGHT',stage:'private_config',projectId:project,orgId:org,artifactSeal:seal,startedAt:new Date().toISOString(),databaseWrites:false,RPCsOpened:false,loginPerformed:false,claims:false};
const save=()=>fs.writeFileSync(path.join(folder,'RESULT.json'),JSON.stringify(report,null,2));save();
try{
 const c=readAdminEnv('.env.admin-readonly');key=c.SUPABASE_SECRET_KEY||'';if(c.SUPABASE_URL!=='https://svuagnobufhfpgzmsyxx.supabase.co'||!key)throw Error('Matching private reader credential unavailable; manual action required');
 if(!/^sb_secret_[A-Za-z0-9_-]+$/.test(key)){let p;try{p=JSON.parse(Buffer.from(key.split('.')[1]||'','base64url'));}catch{}if(p?.role!=='service_role'||(p.ref&&p.ref!=='svuagnobufhfpgzmsyxx'))throw Error('Reader credential type/target invalid');}
 const env=exactArtifact(key);report.runtimeEnvNames=[...Object.keys(env),'SUPABASE_SERVICE_ROLE_KEY'];report.privateCredentialWrittenToDisk=false;report.privateCredentialInArgv=false;
 report.stage='readonly_preflight';report.before=await vercelSnapshot();if(report.before.current.id!==expected||report.before.current.state!=='READY')throw Error('Current CLOSED deployment no longer matches approval');
 const beforeDB=await db();report.beforeDatabase=summary(beforeDB);fs.writeFileSync(path.join(folder,'DATABASE-BEFORE.json'),JSON.stringify(beforeDB,null,2));
 const probe=await fetch(c.SUPABASE_URL+'/rest/v1/rpc/buyer_pilot_redirect_target',{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({p_card_code:'iKRb7_7PyK6kg4Ye7EqvOhYu'}),signal:AbortSignal.timeout(15000)});const denied=await probe.json().catch(()=>({}));
 if(probe.status!==403||denied?.code!=='42501')throw Error('Reader authorization is not the expected closed permission denial');report.readerCredentialProbe={httpStatus:403,errorCode:'42501',dataReturned:false};
 report.baseline=await smoke(['--capture-v1']);if(report.baseline.code!==0||report.baseline.status!=='V1_BASELINE_CAPTURED')throw Error('V1 HTTP baseline failed');
 report.stage='deploy';save();const cmd=['deploy','--prebuilt','--prod','--project',project,'--scope','rakprem','--cwd',root,'--yes','--json'];for(const [k,v] of Object.entries(env))cmd.push('--env',k+'='+v);cmd.push('--env','SUPABASE_SERVICE_ROLE_KEY');
 fs.writeFileSync(path.join(folder,'DEPLOY-ATTEMPT.json'),JSON.stringify({at:new Date().toISOString(),projectId:project,artifactSeal:seal,runtimeEnvNames:report.runtimeEnvNames,privateEnvInheritedByChild:true}),{flag:'wx'});attempted=true;report.status='STAGE1_DEPLOYING';save();console.log(JSON.stringify({stage:report.status,folder,privateEnvName:'SUPABASE_SERVICE_ROLE_KEY',valueLogged:false}));
 const result=await cli(cmd,480000,{SUPABASE_SERVICE_ROLE_KEY:key});report.deployProcessCompleted=true;const candidate=result.deployment||result;report.candidateDeploymentId=candidate.id||candidate.uid||null;save();
 report.stage='postflight';report.after=await vercelSnapshot();if(report.after.current.id===expected||report.after.current.state!=='READY'||report.after.projectEnvironmentMetadataSHA256!==report.before.projectEnvironmentMetadataSHA256||(report.candidateDeploymentId&&report.candidateDeploymentId!==report.after.current.id))throw Error('Deployment identity/global environment postflight failed');report.deployment=report.after.current;
 report.http=await smoke(['--verify-closed',path.join(report.baseline.folder,'RESULT.json')]);if(report.http.code!==0||report.http.status!=='CLOSED_DEPLOYMENT_HTTP_PASS')throw Error('Production HTTP postflight failed: '+(report.http.reason||'unknown'));
 const afterDB=await db();compareSnapshots(beforeDB,afterDB);report.afterDatabase=summary(afterDB);fs.writeFileSync(path.join(folder,'DATABASE-AFTER.json'),JSON.stringify(afterDB,null,2));report.databaseUnchanged=true;report.AdminGenerateUnchanged=true;
 exactArtifact(key);report.status='STAGE1_READER_CONFIGURED_CLOSED_POSTFLIGHT_PASS';report.stage='complete';report.reader={configuredViaDeploymentScopedEnvironment:true,credentialValueLogged:false,actualActive302Tested:false,expectedClosedRPCDenied:true,limitation:'Card remains ready and reader RPC closed; active redirect requires separate Stage 2 approval'};report.finishedAt=new Date().toISOString();save();
 console.log(JSON.stringify({status:report.status,folder,deployment:report.deployment,domain:'https://rakyat-riview.vercel.app',httpChecks:report.http.checks.length,databaseFingerprint:afterDB.state.fingerprint,databaseUnchanged:true,pilotClosed:true,reader:report.reader,projectEnvUnchanged:true}));
}catch(e){
 const redact=s=>String(s).replaceAll(key||'__no_secret_to_redact__','[redacted]').replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g,'[redacted-key]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[redacted-token]');
 report.status='STAGE1_STOPPED';report.reason=redact(e.message);report.deployAttempted=attempted;save();
 if(attempted){try{
  console.log(JSON.stringify({stage:'RECOVERING_PREVIOUS_CLOSED_DEPLOYMENT',folder}));await cli(['rollback',expected,'--yes','--json','--scope','rakprem','--cwd',root],240000);report.rollbackCommandCompleted=true;
  const restored=await vercelSnapshot();if(restored.current.id!==expected||restored.current.state!=='READY'||restored.projectEnvironmentMetadataSHA256!==report.before.projectEnvironmentMetadataSHA256)throw Error('Recovery metadata not confirmed');report.rollbackDeployment=restored.current;
  report.rollbackHTTP=await smoke(['--verify-closed',path.join(report.baseline.folder,'RESULT.json')]);if(report.rollbackHTTP.code!==0)throw Error('Recovery HTTP not confirmed');
  const restoredDB=await db();const before=JSON.parse(fs.readFileSync(path.join(folder,'DATABASE-BEFORE.json')));compareSnapshots(before,restoredDB);report.status='STAGE1_ROLLED_BACK_CLOSED_VERIFIED';
 }catch(r){report.status='RECOVERY_NOT_CONFIRMED_MANUAL_ACTION_REQUIRED';report.recoveryReason=redact(r.message);}}
 report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,folder,reason:report.reason,recoveryReason:report.recoveryReason||null,databaseWrites:false}));process.exitCode=1;
}finally{key='';}
