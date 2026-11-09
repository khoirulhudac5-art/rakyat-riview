// Offline package builder. No DB connection, .env, credential or source migration changes.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {restrictedPackageSQL} from './prepare-restricted-local.mjs';
import {files as migrations} from './v2-migration-control.mjs';
export const sha=b=>createHash('sha256').update(b).digest('hex');
const lit=s=>"'"+String(s).replaceAll("'","''")+"'";
const baseline=restrictedPackageSQL();
const assertBody=baseline.match(/CREATE FUNCTION rr_v2_test\.assert_acl\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/)?.[1];
const fpBody=baseline.match(/CREATE FUNCTION rr_v2_test\.fingerprint\(\)[\s\S]*?AS \$fp\$([\s\S]*?)\$fp\$/)?.[1];
if(!assertBody||!fpBody)throw Error('Closed baseline source cannot be identified');
const body=fs.readFileSync('supabase/admin-readonly/001_read_contract.sql','utf8');
export const packageId=sha(body+assertBody+fpBody+fs.readFileSync(new URL(import.meta.url))+'admin-readonly-v1');
const begin=`BEGIN;SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='30s';SELECT pg_advisory_xact_lock(728401);`;
export const protectedSQL=`SELECT md5(jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.reloptions) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','v','S')),
 'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,a.attacl) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p WHERE schemaname='public'),
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl,p.proowner) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND p.proname NOT IN ('admin_read_v2_inventory','admin_read_v2_audit')),
 'views',(SELECT jsonb_agg(jsonb_build_array(c.relname,pg_get_viewdef(c.oid,true)) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='v'))::text)`;
const verify=`DO $v$ BEGIN
 IF current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM rr_v2_control.state WHERE id AND stage=6 AND state='closed' AND fingerprint=rr_v2_test.fingerprint() AND fingerprint=current_setting('rr_admin_read.expected_fingerprint',true))
 OR EXISTS(SELECT 1 FROM rr_v2_test.runs WHERE status IN ('active','provisioning')) OR EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted)
 THEN RAISE EXCEPTION 'Read package preflight mismatch; stop without retry'; END IF;
 PERFORM rr_v2_test.assert_acl();END $v$;`;
