// SELECT-only preparation/verification. No installer, write transport or environment mutation.
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {sha,protectedSQL} from './admin-readonly-package.mjs';
import {readSnapshot,setReadRole,viewDigestSQL} from './admin-readonly-postflight.mjs';
import {firstClaimConnection} from './prepare-first-claim-live.mjs';
import {generateProtectedSQL,inventoryFunctionSQL} from './admin-generate-review-controls.mjs';
const reviewed=path.resolve('.backups/admin-generate-review-2026-11-07T05-59-10-699Z');
const expectedManifest='1f143f49a9f84d1d1943afbbfb3b5849634fadb3cc80b86f326d7bf9d25b2942';
export function verifyGenerateReview(){
 const bytes=fs.readFileSync(path.join(reviewed,'manifest.json'));if(sha(bytes)!==expectedManifest)throw Error('Frozen generate manifest changed');
 const m=JSON.parse(bytes);if(m.project_ref!=='svuagnobufhfpgzmsyxx'||m.default_enabled!==false||m.expected_fingerprint!=='1aa5a5788a1baed944130434797876ac')throw Error('Review identity mismatch');
 for(const f of m.files){if(path.basename(f.file)!==f.file||sha(fs.readFileSync(path.join(reviewed,f.file)))!==f.sha256)throw Error('Generate artifact checksum mismatch');}
 for(const s of m.sources)if(sha(fs.readFileSync(s.file))!==s.sha256)throw Error('Generate source differs from tested package');
 return m;
}
export const healthSQL=`SELECT json_build_object('readonly',current_setting('transaction_read_only'),'database',current_database(),'user',current_user,'version',current_setting('server_version_num')::int,'backend_tls',(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),'recovery',pg_is_in_recovery(),'connections',(SELECT count(*) FROM pg_stat_activity),'max_connections',current_setting('max_connections')::int,'long_idle',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND xact_start<now()-interval '30 seconds'),'long_active',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND xact_start<now()-interval '60 seconds'),'waiting',(SELECT count(*) FROM pg_locks WHERE NOT granted),'strong_locks',(SELECT count(*) FROM pg_locks WHERE relation IN ('public.card'::regclass,'public.card_activation'::regclass,'public.card_pin_attempts'::regclass) AND mode IN ('AccessExclusiveLock','ShareLock','ShareRowExclusiveLock','ExclusiveLock')))`;
export const dataSQL=`SELECT md5(jsonb_build_object('card',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card c),'activation',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card_activation c),'pin',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card_pin_attempts c),'inventory',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.buyer_card_inventory c),'ownership',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.buyer_card_ownership c),'quota',(SELECT jsonb_agg(to_jsonb(c) ORDER BY user_id) FROM public.buyer_claim_limits c),'audit',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.buyer_ownership_audit c),'reset',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.buyer_activation_reset_audit c),'sequence',(SELECT jsonb_build_array(last_value,is_called) FROM public.card_id_seq))::text)`;
export const compatibilitySQL=`SELECT json_build_object(
 'schema_absent',to_regnamespace('rr_v2_generate') IS NULL,
 'rpc_absent',NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='admin_generate_v2_batch'),
 'card_unique',EXISTS(SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname='card_code' WHERE i.indrelid='public.card'::regclass AND i.indisunique AND i.indisvalid AND i.indnkeyatts=1 AND i.indpred IS NULL AND a.attnum=ANY(i.indkey)),
 'card_id_default',EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.card'::regclass AND a.attname='id' AND (a.attidentity<>'' OR a.atthasdef)),
 'inventory_columns',(SELECT count(*)=7 FROM information_schema.columns WHERE table_schema='public' AND table_name='buyer_card_inventory' AND column_name IN ('card_code','state','ready_at','claimed_at','updated_at','updated_by','activation_revision')),
 'crypto_available',to_regprocedure('extensions.gen_random_bytes(integer)') IS NOT NULL AND has_function_privilege('postgres','extensions.gen_random_bytes(integer)','EXECUTE'),
 'schema_create',has_database_privilege('postgres',current_database(),'CREATE'),
 'write_owner_compatible',(SELECT count(*)=2 AND bool_and(pg_get_userbyid(relowner)='postgres' AND NOT relforcerowsecurity) FROM pg_class WHERE oid IN ('public.card'::regclass,'public.buyer_card_inventory'::regclass)),
 'guard_compatible',(SELECT pg_get_userbyid(proowner)='postgres' AND prosecdef AND proconfig @> ARRAY['search_path=""'] AND (length(prosrc)-length(replace(prosrc,'BEGIN','')))/5=1 FROM pg_proc WHERE oid='public.v2_pause_guard()'::regprocedure),
 'audit_cursor_compatible',(SELECT pg_get_userbyid(proowner)='rr_admin_read_definer' AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""'] AND position('ownership|reset' in prosrc)>0 FROM pg_proc WHERE oid='public.admin_read_v2_audit(integer,text)'::regprocedure),
 'fingerprint_sql',(SELECT prolang=(SELECT oid FROM pg_language WHERE lanname='sql') FROM pg_proc WHERE oid='rr_v2_test.fingerprint()'::regprocedure),
 'assert_plpgsql',(SELECT prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') FROM pg_proc WHERE oid='rr_v2_test.assert_acl()'::regprocedure),
 'migration_history_absent',to_regclass('supabase_migrations.schema_migrations') IS NULL)`;
