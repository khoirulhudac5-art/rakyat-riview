// Executes ONLY the frozen, previously tested six closed steps. No resume path.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {ReadOnlyPSQL} from './readonly-psql.mjs';
import {files,migrationStep,fingerprintSQL} from './v2-migration-control.mjs';
const bundle=path.resolve('.backups/prepared-v2-2026-11-05T18-27-10-329Z');
const digest=x=>createHash('sha256').update(x).digest('hex');
const dataSQL=`SELECT json_build_object(
 'card', (SELECT md5(coalesce(jsonb_agg(to_jsonb(c)-'claim_mode'-'v2_activated_at' ORDER BY id)::text,'')) FROM public.card c),
 'activation',(SELECT md5(coalesce(jsonb_agg(to_jsonb(a) ORDER BY card_code)::text,'')) FROM public.card_activation a),
 'attempts',(SELECT md5(coalesce(jsonb_agg(to_jsonb(a) ORDER BY card_code)::text,'')) FROM public.card_pin_attempts a),
 'sequence',(SELECT md5(row(last_value,is_called)::text) FROM public.card_id_seq))`;
const viewSQL="SELECT md5(coalesce(jsonb_agg(to_jsonb(v) ORDER BY card_code)::text,'')) FROM public.card_public v";
const healthSQL=`SELECT json_build_object('read_only',current_setting('transaction_read_only'),'database',current_database(),'user',current_user,'recovery',pg_is_in_recovery(),'server_version',current_setting('server_version_num')::int,
 'database_create',has_database_privilege(current_user,current_database(),'CREATE'),'schema_create',has_schema_privilege(current_user,'public','CREATE'),
 'connections',(SELECT count(*) FROM pg_stat_activity),'max_connections',current_setting('max_connections')::int,
 'long_idle',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND xact_start<now()-interval '30 seconds'),
 'long_active',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND xact_start<now()-interval '60 seconds'),
 'waiting_locks',(SELECT count(*) FROM pg_locks WHERE NOT granted),
 'strong_locks',(SELECT count(*) FROM pg_locks WHERE relation IN ('public.card'::regclass,'public.card_activation'::regclass,'public.card_pin_attempts'::regclass) AND mode IN ('AccessExclusiveLock','ShareRowExclusiveLock','ShareLock','ExclusiveLock')))`;