const helper=`CREATE FUNCTION rr_v2_control.assert_admin_read_acl() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $acl$
DECLARE app text;r record;enabled boolean;
BEGIN
 SELECT read_enabled INTO STRICT enabled FROM rr_v2_control.admin_read_checkpoint WHERE id AND package_id=${lit(packageId)};
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rr_admin_read_definer' AND NOT(rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
 OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE (g.rolname='rr_admin_read_definer' AND u.rolname<>'postgres') OR u.rolname='rr_admin_read_definer')
 OR has_schema_privilege('rr_admin_read_definer','public','CREATE') THEN RAISE EXCEPTION 'Read definer privileges mismatch';END IF;
 FOREACH app IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF pg_has_role(app,'rr_admin_read_definer','MEMBER') THEN RAISE EXCEPTION 'Unsafe definer membership';END IF;
  FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('admin_read_v2_inventory','admin_read_v2_audit') LOOP
   IF has_function_privilege(app,r.oid,'EXECUTE') IS DISTINCT FROM (app='service_role' AND enabled) THEN RAISE EXCEPTION 'Read RPC permission mismatch';END IF;
  END LOOP;
  IF has_schema_privilege(app,'rr_v2_control','USAGE') THEN RAISE EXCEPTION 'Private read schema exposed';END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('admin_read_v2_inventory','admin_read_v2_audit') AND p.provolatile='s' AND p.prosecdef AND pg_get_userbyid(p.proowner)='rr_admin_read_definer' AND p.proconfig @> ARRAY['search_path=""'])<>2 THEN RAISE EXCEPTION 'Read function definition mismatch';END IF;
 FOR r IN SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN ('public','auth','rr_v2_test','rr_v2_control') LOOP
  IF has_table_privilege('rr_admin_read_definer',r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege('rr_admin_read_definer',r.oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Read definer has base table access';END IF;
 END LOOP;
 FOR r IN SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','v') AND n.nspname IN ('public','auth','rr_v2_test','rr_v2_control') LOOP
  IF has_table_privilege('rr_admin_read_definer',r.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN RAISE EXCEPTION 'Read definer has write access';END IF;
 END LOOP;
END $acl$;
REVOKE ALL ON FUNCTION rr_v2_control.assert_admin_read_acl() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION rr_v2_control.admin_read_admit() RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $admit$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM rr_v2_control.state s JOIN rr_v2_control.admin_read_checkpoint c ON c.id=s.id JOIN rr_v2_test.baseline b ON b.id=s.id WHERE s.stage=6 AND s.state IN ('closed','testing_restricted') AND c.package_id=${lit(packageId)} AND c.read_enabled AND s.hashes=b.hashes AND s.fingerprint=rr_v2_test.fingerprint()) THEN RAISE EXCEPTION 'Admin read access closed or drifted' USING ERRCODE='42501';END IF;
 PERFORM rr_v2_test.assert_acl();
END $admit$;
REVOKE ALL ON FUNCTION rr_v2_control.admin_read_admit() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION rr_v2_control.admin_read_admit() TO rr_admin_read_definer;`;
export const inventorySQL=`SELECT jsonb_build_object('stage',s.stage,'state',s.state,'fingerprint',s.fingerprint,'fingerprint_matches',s.fingerprint=rr_v2_test.fingerprint(),'six_hashes',s.hashes,
 'business_rpc_count',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%') AND p.proname NOT IN ('buyer_test_action','admin_test_reset','admin_read_v2_inventory','admin_read_v2_audit')),
 'test_wrappers',2,'read_rpc_count',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('admin_read_v2_inventory','admin_read_v2_audit')),
 'read_enabled',(SELECT read_enabled FROM rr_v2_control.admin_read_checkpoint WHERE id)) FROM rr_v2_control.state s WHERE id`;
