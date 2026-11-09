-- UNEXECUTED. Disposable synthetic PostgreSQL fixture only, not the existing DB.
-- Run after buyer_account_fixture.sql, migration 1, google_first_claim.sql.
\set ON_ERROR_STOP on
GRANT SELECT(card_code,business_name,review_url) ON public.card TO anon;
GRANT SELECT ON public.card_public TO anon;
ALTER VIEW public.card_public SET (security_invoker=true);
CREATE POLICY public_card_read ON public.card FOR SELECT TO anon USING(true);
\ir ../migrations/20261105000300_existing_public_visibility.sql
BEGIN;
INSERT INTO public.card(card_code,claim_mode,v2_activated_at) VALUES
 ('LEGACY-VISIBILITY','legacy',NULL),
 ('UNCLAIMEDabcdefghijklmn1','google_first_claim',NULL),
 ('ACTIVEabcdefghijklmnopq1','google_first_claim',now());
SET LOCAL ROLE anon;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.card_public WHERE card_code='LEGACY-VISIBILITY') THEN RAISE EXCEPTION 'legacy hidden'; END IF;
 IF EXISTS(SELECT 1 FROM public.card_public WHERE card_code='UNCLAIMEDabcdefghijklmn1') THEN RAISE EXCEPTION 'unclaimed ID enumerable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.card_public WHERE card_code='ACTIVEabcdefghijklmnopq1') THEN RAISE EXCEPTION 'active destination hidden'; END IF;
 IF (public.buyer_public_card_status('UNCLAIMEDabcdefghijklmn1')->>'claim_allowed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'scan status unavailable'; END IF;
 IF has_column_privilege('anon','public.card','pin_hash','SELECT') THEN RAISE EXCEPTION 'hash readable'; END IF;
END $$;
RESET ROLE;
ROLLBACK;
