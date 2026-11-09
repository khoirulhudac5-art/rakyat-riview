// Explicitly approved, single-attempt prebuilt rollout. No SQL/Auth/business writes.
import fs from 'node:fs';import path from 'node:path';import {spawn,execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
const releaseFolder=path.resolve('.backups/pilot-release-2026-11-07T12-02-44-312Z'),root=path.join(releaseFolder,'release'),output=path.join(root,'.vercel/output');
const project='prj_BdqElWlwjelD7zwY6pPZiABHYX9E',org='team_sbndPkxC8tcwQtlNLm0rN3Yg',scope='rakprem',old='dpl_HdXJh3cMvqMq9Q6bsibyjWyD8Xxb';
const seal='5c891b2b7222cb09cabd3835e400fdd52e29db87862fc682ff6458aa7c300e34';
const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),sha=b=>createHash('sha256').update(b).digest('hex');
const expected={BUYER_PILOT_ENABLED:'true',BUYER_INTEGRATION_ENABLED:'true',BUYER_GOOGLE_ENABLED:'true',BUYER_APP_ORIGIN:'https://rakyat-riview.vercel.app',BUYER_RESTRICTED_APP:'false',BUYER_FIRST_CLAIM_ENABLED:'false',BUYER_LOCAL_HTTP:'0',PILOT_SYNTHETIC_LOCAL:'false'};
export function verifyLocal(){
 if(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim()!=='v2-development')throw Error('Wrong working branch');
 const file=path.join(releaseFolder,'ARTIFACT-MANIFEST.json'),bytes=fs.readFileSync(file);if(sha(bytes)!==seal)throw Error('Approved artifact seal mismatch');const m=JSON.parse(bytes);
 if(m.projectId!==project||m.orgId!==org||m.rollback!==old)throw Error('Artifact project/rollback mismatch');
 for(const f of m.files){const p=path.resolve(output,f.file);if(!p.startsWith(output+path.sep)||fs.statSync(p).size!==f.bytes||sha(fs.readFileSync(p))!==f.sha256)throw Error('Artifact file integrity mismatch');}
 const link=JSON.parse(fs.readFileSync(path.join(root,'.vercel/project.json')));if(link.projectId!==project||link.orgId!==org)throw Error('Isolated release link mismatch');
 const p=JSON.parse(fs.readFileSync(path.join(releaseFolder,'PLANNED-DEPLOYMENT-ENV.json')));
 if(Object.keys(p).length!==9||Object.keys(expected).some(k=>p[k]!==expected[k])||Object.keys(p).some(k=>!Object.hasOwn(expected,k)&&k!=='SUPABASE_PUBLISHABLE_KEY'))throw Error('Runtime env unavailable or outside approved scope; manual action required');
 const source=fs.readFileSync('r/001/index.html','utf8'),key=source.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0];if(!key||!source.includes('svuagnobufhfpgzmsyxx')||p.SUPABASE_PUBLISHABLE_KEY!==key)throw Error('Approved publishable key missing/mismatch; manual action required');
 return p;
}
export async function cli(args,timeout=180000,privateEnvironment={}){return new Promise((resolve,reject)=>{
 const c=spawn(process.execPath,[npm,'exec','--cache',path.resolve('.local-tools/npm-cache'),'--yes','--package','vercel','--','vercel',...args],{env:{...process.env,...privateEnvironment},windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',done=false;const timer=setTimeout(()=>{done=true;c.kill();reject(Error('CLI timeout; outcome may be ambiguous'));},timeout);
 c.stdout.on('data',b=>stdout+=b);c.stderr.on('data',b=>stderr+=b);c.on('error',()=>{if(!done){done=true;clearTimeout(timer);reject(Error('CLI failed to start'));}});
 c.on('close',code=>{if(done)return;done=true;clearTimeout(timer);if(code!==0){let msg='CLI request failed';try{const j=JSON.parse(stdout);msg=j.message||j.error?.message||msg;}catch{}msg=msg.replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g,'[redacted-key]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[redacted-token]');return reject(Error(msg.slice(0,450)));}try{resolve(JSON.parse(stdout));}catch{reject(Error('CLI response not JSON; outcome requires reconciliation'));}});
 });}
const api=url=>cli(['api',url,'--method','GET','--scope',scope]);
function dep(d){return {id:d.id||d.uid,projectId:d.projectId,url:d.url,state:d.readyState||d.state,target:d.target,commit:d.meta?.githubCommitSha||d.gitSource?.sha,aliases:d.alias||[]};}
export async function snapshot(){
 const p=await api('/v9/projects/'+project),teams=await api('/v2/teams');if(p.id!==project||p.name!=='rakyat-riview'||p.accountId!==org||!teams.teams?.some(t=>t.id===org&&t.slug===scope))throw Error('Live project/team identity mismatch');
 if(p.nodeVersion!=='24.x'||p.framework!==null||p.buildCommand||p.outputDirectory||p.installCommand||p.rootDirectory)throw Error('Remote project build settings differ from approved V1 defaults');
 const current=dep(await api('/v13/deployments/rakyat-riview.vercel.app')),rollback=dep(await api('/v13/deployments/'+old));
 if(current.projectId!==project||rollback.projectId!==project||rollback.id!==old||rollback.state!=='READY'||!rollback.commit?.startsWith('d057c60'))throw Error('Live deployment/rollback mismatch');
 const env=await api('/v10/projects/'+project+'/env?decrypt=false');
 const metadata=(env.envs||[]).map(e=>({id:e.id,key:e.key,target:e.target,type:e.type,updatedAt:e.updatedAt})).sort((a,b)=>a.id.localeCompare(b.id));
 for(const key of ['ADMIN_PASSWORD','SUPABASE_SECRET_KEY','SUPABASE_URL'])if(!metadata.some(e=>e.key===key&&e.target?.includes('production')))throw Error('Existing production env missing; manual action required');
 return {projectId:project,orgId:org,current,rollback,projectEnvironmentMetadataSHA256:sha(JSON.stringify(metadata)),productionEnvironmentNames:metadata.filter(e=>e.target?.includes('production')).map(e=>e.key).sort()};
}
export async function smoke(args){return new Promise((resolve,reject)=>{
 const c=spawn(process.execPath,['scripts/verify-pilot-deployment-http.mjs',...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',()=>{});c.on('error',()=>reject(Error('HTTP verifier could not start')));c.on('close',code=>{let r;try{r=JSON.parse(out);}catch{return reject(Error('HTTP verifier result missing'));}resolve({code,...r});});
});}
async function main(){
 let folder,report,attempted=false;const save=()=>fs.writeFileSync(path.join(folder,'RESULT.json'),JSON.stringify(report,null,2));
 try{
  const env=verifyLocal();
  if(process.argv[2]==='--preflight'){
   folder=path.resolve('.backups/pilot-closed-deployment-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(folder,{recursive:false});report={status:'PREFLIGHT_RUNNING',remoteChangesMade:false,artifactSeal:seal,runtimeEnvNames:Object.keys(env),startedAt:new Date().toISOString()};save();
   report.before=await snapshot();if(report.before.current.id!==old||report.before.current.state!=='READY')throw Error('Active production no longer matches approved V1 rollback baseline');
   report.baseline=await smoke(['--capture-v1']);if(report.baseline.code!==0||report.baseline.status!=='V1_BASELINE_CAPTURED')throw Error('HTTP V1 baseline failed; no deployment');
   report.status='DEPLOYMENT_PREFLIGHT_PASS';report.envPlanSHA256=sha(fs.readFileSync(path.join(releaseFolder,'PLANNED-DEPLOYMENT-ENV.json')));save();console.log(JSON.stringify({status:report.status,folder,current:report.before.current.id,rollbackReady:true,artifactSeal:seal,runtimeEnvCount:9,baseline:report.baseline.folder,remoteChangesMade:false}));return;
  }
  if(process.argv[2]!=='--approved-closed-only')throw Error('Explicit approved rollout flag required');folder=path.resolve(process.argv[3]||'');if(path.dirname(folder)!==path.resolve('.backups')||!path.basename(folder).startsWith('pilot-closed-deployment-'))throw Error('Invalid preflight folder');
  report=JSON.parse(fs.readFileSync(path.join(folder,'RESULT.json')));if(report.status!=='DEPLOYMENT_PREFLIGHT_PASS'||fs.existsSync(path.join(folder,'DEPLOY-ATTEMPT.json'))||report.envPlanSHA256!==sha(fs.readFileSync(path.join(releaseFolder,'PLANNED-DEPLOYMENT-ENV.json'))))throw Error('Prior attempt or approval artifact changed; no retry');
  const fresh=await snapshot();if(fresh.current.id!==old||fresh.current.state!=='READY'||fresh.projectEnvironmentMetadataSHA256!==report.before.projectEnvironmentMetadataSHA256)throw Error('Fresh production/env drift; no deployment');
  const args=['deploy','--prebuilt','--prod','--project',project,'--scope',scope,'--cwd',root,'--yes','--json'];for(const [k,v] of Object.entries(env))args.push('--env',k+'='+v);
  fs.writeFileSync(path.join(folder,'DEPLOY-ATTEMPT.json'),JSON.stringify({at:new Date().toISOString(),artifactSeal:seal,project,scope,runtimeEnvNames:Object.keys(env)}),{flag:'wx'});attempted=true;report.status='DEPLOYMENT_ATTEMPTED';report.remoteChangesMade=true;save();console.log(JSON.stringify({stage:'DEPLOYING_APPROVED_PREBUILT',folder,runtimeEnvCount:9}));
  const result=await cli(args,480000);const d=result.deployment||result;report.deployment=dep(d);report.deployProcessCompleted=true;save();
  report.after=await snapshot();if(report.after.current.id===old||report.after.current.state!=='READY'||report.after.projectEnvironmentMetadataSHA256!==report.before.projectEnvironmentMetadataSHA256)throw Error('Post-deployment identity/environment check failed');
  if(report.deployment.id&&report.deployment.id!==report.after.current.id)throw Error('Production alias does not match the new deployment');
  report.deployment=report.after.current;
  report.http=await smoke(['--verify-closed',path.join(report.baseline.folder,'RESULT.json')]);save();if(report.http.code!==0||report.http.status!=='CLOSED_DEPLOYMENT_HTTP_PASS')throw Error('Critical HTTP verification failed: '+(report.http.reason||'unknown'));
  verifyLocal();report.status='CLOSED_ONLY_DEPLOYMENT_HTTP_PASS';report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,folder,deployment:report.deployment,domain:'https://rakyat-riview.vercel.app',httpChecks:report.http.checks.length,V1Unchanged:true,projectEnvUnchanged:true,RPCsOpened:false,loginPerformed:false,cardClaims:false}));
 }catch(e){
  if(!folder){console.log(JSON.stringify({status:'STOPPED_BEFORE_DEPLOYMENT',reason:e.message}));process.exitCode=1;return;}
  report={...report,status:'STOPPED',reason:e.message,deployAttempted:attempted};save();
  if(attempted){
   console.log(JSON.stringify({stage:'AUTHORIZED_V1_ROLLBACK',reason:e.message,folder}));
   try{
    const rollback=await cli(['rollback',old,'--yes','--json','--scope',scope,'--cwd',root],240000);report.rollbackCommandCompleted=true;
    const s=await snapshot();report.rollbackCurrent=s.current;if(s.current.id!==old||s.current.state!=='READY'||s.projectEnvironmentMetadataSHA256!==report.before.projectEnvironmentMetadataSHA256)throw Error('Rollback metadata not confirmed');
    const baseline=JSON.parse(fs.readFileSync(path.join(report.baseline.folder,'RESULT.json')));report.rollbackHTTP=[];
    for(const b of baseline.legacy){const r=await fetch('https://rakyat-riview.vercel.app'+b.path,{redirect:'manual',signal:AbortSignal.timeout(20000)}),text=await r.text();const pass=r.status===b.status&&sha(text)===b.sha256;report.rollbackHTTP.push({path:b.path,pass});if(!pass)throw Error('Rollback V1 HTTP not confirmed');}
    report.status='ROLLED_BACK_TO_V1_VERIFIED';report.databaseChanged=false;
   }catch(r){report.status='ROLLBACK_NOT_CONFIRMED_MANUAL_ACTION_REQUIRED';report.rollbackReason=r.message;}
  }
  report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,folder,reason:report.reason,deployment:report.deployment||null,rollbackCurrent:report.rollbackCurrent||null,databaseChanged:false}));process.exitCode=1;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
