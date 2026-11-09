// Offline SQL package builder only. Does not load credentials or open connections.
import fs from 'node:fs';import path from 'node:path';import {sha} from './admin-readonly-package.mjs';
const body=fs.readFileSync('supabase/admin-generate/001_batch.sql','utf8');
const lit=s=>"'"+s.replaceAll("'","''")+"'";
export const generatePackageID=sha(body+fs.readFileSync(new URL(import.meta.url)));
const tx="BEGIN;SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='60s';SELECT pg_advisory_xact_lock(728401);";
const closed=`SELECT rr_v2_test.verify_state('closed');DO $$ BEGIN IF current_user<>'postgres' OR EXISTS(SELECT 1 FROM rr_v2_test.runs WHERE status IN ('active','provisioning')) OR EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted) THEN RAISE EXCEPTION 'Generate control preflight failed';END IF;END $$;`;
export function generateInstallSQL(expected){
 if(!/^[0-9a-f]{32}$/.test(expected))throw Error('Expected closed fingerprint required');
 return `${tx}${closed}
 DO $$ BEGIN IF to_regnamespace('rr_v2_generate') IS NOT NULL OR NOT EXISTS(SELECT 1 FROM rr_v2_control.state WHERE id AND stage=6 AND fingerprint=${lit(expected)}) OR NOT EXISTS(SELECT 1 FROM rr_v2_control.admin_read_checkpoint WHERE id AND read_enabled) THEN RAISE EXCEPTION 'Generate baseline mismatch';END IF;END $$;
 CREATE SCHEMA rr_v2_generate;REVOKE ALL ON SCHEMA rr_v2_generate FROM PUBLIC,anon,authenticated,service_role;
 CREATE TABLE rr_v2_generate.control(id boolean PRIMARY KEY CHECK(id),enabled boolean NOT NULL,package_id text NOT NULL,previous_fingerprint text NOT NULL,previous_guard text NOT NULL,previous_assert text NOT NULL,previous_fp text NOT NULL,previous_audit text NOT NULL,previous_audit_fn text NOT NULL);
 INSERT INTO rr_v2_generate.control SELECT true,false,${lit(generatePackageID)},fingerprint,pg_get_functiondef('public.v2_pause_guard()'::regprocedure),pg_get_functiondef('rr_v2_test.assert_acl()'::regprocedure),pg_get_functiondef('rr_v2_test.fingerprint()'::regprocedure),pg_get_viewdef('rr_v2_control.admin_read_audit'::regclass,true),pg_get_functiondef('public.admin_read_v2_audit(integer,text)'::regprocedure) FROM rr_v2_control.state WHERE id;
 ${body}
 DO $patch$ DECLARE c rr_v2_generate.control%ROWTYPE;src text;BEGIN
 SELECT * INTO STRICT c FROM rr_v2_generate.control WHERE id;
 SELECT prosrc INTO src FROM pg_proc WHERE oid='rr_v2_test.assert_acl()'::regprocedure;
 EXECUTE format('CREATE FUNCTION rr_v2_generate.previous_acl() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='''' AS %L',src);
 SELECT prosrc INTO src FROM pg_proc WHERE oid='rr_v2_test.fingerprint()'::regprocedure;
 EXECUTE format('CREATE FUNCTION rr_v2_generate.previous_fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='''' AS %L',src);
 IF (length(c.previous_guard)-length(replace(c.previous_guard,'BEGIN','')))/5<>1 THEN RAISE EXCEPTION 'Guard body drift';END IF;
 EXECUTE replace(c.previous_guard,'BEGIN','BEGIN IF TG_OP=''INSERT'' THEN IF rr_v2_generate.write_allowed(TG_TABLE_NAME,TG_OP,to_jsonb(NEW)) THEN RETURN NEW;END IF;END IF;');
 EXECUTE 'CREATE VIEW rr_v2_generate.previous_audit WITH(security_barrier=true) AS '||c.previous_audit;
 EXECUTE replace(c.previous_audit_fn,'ownership|reset','ownership|reset|generate');
 END $patch$;
 CREATE OR REPLACE VIEW rr_v2_control.admin_read_audit WITH(security_barrier=true) AS
 SELECT * FROM rr_v2_generate.previous_audit UNION ALL
 SELECT 'generate:'||g.id::text,b.created_at,'create'::text,g.card_code,b.actor,'batch:'||b.request_id::text,NULL::uuid,NULL::uuid FROM rr_v2_generate.cards g JOIN rr_v2_generate.batches b USING(request_id) WHERE b.complete;
 CREATE OR REPLACE FUNCTION rr_v2_test.assert_acl() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN PERFORM rr_v2_generate.previous_acl();PERFORM rr_v2_generate.assert_acl();END $$;
 CREATE OR REPLACE FUNCTION rr_v2_test.fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT md5(jsonb_build_object('base',rr_v2_generate.previous_fingerprint(),
 'schema',(SELECT jsonb_build_array(nspowner,nspacl) FROM pg_namespace WHERE nspname='rr_v2_generate'),
 'control',(SELECT to_jsonb(c) FROM rr_v2_generate.control c WHERE id),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl,p.proowner) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='rr_v2_generate'),
 'relations',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.reloptions) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rr_v2_generate'),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid)) ORDER BY conname) FROM pg_constraint WHERE connamespace='rr_v2_generate'::regnamespace),
 'columns',(SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,ordinal_position) FROM information_schema.columns c WHERE table_schema='rr_v2_generate'),
 'column_acl',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,a.attacl) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rr_v2_generate' AND a.attnum>0 AND NOT a.attisdropped),
 'audit',pg_get_viewdef('rr_v2_generate.previous_audit'::regclass,true))::text) $$;
 DO $$ DECLARE r record;BEGIN FOR r IN SELECT c.oid::regclass rel FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rr_v2_generate' AND c.relkind='r' LOOP EXECUTE 'ALTER TABLE '||r.rel||' ENABLE ROW LEVEL SECURITY';END LOOP;END $$;
 REVOKE ALL ON ALL TABLES IN SCHEMA rr_v2_generate FROM PUBLIC,anon,authenticated,service_role;
 REVOKE ALL ON ALL SEQUENCES IN SCHEMA rr_v2_generate FROM PUBLIC,anon,authenticated,service_role;
 REVOKE ALL ON ALL FUNCTIONS IN SCHEMA rr_v2_generate FROM PUBLIC,anon,authenticated,service_role;
 UPDATE rr_v2_control.state SET fingerprint=rr_v2_test.fingerprint() WHERE id;
 SELECT rr_v2_test.verify_state('closed');COMMIT;`;
}
export function generationAccessSQL(enabled){return `${tx}${closed}
 UPDATE rr_v2_generate.control SET enabled=${enabled?'true':'false'} WHERE id AND package_id=${lit(generatePackageID)};
 ${enabled?'GRANT EXECUTE':'REVOKE ALL'} ON FUNCTION public.admin_generate_v2_batch(uuid,integer,text) ${enabled?'TO':'FROM'} service_role;
 UPDATE rr_v2_control.state SET fingerprint=rr_v2_test.fingerprint() WHERE id;
 SELECT rr_v2_test.verify_state('closed');COMMIT;`;}
