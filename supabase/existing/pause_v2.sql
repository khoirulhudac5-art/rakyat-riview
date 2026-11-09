-- HISTORICAL PARTIAL SCRIPT: superseded by pause_v2_complete.sql for six migrations.
-- Fail closed to prevent accidentally using incomplete emergency controls.
DO $$ BEGIN RAISE EXCEPTION 'Partial pause disabled; review pause_v2_complete.sql'; END $$;
-- EMERGENCY PAUSE ONLY. Requires separate approval. Never auto-executed.
-- Retain card destinations, ownership records, audit, PINs, policies and schema.
BEGIN;
SET LOCAL lock_timeout='3s';
REVOKE EXECUTE ON FUNCTION public.buyer_first_claim(text,text,text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.buyer_activate_card(text,text,text,text,text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.buyer_claim_card(text,text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.buyer_update_card(text,text,text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_create_v2_cards(integer) FROM service_role;
REVOKE EXECUTE ON FUNCTION public.admin_recover_v2_owner(text,uuid,text,text) FROM service_role;
COMMIT;
