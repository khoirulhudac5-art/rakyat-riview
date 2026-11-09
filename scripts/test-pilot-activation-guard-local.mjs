// New activation guard rehearsal only. No .env, customers or production connections.
// Only synthetic loopback databases are modified; no external run is opened.
import fs from 'node:fs';
import {pilotCard,pilotAccessSQL,pilotRollbackSQL,writePilotPackage} from './public-pilot-package.mjs';
import {startPilotFixture} from './public-pilot-fixture-http.mjs';
import {pilotBrowser} from './public-pilot-browser.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {files as migrationFiles,fingerprintSQL,pauseBody} from './v2-migration-control.mjs';
import {restrictedPackageSQL} from './prepare-restricted-local.mjs';
import {writePackage} from './admin-readonly-package.mjs';
import {writeGeneratePackage,generationAccessSQL,generateRollbackSQL,generateInventorySQL} from './admin-generate-package.mjs';

const root=process.cwd(),bin=path.join(root,'.backups/tooling/pgsql/bin');
const base=path.join(root,'.backups','pilot-activation-guard-local-'+new Date().toISOString().replace(/[:.]/g,'-'));
const data=path.join(base,'pgdata'),database='rr_pilot_activation_guard',port='55489';
const password=crypto.randomBytes(32).toString('hex'),env={};
for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP','APPDATA','USERPROFILE','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{PGHOST:'127.0.0.1',PGPORT:port,PGUSER:'rr_local_restricted',PGPASSWORD:password,PGDATABASE:database,PGCONNECT_TIMEOUT:'5',PGCLIENTENCODING:'UTF8',PGTZ:'UTC',PGSSLMODE:'disable',PGAPPNAME:'rakyat-review-synthetic-closed-installer-local'});
let started=false,stage='local_preflight',httpFixture;
const report={target:'isolated local PostgreSQL only',productionConnected:false,customerRowsUsed:false,realCredentialsUsed:false,host:'127.0.0.1',port:Number(port),startedAt:new Date().toISOString(),localRoleProjection:true,managedSupabaseRestored:false,openRunExecuted:false,localPilotRPCsCalled:true,authProvider:'synthetic PKCE/JWT fixture, not real Google or PostgREST'};
const literal=s=>"'"+String(s).replaceAll("'","''")+"'";

function execute(executable,args,allowFailure=false,tool='process'){
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let out='',err='',settled=false;
  child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err+=chunk);
  child.on('error',()=>{if(!settled){settled=true;reject({reason:'Local tool failed to start',tool});}});
  child.on(tool==='pg_ctl'?'exit':'close',code=>{
   if(settled)return;settled=true;
   if(tool==='pg_ctl'){child.stdout.destroy();child.stderr.destroy();}
   if(code===0||allowFailure)resolve({code,out,err});
   else reject({reason:'Local synthetic SQL/tool failed',tool,code,err});
  });
 });
}
const run=(tool,args,allowFailure=false)=>execute(path.join(bin,tool+'.exe'),args,allowFailure,tool);
async function sql(query,db=database,asPostgres=true){
 const args=['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-d',db];
 if(asPostgres)args.push('-c','SET ROLE postgres');
 args.push('-c',query);
 return (await run('psql',args)).out.trim().replaceAll('\r\n','\n');
}
async function sqlFile(file){
 await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',database,'-c','SET ROLE postgres','-f',file]);
}
function writeSQL(name,text){const file=path.join(base,name);fs.writeFileSync(file,text);return file;}
function sanitizedReason(error){
 if(error?.reason)return String(error.reason).slice(0,180);
 if(error?.report?.reason)return String(error.report.reason).slice(0,180);
 return 'Local closed-installer test failed; see isolated synthetic test progress';
}

