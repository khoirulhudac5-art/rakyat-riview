// Scoped live inspection/backup support. No installation or automatic retry here.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {firstClaimConnection} from './prepare-first-claim-live.mjs';
import {readSnapshot,setReadRole,cardPolicy} from './admin-readonly-postflight.mjs';
import {healthSQL,dataSQL} from './admin-generate-preflight.mjs';
import {files as migrations} from './v2-migration-control.mjs';
import {pilotPackageID,pilotInstallSQL,pilotCard} from './public-pilot-package.mjs';
export {dataSQL};
export const expected='5aefd8e4df29f1c365b8942629b911cd';
export const bundle=path.resolve('.backups/public-pilot-review-2026-11-07T07-54-21-397Z');
export const approvedPackage='1ae5113e1ab1c26ade99cd4edc6d4430a2f5ad4ab377d6931ee2bdf13be6ef2f';
export const approvedInstall='71e85f11449999c9f1b8e8a8ffe585ddc68a6bd51d296c771519ed176f05f05a';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export function packageCheck(){
 const m=JSON.parse(fs.readFileSync(path.join(bundle,'manifest.json')));
 if(m.package_id!==approvedPackage||pilotPackageID!==approvedPackage||m.expected_fingerprint!==expected||m.card!==pilotCard)throw Error('Approved pilot package identity mismatch');
 for(const f of m.files)if(path.basename(f.file)!==f.file||sha(fs.readFileSync(path.join(bundle,f.file)))!==f.sha256)throw Error('Approved SQL artifact checksum mismatch');
 for(const s of m.sources)if(sha(fs.readFileSync(s.file))!==s.sha256)throw Error('Approved source checksum mismatch');
 const install=fs.readFileSync(path.join(bundle,'install-closed.sql'),'utf8');
 if(sha(install)!==approvedInstall||install!==pilotInstallSQL(expected))throw Error('Approved install checksum/rebuild mismatch');
 return m;
}
const oldNames="'buyer_test_action','admin_test_reset','admin_read_v2_inventory','admin_read_v2_audit','admin_generate_v2_batch'";
const pilotNames="'buyer_pilot_public_status','buyer_pilot_first_claim','buyer_pilot_list_cards','buyer_pilot_redirect_target'";
const allowed="'admin_read_v2_inventory','admin_read_v2_audit','admin_generate_v2_batch'";
export const profileSQL=`SELECT json_build_object('stage',s.stage,'state',s.state,'fingerprint',s.fingerprint,'actual',rr_v2_test.fingerprint(),'hashes',s.hashes,
 'rpc_count',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%')),
 'original_count',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%') AND p.proname NOT IN (${oldNames},${pilotNames})),
 'wrapper_count',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('buyer_test_action','admin_test_reset')),
 'permissions_exact',(SELECT bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND has_function_privilege('service_role',p.oid,'EXECUTE')=(p.proname IN (${allowed}))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%')),
 'active_runs',(SELECT count(*) FROM rr_v2_test.runs WHERE status IN ('active','provisioning')),
 'generate_enabled',(SELECT enabled FROM rr_v2_generate.control WHERE id),
 'generate_package',(SELECT package_id FROM rr_v2_generate.control WHERE id),
 'batches',(SELECT count(*) FROM rr_v2_generate.batches),'generated_cards',(SELECT count(*) FROM rr_v2_generate.cards),'generate_context',(SELECT count(*) FROM rr_v2_generate.context),
 'pilot_namespace',to_regnamespace('rr_claim_pilot') IS NOT NULL,
 'migration_history',to_regclass('supabase_migrations.schema_migrations') IS NOT NULL)
 FROM rr_v2_control.state s WHERE id`;
