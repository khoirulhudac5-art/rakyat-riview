-- READ ONLY: review alongside preflight.sql; no customer rows returned.
SELECT jsonb_build_object(
 'no_new_relations',NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('buyer_card_ownership','buyer_claim_limits','buyer_ownership_audit','buyer_card_inventory','buyer_activation_reset_audit')),
 'no_new_functions',NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'buyer_%' OR p.proname LIKE 'admin_%' OR p.proname='v2_pause_guard')),
 'no_v2_columns',NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='card' AND column_name IN ('claim_mode','v2_activated_at')),
 'google_identities_present',to_regclass('auth.identities') IS NOT NULL,
 'crypto_available',to_regprocedure('extensions.gen_random_bytes(integer)') IS NOT NULL,
 'legacy_unique',EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.card'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (card_code)'),
 'legacy_rls',(SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.card'::regclass,'public.card_activation'::regclass,'public.card_pin_attempts'::regclass)),
 'public_view_invoker',(SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid='public.card_public'::regclass)
);
