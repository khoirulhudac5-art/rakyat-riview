-- Forward-only local migration. Production requires separate explicit approval.
-- Requires V2 migrations 1..4. No PIN, secret code, or buyer approval workflow.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE TABLE public.buyer_card_inventory (
 card_code text PRIMARY KEY REFERENCES public.card(card_code),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','ready','claimed')),
 ready_at timestamptz,
 claimed_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by text NOT NULL,
 CHECK((state='claimed')=(claimed_at IS NOT NULL)),
 CHECK(state<>'ready' OR ready_at IS NOT NULL)
);
ALTER TABLE public.buyer_card_inventory ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buyer_card_inventory FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.buyer_card_inventory TO service_role;
-- Preserve already-owned/active V2 cards; never release existing stock silently.
-- Legacy rows and their ownership/PIN/URL are untouched.
INSERT INTO public.buyer_card_inventory(card_code,state,claimed_at,updated_by)
 SELECT c.card_code,CASE WHEN c.v2_activated_at IS NOT NULL OR o.user_id IS NOT NULL THEN 'claimed' ELSE 'draft' END,
 CASE WHEN c.v2_activated_at IS NOT NULL OR o.user_id IS NOT NULL THEN coalesce(c.v2_activated_at,o.created_at) ELSE NULL END,'migration:inventory'
 FROM public.card c LEFT JOIN public.buyer_card_ownership o ON o.card_code=c.card_code
 WHERE c.claim_mode='google_first_claim';
CREATE OR REPLACE FUNCTION public.buyer_first_claim(p_card_code text,p_business_name text,p_review_url text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$
DECLARE v_card public.card%ROWTYPE; v_owner uuid; v_count integer;
BEGIN
  -- Google identity comes from Auth's protected schema, not editable metadata.
  IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM auth.identities WHERE user_id=auth.uid() AND provider='google')
    OR p_card_code IS NULL OR p_card_code !~ '^[A-Za-z0-9_-]{24}$'
    OR p_business_name IS NULL OR length(btrim(p_business_name)) NOT BETWEEN 1 AND 150
    OR p_review_url IS NULL OR length(p_review_url)>2048
    OR p_review_url !~ '^https://search\.google\.com/local/writereview\?placeid=ChI[A-Za-z0-9_-]{5,250}$' THEN RETURN jsonb_build_object('success',false,'code','invalid_claim'); END IF;

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
    -- Idempotent retry by same owner: never overwrite previously committed data.
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

CREATE OR REPLACE FUNCTION public.buyer_public_card_status(p_card_code text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $f$
  SELECT jsonb_build_object('code',c.card_code,'activation_state',
    CASE WHEN c.v2_activated_at IS NOT NULL OR c.pin_hash IS NOT NULL THEN 'active' ELSE 'inactive' END,
    'activation_reason',CASE WHEN c.claim_mode='google_first_claim' AND c.v2_activated_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.buyer_card_inventory i WHERE i.card_code=c.card_code AND i.state='ready') THEN 'inventory_not_ready' ELSE NULL END,
    'claim_allowed',EXISTS(SELECT 1 FROM public.buyer_card_inventory i WHERE i.card_code=c.card_code AND i.state='ready') AND c.claim_mode='google_first_claim' AND c.v2_activated_at IS NULL AND c.pin_hash IS NULL
      AND c.review_url IS NULL AND NOT EXISTS(SELECT 1 FROM public.buyer_card_ownership o WHERE o.card_code=c.card_code))
  FROM public.card c WHERE c.card_code=p_card_code;
$f$;
REVOKE ALL ON FUNCTION public.buyer_public_card_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.buyer_public_card_status(text) TO anon,authenticated;

CREATE OR REPLACE FUNCTION public.admin_create_v2_cards(p_quantity integer)
RETURNS TABLE(card_code text) LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$
DECLARE v_code text; i integer;
BEGIN
  IF p_quantity IS NULL OR p_quantity NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Quantity must be 1..1000'; END IF;
  FOR i IN 1..p_quantity LOOP
    LOOP
      v_code:=translate(encode(extensions.gen_random_bytes(18),'base64'),'+/','-_');
      INSERT INTO public.card(card_code,claim_mode) VALUES(v_code,'google_first_claim') ON CONFLICT DO NOTHING;
      EXIT WHEN FOUND;
    END LOOP;
    INSERT INTO public.buyer_card_inventory(card_code,state,updated_by) VALUES(v_code,'draft','inventory:create');
    card_code:=v_code; RETURN NEXT;
  END LOOP;