export const stateSQL=`SELECT json_build_object('stage',s.stage,'state',s.state,'fingerprint',s.fingerprint,'actual',rr_v2_test.fingerprint(),'hashes',s.hashes,
 'rpc_count',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'admin_%' OR p.proname LIKE 'buyer_%')),
 'allowlist_effective',(SELECT bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND has_function_privilege('service_role',p.oid,'EXECUTE')=(p.proname IN ('admin_read_v2_inventory','admin_read_v2_audit'))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'admin_%' OR p.proname LIKE 'buyer_%')),
 'active_runs',(SELECT count(*) FROM rr_v2_test.runs WHERE status IN ('active','provisioning')))
 FROM rr_v2_control.state s WHERE id`;
export function validateGenerateBaseline(health,state,compatibility,hashes){
 if(health.readonly!=='on'||health.database!=='postgres'||health.user!=='postgres'||health.version!==170011||health.recovery||health.long_idle||health.long_active||health.waiting||health.strong_locks||health.connections>=health.max_connections*.8)throw Error('Read-only identity/health/lock guard failed');
 if(state.stage!==6||state.state!=='closed'||state.fingerprint!=='1aa5a5788a1baed944130434797876ac'||state.actual!==state.fingerprint||state.rpc_count!==15||!state.allowlist_effective||state.active_runs!==0||JSON.stringify(state.hashes)!==JSON.stringify(hashes))throw Error('Schema/checkpoint/permission drift; stop without rebaseline');
 if(!Object.values(compatibility).every(v=>v===true))throw Error('Generate schema/owner/patch compatibility failed: '+Object.keys(compatibility).filter(k=>compatibility[k]!==true).join(', '));
}
export async function generatePreflight(parent=path.resolve('.backups'),{config,sessionFactory=readSnapshot,review=verifyGenerateReview}={}){
 const report={status:'RUNNING',project_ref:'svuagnobufhfpgzmsyxx',writeAttempted:false,tls:'verify-full',at:new Date().toISOString()};
 const output=path.join(parent,'generate-preflight-'+Date.now()+'.json');
 try{
  const m=review();const readManifest=JSON.parse(fs.readFileSync('.backups/admin-readonly-approval-2026-11-07T04-26-36-782Z/manifest.json','utf8'));
  const hashes=readManifest.sources.filter(s=>s.file.startsWith('supabase/migrations/')).map(s=>{if(sha(fs.readFileSync(s.file))!==s.sha256)throw Error('Original migration source changed');return s.sha256;});
  const connection=config||{executable:path.resolve('.backups/tooling/pgsql/bin/psql.exe'),env:firstClaimConnection()};
  await sessionFactory(connection,async s=>{
   report.health=JSON.parse(await s.query(healthSQL));report.state=JSON.parse(await s.query(stateSQL));report.compatibility=JSON.parse(await s.query(compatibilitySQL));
   validateGenerateBaseline(report.health,report.state,report.compatibility,hashes);
   await s.query("SELECT rr_v2_test.verify_state('closed')");report.protectedFP=await s.query(protectedSQL);
   if(report.protectedFP!==await s.query('SELECT protected_fingerprint FROM rr_v2_control.admin_read_checkpoint WHERE id'))throw Error('Schema/checkpoint/permission drift in protected V1/read-only baseline');
   report.dataDigest=await s.query(dataSQL);report.viewDigest=await s.query(viewDigestSQL);
   report.generateProtectedFP=await s.query(generateProtectedSQL);report.inventoryFunctionFP=await s.query(inventoryFunctionSQL);
   await setReadRole(s,'service_role');report.readRPCs={};
   for(const [name,key] of [['admin_read_v2_inventory','cards'],['admin_read_v2_audit','events']]){const page=JSON.parse(await s.query('SELECT public.'+name+'(200,NULL)'));if(!Array.isArray(page[key])||!Object.hasOwn(page,'next_cursor'))throw Error('Existing Admin reader failed');report.readRPCs[key]={pass:true,rows:page[key].length};}
  });
  report.status='GENERATE_LIVE_PREFLIGHT_PASS';report.packageManifestSHA256=expectedManifest;report.package_id=m.package_id;report.sixMigrationHashes=hashes;
 }catch(e){report.status='STOPPED';report.reason=/^(Read-only identity|Schema\/checkpoint|Generate schema|Frozen generate|Generate artifact|Generate source|Review identity|Original migration|Existing Admin)/.test(e.message)?e.message:'Read-only preflight connection/query failed; sensitive details suppressed';process.exitCode=1;}
 fs.mkdirSync(parent,{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2),{flag:'wx'});report.output=output;
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 if(process.argv[2]!=='--read-only')throw Error('Only explicit --read-only inspection is supported');
 const r=await generatePreflight();console.log(JSON.stringify({status:r.status,fingerprint:r.state?.fingerprint,compatibility:r.status==='GENERATE_LIVE_PREFLIGHT_PASS',readers:r.readRPCs,writeAttempted:false,reason:r.reason,report:r.output}));
}
