-- PENDING APPROVAL. Do not apply to production as part of development.
-- Additive: old RPCs, grants on old tables, PIN hashes and redirect paths remain intact.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE TABLE public.buyer_card_ownership (
  card_code text PRIMARY KEY REFERENCES public.card(card_code),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX buyer_card_ownership_user_id ON public.buyer_card_ownership(user_id);
ALTER TABLE public.buyer_card_ownership ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buyer_card_ownership FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.buyer_card_ownership TO authenticated;
CREATE POLICY buyer_owns_card ON public.buyer_card_ownership
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

CREATE FUNCTION public.buyer_list_cards()
RETURNS TABLE(card_code text, business_name text, review_url text, created_at timestamptz, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $f$
  SELECT c.card_code, c.business_name, c.review_url, c.created_at, c.pin_hash IS NOT NULL
  FROM public.card c JOIN public.buyer_card_ownership o ON o.card_code = c.card_code
  WHERE o.user_id = (SELECT auth.uid()) ORDER BY o.created_at DESC, c.card_code;
$f$;

CREATE FUNCTION public.buyer_activate_card(p_card_code text, p_activation_code text,
  p_business_name text, p_review_url text, p_pin text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$
BEGIN
  IF auth.uid() IS NULL OR EXISTS (SELECT 1 FROM public.buyer_card_ownership WHERE card_code = p_card_code) THEN
    RETURN false;
  END IF;
  -- Existing activation performs its original validation, bcrypt and one-time lock.
  -- Ownership insert and activation are one transaction; errors roll back both.
  IF public.activate_review_card(p_card_code, p_activation_code, p_business_name, p_review_url, p_pin) IS NOT TRUE THEN
    RETURN false;
  END IF;
  INSERT INTO public.buyer_card_ownership(card_code, user_id) VALUES (p_card_code, auth.uid());
  RETURN true;
END;
$f$;

CREATE FUNCTION public.buyer_update_card(p_card_code text, p_business_name text, p_review_url text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$
BEGIN
  IF auth.uid() IS NULL OR p_business_name IS NULL
    OR length(btrim(p_business_name)) NOT BETWEEN 1 AND 150
    OR p_review_url IS NULL OR length(p_review_url) > 2048
    OR p_review_url !~* '^https://(maps\.app\.goo\.gl|www\.google\.com|google\.com|search\.google\.com)/' THEN
    RETURN false;
  END IF;
  UPDATE public.card c SET business_name = btrim(p_business_name), review_url = p_review_url
  WHERE c.card_code = p_card_code AND EXISTS
    (SELECT 1 FROM public.buyer_card_ownership o WHERE o.card_code = c.card_code AND o.user_id = auth.uid());
  RETURN FOUND;
END;
$f$;

CREATE FUNCTION public.buyer_claim_card(p_card_code text, p_pin text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$
DECLARE
  v_attempts integer;
  v_locked timestamptz;
  v_hash text;
  v_owner uuid;
BEGIN
  IF auth.uid() IS NULL OR p_pin IS NULL OR p_card_code IS NULL
    OR p_card_code !~ '^[a-zA-Z0-9_-]{1,30}$' THEN RETURN false; END IF;
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

REVOKE ALL ON FUNCTION public.buyer_list_cards() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.buyer_activate_card(text,text,text,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.buyer_update_card(text,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.buyer_claim_card(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_list_cards() TO authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_activate_card(text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_update_card(text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_claim_card(text,text) TO authenticated;
COMMIT;
