// Closed installation transport only. The sole write is the frozen tested artifact.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {ReadOnlyPSQL} from './readonly-psql.mjs';
import {restrictedPackageSQL} from './prepare-restricted-local.mjs';
import {fingerprintSQL,files} from './v2-migration-control.mjs';
const approved=path.resolve('.backups/restricted-access-local-2026-11-06T05-23-42-030Z');
const hash=b=>createHash('sha256').update(b).digest('hex');
const literal=s=>"'"+s.replaceAll("'","''")+"'";
export function verifyRestrictedArtifact(){
 if(execFileSync('git',['branch','--show-current'],{encoding:'utf8',windowsHide:true}).trim()!=='v2-development')throw Error('Wrong branch');
 const m=JSON.parse(fs.readFileSync(path.join(approved,'package-manifest.json')));
 if(m.tests!==172||m.status!=='LOCAL_HARDENED_TESTED_NOT_APPLIED')throw Error('Untested package identity');
 for(const f of m.files){const bytes=fs.readFileSync(f.file);if(bytes.length!==f.bytes||hash(bytes)!==f.sha256)throw Error('Approved package/source checksum mismatch');}
 const artifact=m.files[0].file;
 if(fs.readFileSync(artifact,'utf8').trim()!==restrictedPackageSQL().trim())throw Error('Generator differs from approved package');
 const test=JSON.parse(fs.readFileSync(path.join(approved,'local-report.json')));
 if(test.status!=='LOCAL_RESTRICTED_ACCESS_TESTED_CLOSED'||test.tests.tests!==172||!test.localServerStopped||test.productionConnected!==false)throw Error('Local proof invalid');
 return {artifact,hashes:files.map(f=>hash(fs.readFileSync('supabase/migrations/'+f))),artifactSHA256:m.files[0].sha256};
}
const dataSQL=`SELECT md5(jsonb_build_object(
 'cards',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.card c),
 'activation',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card_activation c),
 'attempts',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card_pin_attempts c),
 'owners',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.buyer_card_ownership c),
 'inventory',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.buyer_card_inventory c),
 'limits',(SELECT jsonb_agg(to_jsonb(c) ORDER BY user_id) FROM public.buyer_claim_limits c),
 'owner_audit',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.buyer_ownership_audit c),
 'reset_audit',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.buyer_activation_reset_audit c),
 'sequences',(SELECT jsonb_build_array(last_value,is_called) FROM public.card_id_seq))::text)`;
const v1SQL=`SELECT md5(jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_array(relname,relacl,relowner,relrowsecurity,relforcerowsecurity,reloptions) ORDER BY relname) FROM pg_class WHERE oid IN ('public.card'::regclass,'public.card_activation'::regclass,'public.card_pin_attempts'::regclass,'public.card_id_seq'::regclass,'public.card_public'::regclass)),
 'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,a.attacl) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE a.attnum>0 AND NOT a.attisdropped AND c.oid IN ('public.card'::regclass,'public.card_activation'::regclass,'public.card_pin_attempts'::regclass,'public.card_public'::regclass)),
 'view',pg_get_viewdef('public.card_public'::regclass,true),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p WHERE schemaname='public' AND tablename IN ('card','card_activation','card_pin_attempts')),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl,p.proowner) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname<>'v2_pause_guard' AND p.proname NOT IN ('buyer_test_action','admin_test_reset'))
)::text)`;
const viewSQL="SELECT md5(coalesce(jsonb_agg(to_jsonb(v) ORDER BY card_code)::text,'')) FROM public.card_public v";
const healthSQL=`SELECT json_build_object('read_only',current_setting('transaction_read_only'),'user',current_user,'database',current_database(),'version',current_setting('server_version_num')::int,'recovery',pg_is_in_recovery(),
 'connections',(SELECT count(*) FROM pg_stat_activity),'max_connections',current_setting('max_connections')::int,
 'long_idle',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND xact_start<now()-interval '30 seconds'),
 'long_active',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND xact_start<now()-interval '60 seconds'),
 'waiting',(SELECT count(*) FROM pg_locks WHERE NOT granted),
 'strong_locks',(SELECT count(*) FROM pg_locks WHERE relation IN ('public.card'::regclass,'public.card_activation'::regclass,'public.card_pin_attempts'::regclass) AND mode IN ('AccessExclusiveLock','ShareLock','ShareRowExclusiveLock','ExclusiveLock')))`;
