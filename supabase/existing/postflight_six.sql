-- Read-only: run only after six approved migrations, before opening traffic.
SELECT jsonb_build_object(
 'five_private_tables_rls',(SELECT count(*)=5 AND bool_and(relrowsecurity) FROM pg_class WHERE oid IN
 ('public.buyer_card_ownership'::regclass,'public.buyer_card_inventory'::regclass,'public.buyer_claim_limits'::regclass,'public.buyer_ownership_audit'::regclass,'public.buyer_activation_reset_audit'::regclass)),
 'ownership_pk',EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.buyer_card_ownership'::regclass AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (card_code)'),
 'buyer_claim',has_function_privilege('authenticated','public.buyer_first_claim(text,text,text)','EXECUTE') AND NOT has_function_privilege('anon','public.buyer_first_claim(text,text,text)','EXECUTE'),
 'admin_service_only',NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('admin_create_v2_cards','admin_recover_v2_owner','admin_set_v2_card_ready','admin_reset_v2_activation','admin_list_v2_activation_cards') AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR NOT has_function_privilege('service_role',p.oid,'EXECUTE'))),
 'private_tables_hidden',NOT has_table_privilege('anon','public.buyer_card_ownership','SELECT') AND NOT has_table_privilege('authenticated','public.buyer_card_inventory','SELECT') AND NOT has_table_privilege('authenticated','public.buyer_activation_reset_audit','SELECT'),
 'stock_hidden',EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='card' AND policyname='public_card_read' AND qual LIKE '%v2_activated_at IS NOT NULL%'),
 'revision_present',EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='buyer_card_inventory' AND column_name='activation_revision'),
 'all_five_admin_rpcs',(SELECT count(*)=5 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('admin_create_v2_cards','admin_recover_v2_owner','admin_set_v2_card_ready','admin_reset_v2_activation','admin_list_v2_activation_cards')),
 'legacy_activation_unchanged',md5(pg_get_functiondef('public.activate_review_card(text,text,text,text,text)'::regprocedure))='2c58074f4fb917e87044979c84218986',
 'legacy_initial_pin_unchanged',md5(pg_get_functiondef('public.set_initial_card_pin(text,text)'::regprocedure))='ad326b35c9d03a67e0b44cbb8896b851',
 'no_buyer_ownership_write',NOT has_table_privilege('authenticated','public.buyer_card_ownership','INSERT') AND NOT has_table_privilege('authenticated','public.buyer_card_ownership','UPDATE') AND NOT has_table_privilege('authenticated','public.buyer_card_ownership','DELETE'),
 'reset_audit_service_read_only',has_table_privilege('service_role','public.buyer_activation_reset_audit','SELECT') AND NOT has_table_privilege('service_role','public.buyer_activation_reset_audit','INSERT') AND NOT has_table_privilege('service_role','public.buyer_activation_reset_audit','DELETE'),
 'pin_fix_present',position('p_pin IS NULL' in pg_get_functiondef('public.update_card_review_url(text,text,text)'::regprocedure))>0 AND position('IS NOT TRUE' in pg_get_functiondef('public.update_card_review_url(text,text,text)'::regprocedure))>0,
 'definer_search_path',NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND NOT coalesce(p.proconfig @> ARRAY['search_path=""'],false))
);