export function generateRollbackSQL(){return `${tx}${closed}
 DO $undo$ DECLARE c rr_v2_generate.control%ROWTYPE;BEGIN
 SELECT * INTO STRICT c FROM rr_v2_generate.control WHERE id AND package_id=${lit(generatePackageID)};
 IF EXISTS(SELECT 1 FROM rr_v2_generate.batches) OR EXISTS(SELECT 1 FROM rr_v2_generate.context) THEN RAISE EXCEPTION 'Committed batches exist: pause only; preserve cards and audit';END IF;
 EXECUTE c.previous_assert;EXECUTE c.previous_fp;EXECUTE c.previous_guard;EXECUTE c.previous_audit_fn;
 EXECUTE 'CREATE OR REPLACE VIEW rr_v2_control.admin_read_audit WITH(security_barrier=true) AS '||c.previous_audit;
 DROP FUNCTION public.admin_generate_v2_batch(uuid,integer,text);
 DROP VIEW rr_v2_generate.previous_audit;
 DROP FUNCTION rr_v2_generate.previous_acl();DROP FUNCTION rr_v2_generate.previous_fingerprint();DROP FUNCTION rr_v2_generate.assert_acl();DROP FUNCTION rr_v2_generate.write_allowed(text,text,jsonb);DROP FUNCTION rr_v2_generate.next_code();
 DROP TABLE rr_v2_generate.context;DROP TABLE rr_v2_generate.cards;DROP TABLE rr_v2_generate.batches;DROP TABLE rr_v2_generate.control;DROP SCHEMA rr_v2_generate;
 IF rr_v2_test.fingerprint()<>c.previous_fingerprint THEN RAISE EXCEPTION 'Rollback baseline mismatch';END IF;
 UPDATE rr_v2_control.state SET fingerprint=c.previous_fingerprint WHERE id;PERFORM rr_v2_test.verify_state('closed');END $undo$;COMMIT;`;}
export const generateInventorySQL=`SELECT jsonb_build_object('stage',s.stage,'state',s.state,'fingerprint',s.fingerprint,'match',s.fingerprint=rr_v2_test.fingerprint(),'enabled',(SELECT enabled FROM rr_v2_generate.control WHERE id),'business_closed',NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%') AND p.proname NOT IN ('admin_read_v2_inventory','admin_read_v2_audit','admin_generate_v2_batch') AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('service_role',p.oid,'EXECUTE')))) FROM rr_v2_control.state s WHERE id`;
export function writeGeneratePackage(folder,expected){
 fs.mkdirSync(folder,{recursive:true});const sql={
 'install.sql':generateInstallSQL(expected),'pause.sql':generationAccessSQL(false),
 'enable-after-separate-approval.sql':generationAccessSQL(true),'rollback-empty-only.sql':generateRollbackSQL(),
 'preflight.sql':`BEGIN READ ONLY;SHOW transaction_read_only;${closed} DO $$ BEGIN IF current_setting('transaction_read_only')<>'on' OR NOT EXISTS(SELECT 1 FROM rr_v2_control.state WHERE id AND fingerprint=${lit(expected)}) THEN RAISE EXCEPTION 'Preflight mismatch';END IF;END $$;ROLLBACK;`,
 'postflight.sql':`BEGIN READ ONLY;SHOW transaction_read_only;SELECT rr_v2_test.verify_state('closed');SELECT rr_v2_generate.assert_acl();${generateInventorySQL};ROLLBACK;`};
 const files=Object.entries(sql).map(([file,text])=>{fs.writeFileSync(path.join(folder,file),text);return {file,sha256:sha(text)};});
 const sources=['supabase/admin-generate/001_batch.sql','scripts/admin-generate-package.mjs','lib/admin-generate.mjs','scripts/admin-readonly-server.mjs','assets/admin-v2.js','scripts/test-admin-generate-local.mjs','tests/admin-generate.test.mjs'].map(file=>({file,sha256:sha(fs.readFileSync(file))}));
 const m={package_id:generatePackageID,project_ref:'svuagnobufhfpgzmsyxx',expected_checkpoint:6,expected_state:'closed',expected_fingerprint:expected,scope:'LOCAL_ONLY_NOT_APPROVED_FOR_PRODUCTION',default_enabled:false,files,sources};fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(m,null,2));return m;
}