const healthy=h=>h.read_only==='on'&&h.user==='postgres'&&h.version===170011&&!h.recovery&&h.connections<h.max_connections*.8&&!h.long_idle&&!h.long_active&&!h.waiting&&!h.strong_locks;
const expect=(test,msg)=>{if(!test)throw Error(msg);};
export async function installRestrictedClosed({env,executable,reportDir,expectedFingerprint,sessionRole,localTest=false}){
 const pkg=verifyRestrictedArtifact();expect(localTest||(!sessionRole&&env.PGSSLMODE==='verify-full'&&env.PGDATABASE==='postgres'),'Unsafe live transport');
 fs.mkdirSync(reportDir,{recursive:true});const report={status:'RUNNING',localTest,targetRef:'svuagnobufhfpgzmsyxx',stage:6,state:'closed',writeAttempted:false,openRunExecuted:false,resumeExecuted:false,artifactSHA256:pkg.artifactSHA256,startedAt:new Date().toISOString()};
 const save=()=>fs.writeFileSync(path.join(reportDir,'closed-install-report.json'),JSON.stringify(report,null,2));save();
 const read=async(queries,anon=false)=>{const s=new ReadOnlyPSQL({executable,env});try{if(sessionRole)await s.command('SET ROLE postgres;');await s.begin();if(anon)await s.command('SET LOCAL ROLE anon;');const values=[];for(const q of queries)values.push(await s.query(q));return values;}finally{await s.close();}};
 const effectiveSQL=`SELECT json_build_object('count',count(*),'closed',bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT has_function_privilege('service_role',p.oid,'EXECUTE'))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%')`;
 const write=()=>new Promise((resolve,reject)=>{const child=spawn(executable,['-X','-q','-w','-v','ON_ERROR_STOP=1',...(sessionRole?['-c','SET ROLE postgres']:[]),'-f',pkg.artifact],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let err='';const timer=setTimeout(()=>{child.kill();reject(Error('Client timeout; commit ambiguous; no retry'));},120000);child.stdout.on('data',()=>{});child.stderr.on('data',x=>err+=x);child.on('error',()=>{clearTimeout(timer);reject(Error('Installation process/connection failed; no retry'));});child.on('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error(/timeout|timed out/i.test(err)?'SQL/lock timeout; no retry':/ERROR:/i.test(err)?'Installation SQL error; no retry':'Connection failure; commit may be ambiguous; no retry'));});});
 try{
  const [h,fp,rawState,rawGate,absent,legacy,rights,view]=await read([healthSQL,fingerprintSQL,'SELECT row_to_json(s) FROM rr_v2_control.state s',effectiveSQL,"SELECT to_regnamespace('rr_v2_test') IS NULL",dataSQL,v1SQL,viewSQL]);
  const state=JSON.parse(rawState),gate=JSON.parse(rawGate);report.preHealth=JSON.parse(h);
  expect(healthy(report.preHealth),'Preflight database health/lock failure');
  expect(absent==='t'&&state.stage===6&&state.state==='closed'&&state.fingerprint===fp&&fp===expectedFingerprint&&JSON.stringify(state.hashes)===JSON.stringify(pkg.hashes)&&gate.count===11&&gate.closed,'Preflight checkpoint/hash/fingerprint/RPC drift');
  const [anon]=await read([viewSQL],true);expect(anon===view,'Preflight anonymous V1 mapping differs');
  report.preflightPassed=true;save();verifyRestrictedArtifact();
  report.writeAttempted=true;save();await write();report.sqlProcessCompleted=true;save();
  const [afterState,newFP,afterGate,data,legacyRights,afterView,checks,afterHealth]=await read([
   'SELECT row_to_json(s) FROM rr_v2_control.state s','SELECT rr_v2_test.fingerprint()',effectiveSQL,dataSQL,v1SQL,viewSQL,
   `SELECT json_build_object('registry_tables',(SELECT count(*) FROM pg_tables WHERE schemaname='rr_v2_test'),
    'registry_rls',(SELECT bool_and(relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rr_v2_test' AND c.relkind='r'),
    'runs',(SELECT count(*) FROM rr_v2_test.runs),'cards',(SELECT count(*) FROM rr_v2_test.cards),'contexts',(SELECT count(*) FROM rr_v2_test.context),'events',(SELECT count(*) FROM rr_v2_test.events),'quota_snapshots',(SELECT count(*) FROM rr_v2_test.limit_snapshot),
    'private_helpers',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='rr_v2_test'),
    'row_guards',(SELECT count(*) FROM pg_trigger WHERE tgname='v2_pause_write'),'truncate_guards',(SELECT count(*) FROM pg_trigger WHERE tgname='restricted_no_truncate'),
    'definer_safe',NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','rr_v2_test') AND p.prosecdef AND (pg_get_userbyid(p.proowner)<>'postgres' OR NOT coalesce(p.proconfig @> ARRAY['search_path=""'],false))))`,healthSQL]);
  const s=JSON.parse(afterState),g=JSON.parse(afterGate),c=JSON.parse(checks);report.postHealth=JSON.parse(afterHealth);report.postChecks=c;
  expect(s.stage===6&&s.state==='closed'&&s.fingerprint===newFP&&JSON.stringify(s.hashes)===JSON.stringify(pkg.hashes),'Post-install checkpoint/fingerprint mismatch');
  expect(g.count===13&&g.closed,'Original/test wrapper effective RPC access remains open');
  expect(c.registry_tables===6&&c.registry_rls&&c.runs===0&&c.cards===0&&c.contexts===0&&c.events===0&&c.quota_snapshots===0&&c.private_helpers===9&&c.row_guards===8&&c.truncate_guards===5&&c.definer_safe,'Post-install structure/empty registry/guard failure');
  await read(['SELECT rr_v2_test.assert_acl()']);
  const [anonAfter]=await read([viewSQL],true);expect(data===legacy&&legacyRights===rights&&afterView===view&&anonAfter===view,'V1 data/access/function/redirect regression');
  expect(healthy(report.postHealth),'Post-install database health/lock failure');
  report.status='RESTRICTED_INSTALLED_VERIFIED_CLOSED';report.checkpoint={stage:6,state:'closed',fingerprint:newFP,hashesUnchanged:true};report.originalRPCsClosed=11;report.testWrappersClosed=2;report.v1DataUnchanged=true;report.v1FunctionsAndAccessUnchanged=true;report.anonRedirectMappingUnchanged=true;report.noFixturesOrRunsCreated=true;
 }catch(e){report.status='STOPPED';report.reason=String(e.message||'Closed installation failed');if(report.writeAttempted){try{const [v,exists]=await read(['SELECT row_to_json(s) FROM rr_v2_control.state s',"SELECT to_regnamespace('rr_v2_test') IS NOT NULL"]);report.observedCheckpoint=JSON.parse(v);report.observedTestSchema=exists==='t';}catch{report.observedCheckpoint='Unavailable; no retry or repair attempted';}}
  save();throw Object.assign(Error(report.reason),{report});
 }finally{report.finishedAt=new Date().toISOString();save();}
 return report;
}