export function installSQL(expected){
 if(!/^[0-9a-f]{32}$/.test(expected))throw Error('Expected fingerprint required');
 return `${begin} SELECT set_config('rr_admin_read.expected_fingerprint',${lit(expected)},true);${verify}
 DO $guard$ BEGIN
 IF to_regrole('rr_admin_read_definer') IS NOT NULL OR to_regclass('rr_v2_control.admin_read_checkpoint') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('admin_read_v2_inventory','admin_read_v2_audit'))
 OR replace((SELECT prosrc FROM pg_proc WHERE oid='rr_v2_test.assert_acl()'::regprocedure),E'\\r','')<>${lit(assertBody.replaceAll('\r',''))}
 OR replace((SELECT prosrc FROM pg_proc WHERE oid='rr_v2_test.fingerprint()'::regprocedure),E'\\r','')<>${lit(fpBody.replaceAll('\r',''))}
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('public','rr_v2_control') AND nspacl IS NULL)
 THEN RAISE EXCEPTION 'Read package object/source drift';END IF;END $guard$;
 CREATE TABLE rr_v2_control.admin_read_checkpoint(id boolean PRIMARY KEY CHECK(id),package_id text NOT NULL,read_enabled boolean NOT NULL,previous_fingerprint text NOT NULL,previous_assert text NOT NULL,previous_fp_function text NOT NULL,protected_fingerprint text NOT NULL);
 ALTER TABLE rr_v2_control.admin_read_checkpoint ENABLE ROW LEVEL SECURITY;
 REVOKE ALL ON rr_v2_control.admin_read_checkpoint FROM PUBLIC,anon,authenticated,service_role;
 INSERT INTO rr_v2_control.admin_read_checkpoint SELECT true,${lit(packageId)},true,fingerprint,pg_get_functiondef('rr_v2_test.assert_acl()'::regprocedure),pg_get_functiondef('rr_v2_test.fingerprint()'::regprocedure),(${protectedSQL}) FROM rr_v2_control.state WHERE id;
 -- Private helper exists before the public function bodies are installed.
 ${body}
 ${helper}
 CREATE FUNCTION rr_v2_control.admin_read_base_fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $base$ ${fpBody} $base$;
 REVOKE ALL ON FUNCTION rr_v2_control.admin_read_base_fingerprint() FROM PUBLIC,anon,authenticated,service_role;
 CREATE OR REPLACE FUNCTION rr_v2_test.fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fp$
 SELECT md5(jsonb_build_object('base',rr_v2_control.admin_read_base_fingerprint(),
 'read_views',(SELECT jsonb_agg(jsonb_build_array(c.relname,pg_get_viewdef(c.oid,true),c.reloptions) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rr_v2_control' AND c.relname IN ('admin_read_inventory','admin_read_audit')),
 'read_checkpoint',(SELECT to_jsonb(c) FROM rr_v2_control.admin_read_checkpoint c WHERE id),
 'read_role',(SELECT to_jsonb(r) FROM pg_roles r WHERE rolname='rr_admin_read_definer'))::text) $fp$;
 CREATE OR REPLACE FUNCTION rr_v2_test.assert_acl() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $orig$ ${assertBody.replace(/END\s*$/,'PERFORM rr_v2_control.assert_admin_read_acl(); END')} $orig$;
 SELECT rr_v2_test.assert_acl();
 DO $protected$ BEGIN IF (${protectedSQL})<>(SELECT protected_fingerprint FROM rr_v2_control.admin_read_checkpoint WHERE id) THEN RAISE EXCEPTION 'Protected public functions/RLS/grants/view changed; transaction cancelled';END IF;END $protected$;
 UPDATE rr_v2_control.state SET fingerprint=rr_v2_test.fingerprint() WHERE id;
 SELECT rr_v2_test.verify_state('closed');
 ${inventorySQL}; COMMIT;`;
}
export function pauseSQL(){return `${begin} DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM rr_v2_control.state WHERE id AND stage=6 AND state='closed' AND fingerprint=rr_v2_test.fingerprint()) THEN RAISE EXCEPTION 'Read pause requires review; use existing emergency lockdown if drifted';END IF;PERFORM rr_v2_test.assert_acl();END $$;
 REVOKE ALL ON FUNCTION public.admin_read_v2_inventory(integer,text),public.admin_read_v2_audit(integer,text) FROM PUBLIC,anon,authenticated,service_role;
 UPDATE rr_v2_control.admin_read_checkpoint SET read_enabled=false WHERE id AND package_id=${lit(packageId)};
 UPDATE rr_v2_control.state SET fingerprint=rr_v2_test.fingerprint() WHERE id;SELECT rr_v2_test.verify_state('closed');COMMIT;`;}
export function rollbackSQL(){return `${begin} DO $rollback$
 DECLARE b rr_v2_control.admin_read_checkpoint%ROWTYPE;BEGIN
 SELECT * INTO STRICT b FROM rr_v2_control.admin_read_checkpoint WHERE id AND package_id=${lit(packageId)};
 IF NOT EXISTS(SELECT 1 FROM rr_v2_control.state WHERE id AND stage=6 AND state='closed' AND fingerprint=rr_v2_test.fingerprint()) OR EXISTS(SELECT 1 FROM rr_v2_test.runs WHERE status IN ('active','provisioning')) THEN RAISE EXCEPTION 'Rollback drift; stop for review';END IF;
 PERFORM rr_v2_test.assert_acl();
 EXECUTE b.previous_assert;EXECUTE b.previous_fp_function;
 DROP FUNCTION public.admin_read_v2_inventory(integer,text);DROP FUNCTION public.admin_read_v2_audit(integer,text);
 DROP FUNCTION rr_v2_control.admin_read_admit();DROP FUNCTION rr_v2_control.assert_admin_read_acl();DROP FUNCTION rr_v2_control.admin_read_base_fingerprint();
 DROP VIEW rr_v2_control.admin_read_inventory;DROP VIEW rr_v2_control.admin_read_audit;
 REVOKE USAGE ON SCHEMA rr_v2_control FROM rr_admin_read_definer;
 REVOKE USAGE ON SCHEMA public FROM rr_admin_read_definer;
 DROP TABLE rr_v2_control.admin_read_checkpoint;
 DROP ROLE rr_admin_read_definer;
 IF rr_v2_test.fingerprint()<>b.previous_fingerprint THEN RAISE EXCEPTION 'Rollback fingerprint did not return to baseline; transaction cancelled';END IF;
 UPDATE rr_v2_control.state SET fingerprint=b.previous_fingerprint WHERE id;
 PERFORM rr_v2_test.verify_state('closed');END $rollback$;COMMIT;`;}
