-- PENDING APPROVAL. Requires 20261105000100_buyer_accounts.sql.
-- Never apply to production as part of local development.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
ALTER TABLE public.card ADD COLUMN claim_mode text NOT NULL DEFAULT 'legacy'
  CHECK (claim_mode IN ('legacy','google_first_claim'));
ALTER TABLE public.card ADD COLUMN v2_activated_at timestamptz;

CREATE TABLE public.buyer_claim_limits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0)
);
ALTER TABLE public.buyer_claim_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buyer_claim_limits FROM PUBLIC,anon,authenticated;

CREATE TABLE public.buyer_ownership_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  card_code text NOT NULL REFERENCES public.card(card_code),
  old_owner uuid REFERENCES auth.users(id),
  new_owner uuid NOT NULL REFERENCES auth.users(id),
  actor text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.buyer_ownership_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buyer_ownership_audit FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE public.buyer_ownership_audit_id_seq FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.buyer_first_claim(p_card_code text,p_business_name text,p_review_url text)
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
  IF v_card.v2_activated_at IS NOT NULL OR v_card.pin_hash IS NOT NULL OR v_card.review_url IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.card_activation WHERE card_code=p_card_code AND activated_at IS NOT NULL) THEN RETURN jsonb_build_object('success',false,'code','not_claimable'); END IF;
  INSERT INTO public.buyer_card_ownership(card_code,user_id) VALUES(p_card_code,auth.uid());
  UPDATE public.card SET business_name=btrim(p_business_name),review_url=p_review_url,v2_activated_at=now()
  WHERE card_code=p_card_code;
  INSERT INTO public.buyer_ownership_audit(card_code,new_owner,actor,reason)
  VALUES(p_card_code,auth.uid(),'google:'||auth.uid()::text,'first_claim');
  RETURN jsonb_build_object('success',true,'code','claimed');
END;
$f$;
REVOKE ALL ON FUNCTION public.buyer_first_claim(text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.buyer_first_claim(text,text,text) TO authenticated;

CREATE FUNCTION public.buyer_public_card_status(p_card_code text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $f$
  SELECT jsonb_build_object('code',c.card_code,'activation_state',
    CASE WHEN c.v2_activated_at IS NOT NULL OR c.pin_hash IS NOT NULL THEN 'active' ELSE 'inactive' END,
    'claim_allowed',c.claim_mode='google_first_claim' AND c.v2_activated_at IS NULL AND c.pin_hash IS NULL
      AND c.review_url IS NULL AND NOT EXISTS(SELECT 1 FROM public.buyer_card_ownership o WHERE o.card_code=c.card_code))
  FROM public.card c WHERE c.card_code=p_card_code;
$f$;
REVOKE ALL ON FUNCTION public.buyer_public_card_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.buyer_public_card_status(text) TO anon,authenticated;

CREATE OR REPLACE FUNCTION public.buyer_list_cards()
RETURNS TABLE(card_code text,business_name text,review_url text,created_at timestamptz,active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $f$
  SELECT c.card_code,c.business_name,c.review_url,c.created_at,
    CASE WHEN c.claim_mode='google_first_claim' THEN c.v2_activated_at IS NOT NULL ELSE c.pin_hash IS NOT NULL END
  FROM public.card c JOIN public.buyer_card_ownership o ON o.card_code=c.card_code
  WHERE o.user_id=(SELECT auth.uid()) ORDER BY o.created_at DESC,c.card_code;
$f$;

-- Serialize edits with claims/recovery before checking the current owner.
CREATE OR REPLACE FUNCTION public.buyer_update_card(p_card_code text,p_business_name text,p_review_url text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$
DECLARE v_mode text;
BEGIN
  IF auth.uid() IS NULL OR p_card_code IS NULL OR p_card_code !~ '^[A-Za-z0-9_-]{1,30}$'
    OR p_business_name IS NULL OR length(btrim(p_business_name)) NOT BETWEEN 1 AND 150
    OR p_review_url IS NULL OR length(p_review_url)>2048
    OR p_review_url !~* '^https://(maps\.app\.goo\.gl|www\.google\.com|google\.com|search\.google\.com)/' THEN RETURN false; END IF;
  SELECT claim_mode INTO v_mode FROM public.card WHERE card_code=p_card_code FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.buyer_card_ownership WHERE card_code=p_card_code AND user_id=auth.uid()) THEN RETURN false; END IF;
  IF v_mode='google_first_claim' AND p_review_url !~ '^https://search\.google\.com/local/writereview\?placeid=ChI[A-Za-z0-9_-]{5,250}$' THEN RETURN false; END IF;
  UPDATE public.card SET business_name=btrim(p_business_name),review_url=p_review_url WHERE card_code=p_card_code;
  RETURN true;
END;
$f$;
REVOKE ALL ON FUNCTION public.buyer_update_card(text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.buyer_update_card(text,text,text) TO authenticated;

CREATE FUNCTION public.admin_create_v2_cards(p_quantity integer)
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
    card_code:=v_code; RETURN NEXT;
  END LOOP;
END;
$f$;
REVOKE ALL ON FUNCTION public.admin_create_v2_cards(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_v2_cards(integer) TO service_role;

CREATE FUNCTION public.admin_recover_v2_owner(p_card_code text,p_new_owner uuid,p_actor text,p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$
DECLARE v_card public.card%ROWTYPE; v_owner uuid;
BEGIN
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 150 OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 20 AND 1000
    OR NOT EXISTS(SELECT 1 FROM auth.identities WHERE user_id=p_new_owner AND provider='google') THEN RETURN false; END IF;
  SELECT * INTO v_card FROM public.card WHERE card_code=p_card_code FOR UPDATE;
  IF NOT FOUND OR v_card.claim_mode<>'google_first_claim' OR v_card.v2_activated_at IS NULL THEN RETURN false; END IF;
  SELECT user_id INTO v_owner FROM public.buyer_card_ownership WHERE card_code=p_card_code FOR UPDATE;
  IF v_owner IS NULL OR v_owner=p_new_owner THEN RETURN false; END IF;
  UPDATE public.buyer_card_ownership SET user_id=p_new_owner WHERE card_code=p_card_code;
  INSERT INTO public.buyer_ownership_audit(card_code,old_owner,new_owner,actor,reason)
  VALUES(p_card_code,v_owner,p_new_owner,p_actor,btrim(p_reason));
  RETURN true;
END;
$f$;
REVOKE ALL ON FUNCTION public.admin_recover_v2_owner(text,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_recover_v2_owner(text,uuid,text,text) TO service_role;
-- Preserve legacy table/view ACLs and policies during initial integration.
-- Their separate hardening requires dependency review and separate approval.
COMMIT;
