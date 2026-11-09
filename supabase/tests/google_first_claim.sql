-- Unexecuted acceptance fixture. Disposable LOCAL PostgreSQL only, superuser.
-- Run buyer_account_fixture.sql, buyer_accounts migration, this bootstrap,
-- then google_first_claim migration and assertions below (see FIRST-CLAIM.md).
\set ON_ERROR_STOP on
CREATE ROLE service_role NOLOGIN;
CREATE TABLE auth.identities(user_id uuid REFERENCES auth.users(id),provider text NOT NULL);
CREATE VIEW public.card_public AS SELECT card_code,review_url FROM public.card;
\ir ../migrations/20261105000200_google_first_claim.sql
BEGIN;
INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
INSERT INTO auth.identities VALUES ('00000000-0000-0000-0000-000000000001','google'),('00000000-0000-0000-0000-000000000002','google');
INSERT INTO public.card(card_code,claim_mode) VALUES ('TESTabcdefghijklmnopqrst','google_first_claim'),('LEGACY','legacy');
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  IF (public.buyer_first_claim('TESTabcdefghijklmnopqrst','Synthetic','https://search.google.com/local/writereview?placeid=ChITestFixtureOnly')->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'first claim failed'; END IF;
  IF (public.buyer_first_claim('TESTabcdefghijklmnopqrst','Overwrite','https://search.google.com/local/writereview?placeid=ChITestFixtureOnly')->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'retry failed'; END IF;
  IF (SELECT business_name FROM public.buyer_list_cards())<>'Synthetic' THEN RAISE EXCEPTION 'retry overwrote data'; END IF;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  IF (public.buyer_first_claim('TESTabcdefghijklmnopqrst','Other','https://search.google.com/local/writereview?placeid=ChITestFixtureOnly')->>'success')::boolean IS NOT FALSE THEN RAISE EXCEPTION 'second owner allowed'; END IF;
  IF EXISTS(SELECT 1 FROM public.buyer_list_cards()) THEN RAISE EXCEPTION 'ownership leaked'; END IF;
  IF public.buyer_update_card('TESTabcdefghijklmnopqrst','Other','https://search.google.com/local/writereview?placeid=ChITestFixtureOnly') THEN RAISE EXCEPTION 'foreign edit allowed'; END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.buyer_card_ownership)<>1 THEN RAISE EXCEPTION 'ownership count'; END IF;
  IF (SELECT count(*) FROM public.buyer_ownership_audit)<>1 THEN RAISE EXCEPTION 'audit count'; END IF;
  IF EXISTS(SELECT 1 FROM public.card WHERE card_code='LEGACY' AND (claim_mode<>'legacy' OR v2_activated_at IS NOT NULL)) THEN RAISE EXCEPTION 'legacy changed'; END IF;
  IF has_function_privilege('anon','public.buyer_first_claim(text,text,text)','EXECUTE') THEN RAISE EXCEPTION 'anonymous execution'; END IF;
  IF has_function_privilege('authenticated','public.admin_recover_v2_owner(text,uuid,text,text)','EXECUTE') THEN RAISE EXCEPTION 'public recovery'; END IF;
END $$;
ROLLBACK;
