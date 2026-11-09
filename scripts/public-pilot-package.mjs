// Offline builder. Never reads credentials or connects to a database.
import fs from 'node:fs';
import path from 'node:path';
import {sha} from './admin-readonly-package.mjs';
export const pilotCard='iKRb7_7PyK6kg4Ye7EqvOhYu';
const body=fs.readFileSync('supabase/pilots/001_first_claim_pilot.sql','utf8');
export const pilotPackageID=sha(body+fs.readFileSync(new URL(import.meta.url)));
const q=s=>"'"+s.replaceAll("'","''")+"'";
const tx="BEGIN;SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='60s';SELECT pg_advisory_xact_lock(728401);SELECT rr_v2_test.verify_state('closed');";
const finish="UPDATE rr_v2_control.state SET fingerprint=rr_v2_test.fingerprint() WHERE id;SELECT rr_v2_test.verify_state('closed');COMMIT;";
export function pilotInstallSQL(expected){
 if(!/^[a-f0-9]{32}$/.test(expected))throw Error('Exact baseline fingerprint required');
 return `${tx}
 DO $$ BEGIN IF current_user<>'postgres' OR to_regnamespace('rr_claim_pilot') IS NOT NULL OR NOT EXISTS(SELECT 1 FROM rr_v2_control.state WHERE id AND stage=6 AND fingerprint=${q(expected)}) OR EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted) OR NOT EXISTS(SELECT 1 FROM public.card c JOIN public.buyer_card_inventory i USING(card_code) WHERE c.card_code='${pilotCard}' AND c.claim_mode='google_first_claim' AND c.pin_hash IS NULL AND c.review_url IS NULL AND c.v2_activated_at IS NULL AND i.state='ready') OR EXISTS(SELECT 1 FROM public.buyer_card_ownership WHERE card_code='${pilotCard}') OR EXISTS(SELECT 1 FROM rr_v2_test.cards WHERE card_code='${pilotCard}') THEN RAISE EXCEPTION 'Pilot baseline mismatch';END IF;END $$;
 CREATE SCHEMA rr_claim_pilot;REVOKE ALL ON SCHEMA rr_claim_pilot FROM PUBLIC,anon,authenticated,service_role;
 CREATE TABLE rr_claim_pilot.control(id boolean PRIMARY KEY CHECK(id),card_code text NOT NULL REFERENCES public.card(card_code) CHECK(card_code='${pilotCard}'),public_on boolean NOT NULL DEFAULT false,claim_on boolean NOT NULL DEFAULT false,owner_on boolean NOT NULL DEFAULT false,redirect_on boolean NOT NULL DEFAULT false,expires_at timestamptz,package_id text NOT NULL,previous_fingerprint text NOT NULL,previous_guard text NOT NULL,previous_assert text NOT NULL,previous_fp text NOT NULL,previous_policy text NOT NULL);
 INSERT INTO rr_claim_pilot.control(id,card_code,package_id,previous_fingerprint,previous_guard,previous_assert,previous_fp,previous_policy) SELECT true,'${pilotCard}',${q(pilotPackageID)},fingerprint,pg_get_functiondef('public.v2_pause_guard()'::regprocedure),pg_get_functiondef('rr_v2_test.assert_acl()'::regprocedure),pg_get_functiondef('rr_v2_test.fingerprint()'::regprocedure),(SELECT qual FROM pg_policies WHERE schemaname='public' AND tablename='card' AND policyname='public_card_read') FROM rr_v2_control.state WHERE id;
 ${body}
 DO $patch$ DECLARE c rr_claim_pilot.control%ROWTYPE;src text;BEGIN
 SELECT * INTO STRICT c FROM rr_claim_pilot.control WHERE id;
 SELECT prosrc INTO src FROM pg_proc WHERE oid='rr_v2_test.assert_acl()'::regprocedure;
 EXECUTE format('CREATE FUNCTION rr_claim_pilot.previous_acl() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='''' AS %L',src);
 SELECT prosrc INTO src FROM pg_proc WHERE oid='rr_v2_test.fingerprint()'::regprocedure;
 EXECUTE format('CREATE FUNCTION rr_claim_pilot.previous_fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='''' AS %L',src);
 IF (length(c.previous_guard)-length(replace(c.previous_guard,'BEGIN','')))/5<>1 THEN RAISE EXCEPTION 'Guard drift';END IF;
 EXECUTE replace(c.previous_guard,'BEGIN','BEGIN IF rr_claim_pilot.write_allowed(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP=''INSERT'' THEN NULL ELSE to_jsonb(OLD) END,CASE WHEN TG_OP=''DELETE'' THEN NULL ELSE to_jsonb(NEW) END) THEN IF TG_OP=''DELETE'' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;');
 EXECUTE 'ALTER POLICY public_card_read ON public.card USING (('||c.previous_policy||') AND card_code IS DISTINCT FROM ''${pilotCard}'')';
 END $patch$;
 CREATE OR REPLACE FUNCTION rr_v2_test.assert_acl() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN PERFORM rr_claim_pilot.previous_acl();PERFORM rr_claim_pilot.assert_acl();END $$;
 CREATE OR REPLACE FUNCTION rr_v2_test.fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$ SELECT md5(jsonb_build_object('base',rr_claim_pilot.previous_fingerprint(),
 'schema',(SELECT jsonb_build_array(nspowner,nspacl) FROM pg_namespace WHERE nspname='rr_claim_pilot'),
 'control',(SELECT to_jsonb(c) FROM rr_claim_pilot.control c WHERE id),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl,p.proowner) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='rr_claim_pilot'),
 'relations',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.reloptions) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rr_claim_pilot'),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid)) ORDER BY conname) FROM pg_constraint WHERE connamespace='rr_claim_pilot'::regnamespace),
 'columns',(SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,ordinal_position) FROM information_schema.columns c WHERE table_schema='rr_claim_pilot'),
 'column_acl',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,a.attacl) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rr_claim_pilot' AND a.attnum>0 AND NOT a.attisdropped))::text) $$;
 DO $$ DECLARE r record;BEGIN FOR r IN SELECT c.oid::regclass rel FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rr_claim_pilot' AND c.relkind='r' LOOP EXECUTE 'ALTER TABLE '||r.rel||' ENABLE ROW LEVEL SECURITY';END LOOP;END $$;
 REVOKE ALL ON ALL TABLES IN SCHEMA rr_claim_pilot FROM PUBLIC,anon,authenticated,service_role;
 REVOKE ALL ON ALL SEQUENCES IN SCHEMA rr_claim_pilot FROM PUBLIC,anon,authenticated,service_role;
 REVOKE ALL ON ALL FUNCTIONS IN SCHEMA rr_claim_pilot FROM PUBLIC,anon,authenticated,service_role;
 ${finish}`;
}
// A separate approval is required to execute this on any external database.
export function pilotAccessSQL(mode='pause-all'){
 if(!['enable','close-claim','pause-all'].includes(mode))throw Error('Unknown access transition');
 return `${tx}DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM rr_claim_pilot.control WHERE id AND package_id=${q(pilotPackageID)}) THEN RAISE EXCEPTION 'Package mismatch';END IF;END $$;
 ${mode==='enable'?`UPDATE rr_claim_pilot.control SET public_on=true,claim_on=true,owner_on=true,redirect_on=true,expires_at=clock_timestamp()+interval '30 minutes' WHERE id;
 GRANT EXECUTE ON FUNCTION public.buyer_pilot_public_status(text) TO anon,authenticated;
 GRANT EXECUTE ON FUNCTION public.buyer_pilot_first_claim(text,text,text),public.buyer_pilot_list_cards() TO authenticated;
 GRANT EXECUTE ON FUNCTION public.buyer_pilot_redirect_target(text) TO service_role;`:mode==='close-claim'?`UPDATE rr_claim_pilot.control SET claim_on=false WHERE id;REVOKE ALL ON FUNCTION public.buyer_pilot_first_claim(text,text,text) FROM PUBLIC,anon,authenticated,service_role;`:`UPDATE rr_claim_pilot.control SET public_on=false,claim_on=false,owner_on=false,redirect_on=false WHERE id;REVOKE ALL ON FUNCTION public.buyer_pilot_public_status(text),public.buyer_pilot_first_claim(text,text,text),public.buyer_pilot_list_cards(),public.buyer_pilot_redirect_target(text) FROM PUBLIC,anon,authenticated,service_role;`}
 ${finish}`;
}
export function pilotRollbackSQL(){return `${tx}DO $undo$ DECLARE c rr_claim_pilot.control%ROWTYPE;BEGIN
 SELECT * INTO STRICT c FROM rr_claim_pilot.control WHERE id AND package_id=${q(pilotPackageID)};
 IF EXISTS(SELECT 1 FROM rr_claim_pilot.attempts) OR EXISTS(SELECT 1 FROM rr_claim_pilot.context) OR EXISTS(SELECT 1 FROM public.buyer_card_ownership WHERE card_code=c.card_code) THEN RAISE EXCEPTION 'Committed attempts: pause only, preserve ownership and privacy';END IF;
 EXECUTE c.previous_assert;EXECUTE c.previous_fp;EXECUTE c.previous_guard;EXECUTE 'ALTER POLICY public_card_read ON public.card USING ('||c.previous_policy||')';
 DROP FUNCTION public.buyer_pilot_public_status(text),public.buyer_pilot_first_claim(text,text,text),public.buyer_pilot_list_cards(),public.buyer_pilot_redirect_target(text);
 DROP FUNCTION rr_claim_pilot.previous_acl(),rr_claim_pilot.previous_fingerprint(),rr_claim_pilot.assert_acl(),rr_claim_pilot.admit(text,text,boolean),rr_claim_pilot.write_allowed(text,text,jsonb,jsonb);
 DROP TABLE rr_claim_pilot.context,rr_claim_pilot.attempts,rr_claim_pilot.control;DROP SCHEMA rr_claim_pilot;
 IF rr_v2_test.fingerprint()<>c.previous_fingerprint THEN RAISE EXCEPTION 'Rollback fingerprint mismatch';END IF;
 UPDATE rr_v2_control.state SET fingerprint=c.previous_fingerprint WHERE id;PERFORM rr_v2_test.verify_state('closed');END $undo$;COMMIT;`;}
