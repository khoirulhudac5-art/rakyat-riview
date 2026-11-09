// Local-only acceptance harness for the exact approved six-step orchestrator.
// Reads an offline backup; never reads .env files or contacts Supabase.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fingerprintSQL} from './v2-migration-control.mjs';
import {executeApprovedSix} from './approved-six-runner.mjs';

const root=process.cwd(),bin=path.join(root,'.backups/tooling/pgsql/bin');
const backup=path.join(root,'.backups/v1-2026-11-05T19-04-23-157Z');
const base=path.join(root,'.backups','approved-six-local-'+new Date().toISOString().replace(/[:.]/g,'-'));
const data=path.join(base,'pgdata'),database='v1_app_auth';
const password=crypto.randomBytes(32).toString('hex'),env={};
for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP','APPDATA','USERPROFILE','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{PGHOST:'127.0.0.1',PGPORT:'55482',PGUSER:'rr_local_restore',PGPASSWORD:password,PGDATABASE:database,PGCONNECT_TIMEOUT:'5',PGCLIENTENCODING:'UTF8',PGTZ:'UTC',PGSSLMODE:'disable',PGAPPNAME:'rakyat-review-approved-six-local'});
let started=false,stage='integrity';
const report={target:'isolated local PostgreSQL only',productionConnected:false,host:'127.0.0.1',port:55482,backup:path.relative(root,backup),startedAt:new Date().toISOString(),localRoleProjection:true,managedRolesAndParameterACLRestored:false};

function run(tool,args,allowFailure=false){return new Promise((resolve,reject)=>{
 const c=spawn(path.join(bin,tool+'.exe'),args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';
 c.stdout.on('data',x=>out+=x);c.stderr.on('data',x=>err+=x);
 c.on('error',()=>reject({reason:'Local tool failed to start'}));
 c.on(tool==='pg_ctl'?'exit':'close',code=>{
  if(tool==='pg_ctl'){c.stdout.destroy();c.stderr.destroy();}
  if(code===0||allowFailure)resolve({code,out,err});else reject({reason:'Local tool failed',tool,code});
 });
});}
async function sql(query,db='postgres',asPostgres=false){
 const args=['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-d',db];
 if(asPostgres)args.push('-c','SET ROLE postgres');
 args.push('-c',query);const r=await run('psql',args);return r.out.trim();
}
const id=s=>'"'+s.replaceAll('"','""')+'"';
try{
 fs.mkdirSync(base,{recursive:false});
 const manifest=JSON.parse(fs.readFileSync(path.join(backup,'manifest.json')));
 if(manifest.status!=='VERIFIED_OFFLINE_BACKUP'||manifest.project_ref!=='svuagnobufhfpgzmsyxx')throw{reason:'Unexpected approved backup identity'};
 for(const f of manifest.files){const bytes=fs.readFileSync(path.join(backup,f.name));if(bytes.length!==f.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==f.sha256)throw{reason:'Backup checksum mismatch'};}
 report.backupChecksums=true;
 stage='initdb';const pwfile=path.join(base,'bootstrap-password');fs.writeFileSync(pwfile,password,{flag:'wx'});
 try{await run('initdb',['-D',data,'-U',env.PGUSER,'--pwfile='+pwfile,'--auth-host=scram-sha-256','--auth-local=scram-sha-256','--encoding=UTF8','--locale=C']);}finally{fs.unlinkSync(pwfile);}
 fs.appendFileSync(path.join(data,'postgresql.conf'),"\nlisten_addresses='127.0.0.1'\nport=55482\nlog_min_messages=panic\nlog_min_error_statement=panic\nlog_statement='none'\n");
 stage='start';await run('pg_ctl',['-D',data,'-l',path.join(base,'server.log'),'-w','start']);started=true;
 if(await sql("SELECT current_setting('listen_addresses')")!=='127.0.0.1')throw{reason:'Local loopback isolation failed'};
 report.loopbackOnly=true;
 stage='role_projection';const roles=JSON.parse(fs.readFileSync(path.join(backup,'roles.json')));
 for(const role of roles.roles){
  if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(role.rolname))throw{reason:'Unreviewed role identifier'};
  await sql('CREATE ROLE '+id(role.rolname)+' NOLOGIN NOSUPERUSER '+(role.rolinherit?'INHERIT':'NOINHERIT')+(role.rolbypassrls?' BYPASSRLS':''));
 }
 await sql('ALTER ROLE postgres NOSUPERUSER BYPASSRLS CREATEROLE CREATEDB INHERIT NOLOGIN');
 for(const member of roles.membership||[]){
  if(roles.role_names[member.member]==='postgres'){
   const inherited=roles.role_names[member.roleid];if(!inherited)throw{reason:'Unresolved inherited role'};
   await sql('GRANT '+id(inherited)+' TO postgres');
  }
 }
 stage='scoped_restore';await sql('CREATE DATABASE '+id(database)+' TEMPLATE template0 OWNER postgres');
 const toc=fs.readFileSync(path.join(backup,'archive-list.txt'),'utf8'),excluded=[];
 const kept=toc.split(/\r?\n/).filter(line=>{
  if(/^;|^\s*$/.test(line))return true;
  const omit=/supabase_vault|\bEVENT TRIGGER\b|\b(?:SCHEMA - vault|SCHEMA vault|(?:TABLE DATA|TABLE|VIEW|FUNCTION|ACL|COMMENT) vault)\b/.test(line);
  if(omit)excluded.push(line.split(';')[0]);return !omit;
 });
 const list=path.join(base,'app-auth.list');fs.writeFileSync(list,kept.join('\n'));
 report.scopedExclusions={vault:true,eventTriggers:true,entryCount:excluded.length};
 await run('pg_restore',['--exit-on-error','--single-transaction','--use-list='+list,'--dbname='+database,path.join(backup,'database.dump')]);
 report.scopedRestore=true;
 stage='baseline';report.baseline=JSON.parse(await sql("SELECT json_build_object('legacy_tables',(SELECT count(*) FROM pg_tables WHERE schemaname='public'),'auth_tables',(SELECT count(*) FROM pg_tables WHERE schemaname='auth'),'v2_absent',to_regclass('public.buyer_card_ownership') IS NULL)",database,true));
 if(report.baseline.legacy_tables!==3||report.baseline.auth_tables!==27||!report.baseline.v2_absent)throw{reason:'Unexpected restored baseline'};
 const expectedFingerprint=await sql(fingerprintSQL,database,true);report.expectedFingerprint=expectedFingerprint;
 stage='approved_six';report.core=await executeApprovedSix({env,executable:path.join(bin,'psql.exe'),reportDir:base,expectedFingerprint,sessionRole:'postgres',localTest:true});
 if(report.core?.status!=='SIX_COMMITTED_AND_VERIFIED_CLOSED')throw{reason:'Approved core did not report six verified closed steps'};
 report.status='COMPLETED_LOCAL_CORE';
 console.log(JSON.stringify({status:report.status,folder:base}));
}catch(error){report.status='FAILED';report.failedStage=stage;report.reason=error.reason||'Local acceptance failed; sensitive details suppressed';process.exitCode=1;console.log(JSON.stringify({status:report.status,stage,reason:report.reason,folder:base}));}
finally{
 if(started){try{await run('pg_ctl',['-D',data,'-w','-m','fast','stop']);report.localServerStopped=true;}catch{report.localServerStopped=false;process.exitCode=1;}}
 fs.writeFileSync(path.join(base,'local-report.json'),JSON.stringify(report,null,2));
}