END;
$f$;
REVOKE ALL ON FUNCTION public.admin_create_v2_cards(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_v2_cards(integer) TO service_role;


CREATE FUNCTION public.admin_set_v2_card_ready(p_card_code text,p_ready boolean,p_actor text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$
DECLARE v_card public.card%ROWTYPE; v_state text;
BEGIN
 IF p_card_code IS NULL OR p_ready IS NULL OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 150 THEN RETURN false; END IF;
 SELECT * INTO v_card FROM public.card WHERE card_code=p_card_code FOR UPDATE;
 IF NOT FOUND OR v_card.claim_mode<>'google_first_claim' OR v_card.v2_activated_at IS NOT NULL OR v_card.pin_hash IS NOT NULL
  OR v_card.review_url IS NOT NULL OR EXISTS(SELECT 1 FROM public.buyer_card_ownership WHERE card_code=p_card_code) THEN RETURN false; END IF;
 INSERT INTO public.buyer_card_inventory(card_code,state,updated_by) VALUES(p_card_code,'draft',p_actor) ON CONFLICT DO NOTHING;
 SELECT state INTO v_state FROM public.buyer_card_inventory WHERE card_code=p_card_code FOR UPDATE;
 IF v_state='claimed' THEN RETURN false; END IF;
 UPDATE public.buyer_card_inventory SET state=CASE WHEN p_ready THEN 'ready' ELSE 'draft' END,
 ready_at=CASE WHEN p_ready THEN coalesce(ready_at,now()) ELSE NULL END,updated_at=now(),updated_by=p_actor WHERE card_code=p_card_code;
 RETURN true;
END;
$f$;
REVOKE ALL ON FUNCTION public.admin_set_v2_card_ready(text,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_v2_card_ready(text,boolean,text) TO service_role;

-- Authenticated PIN/code compatibility wrappers are exclusively for legacy cards.
CREATE OR REPLACE FUNCTION public.buyer_activate_card(p_card_code text, p_activation_code text,
  p_business_name text, p_review_url text, p_pin text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$
BEGIN
  IF auth.uid() IS NULL OR EXISTS (SELECT 1 FROM public.buyer_card_ownership WHERE card_code = p_card_code) THEN
    RETURN false;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.card WHERE card_code=p_card_code AND claim_mode='legacy') THEN RETURN false; END IF;
  -- Existing activation performs its original validation, bcrypt and one-time lock.
  -- Ownership insert and activation are one transaction; errors roll back both.
  IF public.activate_review_card(p_card_code, p_activation_code, p_business_name, p_review_url, p_pin) IS NOT TRUE THEN
    RETURN false;
  END IF;
  INSERT INTO public.buyer_card_ownership(card_code, user_id) VALUES (p_card_code, auth.uid());
  RETURN true;
END;
$f$;

CREATE OR REPLACE FUNCTION public.buyer_claim_card(p_card_code text, p_pin text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$
DECLARE
  v_attempts integer;
  v_locked timestamptz;
  v_hash text;
  v_owner uuid;
BEGIN
  IF auth.uid() IS NULL OR p_pin IS NULL OR p_card_code IS NULL
    OR p_card_code !~ '^[a-zA-Z0-9_-]{1,30}$' THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.card WHERE card_code=p_card_code AND claim_mode='legacy') THEN RETURN false; END IF;
  -- Keep the same lock order as the legacy update RPC: attempts, then card.
  IF NOT EXISTS (SELECT 1 FROM public.card WHERE card_code = p_card_code) THEN RETURN false; END IF;
  INSERT INTO public.card_pin_attempts(card_code) VALUES (p_card_code) ON CONFLICT DO NOTHING;
  SELECT attempts, locked_until INTO v_attempts, v_locked
  FROM public.card_pin_attempts WHERE card_code = p_card_code FOR UPDATE;
  IF v_locked > now() THEN RETURN false; END IF;
  SELECT pin_hash INTO v_hash FROM public.card WHERE card_code = p_card_code FOR UPDATE;
  SELECT user_id INTO v_owner FROM public.buyer_card_ownership WHERE card_code = p_card_code;
  IF v_owner IS NOT NULL THEN RETURN v_owner = auth.uid(); END IF;
  IF (v_hash = extensions.crypt(p_pin, v_hash)) IS NOT TRUE THEN
    v_attempts := CASE WHEN v_locked <= now() THEN 1 ELSE v_attempts + 1 END;
    UPDATE public.card_pin_attempts SET attempts = v_attempts,
      locked_until = CASE WHEN v_attempts >= 5 THEN now() + interval '15 minutes' ELSE NULL END
      WHERE card_code = p_card_code;
    RETURN false;
  END IF;
  INSERT INTO public.buyer_card_ownership(card_code,user_id) VALUES (p_card_code,auth.uid());
  UPDATE public.card_pin_attempts SET attempts=0, locked_until=NULL WHERE card_code=p_card_code;
  RETURN true;
END;
$f$;


COMMIT;
