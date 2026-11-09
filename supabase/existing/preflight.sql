-- READ-ONLY. Run with preflight_six.sql before the complete six-migration package.
-- No row values, customer data, hashes, or credentials.
SELECT jsonb_build_object(
 'card',to_regclass('public.card') IS NOT NULL,
 'activation',to_regclass('public.card_activation') IS NOT NULL,
 'pin_attempts',to_regclass('public.card_pin_attempts') IS NOT NULL,
 'new_names_free',to_regclass('public.buyer_card_ownership') IS NULL
   AND to_regclass('public.buyer_claim_limits') IS NULL AND to_regclass('public.buyer_ownership_audit') IS NULL,
 'new_columns_free',NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='card' AND column_name IN ('claim_mode','v2_activated_at')),
 'unique_card_code',EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.card'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (card_code)'),
 'rls', (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.card'::regclass,'public.card_activation'::regclass,'public.card_pin_attempts'::regclass)),
 'view_security_invoker',(SELECT 'security_invoker=true'=ANY(reloptions) FROM pg_class WHERE oid='public.card_public'::regclass),
 'google_identity_schema',to_regclass('auth.identities') IS NOT NULL,
 'crypto',to_regprocedure('extensions.gen_random_bytes(integer)') IS NOT NULL,
 'activation_definition_unchanged',md5(pg_get_functiondef('public.activate_review_card(text,text,text,text,text)'::regprocedure))='2c58074f4fb917e87044979c84218986',
 'policy_unchanged',EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='card' AND policyname='public_card_read' AND roles=ARRAY['anon']::name[] AND cmd='SELECT' AND qual='true')
) AS preflight;
