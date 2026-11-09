// Read-only catalog profile for the additive generate package; no SQL writes.
import {protectedSQL} from './admin-readonly-package.mjs';
export const generateProtectedSQL=protectedSQL.replace("'admin_read_v2_inventory','admin_read_v2_audit'","'admin_read_v2_inventory','admin_read_v2_audit','admin_generate_v2_batch','v2_pause_guard'");
export const inventoryFunctionSQL="SELECT md5(jsonb_build_array(pg_get_functiondef(p.oid),p.proacl,p.proowner)::text) FROM pg_proc p WHERE oid='public.admin_read_v2_inventory(integer,text)'::regprocedure";
export const closedProfileSQL=`SELECT json_build_object('stage',s.stage,'state',s.state,'match',s.fingerprint=rr_v2_test.fingerprint(),'fingerprint',s.fingerprint,
 'package_id',c.package_id,'enabled',c.enabled,'previous_fingerprint',c.previous_fingerprint,'old_definitions_saved',length(c.previous_guard)>0 AND length(c.previous_assert)>0 AND length(c.previous_fp)>0 AND length(c.previous_audit)>0 AND length(c.previous_audit_fn)>0,
 'batch_count',(SELECT count(*) FROM rr_v2_generate.batches),'card_count',(SELECT count(*) FROM rr_v2_generate.cards),'context_count',(SELECT count(*) FROM rr_v2_generate.context),
 'total_rpcs',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%')),
 'allowlist_effective',(SELECT bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND has_function_privilege('service_role',p.oid,'EXECUTE')=(p.proname IN ('admin_read_v2_inventory','admin_read_v2_audit'))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%')))
 FROM rr_v2_control.state s JOIN rr_v2_generate.control c USING(id) WHERE s.id`;
export function validateClosedGenerateProfile(p,packageID){
 if(p.stage!==6||p.state!=='closed'||p.match!==true||p.package_id!==packageID||p.enabled!==false||p.previous_fingerprint!=='1aa5a5788a1baed944130434797876ac'||p.old_definitions_saved!==true||p.batch_count!==0||p.card_count!==0||p.context_count!==0||p.total_rpcs!==16||p.allowlist_effective!==true)throw Error('Closed-only generate postflight mismatch; STOP without retry');
}
