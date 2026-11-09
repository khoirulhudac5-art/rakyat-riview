import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {runAdminDatabaseBrowser} from './postgres-admin-browser.mjs';
export async function runOperations({sql,run,root,base}){
 const db='v1_app_auth',checks=[];
 const q=async s=>{const r=await run('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-d',db,'-c',s],true);if(r.code!==0)throw {reason:'Operational SQL: '+(r.err.match(/ERROR:\s*([^\r\n]+)/)?.[1]||'local failure')};return r.out.trim();};
 const file=async f=>{const r=await run('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-d',db,'-c','SET ROLE postgres','-f',path.join(root,'supabase/existing',f)],true);if(r.code!==0)throw {reason:f+': '+(r.err.match(/ERROR:\s*([^\r\n]+)/)?.[1]||'SQL failure')};return r;};
 const check=(name,ok)=>{if(!ok)throw {reason:name};checks.push({name,passed:true});fs.writeFileSync(path.join(base,'operations-progress.json'),JSON.stringify(checks,null,2));};
 const post=JSON.parse((await file('postflight_six.sql')).out.trim());fs.writeFileSync(path.join(base,'postflight-six.json'),JSON.stringify(post,null,2));check('six-migration postflight',Object.values(post).every(v=>v===true));
 const denied=async statement=>{try{await q(statement);return false;}catch(e){if(!/permission denied|V2 writes paused/i.test(e.reason||''))throw e;return true;}};
 await file('harden_legacy_grants.sql');
 for(const role of ['anon','authenticated','service_role']){
  for(const table of ['card','card_activation','card_pin_attempts'])check(role+' cannot truncate '+table,await q(`SELECT NOT has_table_privilege('${role}','public.${table}','TRUNCATE')`)==='t');
 }
 check('anon cannot manipulate sequence',await q("SELECT NOT has_sequence_privilege('anon','public.card_id_seq','USAGE') AND NOT has_sequence_privilege('anon','public.card_id_seq','UPDATE')")==='t');
 check('service cannot reset shared sequence',await q("SELECT NOT has_sequence_privilege('service_role','public.card_id_seq','UPDATE')")==='t');
 check('application maintenance privileges removed',await q("SELECT NOT has_table_privilege('anon','public.card','MAINTAIN') AND NOT has_table_privilege('authenticated','public.card','MAINTAIN') AND NOT has_table_privilege('service_role','public.card','MAINTAIN')")==='t');
 check('legacy anon redirect view remains readable',Number(await q('BEGIN; SET LOCAL ROLE anon; SELECT count(*) FROM public.card_public; COMMIT;'))>0);
 const legacy="OPS-LEGACY",url='https://search.google.com/local/writereview?placeid=ChITestFixtureOnly';
 await q(`BEGIN; SET LOCAL ROLE service_role; INSERT INTO public.card(card_code) VALUES('${legacy}'); INSERT INTO public.card_activation(card_code,activation_code_hash) VALUES('${legacy}',encode(extensions.digest('ops-unique-synthetic-activation','sha256'),'hex')); COMMIT;`);
 check('service legacy activation after hardening',await q(`BEGIN; SET LOCAL ROLE service_role; SELECT public.activate_review_card('${legacy}','ops-unique-synthetic-activation','Ops legacy','${url}','synthetic-pin'); COMMIT;`)==='t');
 try{await runAdminDatabaseBrowser({q,base});}catch(e){throw {reason:'Admin browser: '+String(e.reason||e.message).split('\n')[0].slice(0,220)};}check('Admin browser to real local PostgreSQL',true);
 const code=JSON.parse(await q('SELECT json_agg(card_code) FROM public.admin_create_v2_cards(1)'))[0];
 await file('pause_v2_complete.sql');
 const signatures=['buyer_first_claim(text,text,text)','buyer_activate_card(text,text,text,text,text)','buyer_claim_card(text,text)','buyer_update_card(text,text,text)','admin_create_v2_cards(integer)','admin_recover_v2_owner(text,uuid,text,text)','admin_set_v2_card_ready(text,boolean,text)','admin_reset_v2_activation(text,text,bigint,text,text)'];
 for(const role of ['anon','authenticated','service_role'])for(const sig of signatures)check(role+' RPC paused '+sig,await q(`SELECT NOT has_function_privilege('${role}','public.${sig}','EXECUTE')`)==='t');
 for(const statement of [
 `UPDATE public.card SET business_name='blocked' WHERE card_code='${code}'`,
 `DELETE FROM public.card WHERE card_code='${code}'`,
 `INSERT INTO public.card(card_code,claim_mode) VALUES('PAUSEINSERT00000000000000','google_first_claim')`,
 `UPDATE public.card SET claim_mode='google_first_claim' WHERE card_code='${legacy}'`,
 `UPDATE public.buyer_card_inventory SET updated_by='blocked'`,
 `INSERT INTO public.card_activation(card_code,activation_code_hash) VALUES('${code}','synthetic')`,
 `INSERT INTO public.card_pin_attempts(card_code) VALUES('${code}')`,
 `DELETE FROM public.buyer_card_ownership`,
 `TRUNCATE public.card`])check('service direct write blocked: '+statement.split(' ').slice(0,3).join(' '),await denied('BEGIN; SET LOCAL ROLE service_role; '+statement+'; COMMIT;'));
 check('owner definer-style V2 update blocked',await denied(`BEGIN; SET LOCAL ROLE postgres; UPDATE public.card SET business_name='blocked' WHERE card_code='${code}'; COMMIT;`));
 check('legacy PIN update still works during pause',await q(`BEGIN; SET LOCAL ROLE service_role; SELECT public.update_card_review_url('${legacy}','synthetic-pin','${url}'); COMMIT;`)==='t');
 check('NULL legacy PIN still rejected during pause',await q(`BEGIN; SET LOCAL ROLE service_role; SELECT public.update_card_review_url('${legacy}',NULL,'${url}'); COMMIT;`)==='f');
 check('V2 read remains available',await q("SELECT has_function_privilege('authenticated','public.buyer_list_cards()','EXECUTE') AND has_function_privilege('anon','public.buyer_public_card_status(text)','EXECUTE')")==='t');
 check('V2 private tables have pause guard',await q("SELECT count(*)=5 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE tgname='v2_pause_write' AND c.relname LIKE 'buyer_%'")==='t');
 check('service cannot manipulate V2 audit sequences',await q("SELECT NOT has_sequence_privilege('service_role','public.buyer_ownership_audit_id_seq','UPDATE') AND NOT has_sequence_privilege('service_role','public.buyer_activation_reset_audit_id_seq','USAGE')")==='t');
 fs.writeFileSync(path.join(base,'operations-tests.json'),JSON.stringify({status:'PASSED',tests:checks.length,checks,productionConnected:false,googleJWT:false},null,2));
 return {status:'PASSED',tests:checks.length};
}
