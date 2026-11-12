-- Migration: 20261109000300_v2_short_code_direct_claim.sql
-- Description: Support 8-character card codes and direct buyer activation without secret token.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- 1. Atomic Batch Generation for Direct Claim Cards (No Secret Tokens)
CREATE OR REPLACE FUNCTION public.admin_generate_v2_cards_direct(
  p_request_id uuid,
  p_quantity integer,
  p_cards jsonb,
  p_actor text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$
DECLARE
  v_item jsonb;
  v_code text;
  i integer;
BEGIN
  IF p_request_id IS NULL OR p_quantity IS NULL OR p_quantity NOT IN (1, 10, 50, 100)
     OR p_cards IS NULL OR jsonb_array_length(p_cards) <> p_quantity
     OR p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 150 THEN
    RAISE EXCEPTION 'Invalid generation payload' USING ERRCODE='22023';
  END IF;

  -- Advisory lock on request_id to serialize retries
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 74921));

  -- Idempotency check: if batch was already completed, return existing batch items
  IF EXISTS(SELECT 1 FROM public.buyer_card_batch WHERE request_id = p_request_id) THEN
    RETURN jsonb_build_object(
      'success', true,
      'batch_id', p_request_id,
      'idempotent', true,
      'cards', (
        SELECT jsonb_agg(jsonb_build_object('card_code', card_code) ORDER BY ordinal)
        FROM public.buyer_card_batch_items
        WHERE request_id = p_request_id
      )
    );
  END IF;

  INSERT INTO public.buyer_card_batch(request_id, quantity, actor)
  VALUES(p_request_id, p_quantity, btrim(p_actor));

  FOR i IN 0..p_quantity - 1 LOOP
    v_item := p_cards->i;
    v_code := v_item->>'card_code';

    IF v_code IS NULL OR v_code !~ '^[A-Za-z0-9_-]{8,30}$' THEN
      RAISE EXCEPTION 'Invalid card format in batch: %', v_code USING ERRCODE='22023';
    END IF;

    IF EXISTS(SELECT 1 FROM public.card WHERE card_code = v_code) THEN
      RAISE EXCEPTION 'Card code collision: %', v_code USING ERRCODE='23505';
    END IF;

    INSERT INTO public.card(card_code, claim_mode)
    VALUES(v_code, 'google_first_claim');

    INSERT INTO public.buyer_card_inventory(card_code, state, ready_at, updated_by)
    VALUES(v_code, 'ready', now(), btrim(p_actor));

    INSERT INTO public.buyer_card_batch_items(request_id, card_code, ordinal)
    VALUES(p_request_id, v_code, i + 1);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'batch_id', p_request_id,
    'idempotent', false,
    'cards', (
      SELECT jsonb_agg(jsonb_build_object('card_code', card_code) ORDER BY ordinal)
      FROM public.buyer_card_batch_items
      WHERE request_id = p_request_id
    )
  );