const readySQL=`SELECT count(*)=1 AND bool_and(c.claim_mode='google_first_claim' AND c.business_name IS NULL AND c.review_url IS NULL AND c.pin_hash IS NULL AND c.v2_activated_at IS NULL AND i.state='ready' AND i.ready_at IS NOT NULL AND b.complete AND b.quantity=1 AND g.ordinal=1 AND b.request_id='192166ad-1490-461e-9554-489a827b999c'::uuid AND b.actor='admin:configured-owner' AND NOT EXISTS(SELECT 1 FROM public.buyer_card_ownership o WHERE o.card_code=c.card_code) AND NOT EXISTS(SELECT 1 FROM public.card_activation a WHERE a.card_code=c.card_code) AND NOT EXISTS(SELECT 1 FROM rr_v2_test.cards t WHERE t.card_code=c.card_code)) FROM public.card c JOIN public.buyer_card_inventory i USING(card_code) JOIN rr_v2_generate.cards g USING(card_code) JOIN rr_v2_generate.batches b USING(request_id) WHERE c.card_code='${pilotCard}'`;
export const publicInvariant=`SELECT md5(jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relowner,c.relacl,c.reloptions,c.relrowsecurity,c.relforcerowsecurity) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','v','S')),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl,p.proowner,p.proconfig) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND p.proname NOT IN ('v2_pause_guard',${pilotNames})),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p WHERE schemaname='public' AND NOT(tablename='card' AND policyname='public_card_read')),
 'views',(SELECT jsonb_agg(jsonb_build_array(c.relname,pg_get_viewdef(c.oid,true)) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='v'),
 'columns',(SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,ordinal_position) FROM information_schema.columns c WHERE table_schema='public'),
 'column_acl',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,a.attacl) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid)) ORDER BY conname) FROM pg_constraint WHERE connamespace='public'::regnamespace),
 'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal),
 'membership',(SELECT jsonb_agg(to_jsonb(m) ORDER BY roleid,member,grantor) FROM pg_auth_members m),
 'defaults',(SELECT jsonb_agg(to_jsonb(d) ORDER BY oid) FROM pg_default_acl d))::text)`;
