// Explicitly approved CLOSED ONLY installer. Never enables a pilot or invokes a business RPC.
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {packageCheck,preflight,snapshot,compareSnapshots,bundle,sha,approvedInstall} from './public-pilot-live.mjs';
import {firstClaimConnection} from './prepare-first-claim-live.mjs';
import {tool} from '../.backups/tooling/admin-readonly-live.mjs';
export function prepareBackupDriver(){
 const source=fs.readFileSync('.backups/tooling/admin-readonly-live-backup.mjs','utf8');
 const old="import {preflight,read,tool,packageCheck,dataSQL} from './admin-readonly-live.mjs';";
 if(source.split(old).length!==2)throw Error('Verified exporter bridge shape changed');
 const replacement=`import {tool} from './admin-readonly-live.mjs';
import {preflight as pilotPreflight,packageCheck,dataSQL} from '../../scripts/public-pilot-live.mjs';
import {inspect} from '../../scripts/readonly-psql.mjs';
async function read(queries,env){return inspect({executable:path.resolve('.backups/tooling/pgsql/bin/psql.exe'),env,queries});}
async function preflight(folder){const r=await pilotPreflight(folder);fs.writeFileSync(path.join(folder,'backup-postflight-baseline.json'),JSON.stringify(r,null,2));return r;}`;
 const text=source.replace(old,replacement).replace("startsWith('admin-readonly-live-')","startsWith('public-pilot-closed-')");
 const file=path.resolve('.backups/tooling/public-pilot-live-backup.mjs');fs.writeFileSync(file,text);
 return {file,sha256:sha(text),sourceSHA256:sha(source)};
}
async function backupChild(driver,folder){return new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[driver,folder],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',b=>{out+=b;});child.stderr.on('data',()=>{});
 child.on('error',()=>reject(Error('Backup process start failed')));child.on('close',code=>{if(code!==0)reject(Error('Backup failed; STOP without retry'));else resolve(out);});
});}
export function verifyBackup(folder){
 const m=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json')));
 if(m.status!=='VERIFIED_CURRENT_BACKUP'||m.project_ref!=='svuagnobufhfpgzmsyxx'||m.tls!=='verify-full'||!m.readOnly||m.beforeFingerprint!=='5aefd8e4df29f1c365b8942629b911cd'||m.afterFingerprint!==m.beforeFingerprint||!m.verification.fullArchiveDecode||!m.verification.allLiveTableDataEntries||!m.verification.authUsersAndIdentities||!m.verification.parameterACL||!m.verification.sameReadOnlyTransactionGuards)throw Error('Backup verification/coverage mismatch');
 for(const f of m.files)if(path.basename(f.name)!==f.name||fs.statSync(path.join(folder,f.name)).size!==f.bytes||sha(fs.readFileSync(path.join(folder,f.name)))!==f.sha256)throw Error('Backup checksum mismatch');
 return m;
}
async function main(){
 let folder,report,stage='local_package',writeAttempted=false;
 const save=()=>{if(folder&&report)fs.writeFileSync(path.join(folder,'INSTALL-RESULT.json'),JSON.stringify(report,null,2));};
 try{
  packageCheck();
  if(process.argv[2]==='--backup-only'){
   folder=path.resolve('.backups/public-pilot-closed-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(folder,{recursive:false});
   report={status:'PREPARING_BACKUP',writeAttempted:false};save();
   const d=prepareBackupDriver();report.backupDriver=d;save();stage='verified_readonly_backup';
   await backupChild(d.file,folder);const m=verifyBackup(folder);
   report.status='BACKUP_VERIFIED_READY_FOR_FRESH_PREFLIGHT';report.backupManifestSHA256=sha(fs.readFileSync(path.join(folder,'manifest.json')));save();
   console.log(JSON.stringify({status:report.status,folder,archive:m.files[0],coverage:m.verification,writeAttempted:false}));return;
  }
  if(process.argv[2]!=='--approved-closed-only')throw Error('Explicit approved closed-only flag required');
  folder=path.resolve(process.argv[3]||'');
  if(path.dirname(folder)!==path.resolve('.backups')||!path.basename(folder).startsWith('public-pilot-closed-'))throw Error('Invalid approved backup folder');
  if(fs.existsSync(path.join(folder,'STOPPED.json'))||fs.existsSync(path.join(folder,'INSTALL-ATTEMPT.json')))throw Error('Prior failure/attempt exists; no automatic retry');
  const backup=verifyBackup(folder);const old=JSON.parse(fs.readFileSync(path.join(folder,'INSTALL-RESULT.json')));
  if(old.status!=='BACKUP_VERIFIED_READY_FOR_FRESH_PREFLIGHT'||sha(fs.readFileSync(path.join(folder,'manifest.json')))!==old.backupManifestSHA256)throw Error('Backup gate not approved/verified');
  report={status:'FRESH_PREFLIGHT',project_ref:'svuagnobufhfpgzmsyxx',writeAttempted:false,installSQLSHA256:approvedInstall,backupManifestSHA256:old.backupManifestSHA256,backup:backup.verification,startedAt:new Date().toISOString()};save();
  stage='fresh_preflight';report.before=await preflight(folder);
  const backed=JSON.parse(fs.readFileSync(path.join(folder,'backup-fingerprints.json')));if(!backed.match||backed.before!==report.before.state.fingerprint)throw Error('Backup/current baseline mismatch');
  const baseline=JSON.parse(fs.readFileSync(path.join(folder,'backup-postflight-baseline.json')));compareSnapshots(baseline,report.before);save();
  stage='install_closed';packageCheck();verifyBackup(folder);
  const env=firstClaimConnection();if(env.PGSSLMODE!=='verify-full')throw Error('TLS guard failed');
  env.PGOPTIONS='-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=60000';env.PGAPPNAME='rakyat-review-approved-pilot-install-closed';
  fs.writeFileSync(path.join(folder,'INSTALL-ATTEMPT.json'),JSON.stringify({at:new Date().toISOString(),sql_sha256:approvedInstall,closedOnly:true}),{flag:'wx'});
  writeAttempted=true;report.writeAttempted=true;save();
  await tool('psql',['-X','-q','-w','-A','-t','-v','ON_ERROR_STOP=1','-f',path.join(bundle,'install-closed.sql')],env);
  report.sqlProcessCompleted=true;save();
  stage='postflight';report.after=await snapshot(true);compareSnapshots(report.before,report.after,{installed:true});packageCheck();verifyBackup(folder);
  report.status='PILOT_INSTALLED_CLOSED_POSTFLIGHT_PASS';report.finishedAt=new Date().toISOString();save();
  console.log(JSON.stringify({status:report.status,folder,checkpoint:6,state:'closed',fingerprint:report.after.state.fingerprint,installSQLSHA256:approvedInstall,originalClosed:11,wrappersClosed:2,pilotClosed:4,pilotReady:true,dataUnchanged:true,adminReadersUnchanged:true,generateUnchanged:true,resetClosed:true,ownerEditClosed:true}));
 }catch(e){
  if(folder){fs.mkdirSync(folder,{recursive:true});report={...report,status:'STOPPED',stage,writeAttempted,reason:'Guard/check failed. No retry, rollback, enable, or further writes performed.',diagnostic:/^((Approved|Six |Checkpoint|Read-only|Ready|Visibility|Pilot|Guard patch|Postflight|Backup|Verified|Prior|Invalid approved|Explicit|TLS|Tool|Database|Connection|Wrong branch|Schema)[\w\s/;:.,+()-]*)$/.test(e.message)?e.message:'Sensitive diagnostic suppressed; inspect the private artifact locally'};save();fs.writeFileSync(path.join(folder,'STOPPED.json'),JSON.stringify(report,null,2));}
  console.log(JSON.stringify({status:'STOPPED',stage,writeAttempted,reason:report?.diagnostic||'Local integrity guard failed; no live operation',folder}));process.exitCode=1;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
