// Preparation only: SELECTs inside verified READ ONLY transactions. Never
// provisions cards, opens a run, changes grants, or obtains user tokens.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {inspect} from './readonly-psql.mjs';
import {pathToFileURL} from 'node:url';
const ref='svuagnobufhfpgzmsyxx',root=process.cwd();
export function firstClaimConnection(){
 if(execFileSync('git',['branch','--show-current'],{encoding:'utf8',windowsHide:true}).trim()!=='v2-development')throw Error('Wrong branch');
 const entries=fs.readFileSync('.env.backup','utf8').split(/\r?\n/).filter(s=>/^\s*BACKUP_DATABASE_URL\s*=/.test(s));if(entries.length!==1)throw Error('Backup connection configuration is missing/ambiguous');
 let raw=entries[0].replace(/^\s*BACKUP_DATABASE_URL\s*=\s*/,'').trim();if(/^(['"])[\s\S]*\1$/.test(raw))raw=raw.slice(1,-1);
 const u=new URL(raw);if(!['postgres:','postgresql:'].includes(u.protocol)||!/^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(u.hostname)||u.port!=='5432'||decodeURIComponent(u.username)!=='postgres.'+ref||u.pathname!=='/postgres'||!u.password)throw Error('Connection does not identify the approved existing project');
 const caPath=path.join(root,'.backups/tooling/prod-ca-2021.crt'),cert=new X509Certificate(fs.readFileSync(caPath));
 const approved=JSON.parse(fs.readFileSync('.backups/v1-2026-11-05T19-04-23-157Z/manifest.json'));
 if(cert.fingerprint256!==approved.ca.fingerprint256||Date.now()>Date.parse(cert.validTo))throw Error('Approved CA identity/validity mismatch');
 const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('PG')||/DATABASE_URL|PASSWORD|TOKEN|SECRET/.test(k))delete env[k];
 Object.assign(env,{PGHOST:u.hostname,PGPORT:u.port,PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:'postgres',PGSSLMODE:'verify-full',PGSSLROOTCERT:caPath,PGCONNECT_TIMEOUT:'20',PGOPTIONS:'-c default_transaction_read_only=on -c lock_timeout=10000 -c statement_timeout=20000',PGAPPNAME:'rakyat-review-first-claim-readonly'});
 return env;
}
export const firstClaimReadinessSQL=`SELECT json_build_object('stage',s.stage,'state',s.state,'fingerprint',s.fingerprint,'live_fingerprint',rr_v2_test.fingerprint(),
 'original_count',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%') AND p.proname NOT IN ('buyer_test_action','admin_test_reset')),
 'original_closed',NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%') AND p.proname NOT IN ('buyer_test_action','admin_test_reset') AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('service_role',p.oid,'EXECUTE'))),
 'wrapper_count',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('buyer_test_action','admin_test_reset')),
 'wrappers_closed',NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('buyer_test_action','admin_test_reset') AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('service_role',p.oid,'EXECUTE'))),
 'active_runs',(SELECT count(*) FROM rr_v2_test.runs WHERE status IN ('active','provisioning')),
 'private_rls',(SELECT count(*)=6 AND bool_and(c.relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rr_v2_test' AND c.relkind='r'),
 'waiting_locks',(SELECT count(*) FROM pg_locks WHERE NOT granted)) FROM rr_v2_control.state s WHERE id`;
const identities=`SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.created_at,t.uid),'[]'::json) FROM (
 SELECT u.id uid,u.created_at,u.last_sign_in_at,CASE WHEN length(split_part(u.email,'@',1))>3 THEN left(split_part(u.email,'@',1),3) ELSE left(split_part(u.email,'@',1),1) END||'***@'||left(split_part(u.email,'@',2),1)||'***' email_hint,u.email_confirmed_at IS NOT NULL confirmed,
 coalesce((to_jsonb(u)->>'banned_until')::timestamptz,'-infinity'::timestamptz)>clock_timestamp() disabled
 FROM auth.users u WHERE to_jsonb(u)->>'deleted_at' IS NULL AND EXISTS(SELECT 1 FROM auth.identities i WHERE i.user_id=u.id AND i.provider='google'))t`;
export async function prepareFirstClaim(){try{
 const env=firstClaimConnection(),executable=path.join(root,'.backups/tooling/pgsql/bin/psql.exe');
 const [rawConnection,rawState,rawUsers]=await inspect({executable,env,queries:["SELECT json_build_object('readonly',current_setting('transaction_read_only'),'database',current_database(),'user',current_user,'backend_tls',(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()))",firstClaimReadinessSQL,identities]});
 const connection=JSON.parse(rawConnection),state=JSON.parse(rawState),users=JSON.parse(rawUsers);
 const baseline=JSON.parse(fs.readFileSync('.backups/restricted-closed-live-2026-11-06T05-49-31-969Z/closed-install-report.json'));
 if(connection.readonly!=='on'||connection.database!=='postgres'||connection.user!=='postgres')throw Error('Read-only connection identity guard failed');
 if(state.stage!==6||state.state!=='closed'||state.fingerprint!==state.live_fingerprint||state.fingerprint!==baseline.checkpoint.fingerprint||state.original_count!==11||!state.original_closed||state.wrapper_count!==2||!state.wrappers_closed||state.active_runs!==0||!state.private_rls||state.waiting_locks!==0)throw Error('Minimum restricted readiness does not match the installed closed baseline');
 const folder=path.join(root,'.local-tools/first-claim-live');fs.mkdirSync(folder,{recursive:true});
 fs.writeFileSync(path.join(folder,'auth-candidates.json'),JSON.stringify({project_ref:ref,read_at:new Date().toISOString(),identities:users},null,2),{mode:0o600});
 let selection;try{selection=JSON.parse(fs.readFileSync(path.join(folder,'selection.json'),'utf8'));}catch{}
 const selected=selection?.confirmed_by_user===true?[selection.A,selection.B].map(id=>users.find(u=>u.uid===id)):users.length===2?users:[];
 if(selected.length!==2||selected.some(u=>!u||!u.confirmed||u.disabled)||selected[0].uid===selected[1].uid){console.log(JSON.stringify({readOnly:true,stage:state.stage,state:state.state,fingerprintMatches:true,googleAccounts:users.length,confirmed:users.filter(u=>u.confirmed).length,enabled:users.filter(u=>!u.disabled).length,eligible:users.filter(u=>u.confirmed&&!u.disabled).length,candidates:users.map((u,i)=>({candidate:i+1,email_hint:u.email_hint,uid_hint:u.uid.slice(-4),last_sign_in_at:u.last_sign_in_at})),selected:0}));throw Error('Exactly two confirmed, enabled Google identities could not be established; no users selected');}
 const file=path.join(folder,'plan.json');let previous;try{previous=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
 const accounts=Object.fromEntries(selected.map((u,i)=>[['A','B'][i],{uid:u.uid,google_identity:true,confirmed:true,label_basis:selection?'User-confirmed private Auth UID selection':'Only two Google Auth users'}]));
 if(previous&&JSON.stringify(previous.accounts)!==JSON.stringify(accounts))throw Error('Tester identity selection changed; existing plan preserved for review');
 const plan={...previous,version:1,project_ref:ref,status:'PREPARED_READ_ONLY_AWAITING_APPROVAL',prepared_at:new Date().toISOString(),run_id:previous?.run_id||randomUUID(),minutes:30,accounts,checkpoint:{stage:6,state:'closed',fingerprint:state.fingerprint},fixtures:[{label:'RR-JWT-DUMMY-01',card_code:null,permanent_path:'/r/<code allocated by open_run>'},{label:'RR-JWT-DUMMY-02',card_code:null,permanent_path:'/r/<code allocated by open_run>'}],provisioning:'Only existing rr_v2_test.open_run after explicit approval; exactly two generated cards',cleanup:'Existing close_run: reset/retire only registered fixtures, preserve IDs/URLs/audit, restore quotas, revoke wrappers, return closed',wrapper_grants_on_open:['buyer_test_action: authenticated','admin_test_reset: service_role (not used in buyer test)'],live_writes_executed:false,read_only_verified:true,tls:'verify-full'};
 fs.writeFileSync(file,JSON.stringify(plan,null,2),{mode:0o600});
 console.log(JSON.stringify({project_ref:ref,readOnly:true,tls:'verify-full',stage:6,state:'closed',fingerprintMatches:true,originalRPCsClosed:11,wrappersClosed:2,testers:selected.map((u,i)=>({label:['A','B'][i],uid:u.uid.slice(0,8)+'…'+u.uid.slice(-4),google:true,confirmed:true})),dummyLiveCreated:0,plan:'.local-tools/first-claim-live/plan.json',awaitingApproval:true}));
}catch(error){console.error('STOPPED:',error?.message&&/^(Wrong branch|Backup connection|Connection does not|Approved CA|Read-only|Minimum restricted|Exactly two|Tester identity)/.test(error.message)?error.message:'Read-only preparation failed; no live write attempted and no credentials printed.');process.exitCode=1;}}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await prepareFirstClaim();
