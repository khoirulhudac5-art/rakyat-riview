// Read-only acceptance only. Never imports/executes installation or rollback transports.
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {firstClaimConnection} from './prepare-first-claim-live.mjs';
import {verifyPackage,protectedSQL,inventorySQL,sha} from './admin-readonly-package.mjs';
import {readSnapshot,checkRoleViews,setReadRole,viewDigestSQL} from './admin-readonly-postflight.mjs';
const bundle=path.resolve('.backups/admin-readonly-approval-2026-11-07T04-26-36-782Z');
const backup=path.resolve('.backups/admin-readonly-live-2026-11-07T04-32-49-871Z');
const expectedFingerprint='1aa5a5788a1baed944130434797876ac';
const expectedPackageManifest='29366f468b75a1efc5f7b1712bb998dc7918e41f7a14511ac9489150d23c7c35';
const expectedBackupManifest='80e8486e37da3397558a0f3e1aadbbbe38354ea5fcd8b1c3d69ba4adc33af9d8';
const healthSQL=`SELECT json_build_object('readonly',current_setting('transaction_read_only'),'database',current_database(),'user',current_user,'version',current_setting('server_version_num')::int,'recovery',pg_is_in_recovery(),'connections',(SELECT count(*) FROM pg_stat_activity),'max_connections',current_setting('max_connections')::int,'long_idle',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND xact_start<now()-interval '30 seconds'),'long_active',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND xact_start<now()-interval '60 seconds'),'waiting',(SELECT count(*) FROM pg_locks WHERE NOT granted),'strong_locks',(SELECT count(*) FROM pg_locks WHERE relation IN ('public.card'::regclass,'public.card_activation'::regclass,'public.card_pin_attempts'::regclass) AND mode IN ('AccessExclusiveLock','ShareLock','ShareRowExclusiveLock','ExclusiveLock')))`;
const dataSQL=`SELECT md5(jsonb_build_object('card',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card c),'activation',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card_activation c),'pin',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card_pin_attempts c),'inventory',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.buyer_card_inventory c),'ownership',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.buyer_card_ownership c),'quota',(SELECT jsonb_agg(to_jsonb(c) ORDER BY user_id) FROM public.buyer_claim_limits c),'audit',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.buyer_ownership_audit c),'reset',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.buyer_activation_reset_audit c),'sequence',(SELECT jsonb_build_array(last_value,is_called) FROM public.card_id_seq))::text)`;
const aclSQL=`SELECT json_build_object(
 'original_count',count(*) FILTER(WHERE p.proname NOT IN ('buyer_test_action','admin_test_reset','admin_read_v2_inventory','admin_read_v2_audit')),
 'wrapper_count',count(*) FILTER(WHERE p.proname IN ('buyer_test_action','admin_test_reset')),
 'read_count',count(*) FILTER(WHERE p.proname IN ('admin_read_v2_inventory','admin_read_v2_audit')),
 'browser_denied',bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')),
 'server_matches_allowlist',bool_and(has_function_privilege('service_role',p.oid,'EXECUTE')=(p.proname IN ('admin_read_v2_inventory','admin_read_v2_audit'))))
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%')`;
export async function runPostflight(){
 const folder=path.resolve('.backups/admin-readonly-postflight-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(folder,{recursive:false});
 const report={status:'RUNNING',project_ref:'svuagnobufhfpgzmsyxx',tls:'verify-full',writeAttempted:false,installedSQL:false,rollbackExecuted:false,backupFilesModified:false,startedAt:new Date().toISOString(),checks:[]};
 const save=()=>fs.writeFileSync(path.join(folder,'RESULT.json'),JSON.stringify(report,null,2));
 const check=(name,pass)=>{report.checks.push({name,pass:Boolean(pass)});save();if(!pass)throw Error(name);};
 try{
  const m=verifyPackage(bundle);
  check('frozen package manifest unchanged',sha(fs.readFileSync(path.join(bundle,'manifest.json')))===expectedPackageManifest);
  check('backup manifest unchanged',sha(fs.readFileSync(path.join(backup,'manifest.json')))===expectedBackupManifest);
  const b=JSON.parse(fs.readFileSync(path.join(backup,'manifest.json'),'utf8'));
  for(const f of b.files){if(path.basename(f.name)!==f.name)throw Error('Invalid backup file');const bytes=fs.readFileSync(path.join(backup,f.name));check('backup checksum: '+f.name,bytes.length===f.bytes&&sha(bytes)===f.sha256);}
  const before=JSON.parse(fs.readFileSync(path.join(backup,'preflight.json'),'utf8'));
  const config={executable:path.resolve('.backups/tooling/pgsql/bin/psql.exe'),env:firstClaimConnection()};
  await readSnapshot(config,async s=>{
   const h=JSON.parse(await s.query(healthSQL));report.health=h;
   check('read-only identity/health/lock guard',h.readonly==='on'&&h.database==='postgres'&&h.user==='postgres'&&h.version===170011&&!h.recovery&&!h.long_idle&&!h.long_active&&!h.waiting&&!h.strong_locks&&h.connections<h.max_connections*.8);
   const i=JSON.parse(await s.query(inventorySQL));report.checkpoint=i;
   check('checkpoint6 closed, exact installed fingerprint and six original hashes',i.stage===6&&i.state==='closed'&&i.fingerprint_matches&&i.fingerprint===expectedFingerprint&&i.read_enabled&&JSON.stringify(i.six_hashes)===JSON.stringify(m.sources.filter(f=>f.file.startsWith('supabase/migrations/')).map(f=>f.sha256)));
   await s.query("SELECT rr_v2_test.verify_state('closed')");await s.query('SELECT rr_v2_test.assert_acl()');check('installed SQL postflight assertions and private ACL passed',true);
   const acl=JSON.parse(await s.query(aclSQL));report.effectiveACL=acl;
   check('11 business and 2 test RPCs closed; 2 read RPCs server-only including inherited grants',acl.original_count===11&&acl.wrapper_count===2&&acl.read_count===2&&acl.browser_denied&&acl.server_matches_allowlist);
   check('public RPC definitions, RLS, grants and views match pre-install baseline',await s.query(protectedSQL)===before.protectedFP);
   check('business data and sequences match pre-install baseline',await s.query(dataSQL)===before.dataDigest);
   check('postgres view matches its own pre-install baseline',await s.query(viewDigestSQL)===before.viewDigest);
   report.roleVisibility=await checkRoleViews(s);check('per-role RLS projections verified in same repeatable-read snapshot',true);
   await setReadRole(s,'service_role');
   const inventory=JSON.parse(await s.query('SELECT public.admin_read_v2_inventory(200,NULL)'));
   check('live inventory RPC executes READ ONLY as server role with valid contract',Array.isArray(inventory.cards)&&Object.hasOwn(inventory,'next_cursor')&&inventory.cards.every(c=>Object.hasOwn(c,'owner_id')&&!Object.hasOwn(c,'pin_hash')));
   const audit=JSON.parse(await s.query('SELECT public.admin_read_v2_audit(200,NULL)'));
   check('live audit RPC executes READ ONLY as server role with valid contract',Array.isArray(audit.events)&&Object.hasOwn(audit,'next_cursor'));
   report.rpcReads={inventory:true,audit:true,role:'service_role',readOnly:true,inventoryRows:inventory.cards.length,auditRows:audit.events.length};
   await setReadRole(s,'postgres');
   check('stored rollback definitions and original fingerprints match package',await s.query(`SELECT package_id='${m.package_id}' AND previous_fingerprint='${m.expected_fingerprint}' AND length(previous_assert)>0 AND length(previous_fp_function)>0 AND protected_fingerprint='${before.protectedFP}' FROM rr_v2_control.admin_read_checkpoint WHERE id`)==='t');
   check('no active restricted run',await s.query("SELECT count(*)=0 FROM rr_v2_test.runs WHERE status IN ('active','provisioning')")==='t');
  });
  // A fresh guarded transaction detects drift after the repeatable-read snapshot.
  await readSnapshot(config,async s=>{check('fresh transaction fingerprint still closed and identical',await s.query(`SELECT stage=6 AND state='closed' AND fingerprint='${expectedFingerprint}' AND fingerprint=rr_v2_test.fingerprint() FROM rr_v2_control.state WHERE id`)==='t');});
  for(const f of b.files)if(sha(fs.readFileSync(path.join(backup,f.name)))!==f.sha256)throw Error('Backup supporting file unexpectedly modified');
  report.status='LIVE_READONLY_POSTFLIGHT_PASS';report.rollbackReady=true;report.rollbackExecuted=false;report.historicalAnonBeforeAfterClaimed=false;
  report.httpBackendTest='NOT_TESTED: actual Admin server credentials and Supabase server key are not configured locally; no deployment or simulation used';
  report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,checks:report.checks.length,fingerprint:expectedFingerprint,state:'closed',writeAttempted:false,rollbackReady:true,folder}));
 }catch(e){report.status='STOPPED';report.reason=e.message;report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,reason:e.message,writeAttempted:false,folder}));process.exitCode=1;}
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){if(process.argv[2]!=='--approved-readonly')throw Error('Read-only execution approval flag required');await runPostflight();}