END;
$f$;
REVOKE ALL ON FUNCTION public.admin_generate_v2_cards_direct(uuid, integer, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_generate_v2_cards_direct(uuid, integer, jsonb, text) TO service_role;

-- 2. Buyer Self-Serve Direct Claim (No Secret Token Required)
CREATE OR REPLACE FUNCTION public.buyer_claim_v2_direct(
  p_card_code text,
  p_business_name text,
  p_review_url text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$
DECLARE
  v_card public.card%ROWTYPE;
  v_owner uuid;
  v_count integer;
BEGIN
  -- Buyer must be authenticated (supports both Email and Google auth)
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthenticated');
  END IF;

  -- Validate parameters (supports 1..30 character card codes)
  IF p_card_code IS NULL OR p_card_code !~ '^[A-Za-z0-9_-]{1,30}$'
     OR p_business_name IS NULL OR length(btrim(p_business_name)) NOT BETWEEN 1 AND 150
     OR p_review_url IS NULL OR length(p_review_url) > 2048
     OR p_review_url !~ '^https://search\.google\.com/local/writereview\?placeid=ChI[A-Za-z0-9_-]{5,250}$' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_claim');
  END IF;

  -- Rate limiting protection (max 20 attempts per 15 minutes per buyer)
  INSERT INTO public.buyer_claim_limits(user_id, window_start, attempts) VALUES(auth.uid(), now(), 1)
  ON CONFLICT(user_id) DO UPDATE SET
    attempts = CASE WHEN buyer_claim_limits.window_start <= now() - interval '15 minutes' THEN 1 ELSE buyer_claim_limits.attempts + 1 END,
    window_start = CASE WHEN buyer_claim_limits.window_start <= now() - interval '15 minutes' THEN now() ELSE buyer_claim_limits.window_start END
  RETURNING attempts INTO v_count;
  IF v_count > 20 THEN
    RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
  END IF;

  -- Lock card row
  SELECT * INTO v_card FROM public.card WHERE card_code = p_card_code FOR UPDATE;
  IF NOT FOUND OR v_card.claim_mode <> 'google_first_claim' THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_claimable');
  END IF;

  -- Check ownership
  SELECT user_id INTO v_owner FROM public.buyer_card_ownership WHERE card_code = p_card_code;
  IF v_owner IS NOT NULL THEN
    RETURN jsonb_build_object('success', v_owner = auth.uid() AND v_card.v2_activated_at IS NOT NULL, 'code', 'already_claimed');
  END IF;

  -- Verify inventory state is ready
  PERFORM 1 FROM public.buyer_card_inventory WHERE card_code = p_card_code AND state = 'ready' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_ready');
  END IF;

  IF v_card.v2_activated_at IS NOT NULL OR v_card.pin_hash IS NOT NULL OR v_card.review_url IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_claimable');
  END IF;

  -- Atomic claim transaction
  INSERT INTO public.buyer_card_ownership(card_code, user_id) VALUES(p_card_code, auth.uid());
  UPDATE public.card SET business_name = btrim(p_business_name), review_url = p_review_url, v2_activated_at = now()
  WHERE card_code = p_card_code;
  UPDATE public.buyer_card_inventory SET state = 'claimed', claimed_at = now(), updated_at = now(), updated_by = 'google:' || auth.uid()::text
  WHERE card_code = p_card_code;
  INSERT INTO public.buyer_ownership_audit(card_code, new_owner, actor, reason)
  VALUES(p_card_code, auth.uid(), 'google:' || auth.uid()::text, 'v2_direct_claim');

  RETURN jsonb_build_object('success', true, 'code', 'claimed');
END;
$f$;
REVOKE ALL ON FUNCTION public.buyer_claim_v2_direct(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_claim_v2_direct(text, text, text) TO authenticated, service_role;

-- 3. Update v2_pause_guard Trigger to Support Both 8-Char and 24-Char Cards
CREATE OR REPLACE FUNCTION public.v2_pause_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE o jsonb;n jsonb;scoped boolean:=true;
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Restricted TRUNCATE denied' USING ERRCODE='42501'; END IF;
 IF TG_OP<>'INSERT' THEN o:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN n:=to_jsonb(NEW); END IF;

 -- 1. Pilot writes allowed
 IF rr_claim_pilot.write_allowed(TG_TABLE_NAME,TG_OP,o,n) THEN
   IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
 END IF;

 -- 2. Prototype generate writes allowed
 IF TG_OP='INSERT' THEN
   IF rr_v2_generate.write_allowed(TG_TABLE_NAME,TG_OP,n) THEN
     RETURN NEW;
   END IF;
 END IF;

 -- 3. V2 Production Operations (MUST be executed through authorized SECURITY DEFINER RPC owned by postgres)
 IF current_user = 'postgres' THEN
   -- 3a. Batch Card Generation (supports 8..30 char card codes)
   IF TG_OP='INSERT' THEN
     IF TG_TABLE_NAME='card' AND n->>'claim_mode'='google_first_claim' AND n->>'pin_hash' IS NULL AND n->>'review_url' IS NULL AND n->>'business_name' IS NULL AND n->>'v2_activated_at' IS NULL AND n->>'card_code' ~ '^[A-Za-z0-9_-]{8,30}$' THEN
       RETURN NEW;
     END IF;
     IF TG_TABLE_NAME='buyer_card_inventory' AND n->>'state'='ready' AND n->>'ready_at' IS NOT NULL AND n->>'claimed_at' IS NULL AND n->>'card_code' ~ '^[A-Za-z0-9_-]{8,30}$' THEN
       RETURN NEW;
     END IF;
   END IF;

   -- 3b. Buyer Self-Serve Claim (token claim or direct claim)
   IF auth.uid() IS NOT NULL THEN
     IF TG_TABLE_NAME='buyer_claim_limits' AND TG_OP IN ('INSERT','UPDATE') AND (n->>'user_id')::uuid = auth.uid() THEN
       RETURN NEW;
     END IF;
     IF TG_TABLE_NAME='buyer_card_ownership' AND TG_OP='INSERT' AND n->>'card_code' ~ '^[A-Za-z0-9_-]{8,30}$' AND (n->>'user_id')::uuid = auth.uid() THEN
       RETURN NEW;
     END IF;
     IF TG_TABLE_NAME='card' AND TG_OP='UPDATE' AND o->>'claim_mode'='google_first_claim' AND n->>'claim_mode'='google_first_claim' AND o->>'v2_activated_at' IS NULL AND n->>'v2_activated_at' IS NOT NULL AND n->'id'=o->'id' AND n->'created_at'=o->'created_at' AND n->>'review_url' ~ '^https://search[.]google[.]com/local/writereview[?]placeid=ChI[A-Za-z0-9_-]{5,250}$' AND length(btrim(n->>'business_name')) BETWEEN 1 AND 150 THEN
       RETURN NEW;
     END IF;
     IF TG_TABLE_NAME='buyer_card_inventory' AND TG_OP='UPDATE' AND o->>'state'='ready' AND n->>'state'='claimed' AND n->>'claimed_at' IS NOT NULL AND n->>'card_code'=o->>'card_code' AND n->>'updated_by' = 'google:' || auth.uid()::text THEN
       RETURN NEW;
     END IF;
     IF TG_TABLE_NAME='buyer_ownership_audit' AND TG_OP='INSERT' AND n->>'reason' IN ('v2_token_claim', 'v2_direct_claim') AND (n->>'new_owner')::uuid = auth.uid() AND n->>'actor' = 'google:' || auth.uid()::text THEN
       RETURN NEW;
     END IF;
   END IF;
 END IF;

 -- 4. Default pause guard & test isolation
 IF TG_TABLE_NAME='card' THEN scoped:=coalesce(o->>'claim_mode','legacy')='google_first_claim' OR coalesce(n->>'claim_mode','legacy')='google_first_claim';
 ELSIF TG_TABLE_NAME IN ('card_activation','card_pin_attempts') THEN
  SELECT EXISTS(SELECT 1 FROM public.card WHERE card_code IN(o->>'card_code',n->>'card_code') AND claim_mode='google_first_claim') INTO scoped;
 END IF;
 IF scoped AND NOT rr_v2_test.write_allowed(TG_TABLE_NAME,TG_OP,o,n) THEN RAISE EXCEPTION 'Restricted write scope denied' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $function$;

-- 4. Resync fingerprint atomically and assert ACL
UPDATE rr_v2_control.state SET fingerprint = rr_v2_test.fingerprint() WHERE id;
SELECT rr_v2_test.assert_acl();

COMMIT;
