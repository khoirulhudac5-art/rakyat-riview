// Local pilot integration tests. Never reads .env or customer backups.
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
const base=path.join(root,'.backups','public-pilot-local-'+new Date().toISOString().replace(/[:.]/g,'-'));
const data=path.join(base,'pgdata'),database='rr_public_pilot',port='55487';
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
 report.tests=[];const check=(name,pass)=>{report.tests.push({name,pass:Boolean(pass)});if(!pass)throw {reason:name};};
 async function as(role,uid,query,db=database){return sql(`SET ROLE ${role};SELECT set_config('request.jwt.claim.sub','${uid||''}',false);${query}`,db).then(x=>x.split('\n').slice(uid?1:0).join('\n').trim());}
 async function denied(query,role='authenticated',uid=A){const r=await run('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-d',database,'-c','SET ROLE postgres','-c',`SET ROLE ${role};SELECT set_config('request.jwt.claim.sub','${uid}',false);${query}`],true);return r.code!==0;}
 const status=()=>as('anon','',`SELECT public.buyer_pilot_public_status('${pilotCard}')`);
 const claim=(uid,code=pilotCard,name='Synthetic pilot business',db=database)=>as('authenticated',uid,`SELECT public.buyer_pilot_first_claim('${code}',${literal(name)},'https://search.google.com/local/writereview?placeid=ChISyntheticPilot2345')`,db).then(JSON.parse);
 const protectedSQL=`SELECT md5(jsonb_build_object('rows',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card c WHERE card_code<>'${pilotCard}'),'pin',(SELECT jsonb_agg(to_jsonb(c)) FROM public.card_pin_attempts c),'activation',(SELECT jsonb_agg(to_jsonb(c)) FROM public.card_activation c),'generate',(SELECT jsonb_agg(to_jsonb(c)) FROM rr_v2_generate.batches c),'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,pg_get_functiondef(p.oid),p.proacl) ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'admin_%' OR p.proname IN ('activate_review_card','set_initial_card_pin','update_card_review_url'))))::text)`;
 const protectedBefore=await sql(protectedSQL),baseline=await sql('SELECT rr_v2_test.fingerprint()');
 const folder=path.join(base,'pilot-package');report.package=writePilotPackage(folder,baseline);
 stage='pilot_install';await sqlFile(path.join(folder,'preflight.sql'));await sqlFile(path.join(folder,'install-closed.sql'));await sqlFile(path.join(folder,'postflight.sql'));
 check('default closed denies status/claim/list/redirect',await denied(`SELECT public.buyer_pilot_public_status('${pilotCard}')`,'anon')&&await denied(`SELECT public.buyer_pilot_first_claim('${pilotCard}','Synthetic','https://search.google.com/local/writereview?placeid=ChISyntheticPilot2345')`));
 stage='empty_rollback';await sql(pilotRollbackSQL());check('empty rollback restores exact fingerprint',await sql('SELECT rr_v2_test.fingerprint()')===baseline);await sqlFile(path.join(folder,'install-closed.sql'));
 stage='enabled';await sql(pilotAccessSQL('enable'));await sqlFile(path.join(folder,'postflight.sql'));
 check('ready minimal anonymous status',JSON.stringify(JSON.parse(await status()))===JSON.stringify({code:pilotCard,claim_allowed:true,activation_state:'inactive'}));
 check('outside scope status generic',JSON.parse(await as('anon','',"SELECT public.buyer_pilot_public_status('RRRRRRRRRRRRRRRRRRRRRRRR')")).activation_state==='unavailable');
 check('outside scope claim denied',!(await claim(A,'RRRRRRRRRRRRRRRRRRRRRRRR')).success);
 await sql(`DELETE FROM auth.identities WHERE user_id='${C}'`);
 check('non-Google identity denied by database',!(await claim(C)).success);
 check('NULL identity denied by database',!JSON.parse(await as('authenticated','',`SELECT public.buyer_pilot_first_claim('${pilotCard}','Synthetic','https://search.google.com/local/writereview?placeid=ChISyntheticPilot2345')`)).success);
 check('private context cannot be forged',await denied('INSERT INTO rr_claim_pilot.context DEFAULT VALUES'));
 check('original claim remains closed',await denied(`SELECT public.buyer_first_claim('${pilotCard}','Synthetic','https://search.google.com/local/writereview?placeid=ChISyntheticPilot2345')`));
 check('redirect server only',await denied(`SELECT public.buyer_pilot_redirect_target('${pilotCard}')`));
 await as('authenticated',A,`SELECT set_config('rr_claim_pilot.enabled','true',false);UPDATE public.card SET business_name='Injected' WHERE card_code='${pilotCard}'`);
 check('GUC spoof cannot enable direct card write',await sql(`SELECT business_name IS NULL FROM public.card WHERE card_code='${pilotCard}'`)==='t');
 stage='isolated_race_clone';
 await sql('CREATE DATABASE rr_public_pilot_race TEMPLATE '+database+' OWNER postgres','postgres',false);
 // information_schema.columns includes table_catalog; initialize the NEW local clone checkpoint for its different database name.
 await sql("UPDATE rr_v2_control.state SET fingerprint=rr_v2_test.fingerprint() WHERE id;SELECT rr_v2_test.verify_state('closed');",'rr_public_pilot_race');
 const cs=await Promise.all([claim(A,pilotCard,'Synthetic race','rr_public_pilot_race'),claim(B,pilotCard,'Synthetic race','rr_public_pilot_race')]);check('concurrent contenders exactly one winner on separate local clone',cs.filter(r=>r.success).length===1&&await sql(`SELECT count(*)=1 FROM public.buyer_card_ownership WHERE card_code='${pilotCard}'`,'rr_public_pilot_race')==='t');
 await sql('DROP DATABASE rr_public_pilot_race','postgres',false);
 stage='http_ready';
 const rpc=async(name,args,uid)=>{
  const params=name==='buyer_pilot_first_claim'?[args.p_card_code,args.p_business_name,args.p_review_url]:name==='buyer_pilot_list_cards'?[]:[args.p_card_code];
  const expr=`public.${name}(${params.map(literal).join(',')})`;
  const query=name==='buyer_pilot_list_cards'?`SELECT coalesce(jsonb_agg(t),'[]') FROM ${expr} t`:`SELECT ${expr}`;
  return JSON.parse(await as(name==='buyer_pilot_redirect_target'?'service_role':uid?'authenticated':'anon',uid||'',query));
 };
 httpFixture=await startPilotFixture({rpc});
 if(process.argv.includes('--serve')){
  console.log(JSON.stringify({mode:'LOCAL_SYNTHETIC_FIXTURE_ONLY',production:false,url:httpFixture.origin+'/fixture-account/A',alternateAccount:httpFixture.origin+'/fixture-account/B',scan:httpFixture.origin+'/r/'+pilotCard,folder:path.relative(root,base),note:'Use direct synthetic review URL; Google OAuth is mocked only in automated browser tests.'}));
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;try{await sql(pilotAccessSQL());await httpFixture.stop();httpFixture=null;}finally{await run('pg_ctl',['-D',data,'-m','fast','-w','stop'],true);started=false;process.exit(0);}};process.once('SIGINT',stop);process.once('SIGTERM',stop);await new Promise(()=>{});
 }
 const post=(body,cookie='')=>fetch(httpFixture.origin+'/api/buyer',{method:'POST',headers:{Origin:httpFixture.origin,'Content-Type':'application/json','X-Buyer-Request':'1',Cookie:cookie},body:JSON.stringify(body)});
 check('HTTP anonymous claim requires session',(await post({action:'first-claim',card_code:pilotCard})).status===401);
 for(const value of ['invalid.jwt.signature',httpFixture.sign(A,Date.now()/1000-5)])check('HTTP invalid/expired JWT denied',(await post({action:'first-claim',card_code:pilotCard},'rr_buyer_a='+value)).status===401);
 const ready=await fetch(httpFixture.origin+'/r/'+pilotCard,{redirect:'manual'});check('HTTP ready uses 303 no-store',ready.status===303&&ready.headers.get('cache-control').includes('no-store'));
 await pilotBrowser({fixture:httpFixture,check,folder:base,phase:'ready'});
 stage='atomic_claim';
 const winner=A,loser=B;report.syntheticWinner='A';
 check('owner retry idempotent', (await claim(winner,pilotCard,'Must not overwrite')).success&&await sql(`SELECT business_name='Synthetic pilot business' FROM public.card WHERE card_code='${pilotCard}'`)==='t');
 check('loser cannot claim',(await claim(loser)).success===false);
 check('loser list empty',JSON.parse(await as('authenticated',loser,'SELECT coalesce(jsonb_agg(t),\'[]\') FROM public.buyer_pilot_list_cards() t')).length===0);
 check('owner list own card',JSON.parse(await as('authenticated',winner,'SELECT coalesce(jsonb_agg(t),\'[]\') FROM public.buyer_pilot_list_cards() t'))[0].card_code===pilotCard);
 check('public view hides active pilot',await as('anon','',`SELECT count(*) FROM public.card_public WHERE card_code='${pilotCard}'`)==='0');
 check('active status contains no private fields',Object.keys(JSON.parse(await status())).sort().join(',')==='activation_state,claim_allowed,code');
 check('target service reader returns canonical URL',JSON.parse(await as('service_role','',`SELECT public.buyer_pilot_redirect_target('${pilotCard}')`)).review_url.endsWith('ChISyntheticPilot2345'));
 check('direct edit remains closed',await denied(`SELECT public.buyer_update_card('${pilotCard}','Changed','https://search.google.com/local/writereview?placeid=ChISyntheticPilot2345')`,'authenticated',winner));
 await as('authenticated',winner,`UPDATE public.card SET business_name='Injected' WHERE card_code='${pilotCard}'`).catch(()=>{});
 check('owner cannot bypass guard with direct table UPDATE',await sql(`SELECT business_name='Synthetic pilot business' FROM public.card WHERE card_code='${pilotCard}'`)==='t');
 check('one owner and one ownership audit',await sql(`SELECT (SELECT count(*) FROM public.buyer_card_ownership WHERE card_code='${pilotCard}')=1 AND (SELECT count(*) FROM public.buyer_ownership_audit WHERE card_code='${pilotCard}')=1 AND NOT EXISTS(SELECT 1 FROM rr_claim_pilot.context)`)==='t');
 stage='http_claimed';
 const active=await fetch(httpFixture.origin+'/r/'+pilotCard,{redirect:'manual'});check('HTTP active redirects anonymously with 302',active.status===302&&active.headers.get('location')==='https://search.google.com/local/writereview?placeid=ChISyntheticPilot2345');
 const ws=httpFixture.session(winner),ownerCookie='rr_buyer_a='+ws.access_token;
 const retried=await post({action:'first-claim',card_code:pilotCard,business_name:'Must not overwrite',review_url:'https://search.google.com/local/writereview?placeid=ChISyntheticPilot2345'},ownerCookie);check('HTTP claim uses authenticated UID and is idempotent',retried.status===200);
 check('HTTP update refuses unsupported operation',(await post({action:'update',card_code:pilotCard},ownerCookie)).status===403);
 check('HTTP unexpected owner parameter rejected',(await post({action:'first-claim',card_code:pilotCard,business_name:'X',review_url:'https://search.google.com/local/writereview?placeid=ChISyntheticPilot2345',p_owner_uid:loser},ownerCookie)).status===400);
 const inventory=JSON.parse(await as('service_role','',"SELECT public.admin_read_v2_inventory(200,NULL)")),audit=JSON.parse(await as('service_role','',"SELECT public.admin_read_v2_audit(200,NULL)"));
 check('Admin readers remain usable and include pilot',inventory.cards.some(c=>c.card_code===pilotCard)&&Array.isArray(audit.events));
 await pilotBrowser({fixture:httpFixture,check,folder:base,phase:'claimed',winner:report.syntheticWinner});
 await httpFixture.stop();httpFixture=null;
 stage='expiry';await sql("UPDATE rr_claim_pilot.control SET expires_at=now()-interval '1 second';UPDATE rr_v2_control.state SET fingerprint=rr_v2_test.fingerprint() WHERE id;");check('expiry refuses claim even with EXECUTE grant',!(await claim(winner)).success);check('expiry preserves owner read',JSON.parse(await as('authenticated',winner,"SELECT jsonb_agg(t) FROM public.buyer_pilot_list_cards() t")).length===1);
 await sql(pilotAccessSQL('close-claim'));check('normal closure revokes claim only',await denied(`SELECT public.buyer_pilot_first_claim('${pilotCard}','X','X')`)&&JSON.parse(await status()).activation_state==='active');
 check('rollback refuses committed attempts',await denied(pilotRollbackSQL(),'postgres',''));
 await sql(pilotAccessSQL());check('emergency pause closes all RPCs',await denied(`SELECT public.buyer_pilot_public_status('${pilotCard}')`,'anon')&&await denied('SELECT public.buyer_pilot_list_cards()','authenticated',winner)&&await denied(`SELECT public.buyer_pilot_redirect_target('${pilotCard}')`,'service_role',''));
 await sqlFile(path.join(folder,'postflight.sql'));check('V1 other cards admin read/generate functions unchanged',await sql(protectedSQL)===protectedBefore);
 check('legacy read still available',Number(await as('anon','',"SELECT count(*) FROM public.card_public WHERE card_code='LEGACY-OUTSIDE-REGISTRY'"))===1);
 report.checkpoint=JSON.parse(await sql('SELECT row_to_json(s) FROM (SELECT stage,state,fingerprint FROM rr_v2_control.state) s'));report.pass=true;
 fs.writeFileSync(path.join(base,'RESULT.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({pass:true,checks:report.tests.length,folder:path.relative(root,base),checkpoint:report.checkpoint}));
}catch(error){report.pass=false;report.stage=stage;report.reason=sanitizedReason(error);if(error.err)fs.writeFileSync(path.join(base,'synthetic-error.txt'),error.err);fs.mkdirSync(base,{recursive:true});fs.writeFileSync(path.join(base,'RESULT.json'),JSON.stringify(report,null,2));console.error(JSON.stringify({pass:false,stage,reason:report.reason,folder:path.relative(root,base)}));process.exitCode=1;
}finally{if(httpFixture)await httpFixture.stop();if(started)await run('pg_ctl',['-D',data,'-m','fast','-w','stop'],true);}
