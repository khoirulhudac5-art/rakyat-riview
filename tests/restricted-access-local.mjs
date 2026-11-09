// Real PostgreSQL tests over synthetic rows only. This module opens no network
// connections, reads no environment files/backups, and cannot select a remote DB.
import fs from 'node:fs';
import path from 'node:path';

const A='f1111111-1111-4111-8111-111111111111';
const B='f2222222-2222-4222-8222-222222222222';
const C='f3333333-3333-4333-8333-333333333333';
const E='f4444444-4444-4444-8444-444444444444';
const RUN='a0000000-0000-4000-8000-000000000001';
const OTHER_RUN='a0000000-0000-4000-8000-000000000002';
const URL='https://search.google.com/local/writereview?placeid=ChITestFixtureOnly';
const LEGACY='LEGACY-RESTRICTED-TEST';
const OUTSIDE='LEGACY-OUTSIDE-REGISTRY';
const lit=v=>v===null||v===undefined?'NULL':"'"+String(v).replaceAll("'","''")+"'";
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const originalCalls=[
 ['buyer_list_cards()', 'public.buyer_list_cards()'],
 ['buyer_activate_card(text,text,text,text,text)', `public.buyer_activate_card('outside','synthetic-only','Synthetic',${lit(URL)},'synthetic-only')`],
 ['buyer_claim_card(text,text)', "public.buyer_claim_card('outside','synthetic-only')"],
 ['buyer_update_card(text,text,text)', `public.buyer_update_card('outside','Synthetic',${lit(URL)})`],
 ['buyer_first_claim(text,text,text)', `public.buyer_first_claim('outside','Synthetic',${lit(URL)})`],
 ['buyer_public_card_status(text)', "public.buyer_public_card_status('outside')"],
 ['admin_create_v2_cards(integer)', 'public.admin_create_v2_cards(1)'],
 ['admin_recover_v2_owner(text,uuid,text,text)', `public.admin_recover_v2_owner('outside','${A}','local-test','Synthetic restricted test reason')`],
 ['admin_set_v2_card_ready(text,boolean,text)', "public.admin_set_v2_card_ready('outside',true,'local-test')"],
 ['admin_list_v2_activation_cards()', 'public.admin_list_v2_activation_cards()'],
 ['admin_reset_v2_activation(text,text,bigint,text,text)', "public.admin_reset_v2_activation('outside','outside',0,'local-test','Synthetic restricted test reason')"],
];