function ensure(ok,reason){if(!ok)throw Error(reason);}
export function verifyFrozenPackage(){
 ensure(execFileSync('git',['branch','--show-current'],{encoding:'utf8',windowsHide:true}).trim()==='v2-development','Wrong branch');
 const m=JSON.parse(fs.readFileSync(path.join(bundle,'manifest.json')));
 ensure(m.targetRef==='svuagnobufhfpgzmsyxx'&&JSON.stringify(m.migrations)===JSON.stringify(files)&&files.length===6,'Package identity mismatch');
 for(const f of m.artifacts)ensure(digest(fs.readFileSync(path.join(bundle,f.name)))===f.sha256,'Artifact checksum mismatch');
 for(let i=1;i<=6;i++)ensure(fs.readFileSync(path.join(bundle,'step-'+i+'.sql'),'utf8')===migrationStep(i),'Generator/package mismatch');
 return {manifest:m,hashes:files.map(f=>digest(fs.readFileSync(path.join('supabase/migrations',f))))};
}
export async function executeApprovedSix({env,executable,reportDir,expectedFingerprint,sessionRole,localTest=false}){
 const pkg=verifyFrozenPackage();
 ensure(localTest||(!sessionRole&&env.PGSSLMODE==='verify-full'&&env.PGDATABASE==='postgres'),'Unsafe live connection mode');
 fs.mkdirSync(reportDir,{recursive:true});
 const report={status:'RUNNING',targetRef:'svuagnobufhfpgzmsyxx',localTest,lastValidatedStage:0,attemptedStage:0,steps:[],startedAt:new Date().toISOString(),resumeExecuted:false};
 const save=()=>fs.writeFileSync(path.join(reportDir,'execution-report.json'),JSON.stringify(report,null,2));save();
 const read=async(queries,anon=false)=>{
  const s=new ReadOnlyPSQL({executable,env});try{
   if(sessionRole)await s.command('SET ROLE postgres;');await s.begin();if(anon)await s.command('SET LOCAL ROLE anon;');
   const result=[];for(const q of queries)result.push(await s.query(q));return result;
  }finally{await s.close();}
 };
 const healthy=h=>h.read_only==='on'&&!h.recovery&&h.user==='postgres'&&h.database_create&&h.schema_create&&h.server_version===170011&&h.connections<h.max_connections*.8&&!h.long_idle&&!h.long_active&&!h.waiting_locks&&!h.strong_locks;
 const state=async()=>{
  const [fp,ledger,gate,legacy,view]=await read([fingerprintSQL,"SELECT row_to_json(s) FROM rr_v2_control.state s",`SELECT json_build_object(
 'all_rpc_closed',NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%') AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('service_role',p.oid,'EXECUTE'))),
 'rpc_count',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%')),
 'private_tables',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('buyer_card_ownership','buyer_claim_limits','buyer_ownership_audit','buyer_card_inventory','buyer_activation_reset_audit') AND c.relkind='r'),
 'private_rls',NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'buyer_%' AND c.relkind='r' AND NOT c.relrowsecurity),
 'guards',(SELECT count(*) FROM pg_trigger WHERE tgname='v2_pause_write'),
 'legacy_rls',(SELECT count(*)=3 AND bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.card'::regclass,'public.card_activation'::regclass,'public.card_pin_attempts'::regclass)),
 'view_invoker',(SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid='public.card_public'::regclass),
 'v1_service_rights',(SELECT bool_and(has_table_privilege('service_role','public.card',priv)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) priv) AND has_sequence_privilege('service_role','public.card_id_seq','USAGE'),
 'control_private',NOT has_schema_privilege('anon','rr_v2_control','USAGE') AND NOT has_schema_privilege('authenticated','rr_v2_control','USAGE') AND NOT has_schema_privilege('service_role','rr_v2_control','USAGE'),
 'legacy_functions',md5(pg_get_functiondef('public.activate_review_card(text,text,text,text,text)'::regprocedure))='2c58074f4fb917e87044979c84218986' AND md5(pg_get_functiondef('public.set_initial_card_pin(text,text)'::regprocedure))='ad326b35c9d03a67e0b44cbb8896b851',
 'legacy_rpc_service',has_function_privilege('service_role','public.activate_review_card(text,text,text,text,text)','EXECUTE') AND has_function_privilege('service_role','public.set_initial_card_pin(text,text)','EXECUTE') AND has_function_privilege('service_role','public.update_card_review_url(text,text,text)','EXECUTE'))`,dataSQL,viewSQL]);
  return {fp,ledger:JSON.parse(ledger),gate:JSON.parse(gate),legacy,view};
 };
 const writeStep=n=>new Promise((resolve,reject)=>{
  const args=['-X','-q','-w','-v','ON_ERROR_STOP=1',...(sessionRole?['-c','SET ROLE postgres']:[]),'-f',path.join(bundle,'step-'+n+'.sql')];
  const p=spawn(executable,args,{env:{...env,PGAPPNAME:'rakyat-review-approved-step-'+n},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const timer=setTimeout(()=>{p.kill();reject(Error('Migration client timeout; COMMIT may be ambiguous; no retry'));},120000);
  let stderr='';p.stdout.on('data',()=>{});p.stderr.on('data',c=>stderr+=c);p.on('error',()=>{clearTimeout(timer);reject(Error('Migration connection/process failed; outcome requires inspection'));});
  p.on('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error(/timeout|timed out/i.test(stderr)?'Migration timeout; stopped without retry':/ERROR:/i.test(stderr)?'Migration SQL error; stopped without retry':'Migration connection/process failed; COMMIT may be ambiguous'));});
 });
 try{
  const pre=[...['preflight.sql','preflight_six.sql','preflight_strict.sql'].map(f=>fs.readFileSync(path.join('supabase/existing',f),'utf8'))];
  const [health,fp,...checks]=await read([healthSQL,fingerprintSQL,...pre]);report.initialHealth=JSON.parse(health);
  ensure(healthy(report.initialHealth),'Initial database health/lock guard failed');
  ensure(fp===expectedFingerprint,'Initial live fingerprint mismatch');ensure(checks.every(v=>Object.values(JSON.parse(v)).every(b=>b===true)),'Initial preflight drift');
  const control=await read(["SELECT to_regclass('rr_v2_control.state') IS NULL"]);ensure(control[0]==='t','Unexpected existing checkpoint');
  const [legacyBefore,viewBefore]=await read([dataSQL,viewSQL]);const [anonBefore]=await read([viewSQL],true);ensure(anonBefore===viewBefore,'Initial anon redirect mapping mismatch');
  report.preflightPassed=true;save();
  for(let n=1;n<=6;n++){
   verifyFrozenPackage();const [h]=await read([healthSQL]);ensure(healthy(JSON.parse(h)),'Per-step health/lock guard failed');
   if(n===1){const [again]=await read([fingerprintSQL]);ensure(again===expectedFingerprint,'Pre-step fingerprint drift');}
   else{const s=await state();ensure(s.ledger.stage===n-1&&s.ledger.state==='closed'&&s.fp===s.ledger.fingerprint&&JSON.stringify(s.ledger.hashes)===JSON.stringify(pkg.hashes.slice(0,n-1))&&s.legacy===legacyBefore&&s.view===viewBefore&&s.gate.all_rpc_closed,'Previous stage verification drift');}
   report.attemptedStage=n;save();await writeStep(n);
   const s=await state(),[anon]=await read([viewSQL],true),g=s.gate;
   ensure(s.ledger.stage===n&&s.ledger.state==='closed'&&s.ledger.fingerprint===s.fp&&JSON.stringify(s.ledger.hashes)===JSON.stringify(pkg.hashes.slice(0,n)),'Committed checkpoint/hash/fingerprint mismatch');
   ensure(g.all_rpc_closed&&g.rpc_count===[4,8,8,8,9,11][n-1]&&g.private_tables===[1,3,3,3,4,5][n-1]&&g.guards===3+g.private_tables&&g.private_rls&&g.legacy_rls&&g.view_invoker&&g.v1_service_rights&&g.control_private&&g.legacy_functions&&g.legacy_rpc_service,'Closed-state schema/RLS/grant verification failed');
   ensure(s.legacy===legacyBefore&&s.view===viewBefore&&anon===viewBefore,'Legacy data/sequence/anon redirect regression');
   report.lastValidatedStage=n;report.steps.push({stage:n,status:'COMMITTED_AND_VERIFIED_CLOSED',fingerprint:s.fp,checks:g,legacyUnchanged:true,anonRedirectMappingUnchanged:true});save();console.log(JSON.stringify({stage:n,status:'COMMITTED_AND_VERIFIED_CLOSED'}));
  }
  const final=await state(),[finalAnon]=await read([viewSQL],true),[finalHealth]=await read([healthSQL]);
  ensure(final.ledger.stage===6&&final.ledger.state==='closed'&&final.fp===final.ledger.fingerprint&&JSON.stringify(final.ledger.hashes)===JSON.stringify(pkg.hashes)&&final.legacy===legacyBefore&&final.view===viewBefore&&finalAnon===viewBefore&&final.gate.all_rpc_closed&&final.gate.private_rls&&final.gate.legacy_rls&&final.gate.control_private&&healthy(JSON.parse(finalHealth)),'Final verification failed');
  report.finalHealth=JSON.parse(finalHealth);report.finalChecks=final.gate;
  report.status='SIX_COMMITTED_AND_VERIFIED_CLOSED';report.v1Unchanged=true;report.v2Closed=true;
 }catch(e){
  report.status='STOPPED';report.reason=String(e.message||'Verification failed');
  // Incident observation only; never retry a step or invoke pause/resume.
  if(report.attemptedStage){try{const [v]=await read(["SELECT stage,state,fingerprint FROM rr_v2_control.state".replace('SELECT stage,state,fingerprint','SELECT row_to_json(s)').replace('FROM rr_v2_control.state','FROM rr_v2_control.state s')]);report.observedCheckpoint=JSON.parse(v);}catch{report.observedCheckpoint='Unavailable; COMMIT outcome requires investigation';}}
  save();throw Object.assign(Error(report.reason),{report});
 }finally{report.finishedAt=new Date().toISOString();save();}
 return report;
}
