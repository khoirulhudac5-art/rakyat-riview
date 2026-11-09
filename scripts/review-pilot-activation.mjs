// Current-state read-only activation review. No enable, deploy, login or claim.
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
import {snapshot,compareSnapshots} from './public-pilot-live.mjs';
const folder=path.resolve('.backups/pilot-activation-review-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(folder,{recursive:false});
const project='prj_BdqElWlwjelD7zwY6pPZiABHYX9E',expectedDeployment='dpl_e2THSUZz1c5yH2Kf74oAPMJpJPGp';
async function get(endpoint){return new Promise((resolve,reject)=>{
 const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');const c=spawn(process.execPath,[npm,'exec','--cache',path.resolve('.local-tools/npm-cache'),'--yes','--package','vercel','--','vercel','api',endpoint,'--scope','rakprem','--method','GET'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='';const timer=setTimeout(()=>{c.kill();reject(Error('Metadata timeout'));},60000);c.stdout.on('data',b=>out+=b);c.stderr.on('data',()=>{});c.on('error',()=>{clearTimeout(timer);reject(Error('CLI unavailable'));});c.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('Metadata access failed'));try{resolve(JSON.parse(out));}catch{reject(Error('Metadata response unavailable'));}});
 });}
const report={status:'READONLY_REVIEW_RUNNING',productionChanged:false,loginPerformed:false,claimPerformed:false,at:new Date().toISOString()};
try{
 const d=await get('/v13/deployments/rakyat-riview.vercel.app');if(d.id!==expectedDeployment||d.projectId!==project||d.readyState!=='READY')throw Error('Current deployment drift');report.deployment={id:d.id,state:d.readyState,projectId:d.projectId,aliases:d.alias||[]};
 const names=Array.isArray(d.env)?d.env.map(e=>typeof e==='string'?e:e.key).filter(Boolean):d.env&&typeof d.env==='object'?Object.keys(d.env):null;
 const env=await get('/v10/projects/'+project+'/env?decrypt=false');report.projectEnvironmentNames=(env.envs||[]).filter(e=>e.target?.includes('production')).map(e=>e.key).sort();report.deploymentEnvironmentNames=names?.sort()||null;
 const rolled=JSON.parse(fs.readFileSync('.backups/pilot-closed-deployment-2026-11-07T12-26-02-283Z/RESULT.json'));report.approvedRuntimeEnvironmentNames=rolled.runtimeEnvNames;report.readerKeyAvailableByKnownConfiguration=[...report.projectEnvironmentNames,...rolled.runtimeEnvNames,...(names||[])].includes('SUPABASE_SERVICE_ROLE_KEY');
 const db=await snapshot(true);const installed=JSON.parse(fs.readFileSync('.backups/public-pilot-closed-2026-11-07T08-05-36-263Z/INSTALL-RESULT.json')).after;compareSnapshots(installed,db);
 if(db.state.fingerprint!=='59f0d0d9a4fee9a96481e0630c7b74a7')throw Error('Database fingerprint drift');
 fs.writeFileSync(path.join(folder,'DATABASE-READONLY.json'),JSON.stringify(db,null,2));
 report.database={tls:'verify-full',readOnly:db.health.readonly,stage:db.state.stage,state:db.state.state,fingerprint:db.state.fingerprint,actualMatches:db.state.actual===db.state.fingerprint,originalRPCsClosed:db.state.original_count,testWrappersClosed:db.state.wrapper_count,permissionsExact:db.state.permissions_exact,pilot:db.control,cardReady:db.ready,anonymousPilotRows:db.anonymousPilotRows,legacyAdminGenerateDigestsUnchanged:true,waitingLocks:db.health.waiting,strongLocks:db.health.strong_locks};
 const origin='https://rakyat-riview.vercel.app';const s=await fetch(origin+'/api/buyer?action=session',{redirect:'manual',signal:AbortSignal.timeout(20000)});report.unauthenticatedSession={status:s.status,denied:s.status===401};if(s.status!==401)throw Error('Anonymous session not denied');
 report.oauth={productionCallback:'https://rakyat-riview.vercel.app/pembeli/oauth.html',allowlistSource:'owner dashboard confirmation',siteURL:'http://localhost:3000',realProductionLoginTested:false,realProductionRefreshTokenTested:false};
 report.status='READONLY_PILOT_REVIEW_PASS_READER_CONFIGURATION_MISSING';
}catch(e){report.status='READONLY_REVIEW_STOPPED';report.reason=e.message;process.exitCode=1;}
fs.writeFileSync(path.join(folder,'RESULT.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({folder,...report}));
