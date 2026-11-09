-- HISTORICAL: verifies only migrations 1..3. Harness uses this intermediate check.
-- Final six-migration acceptance MUST also run postflight_six.sql.
-- READ-ONLY, after approved migrations. No customer data returned.
SELECT jsonb_build_object(
 'new_tables_rls',(SELECT count(*)=3 AND bool_and(relrowsecurity) FROM pg_class
   WHERE oid IN ('public.buyer_card_ownership'::regclass,'public.buyer_claim_limits'::regclass,'public.buyer_ownership_audit'::regclass)),
 'ownership_unique',(SELECT count(*)=1 FROM pg_constraint WHERE conrelid='public.buyer_card_ownership'::regclass AND contype='p'),
 'anon_cannot_claim',NOT has_function_privilege('anon','public.buyer_first_claim(text,text,text)','EXECUTE'),
 'buyer_can_claim',has_function_privilege('authenticated','public.buyer_first_claim(text,text,text)','EXECUTE'),
 'buyer_cannot_recover',NOT has_function_privilege('authenticated','public.admin_recover_v2_owner(text,uuid,text,text)','EXECUTE'),
 'anon_cannot_read_owners',NOT has_table_privilege('anon','public.buyer_card_ownership','SELECT'),
 'buyer_cannot_write_owners',NOT has_table_privilege('authenticated','public.buyer_card_ownership','UPDATE'),
 'buyer_cannot_read_audit',NOT has_table_privilege('authenticated','public.buyer_ownership_audit','SELECT'),
 'public_visibility_scoped',EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='card' AND policyname='public_card_read' AND qual LIKE '%v2_activated_at IS NOT NULL%'),
 'legacy_activation_unchanged',md5(pg_get_functiondef('public.activate_review_card(text,text,text,text,text)'::regprocedure))='2c58074f4fb917e87044979c84218986',
 'legacy_update_unchanged',md5(pg_get_functiondef('public.update_card_review_url(text,text,text)'::regprocedure))='bf1a4289f30aefed6d837f46fd0d1695',
 'legacy_pin_unchanged',md5(pg_get_functiondef('public.set_initial_card_pin(text,text)'::regprocedure))='ad326b35c9d03a67e0b44cbb8896b851'
) AS postflight;