try{
 fs.mkdirSync(base,{recursive:false});
 const branch=(await execute('git',['branch','--show-current'],false,'git')).out.trim();
 if(branch!=='v2-development')throw {reason:'Closed-installer tests require v2-development'};
 report.branch=branch;
 if(migrationFiles.length!==6)throw {reason:'Expected exactly the approved six migration source files'};
 const expectedNames=[
  '20261105000100_buyer_accounts.sql','20261105000200_google_first_claim.sql',
  '20261105000300_existing_public_visibility.sql','20261105000400_fix_legacy_pin_cooldown.sql',
  '20261105000500_one_time_inventory_claim.sql','20261105000600_auto_ready_admin_reset.sql',
 ];
 if(JSON.stringify(migrationFiles)!==JSON.stringify(expectedNames))throw {reason:'Unexpected migration source identities'};
 for(const tool of ['initdb','pg_ctl','psql'])if(!fs.existsSync(path.join(bin,tool+'.exe')))throw {reason:'Portable PostgreSQL tooling unavailable'};
 stage='initdb';
 const pwfile=path.join(base,'bootstrap-password');fs.writeFileSync(pwfile,password,{flag:'wx'});
 try{await run('initdb',['-D',data,'-U',env.PGUSER,'--pwfile='+pwfile,'--auth-host=scram-sha-256','--auth-local=scram-sha-256','--encoding=UTF8','--locale=C']);}
 finally{fs.unlinkSync(pwfile);}
 fs.appendFileSync(path.join(data,'postgresql.conf'),"\nlisten_addresses='127.0.0.1'\nport="+port+"\nlog_min_messages=panic\nlog_min_error_statement=panic\nlog_statement='none'\n");
 stage='start';
 await run('pg_ctl',['-D',data,'-l',path.join(base,'server.log'),'-w','start']);started=true;
 if(await sql("SELECT current_setting('listen_addresses')",'postgres',false)!=='127.0.0.1')throw {reason:'Local loopback isolation failed'};
 report.loopbackOnly=true;
 stage='synthetic_baseline';
 await sql('CREATE ROLE postgres NOSUPERUSER BYPASSRLS CREATEROLE CREATEDB INHERIT NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; GRANT anon,authenticated,service_role TO postgres; GRANT pg_read_all_stats TO postgres;','postgres',false);
 await sql('CREATE DATABASE '+database+' TEMPLATE template0 OWNER postgres','postgres',false);
 const fixture=fs.readFileSync(path.join(root,'supabase/tests/buyer_account_fixture.sql'),'utf8').replace(/^CREATE ROLE (?:anon|authenticated|service_role) NOLOGIN;\r?\n/gm,'');
 await sqlFile(writeSQL('synthetic-base.sql',fixture));
 // Committed schema-only metadata; no customer rows or backup data are loaded.
 const metadata=JSON.parse(fs.readFileSync(path.join(root,'supabase/existing/metadata-before-v2.json'),'utf8'));
 const legacyNames=['activate_review_card','set_initial_card_pin','update_card_review_url'];
 const definitions=legacyNames.map(name=>{const entry=metadata.functions?.find(fn=>fn.name===name);if(!entry?.definition)throw {reason:'Schema-only legacy definition missing'};return entry.definition;});
 await sqlFile(writeSQL('synthetic-legacy-definitions.sql',definitions.join(';\n')+';\n'));
 await sql(`CREATE TABLE auth.identities(user_id uuid REFERENCES auth.users(id),provider text NOT NULL,provider_id text,identity_data jsonb);
 CREATE VIEW public.card_public WITH (security_invoker=true) AS SELECT card_code,business_name,review_url FROM public.card;
 CREATE POLICY public_card_read ON public.card FOR SELECT TO anon USING(true);
 GRANT INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON public.card TO anon;
 GRANT ALL ON public.card TO authenticated;
 GRANT SELECT(card_code,business_name,review_url) ON public.card TO anon;
 GRANT ALL ON public.card_public TO anon,authenticated,service_role;
 GRANT USAGE ON SCHEMA auth,public,extensions TO service_role;
 GRANT ALL ON public.card,public.card_activation,public.card_pin_attempts TO service_role;
 GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
 REVOKE ALL ON FUNCTION public.activate_review_card(text,text,text,text,text),public.set_initial_card_pin(text,text),public.update_card_review_url(text,text,text) FROM PUBLIC,anon,authenticated;
 GRANT EXECUTE ON FUNCTION public.activate_review_card(text,text,text,text,text),public.set_initial_card_pin(text,text),public.update_card_review_url(text,text,text) TO service_role;`);
 report.baselineSource='synthetic buyer_account_fixture + committed schema-only legacy definitions';
 report.localOwnerRoleSuperuser=await sql("SELECT rolsuper FROM pg_roles WHERE rolname='postgres'")==='t';
 if(report.localOwnerRoleSuperuser)throw {reason:'Application owner role must not be superuser'};
 stage='six_local_migrations';
 report.migrations=[];
 for(const name of migrationFiles){await sqlFile(path.join(root,'supabase/migrations',name));report.migrations.push({name,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'supabase/migrations',name))).digest('hex')});}
 // Unrelated, pre-existing synthetic baseline rows allow regression verification.
 const A='f1111111-1111-4111-8111-111111111111',B='f2222222-2222-4222-8222-222222222222',C='f3333333-3333-4333-8333-333333333333';
 await sql(`INSERT INTO auth.users(id) VALUES('${A}'),('${B}'),('${C}');
 INSERT INTO auth.identities(user_id,provider,provider_id,identity_data) VALUES('${A}','google','synthetic-a','{}'),('${B}','google','synthetic-b','{}'),('${C}','google','synthetic-c','{}');
 INSERT INTO public.card(card_code,business_name,review_url) VALUES('LEGACY-OUTSIDE-REGISTRY','Synthetic legacy owned outside registry','https://search.google.com/local/writereview?placeid=ChISyntheticLegacy');
 INSERT INTO public.buyer_card_ownership(card_code,user_id) VALUES('LEGACY-OUTSIDE-REGISTRY','${A}');
 INSERT INTO public.buyer_claim_limits(user_id,window_start,attempts) VALUES('${A}',now(),7);`);
 await sql(`INSERT INTO public.card(card_code,claim_mode,business_name,review_url,v2_activated_at) VALUES
 ('RRRRRRRRRRRRRRRRRRRRRRRR','google_first_claim','Ready synthetic',NULL,NULL),
 ('UUUUUUUUUUUUUUUUUUUUUUUU','google_first_claim','Owned synthetic','https://search.google.com/local/writereview?placeid=ChISyntheticLocal',now()),
 ('WWWWWWWWWWWWWWWWWWWWWWWW','google_first_claim','Second same UID','https://search.google.com/local/writereview?placeid=ChISyntheticLocal',now()),
 ('XXXXXXXXXXXXXXXXXXXXXXXX','google_first_claim','Retired test','https://search.google.com/local/writereview?placeid=ChISyntheticLocal',now());
 INSERT INTO public.buyer_card_inventory(card_code,state,claimed_at,ready_at,updated_by,activation_revision) SELECT card_code,CASE WHEN v2_activated_at IS NULL THEN 'ready' ELSE 'claimed' END, v2_activated_at,now(),'synthetic-fixture',1 FROM public.card WHERE claim_mode='google_first_claim';
 INSERT INTO public.buyer_card_ownership(card_code,user_id) SELECT card_code,'f1111111-1111-4111-8111-111111111111'::uuid FROM public.card WHERE v2_activated_at IS NOT NULL;
 INSERT INTO public.buyer_ownership_audit(card_code,new_owner,actor,reason,created_at) VALUES ('UUUUUUUUUUUUUUUUUUUUUUUU','f1111111-1111-4111-8111-111111111111','synthetic-only','first_claim','2026-11-06T00:00:00Z'),('XXXXXXXXXXXXXXXXXXXXXXXX','f1111111-1111-4111-8111-111111111111','synthetic-only','first_claim','2026-11-06T00:00:00Z');
 INSERT INTO public.buyer_activation_reset_audit(card_code,old_owner,old_activated_at,previous_revision,actor,reason,reset_at) VALUES ('UUUUUUUUUUUUUUUUUUUUUUUU','f1111111-1111-4111-8111-111111111111',now(),0,'synthetic-only','Synthetic recorded reset','2026-11-06T00:00:00Z');`);
 await sql(`INSERT INTO public.card(card_code,claim_mode) VALUES('${pilotCard}','google_first_claim');INSERT INTO public.buyer_card_inventory(card_code,state,ready_at,updated_by,activation_revision) VALUES('${pilotCard}','ready',now(),'synthetic-fixture',1);`);
 stage='closed_checkpoint';
 await sqlFile(writeSQL('closed-baseline.sql',`BEGIN; ${pauseBody(true)}
 CREATE SCHEMA rr_v2_control;
 REVOKE ALL ON SCHEMA rr_v2_control FROM PUBLIC,anon,authenticated,service_role;
 CREATE TABLE rr_v2_control.state(id boolean PRIMARY KEY DEFAULT true CHECK(id),stage integer NOT NULL,hashes jsonb NOT NULL,fingerprint text,state text NOT NULL);
 ALTER TABLE rr_v2_control.state ENABLE ROW LEVEL SECURITY;
 REVOKE ALL ON rr_v2_control.state FROM PUBLIC,anon,authenticated,service_role;
 INSERT INTO rr_v2_control.state VALUES(true,6,${literal(JSON.stringify(report.migrations.map(m=>m.sha256)))}::jsonb,(${fingerprintSQL}),'closed'); COMMIT;`));
 report.initialCheckpoint=JSON.parse(await sql("SELECT json_build_object('stage',stage,'state',state,'fingerprint',fingerprint) FROM rr_v2_control.state"));
 stage='restricted_baseline';
 await sqlFile(writeSQL('restricted-baseline.sql',restrictedPackageSQL()));
 await sql(`INSERT INTO rr_v2_test.runs(run_id,user_a,user_b,expires_at,status,closed_at) VALUES('eeeeeeee-1111-4111-8111-111111111111','${A}','${B}',now()-interval '1 hour','retired',now());
 INSERT INTO rr_v2_test.cards(card_code,run_id,label,retired) VALUES('XXXXXXXXXXXXXXXXXXXXXXXX','eeeeeeee-1111-4111-8111-111111111111','retired synthetic',true);`);
 const readBase=await sql('SELECT rr_v2_test.fingerprint()');const readFolder=path.join(base,'read-package');writePackage(readFolder,readBase);await sqlFile(path.join(readFolder,'install.sql'));
 const genFolder=path.join(base,'generate-package');writeGeneratePackage(genFolder,await sql('SELECT rr_v2_test.fingerprint()'));await sqlFile(path.join(genFolder,'install.sql'));await sql(generationAccessSQL(true));
 report.tests=[];const check=(name,pass)=>{report.tests.push({name,pass:!!pass});if(!pass)throw {reason:name};};
 stage='install_closed_fixture';const pkg=path.join(base,'pilot-package');writePilotPackage(pkg,await sql('SELECT rr_v2_test.fingerprint()'));await sqlFile(path.join(pkg,'install-closed.sql'));
 const fp=await sql('SELECT rr_v2_test.fingerprint()'),sourceFile='.backups/pilot-activation-approval-2026-11-07T13-14-25-857Z/enable-guarded-pending-approval.sql',bytes=fs.readFileSync(sourceFile,'utf8');
 report.guardedSQLSHA256=crypto.createHash('sha256').update(bytes).digest('hex');if(report.guardedSQLSHA256!=='eed4b41287342ae614b5d50ae0b0678d64b6859768c3df9d8955c74d5c4a92bc')throw {reason:'Guarded SQL artifact changed'};
 const activate=bytes.replaceAll('59f0d0d9a4fee9a96481e0630c7b74a7',fp);
 report.fingerprintProjection='Only approved live fingerprint literal replaced with isolated fixture fingerprint; card code identical but synthetic local row';
 async function refused(s){const f=writeSQL('negative-guard.sql',s);return (await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',database,'-c','SET ROLE postgres','-f',f],true)).code!==0;}
 stage='guard_checks';
 check('wrong expected fingerprint aborts transaction',await refused(activate.replaceAll(fp,'0'.repeat(32)))&&await sql('SELECT rr_v2_test.fingerprint()')===fp);
 await sql(`INSERT INTO rr_claim_pilot.attempts(uid,result_code) VALUES('${A}','synthetic-only')`);
 check('prior attempt blocks reopening without any ACL/control change',await refused(activate)&&await sql('SELECT rr_v2_test.fingerprint()')===fp);
 await sql('DELETE FROM rr_claim_pilot.attempts');
 await sqlFile(writeSQL('guarded-activation.sql',activate));
 check('valid guarded activation executes atomically',await sql("SELECT public_on AND claim_on AND owner_on AND redirect_on AND expires_at>clock_timestamp()+interval '29 minutes' FROM rr_claim_pilot.control WHERE id")==='t');
 await sql("SELECT rr_v2_test.verify_state('closed');SELECT rr_claim_pilot.assert_acl()");
 const enabledFP=await sql('SELECT rr_v2_test.fingerprint()');check('same activation cannot be replayed',await refused(activate)&&await sql('SELECT rr_v2_test.fingerprint()')===enabledFP);
 await sql(pilotAccessSQL());check('emergency pause restores closed without claiming synthetic card',await sql(`SELECT NOT public_on AND NOT claim_on AND NOT owner_on AND NOT redirect_on AND NOT EXISTS(SELECT 1 FROM public.buyer_card_ownership WHERE card_code='${pilotCard}') FROM rr_claim_pilot.control WHERE id`)==='t');
 report.pass=true;report.productionConnected=false;report.claimExecuted=false;fs.writeFileSync(path.join(base,'RESULT.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({pass:true,checks:report.tests.length,folder:path.relative(root,base),guardedSQLSHA256:report.guardedSQLSHA256,productionConnected:false}));
}catch(error){report.pass=false;report.stage=stage;report.reason=sanitizedReason(error);if(error.err)fs.writeFileSync(path.join(base,'synthetic-error.txt'),error.err);fs.mkdirSync(base,{recursive:true});fs.writeFileSync(path.join(base,'RESULT.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({pass:false,stage,reason:report.reason,folder:path.relative(root,base)}));process.exitCode=1;
}finally{if(started)await run('pg_ctl',['-D',data,'-m','fast','-w','stop'],true);}