export function writePackage(folder,expected){
 fs.mkdirSync(folder,{recursive:true});const artifacts={'install.sql':installSQL(expected),'pause-read.sql':pauseSQL(),'rollback.sql':rollbackSQL(),'inventory.sql':inventorySQL+';',
 'preflight.sql':`BEGIN READ ONLY;SHOW transaction_read_only;DO $$ BEGIN IF current_setting('transaction_read_only')<>'on' THEN RAISE EXCEPTION 'Read-only guard failed';END IF;END $$;SELECT set_config('rr_admin_read.expected_fingerprint',${lit(expected)},true);${verify} SELECT (${protectedSQL}) AS protected_fingerprint;ROLLBACK;`,
 'postflight.sql':`BEGIN READ ONLY;SHOW transaction_read_only;DO $$ BEGIN IF current_setting('transaction_read_only')<>'on' THEN RAISE EXCEPTION 'Read-only guard failed';END IF;PERFORM rr_v2_test.verify_state('closed');IF (${protectedSQL})<>(SELECT protected_fingerprint FROM rr_v2_control.admin_read_checkpoint WHERE id) THEN RAISE EXCEPTION 'Protected public objects changed';END IF;END $$;SELECT rr_v2_test.assert_acl();${inventorySQL};ROLLBACK;`};
 const records=[];for(const [name,text] of Object.entries(artifacts)){const f=path.join(folder,name);fs.writeFileSync(f,text);records.push({file:name,bytes:Buffer.byteLength(text),sha256:sha(text)});}
 const sources=['supabase/admin-readonly/001_read_contract.sql','scripts/admin-readonly-package.mjs','scripts/prepare-restricted-local.mjs','scripts/v2-migration-control.mjs','supabase/testing/restricted_access.sql',...migrations.map(f=>'supabase/migrations/'+f)];
 const manifest={version:1,package_id:packageId,project_ref:'svuagnobufhfpgzmsyxx',expected_checkpoint:6,expected_state:'closed',expected_fingerprint:expected,files:records,sources:sources.map(file=>({file,sha256:sha(fs.readFileSync(file))})),authorization:'NOT APPROVED FOR PRODUCTION',original_business_rpcs:11,test_wrappers_closed:2,new_read_rpcs_service_only:2};
 fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(manifest,null,2));return manifest;
}
export function verifyPackage(folder){
 const m=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8'));
 if(m.package_id!==packageId||m.project_ref!=='svuagnobufhfpgzmsyxx'||m.expected_checkpoint!==6||m.expected_state!=='closed')throw Error('Package identity mismatch');
 const fresh={'install.sql':installSQL(m.expected_fingerprint),'pause-read.sql':pauseSQL(),'rollback.sql':rollbackSQL(),'inventory.sql':inventorySQL+';'};
 for(const r of m.files){if(path.basename(r.file)!==r.file)throw Error('Invalid artifact path');const bytes=fs.readFileSync(path.join(folder,r.file));if(sha(bytes)!==r.sha256||bytes.length!==r.bytes||(fresh[r.file]&&bytes.toString()!==fresh[r.file]))throw Error('Artifact checksum mismatch');}
 for(const r of m.sources)if(sha(fs.readFileSync(r.file))!==r.sha256)throw Error('Source checksum mismatch');
 if(m.files.length!==6||m.sources.length!==11)throw Error('Incomplete package inventory');
 return m;
}