export const generateData=`SELECT md5(jsonb_build_object('control',(SELECT to_jsonb(c) FROM rr_v2_generate.control c WHERE id),'batch',(SELECT jsonb_agg(to_jsonb(c) ORDER BY request_id) FROM rr_v2_generate.batches c),'cards',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM rr_v2_generate.cards c),'context',(SELECT jsonb_agg(to_jsonb(c)) FROM rr_v2_generate.context c))::text)`;
const viewSQL="SELECT md5(coalesce(jsonb_agg(to_jsonb(v) ORDER BY card_code)::text,'')) FROM public.card_public v";
const policySQL="SELECT json_build_object('qual',qual,'roles',roles,'cmd',cmd,'permissive',permissive) FROM pg_policies WHERE schemaname='public' AND tablename='card' AND policyname='public_card_read'";
export function validateSnapshot(r,post=false){
 const h=r.health,p=r.state;
 if(h.readonly!=='on'||h.database!=='postgres'||h.user!=='postgres'||h.version!==170011||h.recovery||h.long_idle||h.long_active||h.waiting||h.strong_locks||h.connections>=h.max_connections*.8)throw Error('Read-only identity/health/lock guard failed');
 if(p.stage!==6||p.state!=='closed'||p.actual!==p.fingerprint||(!post&&p.fingerprint!==expected)||p.rpc_count!==(post?20:16)||p.original_count!==11||p.wrapper_count!==2||!p.permissions_exact||p.active_runs!==0||p.generate_enabled!==true||p.generate_package!=='dda6227219ae8cdb4a2079feb45144e31998811a228a1df33bac71a3620bdde7'||p.batches!==1||p.generated_cards!==1||p.generate_context!==0||p.pilot_namespace!==post||p.migration_history!==false)throw Error('Checkpoint/schema/permission drift; STOP');
 const hashes=migrations.map(f=>sha(fs.readFileSync(path.join('supabase/migrations',f))));if(JSON.stringify(p.hashes)!==JSON.stringify(hashes))throw Error('Six migration source/hash mismatch');
 if(r.ready!==true||r.anonymousPilotRows!==0||r.authenticatedView!==shaEmptyMD5||r.policy.cmd!=='SELECT'||r.policy.permissive!=='PERMISSIVE'||JSON.stringify(r.policy.roles)!=='["anon"]')throw Error('Ready/privacy/RLS guard failed');
 const norm=s=>s.replace(/[\s()]/g,'');const expectedPolicy=post?cardPolicy+` AND card_code IS DISTINCT FROM '${pilotCard}'::text`:cardPolicy;
 if(norm(r.policy.qual)!==norm(expectedPolicy))throw Error('Visibility policy differs from approved scope');
 if(post&&(!r.control||r.control.package_id!==approvedPackage||r.control.card_code!==pilotCard||r.control.public_on||r.control.claim_on||r.control.owner_on||r.control.redirect_on||r.control.expires_at!==null||r.control.attempts!==0||r.control.context!==0||r.control.previous_fingerprint!==expected))throw Error('Pilot not installed closed/empty at approved baseline');
}
const shaEmptyMD5='d41d8cd98f00b204e9800998ecf8427e';
export async function snapshot(post=false,{connection,sessionFactory=readSnapshot}={}){
 packageCheck();const cfg=connection||{executable:path.resolve('.backups/tooling/pgsql/bin/psql.exe'),env:firstClaimConnection()};
 return sessionFactory(cfg,async s=>{
  const r={health:JSON.parse(await s.query(healthSQL)),state:JSON.parse(await s.query(profileSQL))};
  await s.query("SELECT rr_v2_test.verify_state('closed')");r.ready=await s.query(readySQL)==='t';
  r.policy=JSON.parse(await s.query(policySQL));r.protectedFP=await s.query(publicInvariant);r.dataDigest=await s.query(dataSQL);r.generateDigest=await s.query(generateData);r.viewDigest=await s.query(viewSQL);
  r.guard=await s.query("SELECT prosrc FROM pg_proc WHERE oid='public.v2_pause_guard()'::regprocedure");
  if(post){await s.query('SELECT rr_claim_pilot.assert_acl()');r.control=JSON.parse(await s.query("SELECT jsonb_build_object('package_id',package_id,'card_code',card_code,'previous_fingerprint',previous_fingerprint,'public_on',public_on,'claim_on',claim_on,'owner_on',owner_on,'redirect_on',redirect_on,'expires_at',expires_at,'attempts',(SELECT count(*) FROM rr_claim_pilot.attempts),'context',(SELECT count(*) FROM rr_claim_pilot.context)) FROM rr_claim_pilot.control WHERE id"));}
  await setReadRole(s,'anon');r.anonymousPilotRows=Number(await s.query(`SELECT count(*) FROM public.card_public WHERE card_code='${pilotCard}'`));r.anonView=await s.query(viewSQL);
  await setReadRole(s,'authenticated');r.authenticatedView=await s.query(viewSQL);
  await setReadRole(s,'service_role');r.adminReaders={};
  for(const [fn,key] of [['admin_read_v2_inventory','cards'],['admin_read_v2_audit','events']]){const raw=await s.query(`SELECT public.${fn}(200,NULL)`),d=JSON.parse(raw);if(!Array.isArray(d[key])||!Object.hasOwn(d,'next_cursor'))throw Error('Admin read RPC failed');r.adminReaders[key]={rows:d[key].length,digest:sha(raw)};}
  validateSnapshot(r,post);return r;
 });
}
export async function preflight(folder){const r=await snapshot();r.status='PILOT_LIVE_PREFLIGHT_PASS';r.project_ref='svuagnobufhfpgzmsyxx';r.tls='verify-full';fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'preflight.json'),JSON.stringify(r,null,2));return r;}
export function compareSnapshots(a,b,{installed=false}={}){
 for(const k of ['protectedFP','dataDigest','generateDigest','viewDigest','anonView','authenticatedView','adminReaders'])if(JSON.stringify(a[k])!==JSON.stringify(b[k]))throw Error('Postflight invariant changed: '+k);
 if(!installed&&a.state.fingerprint!==b.state.fingerprint)throw Error('Backup/preflight fingerprint changed');
 if(installed){const prefix=" IF rr_claim_pilot.write_allowed(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;";
  if(b.guard!==a.guard.replace('BEGIN','BEGIN'+prefix))throw Error('Guard patch differs from approved body');
 }
}
