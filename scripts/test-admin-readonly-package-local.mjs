// Isolated closed-installer transport rehearsal. Never reads .env or customer backups.
// Only the synthetic loopback cluster is modified; no run is opened or card RPC called.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {files as migrationFiles,fingerprintSQL,pauseBody} from './v2-migration-control.mjs';
import {restrictedPackageSQL} from './prepare-restricted-local.mjs';
import {writePackage,verifyPackage,protectedSQL,inventorySQL,installSQL,pauseSQL,rollbackSQL} from './admin-readonly-package.mjs';

const root=process.cwd(),bin=path.join(root,'.backups/tooling/pgsql/bin');
const base=path.join(root,'.backups','admin-readonly-local-'+new Date().toISOString().replace(/[:.]/g,'-'));
const data=path.join(base,'pgdata'),database='rr_admin_readonly',port='55484';
const password=crypto.randomBytes(32).toString('hex'),env={};
for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP','APPDATA','USERPROFILE','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{PGHOST:'127.0.0.1',PGPORT:port,PGUSER:'rr_local_restricted',PGPASSWORD:password,PGDATABASE:database,PGCONNECT_TIMEOUT:'5',PGCLIENTENCODING:'UTF8',PGTZ:'UTC',PGSSLMODE:'disable',PGAPPNAME:'rakyat-review-synthetic-closed-installer-local'});
let started=false,stage='local_preflight';
const report={target:'isolated local PostgreSQL only',productionConnected:false,customerRowsUsed:false,realCredentialsUsed:false,host:'127.0.0.1',port:Number(port),startedAt:new Date().toISOString(),localRoleProjection:true,managedSupabaseRestored:false,openRunExecuted:false,businessRPCsCalled:false};
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
 const original=await sql('SELECT rr_v2_test.fingerprint()');
 const dataSQL=`SELECT md5(jsonb_build_object('card',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card c),'inventory',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.buyer_card_inventory c),'owners',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.buyer_card_ownership c),'audit',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.buyer_ownership_audit c),'reset',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.buyer_activation_reset_audit c),'pin',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card_pin_attempts c),'activation',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card_activation c))::text)`;
 const digest=await sql(dataSQL),protectedBefore=await sql(protectedSQL),legacyMap=await sql("SET ROLE anon;SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY card_code),'[]') FROM public.card_public c");
 report.tests=[];const check=(name,pass)=>{report.tests.push({name,pass:Boolean(pass)});if(!pass)throw {reason:name};};
 async function denied(query,role='service_role',state='42501'){
  const r=await run('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate','-d',database,'-c','SET ROLE postgres','-c',`SET ROLE ${role};${query}`],true);
  return r.code!==0&&r.err.includes(state);
 }
 stage='injected_failure';
 const injected=installSQL(original).replace(/COMMIT;\s*$/,"DO $$ BEGIN RAISE EXCEPTION 'Injected package failure';END $$;COMMIT;");
 const failed=await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',database,'-c','SET ROLE postgres','-f',writeSQL('injected.sql',injected)],true);
 if(failed.code===0)throw {reason:'Injected failure did not stop transaction'};
 // A prior SQL error must specifically be the intentional failure, not a broken package.
 if(!failed.err.includes('Injected package failure'))throw {reason:'Package failed before injected point',err:failed.err};
 check('injected pre-COMMIT error restores original fingerprint and removes new role',await sql('SELECT rr_v2_test.fingerprint()')===original&&await sql("SELECT to_regrole('rr_admin_read_definer') IS NULL")==='t');
 stage='install';
 const bundle=path.join(base,'package');report.package=writePackage(bundle,original);verifyPackage(bundle);
 await sqlFile(path.join(bundle,'preflight.sql'));await sqlFile(path.join(bundle,'install.sql'));await sqlFile(path.join(bundle,'postflight.sql'));
 const installed=await sql('SELECT rr_v2_test.fingerprint()');
 check('checkpoint 6 closed, old hashes and both ACL matrices verified',await sql("SELECT stage=6 AND state='closed' AND fingerprint=rr_v2_test.fingerprint() FROM rr_v2_control.state")==='t');
 await sql("SELECT rr_v2_test.assert_acl();SELECT rr_v2_test.verify_state('closed')");
 check('new read RPCs STABLE and owned by nonlogin nonbypass role',await sql("SELECT count(*)=2 AND bool_and(p.provolatile='s' AND p.prosecdef AND NOT(r.rolcanlogin OR r.rolsuper OR r.rolbypassrls)) FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid IN ('public.admin_read_v2_inventory(integer,text)'::regprocedure,'public.admin_read_v2_audit(integer,text)'::regprocedure)")==='t');
 for(const role of ['anon','authenticated']){
  check(role+' cannot invoke inventory',await denied('SELECT public.admin_read_v2_inventory()',role));
  check(role+' cannot invoke audit',await denied('SELECT public.admin_read_v2_audit()',role));
 }
 check('spoofed claims do not grant buyer role Admin read access',await denied("SELECT set_config('request.jwt.claim.role','service_role',false);SELECT public.admin_read_v2_inventory()",'authenticated'));
 check('application cannot select private projection views',await denied('SELECT * FROM rr_v2_control.admin_read_inventory'));
 check('definer cannot select PIN or any base business table',await denied('SELECT pin_hash FROM public.card','rr_admin_read_definer'));
 check('definer cannot mutate business rows',await denied("UPDATE public.card SET business_name='forbidden'",'rr_admin_read_definer'));
 const readRPC=async(name,limit=200,cursor=null)=>JSON.parse(await sql(`BEGIN READ ONLY;SET LOCAL ROLE service_role;SELECT public.${name}(${limit},${cursor===null?'NULL':literal(cursor)});ROLLBACK;`));
 const full=await readRPC('admin_read_v2_inventory');
 check('real PostgreSQL READ ONLY inventory excludes V1 and retired fixtures',full.cards.length===3&&!full.cards.some(c=>['LEGACY-OUTSIDE-REGISTRY','XXXXXXXXXXXXXXXXXXXXXXXX'].includes(c.card_code)));
 check('one UUID can own multiple cards without name/link-based grouping',full.cards.filter(c=>c.owner_id===A).length===2);
 check('inventory JSON is whitelist-only and readiness/date persist',full.cards.every(c=>!Object.hasOwn(c,'pin_hash')&&!Object.hasOwn(c,'id'))&&full.cards.find(c=>c.card_code.startsWith('R')).inventory_state==='ready'&&full.cards.every(c=>Boolean(c.created_at)));
 const p1=await readRPC('admin_read_v2_inventory',1),p2=await readRPC('admin_read_v2_inventory',1,p1.next_cursor),p3=await readRPC('admin_read_v2_inventory',1,p2.next_cursor),empty=await readRPC('admin_read_v2_inventory',1,'zzzzzzzzzzzzzzzzzzzzzzzz');
 check('inventory keyset pages complete without duplicate/skipped records',new Set([p1,p2,p3].flatMap(p=>p.cards.map(c=>c.card_code))).size===3&&p3.next_cursor===null);
 check('empty page is explicit, not an unavailable-contract fallback',empty.cards.length===0&&empty.next_cursor===null);
 const a1=await readRPC('admin_read_v2_audit',1),a2=await readRPC('admin_read_v2_audit',1,a1.next_cursor);
 check('audit keyset handles equal timestamp and colliding source sequence IDs',a1.events.length===1&&a2.events.length===1&&a1.events[0].id!==a2.events[0].id&&a2.next_cursor===null);
 check('audit preserves actual owner/reason without manufacturing create events',[...a1.events,...a2.events].some(e=>e.old_owner===A&&e.action==='reset')&&![...a1.events,...a2.events].some(e=>e.action==='create'));
 check('malformed inventory limit rejected',await denied('SELECT public.admin_read_v2_inventory(201,NULL)','service_role','22023'));
 check('malformed audit cursor rejected',await denied("SELECT public.admin_read_v2_audit(2,'bad!')",'service_role','22023'));
 for(const name of ['buyer_list_cards()','buyer_first_claim(NULL,NULL,NULL)','admin_create_v2_cards(1)','admin_reset_v2_activation(NULL,NULL,NULL,NULL,NULL)','buyer_test_action(NULL,NULL,NULL,NULL,NULL)','admin_test_reset(NULL,NULL,NULL,NULL,NULL,NULL)'])check('previous RPC remains denied: '+name.split('(')[0],await denied('SELECT public.'+name));
 stage='local_api';
 const savedEnv={...process.env};
 try{
  Object.assign(process.env,{ADMIN_V2_READONLY_LOCAL:'true',ADMIN_V2_READ_ORIGIN:'http://127.0.0.1:4191',ADMIN_V2_READ_CONTRACT_READY:'true',ADMIN_SESSION_SECRET:'isolated-local-admin-read-signing-secret-for-test'});
  const {createAdminReadonly}=await import('../lib/admin-readonly.mjs'),{sessionCookie}=await import('../lib/admin-session.mjs');
  let calls=0;const handler=createAdminReadonly({readPage:async(kind,cursor)=>{calls++;return readRPC(kind==='cards'?'admin_read_v2_inventory':'admin_read_v2_audit',200,cursor);}});
  async function api(action,cookie){const result={code:200,setHeader(){},status(n){this.code=n;return this;},json(v){this.data=v;return this;}};await handler({method:'GET',query:{action},headers:{host:'127.0.0.1:4191',cookie}},result);return result;}
  const blocked=await api('cards','rr_buyer_a=fixture-google-token');check('buyer HTTP facade denied before any local SQL read',blocked.code===401&&calls===0);
  const cookie=sessionCookie().split(';')[0],cards=await api('cards',cookie),events=await api('audit',cookie);check('existing Admin session facade maps real local SQL records/UID/audit',cards.code===200&&cards.data.cards.length===3&&events.code===200&&events.data.events.length===2);
 }finally{for(const k of Object.keys(process.env))if(!(k in savedEnv))delete process.env[k];Object.assign(process.env,savedEnv);}
 stage='drift_checks';
 check('unapproved view option drift blocks reads',await denied('BEGIN;SET LOCAL ROLE postgres;ALTER VIEW rr_v2_control.admin_read_inventory SET(security_barrier=false);SET LOCAL ROLE service_role;SELECT public.admin_read_v2_inventory();ROLLBACK;'));
 check('unsafe role flag drift blocks reads',await denied('BEGIN;SET LOCAL ROLE postgres;ALTER ROLE rr_admin_read_definer LOGIN;SET LOCAL ROLE service_role;SELECT public.admin_read_v2_inventory();ROLLBACK;'));
 check('failed drift probes leave installed fingerprint intact',await sql('SELECT rr_v2_test.fingerprint()')===installed);
 check('existing emergency lockdown closes all 15 RPCs even with role drift',await sql(`BEGIN;ALTER ROLE rr_admin_read_definer LOGIN;SELECT rr_v2_test.lockdown();SELECT (SELECT state='review_required' FROM rr_v2_control.state WHERE id) AND (SELECT count(*)=15 AND bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT has_function_privilege('service_role',p.oid,'EXECUTE')) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%'));ROLLBACK;`)==='t');
 check('V1 public redirect mapping unchanged',await sql("SET ROLE anon;SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY card_code),'[]') FROM public.card_public c")===legacyMap);
 check('all business/PIN/activation/ownership/audit data unchanged',await sql(dataSQL)===digest);
 check('V1/V2 public RPC definitions, effective ACL metadata, RLS and redirect views unchanged',await sql(protectedSQL)===protectedBefore);
 stage='pause';await sqlFile(path.join(bundle,'pause-read.sql'));
 check('pause denies Admin read while keeping business/test RPCs closed',await denied('SELECT public.admin_read_v2_inventory()')&&await denied('SELECT public.admin_read_v2_audit()'));
 await sql("SELECT rr_v2_test.verify_state('closed')");
 stage='rollback';await sqlFile(path.join(bundle,'rollback.sql'));
 check('rollback restores exact original fingerprint, definitions and data',await sql('SELECT rr_v2_test.fingerprint()')===original&&await sql(dataSQL)===digest);
 check('rollback removes only new role/read package objects',await sql("SELECT to_regrole('rr_admin_read_definer') IS NULL AND to_regprocedure('public.admin_read_v2_inventory(integer,text)') IS NULL AND to_regclass('rr_v2_control.admin_read_checkpoint') IS NULL")==='t');
 await sql("SELECT rr_v2_test.verify_state('closed')");
 stage='reinstall_rollback';await sqlFile(path.join(bundle,'install.sql'));await sqlFile(path.join(bundle,'rollback.sql'));
 check('direct rollback from enabled read state also restores baseline',await sql('SELECT rr_v2_test.fingerprint()')===original);
 report.status='LOCAL_ADMIN_READ_PACKAGE_PASS';report.passed=report.tests.filter(t=>t.pass).length;report.finalClosed=true;report.originalFingerprintRestored=true;
 console.log(JSON.stringify({status:report.status,passed:report.passed,folder:base,productionConnected:false}));
}catch(error){report.status='FAILED';report.failedStage=stage;report.reason=sanitizedReason(error);if(error?.err)fs.writeFileSync(path.join(base,'synthetic-error.txt'),String(error.err));console.log(JSON.stringify({status:report.status,stage,reason:report.reason,folder:base}));process.exitCode=1;}
finally{if(started){try{await run('pg_ctl',['-D',data,'-w','-m','fast','stop']);report.localServerStopped=true;}catch{report.localServerStopped=false;process.exitCode=1;}}if(fs.existsSync(base))fs.writeFileSync(path.join(base,'admin-read-local-report.json'),JSON.stringify(report,null,2));}