export async function runRestrictedTests({sql,base,database='rr_restricted',testTransport}){
 const q=query=>sql(query,database);
 const parse=value=>value==='t'?true:value==='f'?false:value===''?null:JSON.parse(value);
 const json=async query=>parse(await q(query));
 const results=[];
 const check=(name,passed)=>{
  results.push({name,passed:Boolean(passed)});
  if(base)fs.writeFileSync(path.join(base,'restricted-progress.json'),JSON.stringify(results,null,2));
  if(!passed)throw Object.assign(Error('Restricted SQL assertion failed: '+name),{reason:'Restricted SQL assertion failed: '+name});
 };
 const asSQL=(uid,expression,role='authenticated',extra='')=>`BEGIN; SET LOCAL ROLE ${role}; SET LOCAL "request.jwt.claim.sub"=${lit(uid??'')}; ${extra} SELECT ${expression}; COMMIT;`;
 const as=(uid,expression,role='authenticated',extra='')=>json(asSQL(uid,expression,role,extra));
 const errorText=error=>String(error?.err??error?.stderr??error?.reason??error?.message??error);
 const isPolicyError=error=>{
  const message=errorText(error);
  if(/does not exist|syntax error|ambiguous|invalid input syntax|undefined|cannot change return type/i.test(message))return false;
  return /permission denied|denied|paused|restricted|expired|not authorized|not allowed|not registered|checkpoint|fingerprint|active run|already active|already exists|duplicate key|Google|identity/i.test(message);
 };
 const denied=async(name,operation)=>{
  let value;
  try{
   value=await operation();
  }catch(error){
   if(!isPolicyError(error))throw error;
   check(name,true);
   return;
  }
  check(name,value===false||value===null||(typeof value==='object'&&value.success===false));
 };
 const action=(uid,op,code=null,name=null,url=null,runId=RUN)=>as(uid,`public.buyer_test_action('${runId}',${lit(op)},${lit(code)},${lit(name)},${lit(url)})`);
 const reset=(code,confirmation,revision,actor='local-test-admin',reason='Synthetic authorized activation reset',runId=RUN,role='service_role')=>as('',`public.admin_test_reset('${runId}',${lit(code)},${lit(confirmation)},${revision===null?'NULL':revision},${lit(actor)},${lit(reason)})`,role);
 const cardSnapshot=code=>q(`SELECT md5(to_jsonb(c)::text) FROM public.card c WHERE card_code=${lit(code)}`);
 const originalClosed=async label=>{
  check(label,await json(`SELECT bool_and(NOT has_function_privilege(r,p.oid,'EXECUTE')) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN unnest(ARRAY['anon','authenticated','service_role'])r WHERE n.nspname='public' AND p.oid=ANY(ARRAY[${originalCalls.map(([signature])=>lit('public.'+signature)+'::regprocedure').join(',')}])`));
 };
 const runState=()=>json('SELECT jsonb_build_object(\'stage\',stage,\'state\',state,\'fingerprint\',fingerprint) FROM rr_v2_control.state WHERE id');
 const fingerprintMatches=()=>json('SELECT fingerprint=rr_v2_test.fingerprint() FROM rr_v2_control.state WHERE id');
 const legacySnapshot=()=>q(`SELECT md5(jsonb_build_object(
  'cards',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card c WHERE claim_mode='legacy' AND card_code<>${lit(LEGACY)}),
  'activation',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.card_code) FROM public.card_activation a JOIN public.card c USING(card_code) WHERE c.claim_mode='legacy' AND c.card_code<>${lit(LEGACY)}),
  'attempts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.card_code) FROM public.card_pin_attempts a JOIN public.card c USING(card_code) WHERE c.claim_mode='legacy' AND c.card_code<>${lit(LEGACY)}),
  'owners',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.card_code) FROM public.buyer_card_ownership o JOIN public.card c USING(card_code) WHERE c.claim_mode='legacy'),
  'grants',(SELECT jsonb_agg(jsonb_build_array(relname,relacl,relrowsecurity) ORDER BY relname) FROM pg_class WHERE oid IN ('public.card'::regclass,'public.card_activation'::regclass,'public.card_pin_attempts'::regclass)),
  'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.oid IN ('public.activate_review_card(text,text,text,text,text)'::regprocedure,'public.update_card_review_url(text,text,text)'::regprocedure,'public.set_initial_card_pin(text,text)'::regprocedure))
 )::text)`);

 const initialState=await runState();
 check('Restricted package starts at checkpoint 6 closed',initialState?.stage===6&&initialState.state==='closed');
 check('Installed package checkpoint fingerprint is current',await fingerprintMatches());
 await originalClosed('All 11 original RPC remain closed before test opening');
 const legacyBefore=await legacySnapshot();
 const quotaBefore=await q(`SELECT to_jsonb(l)::text FROM public.buyer_claim_limits l WHERE user_id='${A}'`);
 await q(`INSERT INTO auth.users(id) VALUES('${A}'),('${B}'),('${C}'),('${E}') ON CONFLICT DO NOTHING;
 INSERT INTO auth.identities(user_id,provider_id,identity_data,provider) VALUES
 ('${A}','restricted-a','{"sub":"restricted-a"}','google'),('${B}','restricted-b','{"sub":"restricted-b"}','google'),('${C}','restricted-c','{"sub":"restricted-c"}','google') ON CONFLICT DO NOTHING;`);
 for(const role of ['anon','authenticated','service_role']){
  await denied('Private test registry is inaccessible to '+role,()=>as(A,'count(*) FROM rr_v2_test.runs',role));
  await denied('Operator-only open_run is inaccessible to '+role,()=>as(A,`rr_v2_test.open_run('${OTHER_RUN}','${A}','${B}',30)`,role));
  await denied('Operator-only close_run is inaccessible to '+role,()=>as(A,`rr_v2_test.close_run('${OTHER_RUN}')`,role));
 }
 check('Registry tables use RLS with no app privileges',await json(`SELECT bool_and(c.relrowsecurity AND NOT has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AND NOT has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AND NOT has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rr_v2_test' AND c.relkind='r'`));
 await denied('No Google identity cannot be registered as a test account',()=>json(`SELECT jsonb_agg(card_code) FROM rr_v2_test.open_run('${OTHER_RUN}','${A}','${E}',30)`));
 await denied('Same user cannot occupy both A and B',()=>json(`SELECT jsonb_agg(card_code) FROM rr_v2_test.open_run('${OTHER_RUN}','${A}','${A}',30)`));
 const cards=await json(`SELECT jsonb_agg(card_code) FROM rr_v2_test.open_run('${RUN}','${A}','${B}',30)`);
 check('Opening creates exactly two random registered synthetic cards',cards?.length===2&&new Set(cards).size===2&&cards.every(code=>/^[A-Za-z0-9_-]{24}$/.test(code)));
 const [first,second]=cards;
 check('Opening transitions checkpoint 6 to testing_restricted',(await runState()).state==='testing_restricted'&&await fingerprintMatches());
 check('Run contains only two protected Google UUIDs and bounded expiry',await json(`SELECT user_a='${A}' AND user_b='${B}' AND status='active' AND expires_at>clock_timestamp() AND expires_at<=clock_timestamp()+interval '31 minutes' FROM rr_v2_test.runs WHERE run_id='${RUN}'`));
 await originalClosed('Opening testing access leaves all original 11 RPC closed');
 await denied('A second live run cannot be opened',()=>json(`SELECT jsonb_agg(card_code) FROM rr_v2_test.open_run('${OTHER_RUN}','${A}','${B}',30)`));
 for(const role of ['anon','authenticated','service_role'])for(const [signature,expression] of originalCalls){
  await denied('Direct original RPC denied: '+role+' '+signature,()=>as(A,expression,role));
 }
 for(const uid of [A,B]){
  const status=await action(uid,'status',first);
  check('Registered user can read only registered status '+uid.slice(0,8),status?.success===true&&status.status?.code===first);
  for(const op of ['status','claim','update'])await denied('Registered account cannot access legacy/outside card '+uid.slice(0,8)+' '+op,()=>action(uid,op,OUTSIDE,'Out of scope',URL));
  await denied('Registered account cannot access unregistered V2-looking code '+uid.slice(0,8),()=>action(uid,'claim','Z'.repeat(24),'Out of scope',URL));
  await denied('Registry cannot be borrowed through a different run ID '+uid.slice(0,8),()=>action(uid,'claim',first,'Wrong run',URL,OTHER_RUN));
 }
 for(const op of ['list','status','claim','update'])await denied('Third Google account rejected: '+op,()=>action(C,op,first,'Third account',URL));
 await denied('Missing Auth subject rejected',()=>action('', 'claim',first,'No session',URL));
 await denied('Email-only account rejected',()=>action(E,'claim',first,'Email account',URL));
 await denied('Unknown operation rejected',()=>action(A,'admin_reset',first));
 await denied('Anonymous direct test RPC rejected',()=>as('',`public.buyer_test_action('${RUN}','status',${lit(first)})`,'anon'));
 await denied('Service role cannot impersonate buyer test RPC',()=>as(A,`public.buyer_test_action('${RUN}','claim',${lit(first)},'Impersonation',${lit(URL)})`,'service_role'));
 await denied('Forged GUC cannot authorize a paused V2 table write',()=>q(`BEGIN; SET LOCAL rr_v2_test.allowed='true'; SET LOCAL rr_v2_test.run_id='${RUN}'; SET LOCAL rr_v2_test.card_code=${lit(first)}; UPDATE public.card SET business_name='Forged context' WHERE card_code=${lit(first)}; COMMIT;`));
 const beforeDirectWrite=await cardSnapshot(first);
 try{await q(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub"='${A}'; UPDATE public.card SET review_url=${lit(URL)} WHERE card_code=${lit(first)}; COMMIT;`);}catch(error){if(!isPolicyError(error))throw error;}
 check('Authenticated direct card write is blocked by RLS or privileges',beforeDirectWrite===await cardSnapshot(first));
 await denied('Visible service-role card update cannot bypass scope guard',()=>q(`BEGIN; SET LOCAL ROLE service_role; SET LOCAL "request.jwt.claim.sub"='${A}'; UPDATE public.card SET review_url=${lit(URL)} WHERE card_code=${lit(first)}; COMMIT;`));
 await denied('Direct private context forgery cannot create a trusted row',()=>as(A,"count(*) FROM rr_v2_test.context"));
 check('Denied operations left both synthetic cards unclaimed',await json(`SELECT NOT EXISTS(SELECT 1 FROM public.buyer_card_ownership WHERE card_code=ANY(ARRAY[${cards.map(lit).join(',')}])) AND (SELECT bool_and(v2_activated_at IS NULL AND review_url IS NULL) FROM public.card WHERE card_code=ANY(ARRAY[${cards.map(lit).join(',')}]))`));

 // Force a genuine overlapping claim: A commits after B has waited on A's row
 // lock, so passing this test requires PostgreSQL's concurrency protections.
 const claimExpr=(code,name)=>`public.buyer_test_action('${RUN}','claim',${lit(code)},${lit(name)},${lit(URL)})`;
 const holder=q(asSQL(A,claimExpr(first,'Atomic winner'),'authenticated',"SET LOCAL application_name='rr_restricted_claim_holder';").replace(' COMMIT;', ()=> ' DO $$ BEGIN PERFORM pg_sleep(2); END $$; COMMIT;'));
 holder.catch(()=>{});
 let held=false;
 for(let i=0;i<60;i++){
  held=await json("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='rr_restricted_claim_holder' AND wait_event='PgSleep')");
  if(held)break;
  await sleep(40);
 }
 check('Winning claim transaction holds a real PostgreSQL lock',held);
 const challenger=q(asSQL(B,claimExpr(first,'Atomic loser'),'authenticated',"SET LOCAL application_name='rr_restricted_claim_loser';"));
 challenger.catch(()=>{});
 let waited=false;
 for(let i=0;i<50;i++){
  waited=await json("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='rr_restricted_claim_loser' AND wait_event_type='Lock')");
  if(waited)break;
  await sleep(30);
 }
 const [won,lost]=(await Promise.all([holder,challenger])).map(parse);
 check('Concurrent claims produce exactly one winner after observed lock wait',waited&&won.success===true&&lost.success===false);
 check('Race produces one owner and one durable first-claim audit',await json(`SELECT (SELECT count(*)=1 AND bool_and(user_id='${A}') FROM public.buyer_card_ownership WHERE card_code=${lit(first)}) AND (SELECT count(*)=1 FROM public.buyer_ownership_audit WHERE card_code=${lit(first)}) AND (SELECT state='claimed' FROM public.buyer_card_inventory WHERE card_code=${lit(first)})`));
 const ownerSnapshot=await cardSnapshot(first);
 check('Winning owner retry succeeds idempotently',(await action(A,'claim',first,'Must not overwrite',URL)).success===true&&ownerSnapshot===await cardSnapshot(first));
 await denied('Second account cannot edit first owner card',()=>action(B,'update',first,'Unauthorized edit',URL));
 check('Owner can edit business and canonical review URL',(await action(A,'update',first,'Updated synthetic business',URL)).success===true);
 await denied('Malformed review URL remains rejected',()=>action(A,'update',first,'Bad destination','https://google.com/url?q=https://evil.example'));
 check('Second registered card can be claimed by B',(await action(B,'claim',second,'Second synthetic business',URL)).success===true);
 const listA=await action(A,'list'),listB=await action(B,'list');
 check('A list contains owned registry card only',listA.success===true&&listA.cards.length===1&&listA.cards[0].card_code===first&&!JSON.stringify(listA).includes(OUTSIDE));
 check('B list contains owned registry card only',listB.success===true&&listB.cards.length===1&&listB.cards[0].card_code===second&&!JSON.stringify(listB).includes(first));
 // RLS may deny SELECT entirely (stricter) or expose own rows only.
 let ownershipRead;
 try{ownershipRead=await as(B,`count(*)=0 FROM public.buyer_card_ownership WHERE card_code=${lit(first)}`);}catch(error){if(!isPolicyError(error))throw error;ownershipRead=true;}
 check('Ownership RLS or denied SELECT never exposes foreign rows',ownershipRead===true);
 await denied('Authenticated buyer cannot reset using service RPC',()=>as(A,`public.admin_test_reset('${RUN}',${lit(first)},${lit(first)},0,'forged-admin','Synthetic reset forbidden to buyers')`));

 if(testTransport){
  const transport=await testTransport({runId:RUN,cardCode:first,userA:A,userB:B,userC:C});
  for(const test of transport.results??[])check(test.name,test.passed);
  check('HTTP JWT evidence is explicitly synthetic, never claimed Google OAuth',transport.syntheticJwtOnly===true);
 }
 const revision=await json(`SELECT activation_revision FROM public.buyer_card_inventory WHERE card_code=${lit(first)}`);
 const beforeReset=await q(`SELECT md5(jsonb_build_array(to_jsonb(c),to_jsonb(o),to_jsonb(i))::text) FROM public.card c JOIN public.buyer_card_ownership o USING(card_code) JOIN public.buyer_card_inventory i USING(card_code) WHERE c.card_code=${lit(first)}`);
 for(const [label,confirmation,rev,actor,reason] of [
  ['wrong confirmation','WRONG',revision,'local-test-admin','Synthetic reset needs exact confirmation'],
  ['NULL confirmation',null,revision,'local-test-admin','Synthetic reset needs exact confirmation'],
  ['stale revision',first,revision+1,'local-test-admin','Synthetic reset uses stale revision'],
  ['NULL revision',first,null,'local-test-admin','Synthetic reset needs expected revision'],
  ['empty actor',first,revision,'','Synthetic reset needs an accountable actor'],
  ['NULL actor',first,revision,null,'Synthetic reset needs an accountable actor'],
  ['short reason',first,revision,'local-test-admin','short'],
  ['NULL reason',first,revision,'local-test-admin',null],
 ])check('Admin reset rejects '+label,await reset(first,confirmation,rev,actor,reason)===false);
 check('Invalid resets leave activation and ownership atomically unchanged',beforeReset===await q(`SELECT md5(jsonb_build_array(to_jsonb(c),to_jsonb(o),to_jsonb(i))::text) FROM public.card c JOIN public.buyer_card_ownership o USING(card_code) JOIN public.buyer_card_inventory i USING(card_code) WHERE c.card_code=${lit(first)}`));
 check('Admin cannot reset a card outside registry',await reset(OUTSIDE,OUTSIDE,0)===false);
 check('Admin cannot borrow another run',await reset(first,first,revision,'local-test-admin','Synthetic reset has a wrong run context',OTHER_RUN)===false);
 const identity=await q(`SELECT row(id,card_code,created_at)::text FROM public.card WHERE card_code=${lit(first)}`);
 const parallel=await Promise.all([reset(first,first,revision),reset(first,first,revision)]);
 check('Concurrent matching admin resets produce one successful reset',parallel.filter(Boolean).length===1);
 check('Reset preserves card identity and permanent URL code',identity===await q(`SELECT row(id,card_code,created_at)::text FROM public.card WHERE card_code=${lit(first)}`));
 check('Reset clears activation, releases owner, increments revision and keeps audit',await json(`SELECT (SELECT business_name IS NULL AND review_url IS NULL AND v2_activated_at IS NULL FROM public.card WHERE card_code=${lit(first)}) AND NOT EXISTS(SELECT 1 FROM public.buyer_card_ownership WHERE card_code=${lit(first)}) AND (SELECT state='ready' AND activation_revision=${revision+1} FROM public.buyer_card_inventory WHERE card_code=${lit(first)}) AND (SELECT count(*)=1 AND bool_and(old_owner='${A}' AND old_activated_at IS NOT NULL AND previous_revision=${revision} AND length(reason)>=20 AND actor='restricted-admin:local-test-admin') FROM public.buyer_activation_reset_audit WHERE card_code=${lit(first)})`));
 await denied('Former owner cannot edit immediately after reset',()=>action(A,'update',first,'Former owner',URL));
 check('B can claim card after authorized admin reset',(await action(B,'claim',first,'Reclaimed by B',URL)).success===true);
 await denied('Former owner cannot edit after B reclaims',()=>action(A,'update',first,'Former owner takeover',URL));
 check('Stale admin confirmation cannot reset a later activation',await reset(first,first,revision)===false);
 const auditBeforeClose=await json(`SELECT count(*) FROM public.buyer_activation_reset_audit WHERE card_code=ANY(ARRAY[${cards.map(lit).join(',')}])`);

 // Expiry must use wall-clock time, including transactions that started while
 // the run was valid and then waited on a card row beyond its deadline.
 await q(`UPDATE rr_v2_test.runs SET expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE run_id='${RUN}'`);
 const locked=q(`BEGIN; SET LOCAL application_name='rr_restricted_expiry_lock'; SELECT 1 FROM public.card WHERE card_code=${lit(first)} FOR UPDATE; DO $$ BEGIN PERFORM pg_sleep(3); END $$; COMMIT;`);
 locked.catch(()=>{});
 let expiryHeld=false;
 for(let i=0;i<40;i++){
  expiryHeld=await json("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='rr_restricted_expiry_lock' AND wait_event='PgSleep')");
  if(expiryHeld)break;
  await sleep(25);
 }
 check('Expiry test holds a real row lock while run is valid',expiryHeld);
 const blocked=q(asSQL(B,`public.buyer_test_action('${RUN}','update',${lit(first)},'Must expire while waiting',${lit(URL)})`,'authenticated',"SET LOCAL application_name='rr_restricted_expiry_waiter';"));
 blocked.catch(()=>{});
 let expiryWaited=false;
 for(let i=0;i<35;i++){
  expiryWaited=await json("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='rr_restricted_expiry_waiter' AND wait_event_type='Lock')");
  if(expiryWaited)break;
  await sleep(20);
 }
 await locked;
 check('Expiring operation was actually blocked before its deadline',expiryWaited);
 await denied('Expiry is rechecked after a lock wait in an already-started transaction',async()=>parse(await blocked));
 check('Rejected expired edit did not persist',await json(`SELECT business_name='Reclaimed by B' FROM public.card WHERE card_code=${lit(first)}`));
 for(const uid of [A,B])for(const op of ['list','status','claim','update'])await denied('Expired run rejects '+uid.slice(0,8)+' '+op,()=>action(uid,op,first,'Expired action',URL));
 const currentRevision=await json(`SELECT activation_revision FROM public.buyer_card_inventory WHERE card_code=${lit(first)}`);
 check('Expired run rejects service admin reset',await reset(first,first,currentRevision)===false);
 check('Expiry enforcement does not depend on cleanup having run',await json(`SELECT status='active' AND closed_at IS NULL AND expires_at<clock_timestamp() FROM rr_v2_test.runs WHERE run_id='${RUN}'`));
 await originalClosed('Original RPCs remain closed even after expiry');
 check('Expired run can be closed safely by operator',await json(`SELECT rr_v2_test.close_run('${RUN}')`));
 check('Close restores checkpoint 6 closed with matching fingerprint',(await runState()).state==='closed'&&await fingerprintMatches());
 check('Close retires registry and withdraws stock without deleting identity',await json(`SELECT (SELECT status='retired' AND closed_at IS NOT NULL FROM rr_v2_test.runs WHERE run_id='${RUN}') AND (SELECT count(*)=2 AND bool_and(retired) FROM rr_v2_test.cards WHERE run_id='${RUN}') AND (SELECT count(*)=2 AND bool_and(review_url IS NULL AND business_name IS NULL AND v2_activated_at IS NULL) FROM public.card WHERE card_code=ANY(ARRAY[${cards.map(lit).join(',')}])) AND (SELECT count(*)=2 AND bool_and(state='draft') FROM public.buyer_card_inventory WHERE card_code=ANY(ARRAY[${cards.map(lit).join(',')}])) AND NOT EXISTS(SELECT 1 FROM public.buyer_card_ownership WHERE card_code=ANY(ARRAY[${cards.map(lit).join(',')}]))`));
 check('Close retains previous reset audit and records both fixture cleanup resets',await json(`SELECT count(*)=${auditBeforeClose+2} AND count(*) FILTER(WHERE actor LIKE 'test-cleanup:%' AND old_owner='${B}')=2 FROM public.buyer_activation_reset_audit WHERE card_code=ANY(ARRAY[${cards.map(lit).join(',')}])`));
 check('Lifecycle and successful reset have durable private event audit',await json(`SELECT (SELECT count(*)=1 FROM rr_v2_test.events WHERE run_id='${RUN}' AND event='opened') AND (SELECT count(*)=1 FROM rr_v2_test.events WHERE run_id='${RUN}' AND event='closed') AND EXISTS(SELECT 1 FROM rr_v2_test.events WHERE run_id='${RUN}' AND event='admin_reset' AND card_code=${lit(first)} AND detail->>'success'='true')`));
 const auditAfterClose=await q(`SELECT md5(coalesce(jsonb_agg(to_jsonb(a) ORDER BY id)::text,'')) FROM public.buyer_activation_reset_audit a WHERE card_code=ANY(ARRAY[${cards.map(lit).join(',')}])`);
 check('Close is idempotent and does not change fingerprint',await json(`SELECT rr_v2_test.close_run('${RUN}')`)===true&&await fingerprintMatches());
 check('Idempotent close does not append or alter activation audit',auditAfterClose===await q(`SELECT md5(coalesce(jsonb_agg(to_jsonb(a) ORDER BY id)::text,'')) FROM public.buyer_activation_reset_audit a WHERE card_code=ANY(ARRAY[${cards.map(lit).join(',')}])`));
 await originalClosed('All original 11 RPC remain closed after cleanup');
 await denied('Retired buyer run cannot be used again',()=>action(B,'update',first,'Retired mutation',URL));
 await denied('Retired admin run cannot be used again',()=>reset(first,first,currentRevision));
 await denied('Retired run ID cannot be reopened',()=>json(`SELECT jsonb_agg(card_code) FROM rr_v2_test.open_run('${RUN}','${A}','${B}',30)`));

 // V1 smoke/regression runs on a new synthetic legacy fixture, never any row
 // supplied by a customer backup. The complete pre-existing legacy digest and
 // grants/definitions are checked separately below.
 await q(`INSERT INTO public.card(card_code) VALUES(${lit(LEGACY)}); INSERT INTO public.card_activation(card_code,activation_code_hash) VALUES(${lit(LEGACY)},encode(extensions.digest('synthetic-activation','sha256'),'hex'))`);
 check('Legacy V1 activation remains usable while V2 closed',await as('',`public.activate_review_card(${lit(LEGACY)},'synthetic-activation','Synthetic legacy',${lit(URL)},'synthetic-pin')`,'service_role')===true);
 const legacyNullBefore=await cardSnapshot(LEGACY);
 check('Legacy NULL PIN fix still rejects without mutation',await as('',`public.update_card_review_url(${lit(LEGACY)},NULL,${lit(URL)})`,'service_role')===false&&legacyNullBefore===await cardSnapshot(LEGACY));
 check('Legacy bcrypt PIN update remains usable while V2 closed',await as('',`public.update_card_review_url(${lit(LEGACY)},'synthetic-pin',${lit(URL)})`,'service_role')===true);
 for(let i=0;i<5;i++)await as('',`public.update_card_review_url(${lit(LEGACY)},'wrong-synthetic-pin',${lit(URL)})`,'service_role');
 check('Legacy five-failure 15-minute lock is preserved',await json(`SELECT attempts=5 AND locked_until>now()+interval '14 minutes' AND locked_until<=now()+interval '15 minutes' FROM public.card_pin_attempts WHERE card_code=${lit(LEGACY)}`));
 await q(`UPDATE public.card_pin_attempts SET locked_until=now()-interval '1 second' WHERE card_code=${lit(LEGACY)}`);
 await as('',`public.update_card_review_url(${lit(LEGACY)},'wrong-synthetic-pin',${lit(URL)})`,'service_role');
 check('Legacy expired cooldown restarts at one failure',await json(`SELECT attempts=1 AND locked_until IS NULL FROM public.card_pin_attempts WHERE card_code=${lit(LEGACY)}`));
 check('Legacy redirect view remains readable without login',await as('',`review_url=${lit(URL)} FROM public.card_public WHERE card_code=${lit(LEGACY)}`,'anon')===true);
 check('Every pre-existing V1 row, grant, RPC definition and RLS setting is unchanged',legacyBefore===await legacySnapshot());
 check('Legacy TRUNCATE grants were not widened',await json(`SELECT NOT EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role'])r CROSS JOIN unnest(ARRAY['public.card','public.card_activation','public.card_pin_attempts'])t WHERE has_table_privilege(r,t,'TRUNCATE'))`));
 check('Cleanup preserves the exact pre-existing rate quota and its time window',Boolean(quotaBefore)&&quotaBefore===await q(`SELECT to_jsonb(l)::text FROM public.buyer_claim_limits l WHERE user_id='${A}'`));
 check('Trusted context never leaks outside wrapper transaction',await json('SELECT count(*)=0 FROM rr_v2_test.context'));
 // Exercise emergency denial over a known synthetic grant drift, then roll the
 // entire scenario back so the harness finishes at the normal closed checkpoint.
 const beforeLockdown=await runState();
 const lockdown=await json(`BEGIN;
 GRANT EXECUTE ON FUNCTION public.buyer_test_action(uuid,text,text,text,text) TO anon;
 DO $$ BEGIN
  IF (SELECT fingerprint=rr_v2_test.fingerprint() FROM rr_v2_control.state WHERE id) THEN RAISE EXCEPTION 'Synthetic grant drift was not detected'; END IF;
  PERFORM rr_v2_test.lockdown();
 END $$;
 SELECT jsonb_build_object(
  'review_required',(SELECT state='review_required' AND stage=6 FROM rr_v2_control.state WHERE id),
  'fingerprint_preserved',(SELECT fingerprint=${lit(beforeLockdown.fingerprint)} FROM rr_v2_control.state WHERE id),
  'all_rpcs_closed',NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN unnest(ARRAY['anon','authenticated','service_role'])r WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%') AND has_function_privilege(r,p.oid,'EXECUTE'))
 ); ROLLBACK;`);
 check('Emergency lockdown closes direct RPC access and requires review',lockdown.review_required===true&&lockdown.all_rpcs_closed===true);
 check('Emergency lockdown preserves prior fingerprint instead of blessing drift',lockdown.fingerprint_preserved===true);
 check('Rollback-only lockdown test restores exact closed checkpoint',JSON.stringify(beforeLockdown)===JSON.stringify(await runState())&&await fingerprintMatches());
 // Probe effective permissions, including column ACLs and role inheritance.
 // The deliberate local grants and temporary role are transactionally removed.
 for(const scenario of [
  {name:'Explicit private column grant',setup:'GRANT SELECT(card_code) ON public.buyer_card_ownership TO authenticated;',effective:"has_column_privilege('authenticated','public.buyer_card_ownership','card_code','SELECT') AND NOT has_table_privilege('authenticated','public.buyer_card_ownership','SELECT')"},
  {name:'Inherited private table grant',setup:'CREATE ROLE rr_test_reader NOLOGIN; GRANT SELECT ON public.buyer_card_ownership TO rr_test_reader; GRANT rr_test_reader TO authenticated;',effective:"has_table_privilege('authenticated','public.buyer_card_ownership','SELECT') AND pg_has_role('authenticated','rr_test_reader','USAGE')"},
 ]){
  const beforeACL=await runState();
  const detected=await json(`BEGIN; ${scenario.setup}
  DO $$ DECLARE rejected boolean:=false; BEGIN
   IF NOT (${scenario.effective}) THEN RAISE EXCEPTION 'Synthetic effective ACL setup failed'; END IF;
   BEGIN PERFORM rr_v2_test.assert_acl(); EXCEPTION WHEN insufficient_privilege THEN rejected:=true; END;
   IF NOT rejected THEN RAISE EXCEPTION 'Synthetic private ACL drift was not rejected'; END IF;
  END $$;
  SELECT true; ROLLBACK;`);
  check(scenario.name+' is rejected with SQLSTATE 42501',detected===true);
  check(scenario.name+' rollback restores exact checkpoint and fingerprint',JSON.stringify(beforeACL)===JSON.stringify(await runState())&&await fingerprintMatches());
 }
 // Closed-state wrappers must have no application-role EXECUTE grants. Role
 // membership must not let a buyer acquire the service-only admin authority.
 // Every deliberate violation is rolled back, including cluster role grants.
 for(const scenario of [
  {name:'Admin wrapper granted to authenticated',setup:'GRANT EXECUTE ON FUNCTION public.admin_test_reset(uuid,text,text,bigint,text,text) TO authenticated;',effective:"has_function_privilege('authenticated','public.admin_test_reset(uuid,text,text,bigint,text,text)','EXECUTE')"},
  {name:'Buyer wrapper granted to anon',setup:'GRANT EXECUTE ON FUNCTION public.buyer_test_action(uuid,text,text,text,text) TO anon;',effective:"has_function_privilege('anon','public.buyer_test_action(uuid,text,text,text,text)','EXECUTE')"},
  {name:'Authenticated inherits service role',setup:'GRANT service_role TO authenticated; SET LOCAL ROLE postgres;',effective:"pg_has_role('authenticated','service_role','MEMBER')",asRoot:true},
 ]){
  const beforeACL=await runState();
  const query=`BEGIN; ${scenario.setup}
  DO $$ DECLARE rejected boolean:=false; BEGIN
   IF NOT (${scenario.effective}) THEN RAISE EXCEPTION 'Synthetic wrapper or role ACL setup failed'; END IF;
   BEGIN PERFORM rr_v2_test.assert_acl(); EXCEPTION WHEN insufficient_privilege THEN rejected:=true; END;
   IF NOT rejected THEN RAISE EXCEPTION 'Synthetic wrapper or role ACL drift was not rejected'; END IF;
  END $$;
  SELECT true; ROLLBACK;`;
  const detected=scenario.asRoot?parse(await sql(query,database,false)):await json(query);
  check(scenario.name+' is rejected with SQLSTATE 42501',detected===true);
  check(scenario.name+' rollback restores exact checkpoint and fingerprint',JSON.stringify(beforeACL)===JSON.stringify(await runState())&&await fingerprintMatches());
 }
 const report={status:'PASSED',tests:results.length,results,engine:'Real isolated PostgreSQL with concurrent sessions and row locks',syntheticFixturesOnly:true,productionConnected:false,realGoogleOAuthTested:false,syntheticJwtTransportTested:Boolean(testTransport),finalState:await runState()};
 if(base)fs.writeFileSync(path.join(base,'restricted-tests.json'),JSON.stringify(report,null,2));
 return report;
}
