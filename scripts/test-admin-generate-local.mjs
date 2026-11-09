// Isolated closed-installer transport rehearsal. Never reads .env or customer backups.
// Only the synthetic loopback cluster is modified; no run is opened or card RPC called.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {files as migrationFiles,fingerprintSQL,pauseBody} from './v2-migration-control.mjs';
import {restrictedPackageSQL} from './prepare-restricted-local.mjs';
import {writePackage} from './admin-readonly-package.mjs';
import {writeGeneratePackage,generationAccessSQL,generateRollbackSQL,generateInventorySQL} from './admin-generate-package.mjs';

const root=process.cwd(),bin=path.join(root,'.backups/tooling/pgsql/bin');
const base=path.join(root,'.backups','admin-generate-local-'+new Date().toISOString().replace(/[:.]/g,'-'));
const data=path.join(base,'pgdata'),database='rr_admin_generate',port='55486';
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
 const readBase=await sql('SELECT rr_v2_test.fingerprint()');const readFolder=path.join(base,'read-package');writePackage(readFolder,readBase);await sqlFile(path.join(readFolder,'install.sql'));
 const before=await sql('SELECT rr_v2_test.fingerprint()');
 report.tests=[];const check=(name,pass)=>{report.tests.push({name,pass:Boolean(pass)});if(!pass)throw {reason:name};};
 const legacySQL=`SELECT md5(jsonb_build_object('cards',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card c WHERE claim_mode='legacy'),'pin',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card_pin_attempts c),'activation',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card_activation c),'owners',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.buyer_card_ownership c),'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,pg_get_functiondef(p.oid),p.proacl) ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('activate_review_card','set_initial_card_pin','update_card_review_url','admin_create_v2_cards','buyer_first_claim','buyer_update_card')),'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p WHERE schemaname='public'),'public_access',(SELECT jsonb_agg(jsonb_build_array(relname,relacl,relrowsecurity) ORDER BY relname) FROM pg_class WHERE oid IN ('public.card'::regclass,'public.card_public'::regclass,'public.card_activation'::regclass,'public.card_pin_attempts'::regclass)))::text)`;
 const legacy=await sql(legacySQL);
 const packageFolder=path.join(base,'generate-package');report.package=writeGeneratePackage(packageFolder,before);
 stage='package_install';await sqlFile(path.join(packageFolder,'preflight.sql'));await sqlFile(path.join(packageFolder,'install.sql'));await sqlFile(path.join(packageFolder,'postflight.sql'));
 async function denied(query,role='service_role',state='42501'){
  const r=await run('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate','-d',database,'-c','SET ROLE postgres','-c',`SET ROLE ${role};${query}`],true);return r.code!==0&&r.err.includes(state);
 }
 const req=()=>crypto.randomUUID();const actor='admin:synthetic-owner';
 const call=async(id,q=1,who=actor)=>JSON.parse(await sql(`SET ROLE service_role;SELECT public.admin_generate_v2_batch('${id}',${q},${literal(who)})`));
 check('install leaves generate denied even for service role',await denied(`SELECT public.admin_generate_v2_batch('${req()}',1,'admin')`));
 await sqlFile(path.join(packageFolder,'rollback-empty-only.sql'));check('empty-only rollback restores exact previous fingerprint',await sql('SELECT rr_v2_test.fingerprint()')===before);
 await sqlFile(path.join(packageFolder,'install.sql'));await sqlFile(path.join(packageFolder,'enable-after-separate-approval.sql'));
 stage='generate_batches';let generated=0;
 for(const q of [1,100,1000]){const id=req(),r=await call(id,q);generated+=q;check('batch '+q+' exact, unique 24-character IDs',r.success&&r.cards.length===q&&new Set(r.cards.map(c=>c.card_code)).size===q&&r.cards.every(c=>/^[A-Za-z0-9_-]{24}$/.test(c.card_code)));check('batch '+q+' ready inventory and durable actor/audit',await sql(`SELECT b.complete AND b.actor=${literal(actor)} AND count(g.*)=${q} AND bool_and(c.claim_mode='google_first_claim' AND c.pin_hash IS NULL AND c.v2_activated_at IS NULL AND i.state='ready' AND i.ready_at IS NOT NULL) FROM rr_v2_generate.batches b JOIN rr_v2_generate.cards g USING(request_id) JOIN public.card c USING(card_code) JOIN public.buyer_card_inventory i USING(card_code) WHERE b.request_id='${id}' GROUP BY b.request_id`)==='t');}
 const concurrent=req(),results=await Promise.all([call(concurrent,100),call(concurrent,100),call(concurrent,100)]);generated+=100;
 check('parallel same UUID produces exactly one batch/result',results.every(r=>JSON.stringify(r)===JSON.stringify(results[0]))&&await sql(`SELECT count(*)=100 FROM rr_v2_generate.cards WHERE request_id='${concurrent}'`)==='t');
 check('retry after response discarded following actual COMMIT returns same IDs',JSON.stringify(await call(concurrent,100))===JSON.stringify(results[0]));
 check('same key different quantity rejected',await denied(`SELECT public.admin_generate_v2_batch('${concurrent}',99,${literal(actor)})`,'service_role','22023'));
 check('same key different actor rejected',await denied(`SELECT public.admin_generate_v2_batch('${concurrent}',100,'admin:other')`,'service_role','22023'));
 const different=await Promise.all([call(req(),1),call(req(),1)]);generated+=2;check('parallel different requests do not share card IDs',different[0].cards[0].card_code!==different[1].cards[0].card_code);
 for(const role of ['anon','authenticated'])check(role+' cannot invoke direct generate RPC',await denied(`SELECT public.admin_generate_v2_batch('${req()}',1,'admin')`,role));
 check('application cannot forge private transaction context',await denied('INSERT INTO rr_v2_generate.context DEFAULT VALUES'));
 check('session variables cannot authorize direct card write',await denied("SELECT set_config('rr_v2_generate.enabled','true',false);INSERT INTO public.card(card_code,claim_mode) VALUES('ZZZZZZZZZZZZZZZZZZZZZZZZ','google_first_claim')"));
 check('old generate remains closed',await denied('SELECT public.admin_create_v2_cards(1)'));
 stage='collision';const originalCodeFn=await sql("SELECT pg_get_functiondef('rr_v2_generate.next_code()'::regprocedure)");
 await sql(`CREATE SEQUENCE public.synthetic_collision;CREATE OR REPLACE FUNCTION rr_v2_generate.next_code() RETURNS text LANGUAGE sql VOLATILE SET search_path='' AS $$ SELECT CASE WHEN nextval('public.synthetic_collision')=1 THEN 'RRRRRRRRRRRRRRRRRRRRRRRR' ELSE translate(encode(extensions.gen_random_bytes(18),'base64'),'+/','-_') END $$;UPDATE rr_v2_control.state SET fingerprint=rr_v2_test.fingerprint() WHERE id;`);
 const collision=await call(req(),1);generated++;check('forced code collision retries and preserves existing card',collision.cards[0].card_code!=='RRRRRRRRRRRRRRRRRRRRRRRR'&&await sql("SELECT business_name='Ready synthetic' FROM public.card WHERE card_code='RRRRRRRRRRRRRRRRRRRRRRRR'")==='t');
 await sql(`CREATE OR REPLACE FUNCTION rr_v2_generate.next_code() RETURNS text LANGUAGE sql VOLATILE SET search_path='' AS $$ SELECT 'RRRRRRRRRRRRRRRRRRRRRRRR'::text $$;UPDATE rr_v2_control.state SET fingerprint=rr_v2_test.fingerprint() WHERE id;`);
 const exhausted=req();check('collision exhaustion is bounded and atomic',await denied(`SELECT public.admin_generate_v2_batch('${exhausted}',1,${literal(actor)})`,'service_role','P0001')&&await sql(`SELECT count(*)=0 FROM rr_v2_generate.batches WHERE request_id='${exhausted}'`)==='t');
 await sql(originalCodeFn+';DROP SEQUENCE public.synthetic_collision;UPDATE rr_v2_control.state SET fingerprint=rr_v2_test.fingerprint() WHERE id;');
 stage='atomic_failure';await sql(`CREATE SEQUENCE public.synthetic_failure;CREATE FUNCTION public.synthetic_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.claim_mode='google_first_claim' AND nextval('public.synthetic_failure')=3 THEN RAISE EXCEPTION 'synthetic mid-batch failure';END IF;RETURN NEW;END $$;CREATE TRIGGER synthetic_fail BEFORE INSERT ON public.card FOR EACH ROW EXECUTE FUNCTION public.synthetic_fail();UPDATE rr_v2_control.state SET fingerprint=rr_v2_test.fingerprint() WHERE id;`);
 const failID=req(),countBefore=await sql('SELECT count(*) FROM public.card');check('mid-batch error leaves no card, batch or audit partials',await denied(`SELECT public.admin_generate_v2_batch('${failID}',5,${literal(actor)})`,'service_role','P0001')&&await sql('SELECT count(*) FROM public.card')===countBefore&&await sql(`SELECT NOT EXISTS(SELECT 1 FROM rr_v2_generate.batches WHERE request_id='${failID}') AND NOT EXISTS(SELECT 1 FROM rr_v2_generate.cards WHERE request_id='${failID}') AND NOT EXISTS(SELECT 1 FROM rr_v2_generate.context)`)==='t');
 await sql('DROP TRIGGER synthetic_fail ON public.card;DROP FUNCTION public.synthetic_fail();DROP SEQUENCE public.synthetic_failure;UPDATE rr_v2_control.state SET fingerprint=rr_v2_test.fingerprint() WHERE id;');
 stage='read_integration';
 const readRPC=async(name,cursor=null)=>JSON.parse(await sql(`BEGIN READ ONLY;SET LOCAL ROLE service_role;SELECT public.${name}(200,${cursor===null?'NULL':literal(cursor)});ROLLBACK;`));
 let cursor=null,total=0,ids=new Set();do{const page=await readRPC('admin_read_v2_audit',cursor);for(const e of page.events){if(ids.has(e.id))throw {reason:'Audit duplicate'};ids.add(e.id);if(e.action==='create')total++;}cursor=page.next_cursor;}while(cursor);
 check('audit reader pages all persisted generate events alongside old sources',total===generated&&ids.has('ownership:1')&&ids.has('reset:1'));
 cursor=null;total=0;do{const page=await readRPC('admin_read_v2_inventory',cursor);total+=page.cards.length;cursor=page.next_cursor;}while(cursor);check('existing inventory reads new ready cards without test-registry pollution',total===generated+3);
 check('all legacy data, PIN, ownership, functions and base grants unchanged',await sql(legacySQL)===legacy);
 check('13 original/testing RPCs remain closed',JSON.parse(await sql(generateInventorySQL)).business_closed);
 stage='http_tests';
 const savedEnv={...process.env};let localServer;
 try{
  Object.assign(process.env,{ADMIN_GENERATE_LOCAL:'isolated_postgres',ADMIN_GENERATE_ENABLED:'true',ADMIN_GENERATE_DOMAIN_CONFIRMED:'false',ADMIN_OPERATOR_ID:actor,ADMIN_V2_READONLY_LOCAL:'true',ADMIN_V2_READ_CONTRACT_READY:'true',ADMIN_V2_READ_ORIGIN:'http://127.0.0.1:4193',ADMIN_PASSWORD:'local-generate-admin-only',ADMIN_SESSION_SECRET:crypto.randomBytes(48).toString('hex')});delete process.env.VERCEL;delete process.env.NODE_ENV;
  const {createAdminGenerate}=await import('../lib/admin-generate.mjs'),{createAdminReadonlyServer}=await import('./admin-readonly-server.mjs');
  let loseNext=false,invocations=0;
  const handler=createAdminGenerate({invoke:async a=>{invocations++;const r=await call(a.p_request_id,a.p_quantity,a.p_actor);if(loseNext){loseNext=false;throw Error('Synthetic lost response AFTER real local COMMIT');}return r;},readPage:(kind,cursor)=>readRPC(kind==='cards'?'admin_read_v2_inventory':'admin_read_v2_audit',cursor)});
  localServer=createAdminReadonlyServer({handler});await new Promise(r=>localServer.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+localServer.address().port;process.env.ADMIN_V2_READ_ORIGIN=origin;
  async function http(action,body,cookie=''){const r=await fetch(origin+'/api/v2-admin?action='+action,{method:body?'POST':'GET',headers:{...(cookie?{cookie}:{}),...(body?{origin,'content-type':'application/json','x-admin-request':'1'}:{})},body:body?JSON.stringify({action,...body}):undefined});return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],data:await r.json()};}
  const httpID=req();
  check('HTTP anon and buyer cannot generate or reach SQL', (await http('create',{quantity:1,request_id:httpID})).status===401&&(await http('create',{quantity:1,request_id:httpID},'rr_buyer_a=synthetic')).status===401&&invocations===0);
  const login=await http('login',{password:process.env.ADMIN_PASSWORD});const cookie=login.cookie;check('HTTP Admin login uses server-signed session',login.status===200&&Boolean(cookie));
  check('invalid idempotency key rejected before SQL',(await http('create',{quantity:1,request_id:'invalid'},cookie)).status===400&&invocations===0);
  loseNext=true;const lost=await http('create',{quantity:2,request_id:httpID,actor:'forged-browser'},cookie);generated+=2;
  check('HTTP lost response after COMMIT does not report false success',lost.status===503&&lost.data.request_id===httpID&&await sql(`SELECT count(*)=2 FROM rr_v2_generate.cards WHERE request_id='${httpID}'`)==='t');
  const retry=await http('create',{quantity:2,request_id:httpID,actor:'forged-browser'},cookie);
  check('HTTP retry returns success/cards without duplicate batch',retry.status===200&&retry.data.success&&retry.data.cards.length===2&&await sql(`SELECT count(*)=2 FROM rr_v2_generate.cards WHERE request_id='${httpID}'`)==='t');
  check('Admin actor is server-defined, not supplied by browser',await sql(`SELECT actor=${literal(actor)} FROM rr_v2_generate.batches WHERE request_id='${httpID}'`)==='t');
  check('unconfirmed permanent domain suppresses all production URLs/exports',retry.data.production_urls_available===false&&retry.data.cards.every(c=>c.card_url===null&&c.qr_url===null&&c.nfc_url===null));
  const inventory=await http('cards',null,cookie),audit=await http('audit',null,cookie);
  check('HTTP inventory and audit use local SQL, preserving UID data and create audit',inventory.status===200&&inventory.data.cards.length===generated+3&&audit.status===200&&audit.data.events.filter(e=>e.action==='create').length===generated);
  check('reset remains denied despite Admin session',(await http('reset',{card_code:retry.data.cards[0].card_code},cookie)).status===405);
  report.httpLocalPostgres=true;
 }finally{if(localServer)await new Promise(r=>{localServer.close(r);localServer.closeAllConnections();});for(const k of Object.keys(process.env))if(!(k in savedEnv))delete process.env[k];Object.assign(process.env,savedEnv);}
 await sqlFile(path.join(packageFolder,'pause.sql'));
 check('pause closes generate and leaves read RPCs usable',await denied(`SELECT public.admin_generate_v2_batch('${req()}',1,'admin')`)&&Array.isArray((await readRPC('admin_read_v2_inventory')).cards));
 const undo=await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',database,'-c','SET ROLE postgres','-f',path.join(packageFolder,'rollback-empty-only.sql')],true);
 check('rollback with committed batch refuses destructive cleanup',undo.code!==0&&await sql(`SELECT count(*)=${generated} FROM rr_v2_generate.cards`)==='t');
 await sqlFile(path.join(packageFolder,'postflight.sql'));
 report.status='LOCAL_ADMIN_GENERATE_PASS';report.passed=report.tests.length;report.generatedCards=generated;report.finalState='closed';report.generateEnabled=false;
 console.log(JSON.stringify({status:report.status,passed:report.passed,generated,folder:base,productionConnected:false}));
 if(process.argv.includes('--serve')){
  await sqlFile(path.join(packageFolder,'enable-after-separate-approval.sql'));
  Object.assign(process.env,{ADMIN_GENERATE_LOCAL:'isolated_postgres',ADMIN_GENERATE_ENABLED:'true',ADMIN_GENERATE_DOMAIN_CONFIRMED:'false',ADMIN_OPERATOR_ID:actor,ADMIN_V2_READONLY_LOCAL:'true',ADMIN_V2_READ_CONTRACT_READY:'true',ADMIN_V2_READ_ORIGIN:'http://127.0.0.1:4193',ADMIN_PASSWORD:'local-generate-admin-only',ADMIN_SESSION_SECRET:crypto.randomBytes(48).toString('hex')});delete process.env.VERCEL;delete process.env.NODE_ENV;
  const {createAdminGenerate}=await import('../lib/admin-generate.mjs'),{createAdminReadonlyServer}=await import('./admin-readonly-server.mjs');
  const preview=createAdminReadonlyServer({handler:createAdminGenerate({invoke:a=>call(a.p_request_id,a.p_quantity,a.p_actor),readPage:(kind,cursor)=>readRPC(kind==='cards'?'admin_read_v2_inventory':'admin_read_v2_audit',cursor)})});
  await new Promise((resolve,reject)=>{preview.once('error',reject);preview.listen(4193,'127.0.0.1',resolve);});
  report.preview={origin:'http://127.0.0.1:4193',source:'isolated_postgres_synthetic',productionConnected:false,urlsExportDisabled:true};report.generateEnabled=true;
  fs.writeFileSync(path.join(base,'RESULT.json'),JSON.stringify(report,null,2));
  console.log('LOCAL POSTGRESQL SYNTHETIC PREVIEW: http://127.0.0.1:4193/admin-v2.html | Local-only password: local-generate-admin-only | No production connection; URL export disabled.');
  await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  await new Promise(resolve=>{preview.close(resolve);preview.closeAllConnections();});await sqlFile(path.join(packageFolder,'pause.sql'));report.generateEnabled=false;
 }
}catch(error){report.status='FAILED';report.failedStage=stage;report.reason=sanitizedReason(error);if(error?.err)fs.writeFileSync(path.join(base,'synthetic-error.txt'),String(error.err));console.log(JSON.stringify({status:report.status,stage,reason:report.reason,folder:base}));process.exitCode=1;}
finally{if(started){try{await run('pg_ctl',['-D',data,'-w','-m','fast','stop']);report.localServerStopped=true;}catch{report.localServerStopped=false;process.exitCode=1;}}if(fs.existsSync(base))fs.writeFileSync(path.join(base,'RESULT.json'),JSON.stringify(report,null,2));}
