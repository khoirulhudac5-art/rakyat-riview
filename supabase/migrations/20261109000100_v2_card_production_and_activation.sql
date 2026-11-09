-- Migration: V2 NFC + QR Code Production and Secret Token Activation System
-- Local migration preparation only. DO NOT run in production without explicit approval.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- 1. Table for Secret Activation Token Hashes
CREATE TABLE IF NOT EXISTS public.buyer_card_activation (
  card_code text PRIMARY KEY REFERENCES public.card(card_code) ON DELETE CASCADE,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claimed_by uuid REFERENCES auth.users(id),
  reissue_count integer NOT NULL DEFAULT 0
);
ALTER TABLE public.buyer_card_activation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buyer_card_activation FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.buyer_card_activation TO service_role;

-- 2. Tables for Batch Generation & Idempotency Tracking
CREATE TABLE IF NOT EXISTS public.buyer_card_batch (
  request_id uuid PRIMARY KEY,
  quantity integer NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.buyer_card_batch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buyer_card_batch FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.buyer_card_batch TO service_role;

CREATE TABLE IF NOT EXISTS public.buyer_card_batch_items (
  request_id uuid NOT NULL REFERENCES public.buyer_card_batch(request_id) ON DELETE CASCADE,
  card_code text NOT NULL REFERENCES public.card(card_code) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  PRIMARY KEY (request_id, ordinal)
);
ALTER TABLE public.buyer_card_batch_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buyer_card_batch_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.buyer_card_batch_items TO service_role;

-- 3. Atomic Batch Card Generation with Secret Token Hashes
CREATE OR REPLACE FUNCTION public.admin_generate_v2_cards_with_tokens(
  p_request_id uuid,
  p_quantity integer,
  p_cards jsonb,
  p_actor text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$
DECLARE
  v_item jsonb;
  v_code text;
  v_hash text;
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
    v_hash := v_item->>'token_hash';

    IF v_code IS NULL OR v_code !~ '^[A-Za-z0-9_-]{24}$'
       OR v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'Invalid card format in batch' USING ERRCODE='22023';
    END IF;

    IF EXISTS(SELECT 1 FROM public.card WHERE card_code = v_code) THEN
      RAISE EXCEPTION 'Card code collision: %', v_code USING ERRCODE='23505';
    END IF;

    INSERT INTO public.card(card_code, claim_mode)
    VALUES(v_code, 'google_first_claim');

    INSERT INTO public.buyer_card_inventory(card_code, state, ready_at, updated_by)
    VALUES(v_code, 'ready', now(), btrim(p_actor));

    INSERT INTO public.buyer_card_activation(card_code, token_hash)
    VALUES(v_code, v_hash);

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
REVOKE ALL ON FUNCTION public.admin_generate_v2_cards_with_tokens(uuid, integer, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_generate_v2_cards_with_tokens(uuid, integer, jsonb, text) TO service_role;

-- 4. Buyer Self-Serve Claim with Secret Activation Token
CREATE OR REPLACE FUNCTION public.buyer_claim_v2_with_token(
  p_card_code text,
  p_token text,
  p_business_name text,
  p_review_url text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$
DECLARE
  v_card public.card%ROWTYPE;
  v_owner uuid;
  v_count integer;
  v_computed_hash text;
  v_activation public.buyer_card_activation%ROWTYPE;
BEGIN
  -- Buyer must have active authenticated Google session
  IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM auth.identities WHERE user_id = auth.uid() AND provider = 'google') THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthenticated');
  END IF;

  -- Validate parameters
  IF p_card_code IS NULL OR p_card_code !~ '^[A-Za-z0-9_-]{24}$'
     OR p_token IS NULL OR length(p_token) < 16 OR length(p_token) > 128
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

  -- Verify card is not already owned
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

  -- Compute SHA-256 hash of supplied token
  v_computed_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  -- Verify token hash in buyer_card_activation
  SELECT * INTO v_activation FROM public.buyer_card_activation WHERE card_code = p_card_code FOR UPDATE;
  IF NOT FOUND OR v_activation.token_hash <> v_computed_hash OR v_activation.claimed_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_token');
  END IF;

  -- Atomic claim transaction
  INSERT INTO public.buyer_card_ownership(card_code, user_id) VALUES(p_card_code, auth.uid());
  UPDATE public.card SET business_name = btrim(p_business_name), review_url = p_review_url, v2_activated_at = now()
  WHERE card_code = p_card_code;
  UPDATE public.buyer_card_inventory SET state = 'claimed', claimed_at = now(), updated_at = now(), updated_by = 'google:' || auth.uid()::text
  WHERE card_code = p_card_code;
  UPDATE public.buyer_card_activation SET claimed_at = now(), claimed_by = auth.uid()
  WHERE card_code = p_card_code;
  INSERT INTO public.buyer_ownership_audit(card_code, new_owner, actor, reason)
  VALUES(p_card_code, auth.uid(), 'google:' || auth.uid()::text, 'v2_token_claim');

  RETURN jsonb_build_object('success', true, 'code', 'claimed');
END;
$f$;
REVOKE ALL ON FUNCTION public.buyer_claim_v2_with_token(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_claim_v2_with_token(text, text, text, text) TO authenticated;

-- 5. Admin Token Reissue (unclaimed cards only)
CREATE OR REPLACE FUNCTION public.admin_reissue_v2_activation_token(
  p_card_code text,
  p_new_token_hash text,
  p_actor text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$
DECLARE
  v_card public.card%ROWTYPE;
BEGIN
  IF p_card_code IS NULL OR p_card_code !~ '^[A-Za-z0-9_-]{24}$'
     OR p_new_token_hash IS NULL OR p_new_token_hash !~ '^[0-9a-f]{64}$'
     OR p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 150 THEN
    RETURN false;
  END IF;

  SELECT * INTO v_card FROM public.card WHERE card_code = p_card_code FOR UPDATE;
  IF NOT FOUND OR v_card.claim_mode <> 'google_first_claim' OR v_card.v2_activated_at IS NOT NULL THEN
    RETURN false;
  END IF;

  PERFORM 1 FROM public.buyer_card_inventory WHERE card_code = p_card_code AND state = 'ready' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.buyer_card_activation
  SET token_hash = p_new_token_hash, reissue_count = reissue_count + 1
  WHERE card_code = p_card_code AND claimed_at IS NULL;

  RETURN FOUND;
END;
$f$;
REVOKE ALL ON FUNCTION public.admin_reissue_v2_activation_token(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reissue_v2_activation_token(text, text, text) TO service_role;

-- 6. Guard Legacy buyer_first_claim against token-protected cards
CREATE OR REPLACE FUNCTION public.buyer_first_claim(p_card_code text, p_business_name text, p_review_url text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$
DECLARE v_card public.card%ROWTYPE; v_owner uuid; v_count integer;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM auth.identities WHERE user_id=auth.uid() AND provider='google')
    OR p_card_code IS NULL OR p_card_code !~ '^[A-Za-z0-9_-]{24}$'
    OR p_business_name IS NULL OR length(btrim(p_business_name)) NOT BETWEEN 1 AND 150
    OR p_review_url IS NULL OR length(p_review_url)>2048
    OR p_review_url !~ '^https://search\.google\.com/local/writereview\?placeid=ChI[A-Za-z0-9_-]{5,250}$' THEN
    RETURN jsonb_build_object('success',false,'code','invalid_claim');
  END IF;

  -- Guard: token-protected cards cannot be claimed via legacy buyer_first_claim
  IF EXISTS(SELECT 1 FROM public.buyer_card_activation WHERE card_code = p_card_code) THEN
    RETURN jsonb_build_object('success', false, 'code', 'token_required');
  END IF;

  INSERT INTO public.buyer_claim_limits(user_id,window_start,attempts) VALUES(auth.uid(),now(),1)
  ON CONFLICT(user_id) DO UPDATE SET
    attempts=CASE WHEN buyer_claim_limits.window_start<=now()-interval '15 minutes' THEN 1 ELSE buyer_claim_limits.attempts+1 END,
    window_start=CASE WHEN buyer_claim_limits.window_start<=now()-interval '15 minutes' THEN now() ELSE buyer_claim_limits.window_start END
  RETURNING attempts INTO v_count;
  IF v_count>20 THEN RETURN jsonb_build_object('success',false,'code','rate_limited'); END IF;

  SELECT * INTO v_card FROM public.card WHERE card_code=p_card_code FOR UPDATE;
  IF NOT FOUND OR v_card.claim_mode<>'google_first_claim' THEN RETURN jsonb_build_object('success',false,'code','not_claimable'); END IF;
  SELECT user_id INTO v_owner FROM public.buyer_card_ownership WHERE card_code=p_card_code;
  IF v_owner IS NOT NULL THEN
    RETURN jsonb_build_object('success',v_owner=auth.uid() AND v_card.v2_activated_at IS NOT NULL,'code','already_claimed');
  END IF;
  PERFORM 1 FROM public.buyer_card_inventory WHERE card_code=p_card_code AND state='ready' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','not_ready'); END IF;
  IF v_card.v2_activated_at IS NOT NULL OR v_card.pin_hash IS NOT NULL OR v_card.review_url IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.card_activation WHERE card_code=p_card_code AND activated_at IS NOT NULL) THEN RETURN jsonb_build_object('success',false,'code','not_claimable'); END IF;
  INSERT INTO public.buyer_card_ownership(card_code,user_id) VALUES(p_card_code,auth.uid());
  UPDATE public.card SET business_name=btrim(p_business_name),review_url=p_review_url,v2_activated_at=now()
  WHERE card_code=p_card_code;
  UPDATE public.buyer_card_inventory SET state='claimed',claimed_at=now(),updated_at=now(),updated_by='google:'||auth.uid()::text WHERE card_code=p_card_code;
  INSERT INTO public.buyer_ownership_audit(card_code,new_owner,actor,reason)
  VALUES(p_card_code,auth.uid(),'google:'||auth.uid()::text,'first_claim');
  RETURN jsonb_build_object('success',true,'code','claimed');
END;
$f$;
REVOKE ALL ON FUNCTION public.buyer_first_claim(text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.buyer_first_claim(text,text,text) TO authenticated;

COMMIT;
