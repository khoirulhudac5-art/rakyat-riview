// LOCAL SQL preparation only. Never opens a DB connection or reads credentials.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fingerprintSQL,files} from './v2-migration-control.mjs';
export function restrictedPackageSQL(){
 const base=fs.readFileSync('supabase/testing/restricted_access.sql','utf8');
 if(files.length!==6)throw Error('Exactly six approved source migrations required');
 const hashes=JSON.stringify(files.map(f=>createHash('sha256').update(fs.readFileSync('supabase/migrations/'+f)).digest('hex')));
 const privateFP=`SELECT md5(jsonb_build_object('public',(${fingerprintSQL}),
 'schema',(SELECT jsonb_agg(jsonb_build_array(nspname,nspowner,nspacl) ORDER BY nspname) FROM pg_namespace WHERE nspname IN ('rr_v2_test','rr_v2_control')),
 'tables',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('rr_v2_test','rr_v2_control')),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,pg_get_functiondef(p.oid),p.proowner,p.proacl) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('rr_v2_test','rr_v2_control')),
 'public_function_owners',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,p.proowner) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),
 'columns',(SELECT jsonb_agg(to_jsonb(c) ORDER BY table_schema,table_name,ordinal_position) FROM information_schema.columns c WHERE table_schema IN ('rr_v2_test','rr_v2_control')),
 'column_acl',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,a.attname,a.attacl) ORDER BY n.nspname,c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('rr_v2_test','rr_v2_control') AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.conname,pg_get_constraintdef(c.oid)) ORDER BY n.nspname,c.conname) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname IN ('rr_v2_test','rr_v2_control')),
 'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY n.nspname,c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('rr_v2_test','rr_v2_control') AND NOT t.tgisinternal),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname) FROM pg_policies p WHERE schemaname IN ('rr_v2_test','rr_v2_control')))::text)`;
 return `BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; SELECT pg_advisory_xact_lock(728401);
 DO $$ BEGIN IF to_regclass('rr_v2_test.runs') IS NOT NULL OR NOT EXISTS(SELECT 1 FROM rr_v2_control.state WHERE id AND stage=6 AND state='closed' AND hashes='${hashes}'::jsonb AND fingerprint=(${fingerprintSQL}))
 OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%'))<>11
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%') AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('service_role',p.oid,'EXECUTE')))
 THEN RAISE EXCEPTION 'Restricted package requires verified closed stage 6'; END IF; END $$;
 ${base}
 CREATE FUNCTION rr_v2_test.fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fp$ ${privateFP} $fp$;
 CREATE FUNCTION rr_v2_test.schema_fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$ SELECT rr_v2_test.fingerprint() $$;
 REVOKE ALL ON ALL FUNCTIONS IN SCHEMA rr_v2_test FROM PUBLIC,anon,authenticated,service_role;
 SELECT rr_v2_test.assert_acl();
 UPDATE rr_v2_control.state SET fingerprint=rr_v2_test.fingerprint() WHERE id;
 COMMIT;`;
}