export function writePilotPackage(folder,expected){
 fs.mkdirSync(folder,{recursive:true});
 const sql={'install-closed.sql':pilotInstallSQL(expected),'enable-separate-approval.sql':pilotAccessSQL('enable'),'close-claim.sql':pilotAccessSQL('close-claim'),'emergency-pause.sql':pilotAccessSQL(),'rollback-empty-only.sql':pilotRollbackSQL(),
 'preflight.sql':`BEGIN READ ONLY;DO $$ BEGIN IF current_setting('transaction_read_only')<>'on' OR NOT EXISTS(SELECT 1 FROM rr_v2_control.state WHERE id AND stage=6 AND state='closed' AND fingerprint=${q(expected)}) OR to_regnamespace('rr_claim_pilot') IS NOT NULL OR EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted) THEN RAISE EXCEPTION 'Read-only preflight failed';END IF;END $$;SELECT rr_v2_test.verify_state('closed');ROLLBACK;`,
 'postflight.sql':`BEGIN READ ONLY;SHOW transaction_read_only;SELECT rr_v2_test.verify_state('closed');SELECT rr_claim_pilot.assert_acl();SELECT stage,state,fingerprint FROM rr_v2_control.state;SELECT card_code,public_on,claim_on,owner_on,redirect_on,expires_at FROM rr_claim_pilot.control;ROLLBACK;`};
 const files=Object.entries(sql).map(([file,s])=>{fs.writeFileSync(path.join(folder,file),s);return {file,sha256:sha(s)};});
 const manifest={scope:'LOCAL_ONLY_PENDING_PRODUCTION_APPROVAL',package_id:pilotPackageID,expected_fingerprint:expected,card:pilotCard,files};fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(manifest,null,2));return manifest;
}
