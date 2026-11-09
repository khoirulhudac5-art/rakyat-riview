import {runPartialTests} from '../tests/postgres-partial-local.mjs';
import {runOperations} from '../tests/postgres-operations-local.mjs';
import {runLocalV2Tests} from '../tests/postgres-v2-local.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
const root=process.cwd(),bin=path.join(root,'.backups/tooling/pgsql/bin'),backup=path.join(root,'.backups/v1-2026-11-05T17-00-39-619Z');
const base=path.join(root,'.backups','v2-operations-test-'+new Date().toISOString().replace(/[:.]/g,'-')),data=path.join(base,'pgdata');
const password=crypto.randomBytes(32).toString('hex');const env={};for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP','APPDATA','USERPROFILE','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{PGHOST:'127.0.0.1',PGPORT:'55480',PGUSER:'rr_local_restore',PGPASSWORD:password,PGDATABASE:'postgres',PGCONNECT_TIMEOUT:'5',PGCLIENTENCODING:'UTF8',PGTZ:'UTC'});
let started=false,stage='integrity';const report={target:'isolated local PostgreSQL only',host:'127.0.0.1',port:55480,productionConnected:false,migrationsRun:false,started_at:new Date().toISOString()};
function run(tool,args,allowFailure=false){return new Promise((resolve,reject)=>{const c=spawn(path.join(bin,tool+'.exe'),args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',v=>out+=v);c.stderr.on('data',v=>err+=v);c.on('error',()=>reject({reason:'Local tool failed to start'}));c.on(tool==='pg_ctl'?'exit':'close',code=>{if(tool==='pg_ctl'){c.stdout.destroy();c.stderr.destroy();}const r={code,out,err};if(code===0||allowFailure)resolve(r);else reject({reason:/extension.*(not available|control)|could not open extension control/i.test(err)?'Required extension unavailable':/permission denied/i.test(err)?'Local restore permission error':'Local tool failed',tool,code});});});}
async function sql(query,database='postgres'){const r=await run('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-d',database,'-c',query]);return r.out.trim();}
try{
 fs.mkdirSync(base,{recursive:false});const manifest=JSON.parse(fs.readFileSync(path.join(backup,'manifest.json')));
 for(const f of manifest.files){const bytes=fs.readFileSync(path.join(backup,f.name));if(bytes.length!==f.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==f.sha256)throw{reason:'Backup checksum mismatch'};}report.backupChecksums=true;
 stage='initdb';const pwfile=path.join(base,'local-bootstrap-password');fs.writeFileSync(pwfile,password,{flag:'wx'});
 try{await run('initdb',['-D',data,'-U','rr_local_restore','--pwfile='+pwfile,'--auth-host=scram-sha-256','--auth-local=scram-sha-256','--encoding=UTF8','--locale=C']);}finally{fs.unlinkSync(pwfile);}
 fs.appendFileSync(path.join(data,'postgresql.conf'),"\nlisten_addresses='127.0.0.1'\nport=55480\nlog_min_messages=panic\nlog_min_error_statement=panic\nlog_statement='none'\n");
 stage='start';await run('pg_ctl',['-D',data,'-l',path.join(base,'server.log'),'-w','start']);started=true;
 report.loopbackOnly=await sql("SELECT current_setting('listen_addresses')") ==='127.0.0.1';if(!report.loopbackOnly)throw{reason:'Local isolation check failed'};
 stage='roles';const rolesAttempt=await run('psql',['-X','-q','--single-transaction','-v','ON_ERROR_STOP=1','-f',path.join(backup,'roles.sql')],true);report.rolesRestored=rolesAttempt.code===0;
 if(rolesAttempt.code!==0){report.rolesCompatibilityIssue=true;const roles=fs.readFileSync(path.join(backup,'roles.sql'),'utf8').split(/\r?\n/).map(l=>l.match(/^CREATE ROLE ([A-Za-z_][A-Za-z0-9_]*);$/)?.[1]).filter(Boolean);for(const role of roles){await sql('CREATE ROLE '+role+' NOLOGIN'+(role==='service_role'?' BYPASSRLS':''));}report.localRoleProjection=true;}
 await sql('CREATE DATABASE v1_strict TEMPLATE template0');stage='full_restore';
 const full=await run('pg_restore',['--exit-on-error','--single-transaction','--dbname=v1_strict',path.join(backup,'database.dump')],true);
 report.fullRestore={success:full.code===0,exitCode:full.code,missingSupabaseVault:/supabase_vault/.test(full.err)&&/not available|control/.test(full.err),transactional:true};
 console.log(JSON.stringify({fullRestore:report.fullRestore}));
 // Explicitly scoped restore; do not fabricate substitutes for managed extensions.
 await sql('CREATE DATABASE v1_app_auth TEMPLATE template0');
 const toc=fs.readFileSync(path.join(backup,'archive-list.txt'),'utf8');
 const excluded=[],kept=toc.split(/\r?\n/).filter(line=>{if(/^;|^\s*$/.test(line))return true;const omit=/supabase_vault|\bEVENT TRIGGER\b|\b(?:SCHEMA - vault|SCHEMA vault|(?:TABLE DATA|TABLE|VIEW|FUNCTION|ACL|COMMENT) vault)\b/.test(line);if(omit)excluded.push(line.split(';')[0]);return !omit;});
 const list=path.join(base,'app-auth.list');fs.writeFileSync(list,kept.join('\n'));report.scopedExclusions={vault:true,eventTriggers:true,entryCount:excluded.length};
 stage='scoped_restore';await run('pg_restore',['--exit-on-error','--single-transaction','--use-list='+list,'--dbname=v1_app_auth',path.join(backup,'database.dump')]);report.scopedRestore=true;
 stage='verification';
 const result=JSON.parse(await sql("SELECT json_build_object('public_tables',(SELECT count(*) FROM pg_tables WHERE schemaname='public'),'auth_tables',(SELECT count(*) FROM pg_tables WHERE schemaname='auth'),'auth_functions',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='auth'),'public_functions',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),'rls_legacy',(SELECT count(*)=3 AND bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.card'::regclass,'public.card_activation'::regclass,'public.card_pin_attempts'::regclass)),'policy',(SELECT count(*) FROM pg_policies WHERE schemaname='public'),'rpc_service_only',NOT has_function_privilege('anon','public.activate_review_card(text,text,text,text,text)','EXECUTE') AND has_function_privilege('service_role','public.activate_review_card(text,text,text,text,text)','EXECUTE'),'card_rows',(SELECT count(*) FROM public.card),'activation_rows',(SELECT count(*) FROM public.card_activation),'attempt_rows',(SELECT count(*) FROM public.card_pin_attempts),'auth_users',(SELECT count(*) FROM auth.users),'auth_identities',(SELECT count(*) FROM auth.identities))",'v1_app_auth'));
 report.verification=result;
 if(result.public_tables!==3||result.auth_tables!==27||!result.rls_legacy||result.policy!==1||!result.rpc_service_only)throw{reason:'Restored schema/RLS assertion failed'};
 const originals=JSON.parse(fs.readFileSync(path.join(root,'supabase/existing/metadata-before-v2.json')));
 const restored=JSON.parse(await sql("SELECT json_agg(json_build_object('name',p.proname,'md5',md5(pg_get_functiondef(p.oid)))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'",'v1_app_auth'));
 report.legacyFunctionDefinitionsMatch=originals.functions.every(f=>restored.some(r=>r.name===f.name&&r.md5===f.definition_md5));if(!report.legacyFunctionDefinitionsMatch)throw{reason:'Legacy function definition differs from snapshot'};
 
 const originalData=path.join(base,'original-app-auth.sql'),restoredData=path.join(base,'restored-app-auth.sql');
 await run('pg_restore',['--data-only','--schema=public','--schema=auth','--file='+originalData,path.join(backup,'database.dump')]);
 await run('pg_dump',['--no-password','--data-only','--schema=public','--schema=auth','--file='+restoredData,'v1_app_auth']);
 function copyBlocks(file){const blocks=new Map();const lines=fs.readFileSync(file,'utf8').split(/\r?\n/);for(let i=0;i<lines.length;i++){if(!lines[i].startsWith('COPY '))continue;const header=lines[i],rows=[];while(++i<lines.length&&lines[i]!=='\\.')rows.push(lines[i]);blocks.set(header,crypto.createHash('sha256').update(rows.sort().join('\n')).digest('hex'));}return blocks;}
 const before=copyBlocks(originalData),after=copyBlocks(restoredData);report.dataComparison={tables:before.size,allCopyRowsMatch:before.size===after.size&&[...before].every(([k,v])=>after.get(k)===v)};
 if(before.size!==30||!report.dataComparison.allCopyRowsMatch)throw{reason:'Restored public/Auth data differs from archive'};
 const sequenceLines=file=>fs.readFileSync(file,'utf8').split(/\r?\n/).filter(l=>l.startsWith('SELECT pg_catalog.setval(')).sort();report.sequenceValuesMatch=JSON.stringify(sequenceLines(originalData))===JSON.stringify(sequenceLines(restoredData));if(!report.sequenceValuesMatch)throw{reason:'Sequence state differs from archive'};
 const anon=await sql('BEGIN READ ONLY; SET LOCAL ROLE anon; SELECT count(card_code) FROM public.card; COMMIT;','v1_app_auth');
 const auth=await sql('BEGIN READ ONLY; SET LOCAL ROLE authenticated; SELECT count(card_code) FROM public.card; COMMIT;','v1_app_auth');
 report.rlsBehavior={anonLegacyRowsVisible:Number(anon)===Number(result.card_rows),authenticatedRowsHidden:Number(auth)===0};
 if(!report.rlsBehavior.anonLegacyRowsVisible||!report.rlsBehavior.authenticatedRowsHidden)throw{reason:'Restored RLS behavior mismatch'};
 await sql('CREATE DATABASE v2_partial TEMPLATE v1_app_auth'); await sql('ALTER DATABASE v2_partial OWNER TO postgres');
 const legacyMax=Number(await sql('SELECT coalesce(max(id),0) FROM public.card','v1_app_auth'));const customerSnapshot=await sql("SELECT md5(coalesce(jsonb_agg(to_jsonb(c) ORDER BY id)::text,'')) FROM public.card c",'v1_app_auth');
 stage='preflight';for(const f of ['preflight.sql','preflight_six.sql']){const r=await run('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-d','v1_app_auth','-f',path.join(root,'supabase/existing',f)]);if(!Object.values(JSON.parse(r.out.trim())).every(x=>x===true))throw{reason:'Preflight failed'};}report.preflight=true;stage='v2_migrations_and_tests';report.v2=await runLocalV2Tests({sql,run,base,root,pinFix:true,inventoryGate:true,adminReset:true,rolesBackup:path.join(backup,'roles.sql')});report.migrationsRun=true;stage='operations';report.operations=await runOperations({sql,run,root,base});stage='partial_control';report.partial=await runPartialTests({sql,run,root,base});report.originalLegacyRowsUnchanged=customerSnapshot===await sql("SELECT md5(coalesce(jsonb_agg(to_jsonb(c)-'claim_mode'-'v2_activated_at' ORDER BY id)::text,'')) FROM public.card c WHERE id<="+legacyMax,'v1_app_auth');if(!report.originalLegacyRowsUnchanged)throw{reason:'Original legacy rows changed'};report.status=report.fullRestore.success?'FULL_RESTORE_VERIFIED':'SCOPED_RESTORE_VERIFIED_FULL_RESTORE_BLOCKED';
 console.log(JSON.stringify({status:report.status,legacyTables:result.public_tables,authTables:result.auth_tables,rlsVerified:result.rls_legacy,functionDefinitionsMatch:report.legacyFunctionDefinitionsMatch,reportFolder:base}));
}catch(error){report.status='FAILED';report.failedStage=stage;report.reason=error?.reason||'Restore or verification failed; sensitive details suppressed';console.log(JSON.stringify({status:report.status,stage,reason:report.reason,reportFolder:base}));process.exitCode=1;}
finally{if(started){try{await run('pg_ctl',['-D',data,'-w','-m','fast','stop']);report.localServerStopped=true;}catch{report.localServerStopped=false;process.exitCode=1;}}fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(report,null,2));}
