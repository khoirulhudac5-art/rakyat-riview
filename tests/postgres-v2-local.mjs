// Called only by the isolated portable harness. No production URL/env is read.
import fs from 'node:fs';
import path from 'node:path';
import {runSQLFixtures} from './postgres-fixtures-local.mjs';
export async function runLocalV2Tests({sql,run,base,root,pinFix=false,ownershipAudit=false,inventoryGate=false,adminReset=false,rolesBackup=path.join(root,'.backups/v1-2026-11-05T09-33-17-216Z/roles.sql')}){
 const db='v1_app_auth',results=[],findings=[];
 const q=s=>sql(s,db),json=async s=>{const value=await q(s);return value==='t'?true:value==='f'?false:value===''?null:JSON.parse(value);};
 const check=(name,condition)=>{results.push({name,passed:Boolean(condition)});fs.writeFileSync(path.join(base,'v2-progress.json'),JSON.stringify(results,null,2));if(!condition)throw{reason:'SQL assertion failed: '+name};};
 const baseline=await json("SELECT json_build_object('card',md5(coalesce(jsonb_agg(to_jsonb(c) ORDER BY id)::text,'')),'legacy_count',count(*)) FROM public.card c");
 // Reproduce the relevant production postgres role properties/memberships,
 // without enabling LOGIN or adding a production credential to the local server.
 await sql('ALTER DATABASE v1_app_auth OWNER TO postgres');
 await q('ALTER ROLE postgres NOSUPERUSER INHERIT CREATEROLE CREATEDB REPLICATION BYPASSRLS NOLOGIN');
 const roleDump=fs.readFileSync(rolesBackup,'utf8');
 for(const line of roleDump.split(/\r?\n/)){const m=line.match(/^GRANT ([A-Za-z_]+) TO postgres\b/);if(m)await q('GRANT '+m[1]+' TO postgres');}
 const migrations=['20261105000100_buyer_accounts.sql','20261105000200_google_first_claim.sql','20261105000300_existing_public_visibility.sql'];
 for(const file of migrations){await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',db,'-c','SET ROLE postgres','-f',path.join(root,'supabase/migrations',file)]);results.push({name:'migration '+file,passed:true});}
 const after=await json("SELECT json_build_object('card',md5(coalesce(jsonb_agg(to_jsonb(c)-'claim_mode'-'v2_activated_at' ORDER BY id)::text,'')),'legacy_count',count(*),'all_legacy',bool_and(claim_mode='legacy' AND v2_activated_at IS NULL)) FROM public.card c");
 check('Existing card values unchanged; all existing cards remain legacy',baseline.card===after.card&&baseline.legacy_count===after.legacy_count&&after.all_legacy);
 const post=await run('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-d',db,'-f',path.join(root,'supabase/existing/postflight.sql')]);
 check('Postflight permissions and original legacy definitions',Object.values(JSON.parse(post.out.trim())).every(v=>v===true));
 if(pinFix){
  const acl=await q("SELECT row(proowner,proacl)::text FROM pg_proc WHERE oid='public.update_card_review_url(text,text,text)'::regprocedure");
  await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',db,'-c','SET ROLE postgres','-f',path.join(root,'supabase/migrations/20261105000400_fix_legacy_pin_cooldown.sql')]);
  check('Additional PIN migration preserves owner and EXECUTE grants',acl===await q("SELECT row(proowner,proacl)::text FROM pg_proc WHERE oid='public.update_card_review_url(text,text,text)'::regprocedure"));
  for(const test of ['update_card_review_url.sql','buyer_accounts.sql']){
   const result=await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',db,'-f',path.join(root,'supabase/tests',test)],true);
   if(result.code!==0){const error=result.err.match(/ERROR:\s+([^\r\n]+)/)?.[1]||'SQL error';throw{reason:'SQL regression '+test+': '+error.replace(/"[^"]*"|'[^']*'/g,'[redacted]').slice(0,180)};}check('SQL regression '+test,true);
  }
 }
 if(inventoryGate){
  await q(`INSERT INTO auth.users(id,email) VALUES ('f9999999-9999-4999-8999-999999999999','inventory-migration@example.test'); INSERT INTO public.card(card_code,claim_mode,v2_activated_at,review_url) VALUES ('${'M'.repeat(24)}','google_first_claim',now(),'https://search.google.com/local/writereview?placeid=ChITestFixtureOnly'),('${'D'.repeat(24)}','google_first_claim',NULL,NULL); INSERT INTO public.buyer_card_ownership(card_code,user_id) VALUES ('${'M'.repeat(24)}','f9999999-9999-4999-8999-999999999999');`);
  await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',db,'-c','SET ROLE postgres','-f',path.join(root,'supabase/migrations/20261105000500_one_time_inventory_claim.sql')]);
  check('Inventory migration preserves active V2 and leaves unclaimed stock draft',await json(`SELECT (SELECT state='claimed' AND claimed_at IS NOT NULL FROM public.buyer_card_inventory WHERE card_code='${'M'.repeat(24)}') AND (SELECT state='draft' FROM public.buyer_card_inventory WHERE card_code='${'D'.repeat(24)}') AND NOT EXISTS(SELECT 1 FROM public.buyer_card_inventory i JOIN public.card c USING(card_code) WHERE c.claim_mode='legacy')`));
 }
 if(adminReset){await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',db,'-c','SET ROLE postgres','-f',path.join(root,'supabase/migrations/20261105000600_auto_ready_admin_reset.sql')]);check('New decision releases pristine V2 drafts',await json(`SELECT state='ready' FROM public.buyer_card_inventory WHERE card_code='${'D'.repeat(24)}'`));}
 const A='f1111111-1111-4111-8111-111111111111',B='f2222222-2222-4222-8222-222222222222',C='f3333333-3333-4333-8333-333333333333',E='f4444444-4444-4444-8444-444444444444';
 await q(`INSERT INTO auth.users(id,email) VALUES ('${A}','local-a@example.test'),('${B}','local-b@example.test'),('${C}','local-c@example.test'),('${E}','local-email@example.test'); UPDATE auth.users SET raw_user_meta_data='{"provider":"google"}' WHERE id='${E}'; INSERT INTO auth.identities(user_id,provider_id,identity_data,provider) VALUES ('${A}','local-google-a','{"sub":"local-google-a"}','google'),('${B}','local-google-b','{"sub":"local-google-b"}','google'),('${C}','local-google-c','{"sub":"local-google-c"}','google');`);
 const as=async(uid,expr,role='authenticated')=>json(`BEGIN; SET LOCAL ROLE ${role}; SET LOCAL "request.jwt.claim.sub"='${uid}'; SELECT ${expr}; COMMIT;`);
 const cards=await json("BEGIN; SET LOCAL ROLE service_role; SELECT json_agg(card_code) FROM public.admin_create_v2_cards(12); COMMIT;");
 check('Service-role issuance creates unique 24-character IDs',cards.length===12&&new Set(cards).size===12&&cards.every(c=>/^[A-Za-z0-9_-]{24}$/.test(c)));
 const url='https://search.google.com/local/writereview?placeid=ChITestFixtureOnly';
 const claim=(code,name='Synthetic business')=>`public.buyer_first_claim('${code}','${name}','${url}')`;
 if(inventoryGate){
  if(adminReset){check('New admin cards are immediately ready',await json(`SELECT count(*)=12 AND bool_and(state='ready') FROM public.buyer_card_inventory WHERE card_code=ANY(ARRAY[${cards.map(c=>"'"+c+"'").join(',')}])`));check('Admin status includes readiness and reset revision',await as('',`(SELECT inventory_state='ready' AND activation_revision=0 AND NOT active FROM public.admin_list_v2_activation_cards() WHERE card_code='${cards[0]}')`,'service_role')===true);await as('',`public.admin_set_v2_card_ready('${cards[0]}',false,'test-only-withdrawal')`,'service_role');await q(`UPDATE public.buyer_card_inventory SET state='draft',ready_at=NULL WHERE card_code<>'${cards[0]}' AND card_code=ANY(ARRAY[${cards.map(c=>"'"+c+"'").join(',')}])`);}
  check('New issuance creates draft inventory',await json(`SELECT count(*)=12 AND bool_and(state='draft') FROM public.buyer_card_inventory WHERE card_code=ANY(ARRAY[${cards.map(c=>"'"+c+"'").join(',')}])`));
  check('Google user cannot claim draft stock',(await as(A,claim(cards[0]))).code==='not_ready');
  await q(`INSERT INTO public.card(card_code,claim_mode) VALUES ('${'Z'.repeat(24)}','google_first_claim')`);
  check('Missing inventory row cannot be claimed',(await as(A,claim('Z'.repeat(24)))).code==='not_ready');
  await q(`INSERT INTO public.card_activation(card_code,activation_code_hash) VALUES ('${cards[10]}',encode(extensions.digest('synthetic-activation','sha256'),'hex')); UPDATE public.card SET pin_hash=extensions.crypt('synthetic-pin',extensions.gen_salt('bf')) WHERE card_code='${cards[11]}'`);
  check('Legacy activation wrapper cannot bypass V2 inventory',await as(A,`public.buyer_activate_card('${cards[10]}','synthetic-activation','Bypass','${url}','synthetic-pin')`)===false);
  check('Legacy PIN wrapper cannot acquire V2 stock',await as(E,`public.buyer_claim_card('${cards[11]}','synthetic-pin')`)===false);
  await q(`DELETE FROM public.card_activation WHERE card_code='${cards[10]}'; UPDATE public.card SET pin_hash=NULL WHERE card_code='${cards[11]}'`);
  const draftStatus=await as('',`public.buyer_public_card_status('${cards[0]}')`,'anon');check('Public status cannot advertise draft stock as claimable',draftStatus.claim_allowed===false&&draftStatus.activation_reason==='inventory_not_ready');
  for(const [role,statement]of [['authenticated',`SELECT public.admin_set_v2_card_ready('${cards[0]}',true,'forged')`],['authenticated',`UPDATE public.buyer_card_inventory SET state='ready',ready_at=now() WHERE card_code='${cards[0]}'`],['anon','SELECT * FROM public.buyer_card_inventory LIMIT 0'],['authenticated','SELECT * FROM public.buyer_card_inventory LIMIT 0']]){const r=await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',db,'-c','SET ROLE '+role+'; '+statement],true);check('Inventory privilege denied '+role+' '+statement.split(' ')[0],r.code!==0&&/permission denied/.test(r.err));}
  check('Inventory service releases stock before sale',await as('',`(SELECT bool_and(public.admin_set_v2_card_ready(card_code,true,'local-inventory')) FROM public.buyer_card_inventory WHERE card_code=ANY(ARRAY[${cards.map(c=>"'"+c+"'").join(',')}]))`,'service_role')===true);
  check('Inventory can withdraw unclaimed stock',await as('',`public.admin_set_v2_card_ready('${cards[4]}',false,'local-inventory')`,'service_role')===true&&(await as(A,claim(cards[4]))).code==='not_ready');
  await as('',`public.admin_set_v2_card_ready('${cards[4]}',true,'local-inventory')`,'service_role');
 }
 check('No Google identity cannot claim',(await as(E,claim(cards[0]))).success===false);
 check('NULL business name rejected',(await as(A,`public.buyer_first_claim('${cards[0]}',NULL,'${url}')`)).success===false);
 const anonAttempt=await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',db,'-c',`SET ROLE anon; SELECT ${claim(cards[0])}`],true);
 check('Anonymous execute denied',anonAttempt.code!==0&&/permission denied/.test(anonAttempt.err));
 check('Unclaimed stock hidden from public enumeration',await as('',`(SELECT count(*) FROM public.card_public WHERE card_code='${cards[0]}')`,'anon')===0);
 check('Targeted public status recognizes hidden card',(await as('',`public.buyer_public_card_status('${cards[0]}')`,'anon')).claim_allowed===true);
 if(ownershipAudit){
  // These inputs are all public or attacker-selected. No purchase binding,
  // private activation credential or physical NFC proof is supplied.
  const qrViewer=await as(B,claim(cards[8],'Public QR viewer'));
  const laterBuyer=await as(A,claim(cards[8],'Intended physical buyer'));
  check('Audit reproduction: public code plus Google claims unowned card; later buyer rejected',qrViewer.success===true&&laterBuyer.success===false);
  findings.push({severity:'accepted product decision',code:'PUBLIC_QR_PLUS_GOOGLE_CAN_FIRST_CLAIM',note:'First authenticated Google claim wins as explicitly accepted by the project owner. Reclaim and cross-account edit protection remain required.'});
 }
 for(const statement of ['SELECT pin_hash FROM public.card LIMIT 0','SELECT * FROM public.buyer_card_ownership LIMIT 0']){
  const r=await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',db,'-c','SET ROLE anon; '+statement],true);check('Anon private column/table denied: '+statement.split(' FROM ')[1],r.code!==0&&/permission denied/.test(r.err));
 }
 // Force real overlap: hold the winning transaction after claim; observe the
 // competing transaction waiting for a PostgreSQL lock before releasing it.
 const holder=q(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub"='${A}'; SET LOCAL application_name='rr_v2_race_holder'; SELECT ${claim(cards[0],'Race winner')}; DO $$ BEGIN PERFORM pg_sleep(3); END $$; COMMIT;`);
 holder.catch(()=>{});
 for(let i=0;i<40;i++){if(await json("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='rr_v2_race_holder' AND wait_event='PgSleep')"))break;await new Promise(r=>setTimeout(r,50));}
 const loser=q(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub"='${B}'; SET LOCAL application_name='rr_v2_race_loser'; SELECT ${claim(cards[0],'Race loser')}; COMMIT;`);
 loser.catch(()=>{});
 let waited=false;for(let i=0;i<30;i++){waited=await json("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='rr_v2_race_loser' AND wait_event_type='Lock')");if(waited)break;await new Promise(r=>setTimeout(r,40));}
 const [win,lose]=await Promise.all([holder,loser]);check('Real competing sessions: lock wait, one winner and one loser',waited&&JSON.parse(win).success===true&&JSON.parse(lose).success===false);
 check('Single ownership and single audit entry',await json(`SELECT (SELECT count(*) FROM public.buyer_card_ownership WHERE card_code='${cards[0]}')=1 AND (SELECT count(*) FROM public.buyer_ownership_audit WHERE card_code='${cards[0]}')=1`));
 if(inventoryGate){check('Winning claim consumes readiness atomically',await json(`SELECT state='claimed' AND claimed_at IS NOT NULL FROM public.buyer_card_inventory WHERE card_code='${cards[0]}'`));check('Inventory cannot reopen a claimed card',await as('',`public.admin_set_v2_card_ready('${cards[0]}',true,'local-inventory')`,'service_role')===false);}
 check('Same-owner retry succeeds',(await as(A,claim(cards[0],'Attempt overwrite'))).success===true);
 check('Idempotent retry does not overwrite',await json(`SELECT business_name='Race winner' FROM public.card WHERE card_code='${cards[0]}'`));
 check('Other buyer cannot edit',await as(B,`public.buyer_update_card('${cards[0]}','Hijack','${url}')`)===false);
 check('Owner can edit',await as(A,`public.buyer_update_card('${cards[0]}','Updated synthetic','${url}')`)===true);
 if(inventoryGate)check('Permanent owner can repeatedly edit without reopening activation',await as(A,`public.buyer_update_card('${cards[0]}','Updated again','${url}')`)===true&&await json(`SELECT state='claimed' FROM public.buyer_card_inventory WHERE card_code='${cards[0]}'`));
 check('V2 edit rejects noncanonical Google redirect',await as(A,`public.buyer_update_card('${cards[0]}','Bad','https://google.com/url?q=https://evil.example')`)===false);
 check('New session retains ownership',(await as(A,'(SELECT json_agg(card_code) FROM public.buyer_list_cards())')).includes(cards[0]));
 check('Other buyer cannot list a card owned by another account',await as(B,`(SELECT count(*) FROM public.buyer_list_cards() WHERE card_code='${cards[0]}')`)===0);
 check('Ownership RLS hides foreign rows',await as(B,`(SELECT count(*) FROM public.buyer_card_ownership WHERE card_code='${cards[0]}')`)===0);
 check('Active card publicly exposes stored destination',await as('',`(SELECT review_url='${url}' FROM public.card_public WHERE card_code='${cards[0]}')`,'anon')===true);
 for(const [label,statement]of [['direct ownership update',`UPDATE public.buyer_card_ownership SET user_id='${B}' WHERE card_code='${cards[0]}'`],['audit read','SELECT * FROM public.buyer_ownership_audit'],['rate bucket read','SELECT * FROM public.buyer_claim_limits'],['admin recovery',`SELECT public.admin_recover_v2_owner('${cards[0]}','${B}','attacker','Unapproved recovery attempt')`]]){
   const r=await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',db,'-c','SET ROLE authenticated; '+statement],true);check('Buyer denied '+label,r.code!==0&&/permission denied/.test(r.err));
 }
 await q(`CREATE FUNCTION public.local_test_abort_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic rollback check'; END $$; CREATE TRIGGER local_test_abort BEFORE INSERT ON public.buyer_ownership_audit FOR EACH ROW WHEN (NEW.card_code='${cards[1]}') EXECUTE FUNCTION public.local_test_abort_audit();`);
 const aborted=await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',db,'-c',`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub"='${A}'; SELECT ${claim(cards[1])}; COMMIT;`],true);
 check('Audit insertion error rolls back owner and activation',aborted.code!==0&&await json(`SELECT NOT EXISTS(SELECT 1 FROM public.buyer_card_ownership WHERE card_code='${cards[1]}') AND (SELECT review_url IS NULL AND v2_activated_at IS NULL FROM public.card WHERE card_code='${cards[1]}')`));
 if(inventoryGate)check('Failed transaction does not consume inventory readiness',await json(`SELECT state='ready' AND claimed_at IS NULL FROM public.buyer_card_inventory WHERE card_code='${cards[1]}'`));
 await q('DROP TRIGGER local_test_abort ON public.buyer_ownership_audit; DROP FUNCTION public.local_test_abort_audit()');
 await as(C,`(SELECT json_agg(public.buyer_first_claim('zzzzzzzzzzzzzzzzzzzzzzzz','Synthetic','${url}')) FROM generate_series(1,20))`);
 check('Attempt 21 rate limited',(await as(C,claim(cards[2]))).code==='rate_limited');
 await q(`UPDATE public.buyer_claim_limits SET window_start=now()-interval '16 minutes' WHERE user_id='${C}'`);
 check('Expired claim window restarts at one',(await as(C,claim(cards[2]))).success===true&&await json(`SELECT attempts=1 FROM public.buyer_claim_limits WHERE user_id='${C}'`));
 check('Admin recovery succeeds with audit',await as('',`public.admin_recover_v2_owner('${cards[0]}','${B}','local-admin','Synthetic authorized recovery test')`,'service_role')===true&&await json(`SELECT count(*)=2 FROM public.buyer_ownership_audit WHERE card_code='${cards[0]}'`));
 check('Previous owner loses edit; new owner can edit',await as(A,`public.buyer_update_card('${cards[0]}','Old owner','${url}')`)===false&&await as(B,`public.buyer_update_card('${cards[0]}','New owner','${url}')`)===true);
 const recovery=q(`BEGIN; SET LOCAL ROLE service_role; SET LOCAL application_name='rr_v2_recovery_holder'; SELECT public.admin_recover_v2_owner('${cards[0]}','${A}','local-admin','Synthetic concurrent recovery check'); DO $$ BEGIN PERFORM pg_sleep(3); END $$; COMMIT;`);recovery.catch(()=>{});
 for(let i=0;i<40;i++){if(await json("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='rr_v2_recovery_holder' AND wait_event='PgSleep')"))break;await new Promise(r=>setTimeout(r,50));}
 const staleEdit=q(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub"='${B}'; SET LOCAL application_name='rr_v2_stale_edit'; SELECT public.buyer_update_card('${cards[0]}','Stale owner edit','${url}'); COMMIT;`);staleEdit.catch(()=>{});
 let editWaited=false;for(let i=0;i<30;i++){editWaited=await json("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='rr_v2_stale_edit' AND wait_event_type='Lock')");if(editWaited)break;await new Promise(r=>setTimeout(r,40));}
 const recoveryResult=await Promise.all([recovery,staleEdit]);check('Concurrent recovery blocks and then denies former-owner edit',editWaited&&recoveryResult[0]==='t'&&recoveryResult[1]==='f');
 // Synthetic legacy fixtures only; never mutate restored customer rows.
 await q(`INSERT INTO public.card(card_code) VALUES ('LEGACYabcdefghijklmnopqr'); INSERT INTO public.card_activation(card_code,activation_code_hash) VALUES ('LEGACYabcdefghijklmnopqr',encode(extensions.digest('synthetic-activation','sha256'),'hex'));`);
 check('Legacy activation and bcrypt verification still work',await as('',`public.activate_review_card('LEGACYabcdefghijklmnopqr','synthetic-activation','Legacy synthetic','${url}','synthetic-pin')`,'service_role')===true&&await as('',`public.update_card_review_url('LEGACYabcdefghijklmnopqr','synthetic-pin','${url}')`,'service_role')===true);
 check('First claim does not take legacy card',(await as(A,claim('LEGACYabcdefghijklmnopqr'))).success===false);
 check('PIN legacy claim rejects NULL',await as(A,"public.buyer_claim_card('LEGACYabcdefghijklmnopqr',NULL)")===false);
 for(let i=0;i<5;i++)await as(A,"public.buyer_claim_card('LEGACYabcdefghijklmnopqr','wrong-pin')");
 check('Five incorrect PIN claims lock for 15 minutes',await json("SELECT attempts=5 AND locked_until>now()+interval '14 minutes' FROM public.card_pin_attempts WHERE card_code='LEGACYabcdefghijklmnopqr'"));
 await q("UPDATE public.card_pin_attempts SET locked_until=now()-interval '1 second' WHERE card_code='LEGACYabcdefghijklmnopqr'");await as(A,"public.buyer_claim_card('LEGACYabcdefghijklmnopqr','wrong-pin')");
 check('Expired PIN lock restarts at one',await json("SELECT attempts=1 AND locked_until IS NULL FROM public.card_pin_attempts WHERE card_code='LEGACYabcdefghijklmnopqr'"));
 check('Correct legacy PIN links owner',await as(A,"public.buyer_claim_card('LEGACYabcdefghijklmnopqr','synthetic-pin')")===true);
 const stateBefore=await q("SELECT md5(row(c.review_url,c.pin_hash,p.attempts,p.locked_until)::text) FROM public.card c LEFT JOIN public.card_pin_attempts p USING(card_code) WHERE c.card_code='LEGACYabcdefghijklmnopqr'");
 const knownNull=await as('',`public.update_card_review_url('LEGACYabcdefghijklmnopqr',NULL,'${url}')`,'service_role');
 if(pinFix)check('Service-role NULL PIN rejected without changing URL/hash/attempt state',knownNull===false&&stateBefore===await q("SELECT md5(row(c.review_url,c.pin_hash,p.attempts,p.locked_until)::text) FROM public.card c LEFT JOIN public.card_pin_attempts p USING(card_code) WHERE c.card_code='LEGACYabcdefghijklmnopqr'"));
 if(knownNull===true)findings.push({severity:'existing legacy RPC issue',code:'LEGACY_NULL_PIN_ACCEPTED',note:'Confirmed on synthetic legacy card. Existing API validates PIN; service-role RPC itself remains vulnerable. Separate pre-existing fix not included in these three migrations.'});
 await q("UPDATE public.card_pin_attempts SET attempts=5,locked_until=now()-interval '1 second' WHERE card_code='LEGACYabcdefghijklmnopqr'");
 await as('',`public.update_card_review_url('LEGACYabcdefghijklmnopqr','wrong-pin','${url}')`,'service_role');
 if(pinFix){
  check('Legacy RPC cooldown expires into attempt one without lock',await json("SELECT attempts=1 AND locked_until IS NULL FROM public.card_pin_attempts WHERE card_code='LEGACYabcdefghijklmnopqr'"));
  for(let i=2;i<=5;i++)await as('',`public.update_card_review_url('LEGACYabcdefghijklmnopqr','wrong-pin','${url}')`,'service_role');
  check('Legacy RPC relocks only at fifth failure for fifteen minutes',await json("SELECT attempts=5 AND locked_until>now()+interval '14 minutes' AND locked_until<=now()+interval '15 minutes' FROM public.card_pin_attempts WHERE card_code='LEGACYabcdefghijklmnopqr'"));
  check('Correct PIN cannot bypass active lock',await as('',`public.update_card_review_url('LEGACYabcdefghijklmnopqr','synthetic-pin','${url}')`,'service_role')===false);
  await q("UPDATE public.card_pin_attempts SET locked_until=now()-interval '1 second' WHERE card_code='LEGACYabcdefghijklmnopqr'");
  check('Correct legacy bcrypt PIN succeeds after lock expires and resets counter',await as('',`public.update_card_review_url('LEGACYabcdefghijklmnopqr','synthetic-pin','${url}')`,'service_role')===true&&await json("SELECT attempts=0 AND locked_until IS NULL FROM public.card_pin_attempts WHERE card_code='LEGACYabcdefghijklmnopqr'"));
  const concurrentFailures=await Promise.all(Array.from({length:7},()=>as('',`public.update_card_review_url('LEGACYabcdefghijklmnopqr','wrong-pin','${url}')`,'service_role')));
  check('Concurrent wrong PIN calls cannot exceed five counted failures',concurrentFailures.every(v=>v===false)&&await json("SELECT attempts=5 AND locked_until>now() FROM public.card_pin_attempts WHERE card_code='LEGACYabcdefghijklmnopqr'"));
 }
 if(await json("SELECT attempts=1 AND locked_until>now() FROM public.card_pin_attempts WHERE card_code='LEGACYabcdefghijklmnopqr'"))findings.push({severity:'existing legacy RPC issue',code:'LEGACY_EXPIRED_PIN_LOCK_RELOCKS',note:'Old RPC immediately relocks after expired lock despite resetting count to one. Not caused by V2 migrations; separate existing PIN migration remains pending.'});
 if(pinFix){for(const file of await runSQLFixtures({sql,run,base,root}))check('Complete synthetic SQL suite '+file,true);}
 if(adminReset){
  const target=cards[0],reset=(confirmation,revision)=>`public.admin_reset_v2_activation('${target}','${confirmation}',${revision},'local-admin','Synthetic authorized activation reset')`;
  const revision=await json(`SELECT activation_revision FROM public.buyer_card_inventory WHERE card_code='${target}'`);
  for(const role of ['anon','authenticated']){const r=await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',db,'-c',`SET ROLE ${role}; SELECT ${reset(target,revision)}`],true);check('Reset denied to '+role,r.code!==0&&/permission denied/.test(r.err));}
  check('Reset requires matching typed confirmation',await as('',reset('WRONG',revision),'service_role')===false);
  check('Stale admin reset rejected',await as('',reset(target,revision+1),'service_role')===false);
  const preserved=await q(`SELECT row(id,card_code,created_at)::text FROM public.card WHERE card_code='${target}'`);
  await q(`CREATE FUNCTION public.local_abort_reset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic reset rollback'; END $$; CREATE TRIGGER local_abort_reset BEFORE INSERT ON public.buyer_activation_reset_audit FOR EACH ROW EXECUTE FUNCTION public.local_abort_reset();`);
  const failed=await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',db,'-c',`SET ROLE service_role; SELECT ${reset(target,revision)}`],true);
  check('Reset audit error rolls back ownership and activation',failed.code!==0&&await json(`SELECT EXISTS(SELECT 1 FROM public.buyer_card_ownership WHERE card_code='${target}') AND (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code='${target}')`));
  await q('DROP TRIGGER local_abort_reset ON public.buyer_activation_reset_audit; DROP FUNCTION public.local_abort_reset()');
  const parallelResets=await Promise.all([as('',reset(target,revision),'service_role'),as('',reset(target,revision),'service_role')]);check('Concurrent duplicate admin resets produce one successful atomic reset',parallelResets.filter(Boolean).length===1);
  check('Identity and permanent code survive reset',preserved===await q(`SELECT row(id,card_code,created_at)::text FROM public.card WHERE card_code='${target}'`));
  check('Reset removes owner/name/URL and reopens claim',await json(`SELECT business_name IS NULL AND review_url IS NULL AND v2_activated_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.buyer_card_ownership o WHERE o.card_code=c.card_code) FROM public.card c WHERE card_code='${target}'`)&&(await as('',`public.buyer_public_card_status('${target}')`,'anon')).claim_allowed===true);
  check('Previous owner cannot edit after reset',await as(A,`public.buyer_update_card('${target}','Old owner','${url}')`)===false);
  check('Reset has durable audit',await json(`SELECT count(*)=1 AND bool_and(old_owner='${A}'::uuid AND previous_revision=${revision}) FROM public.buyer_activation_reset_audit WHERE card_code='${target}'`));
  check('Reset audit service role is read-only outside definer RPC',await json("SELECT has_table_privilege('service_role','public.buyer_activation_reset_audit','SELECT') AND NOT has_table_privilege('service_role','public.buyer_activation_reset_audit','INSERT') AND NOT has_table_privilege('service_role','public.buyer_activation_reset_audit','UPDATE') AND NOT has_table_privilege('service_role','public.buyer_activation_reset_audit','DELETE')"));
  const privateAudit=await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',db,'-c','SET ROLE authenticated; SELECT * FROM public.buyer_activation_reset_audit LIMIT 0'],true);check('Buyer cannot read reset audit',privateAudit.code!==0&&/permission denied/.test(privateAudit.err));
  const race=await Promise.all([as(A,claim(target,'Reclaim A')),as(B,claim(target,'Reclaim B'))]);check('Post-reset two-account race still has exactly one winner',race.filter(r=>r.success).length===1);
  check('Old reset confirmation cannot reset new activation',await as('',reset(target,revision),'service_role')===false);
  check('V1 reset rejected',await as('',`public.admin_reset_v2_activation('LEGACYabcdefghijklmnopqr','LEGACYabcdefghijklmnopqr',0,'local-admin','Synthetic legacy reset must fail')`,'service_role')===false);
  // Reset starts first and holds the card lock; an old-owner edit must fail.
  const currentRev=await json(`SELECT activation_revision FROM public.buyer_card_inventory WHERE card_code='${target}'`),currentOwner=race[0].success?A:B;
  const held=q(`BEGIN; SET LOCAL ROLE service_role; SET LOCAL application_name='rr_reset_holder'; SELECT ${reset(target,currentRev)}; DO $$ BEGIN PERFORM pg_sleep(3); END $$; COMMIT;`);held.catch(()=>{});
  for(let i=0;i<40;i++){if(await json("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='rr_reset_holder' AND wait_event='PgSleep')"))break;await new Promise(r=>setTimeout(r,50));}
  const edit=as(currentOwner,`public.buyer_update_card('${target}','Stale during reset','${url}')`);edit.catch(()=>{});
  const results=await Promise.all([held,edit]);check('Concurrent reset prevents former owner editing',results[0]==='t'&&results[1]===false);
 }
 const out={status:'PASSED',inventoryGateApplied:inventoryGate,physicalOwnershipRequirementMet:ownershipAudit?false:null,pinFixApplied:pinFix,engine:'PostgreSQL 17.11, actual transactions and concurrent sessions',tests:results.length,results,findings,productionConnected:false,googleOAuthTested:false,roleContext:'Migrations executed as postgres NOSUPERUSER/BYPASSRLS with relevant inherited memberships; local provider-managed role projection still applies'};
 fs.writeFileSync(path.join(base,'v2-tests.json'),JSON.stringify(out,null,2));console.log(JSON.stringify({v2SQLTests:out.tests,status:out.status,findings:findings.map(f=>f.code)}));return out;
}
