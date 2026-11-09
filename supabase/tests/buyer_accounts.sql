-- Run ONLY in a disposable local/staging database, AFTER the buyer migration.
-- User rows below are synthetic. All fixtures and changes roll back.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users(id) VALUES
  ('10000000-0000-0000-0000-000000000001'),('10000000-0000-0000-0000-000000000002');
INSERT INTO public.card(card_code,business_name,review_url,pin_hash) VALUES
  ('SYN-DB-NEW',NULL,NULL,NULL),
  ('SYN-DB-OLD','Synthetic old','https://www.google.com/maps',extensions.crypt('legacy synthetic PIN',extensions.gen_salt('bf')));
INSERT INTO public.card_activation(card_code,activation_code_hash) VALUES
  ('SYN-DB-NEW',encode(extensions.digest('synthetic-activation','sha256'),'hex'));
CREATE TEMP TABLE original_card AS SELECT card_code,pin_hash,review_url FROM public.card WHERE card_code='SYN-DB-OLD';
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
SET LOCAL ROLE authenticated;
DO $test$
BEGIN
  IF public.buyer_claim_card('SYN-DB-OLD',NULL) IS NOT FALSE THEN RAISE EXCEPTION 'NULL accepted'; END IF;
  IF public.buyer_activate_card('SYN-DB-NEW','wrong-code','Synthetic','https://www.google.com/maps','synthetic-pin') IS NOT FALSE THEN RAISE EXCEPTION 'Bad activation accepted'; END IF;
  IF EXISTS(SELECT 1 FROM public.buyer_card_ownership) THEN RAISE EXCEPTION 'Failed activation created ownership'; END IF;
  IF public.buyer_activate_card('SYN-DB-NEW','synthetic-activation','Synthetic A','https://www.google.com/maps','synthetic-pin') IS NOT TRUE THEN RAISE EXCEPTION 'Activation failed'; END IF;
  IF (SELECT count(*) FROM public.buyer_list_cards())<>1 THEN RAISE EXCEPTION 'Owner list mismatch'; END IF;
  IF public.buyer_update_card('SYN-DB-NEW','Updated A','https://google.com/maps') IS NOT TRUE THEN RAISE EXCEPTION 'Owner edit failed'; END IF;
  IF public.buyer_update_card('SYN-DB-NEW','Unsafe','https://google.com.evil.example/') IS NOT FALSE THEN RAISE EXCEPTION 'Unsafe URL accepted'; END IF;
  BEGIN
    INSERT INTO public.buyer_card_ownership VALUES ('SYN-DB-OLD','10000000-0000-0000-0000-000000000001',now());
    RAISE EXCEPTION 'Direct ownership insert accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$test$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',true);
SET LOCAL ROLE authenticated;
DO $test$
BEGIN
  IF EXISTS(SELECT 1 FROM public.buyer_card_ownership) OR EXISTS(SELECT 1 FROM public.buyer_list_cards()) THEN RAISE EXCEPTION 'Cross-account disclosure'; END IF;
  IF public.buyer_update_card('SYN-DB-NEW','Hijacked','https://google.com/maps') IS NOT FALSE THEN RAISE EXCEPTION 'Cross-account update'; END IF;
  IF public.buyer_claim_card('SYN-DB-NEW','synthetic-pin') IS NOT FALSE THEN RAISE EXCEPTION 'Cross-account takeover'; END IF;
  IF public.buyer_activate_card('SYN-DB-NEW','synthetic-activation','Hijacked','https://google.com/maps','synthetic-pin') IS NOT FALSE THEN RAISE EXCEPTION 'Repeat activation'; END IF;
END;
$test$;
RESET ROLE;
-- Five failed legacy claim attempts lock, including for the correct PIN.
SET LOCAL ROLE authenticated;
DO $test$
DECLARE i integer;
BEGIN
  FOR i IN 1..5 LOOP
    IF public.buyer_claim_card('SYN-DB-OLD','wrong synthetic PIN') IS NOT FALSE THEN RAISE EXCEPTION 'Incorrect PIN accepted'; END IF;
  END LOOP;
  IF public.buyer_claim_card('SYN-DB-OLD','legacy synthetic PIN') IS NOT FALSE THEN RAISE EXCEPTION 'Lock bypassed'; END IF;
END;
$test$;
RESET ROLE;
DO $test$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.card_pin_attempts WHERE card_code='SYN-DB-OLD' AND attempts=5 AND locked_until=now()+interval '15 minutes') THEN RAISE EXCEPTION 'Unexpected lock duration'; END IF;
END;
$test$;
UPDATE public.card_pin_attempts SET locked_until=now() WHERE card_code='SYN-DB-OLD';
SET LOCAL ROLE authenticated;
SELECT public.buyer_claim_card('SYN-DB-OLD','wrong synthetic PIN');
RESET ROLE;
DO $test$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.card_pin_attempts WHERE card_code='SYN-DB-OLD' AND attempts=1 AND locked_until IS NULL) THEN RAISE EXCEPTION 'Expired lock reset failed'; END IF;
END;
$test$;
SET LOCAL ROLE authenticated;
DO $test$
BEGIN
  IF public.buyer_claim_card('SYN-DB-OLD','legacy synthetic PIN') IS NOT TRUE THEN RAISE EXCEPTION 'Legacy PIN claim failed'; END IF;
  IF (SELECT count(*) FROM public.buyer_list_cards())<>1 THEN RAISE EXCEPTION 'Legacy ownership missing'; END IF;
END;
$test$;
RESET ROLE;
DO $test$
BEGIN
  IF EXISTS(SELECT 1 FROM public.card c JOIN original_card o USING(card_code) WHERE c.pin_hash IS DISTINCT FROM o.pin_hash OR c.review_url IS DISTINCT FROM o.review_url) THEN RAISE EXCEPTION 'Legacy data changed'; END IF;
  IF has_function_privilege('anon','public.buyer_list_cards()','EXECUTE') THEN RAISE EXCEPTION 'Anonymous RPC grant'; END IF;
END;
$test$;
-- Missing JWT cannot use SECURITY DEFINER to acquire or modify any card.
SELECT set_config('request.jwt.claim.sub','',true);
SET LOCAL ROLE authenticated;
DO $test$
BEGIN
  IF EXISTS(SELECT 1 FROM public.buyer_list_cards()) OR public.buyer_claim_card('SYN-DB-OLD','legacy synthetic PIN') IS NOT FALSE OR public.buyer_update_card('SYN-DB-NEW','Unsafe','https://google.com/maps') IS NOT FALSE THEN RAISE EXCEPTION 'Missing uid accepted'; END IF;
END;
$test$;
RESET ROLE;
ROLLBACK;
