-- Migration: 20261110000100_v2_buyer_dashboard.sql
-- Purpose: Enable buyer dashboard multi-card list and edit capabilities for V2 claimed cards

BEGIN;

-- 1. Create public.buyer_v2_list_cards()
DROP FUNCTION IF EXISTS public.buyer_v2_list_cards();
CREATE OR REPLACE FUNCTION public.buyer_v2_list_cards()
RETURNS TABLE(
  card_code text,
  business_name text,
  review_url text,
  created_at timestamp with time zone,
  active boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    c.card_code,
    c.business_name,
    c.review_url,
    c.created_at,
    (c.v2_activated_at IS NOT NULL) AS active
  FROM public.card c
  JOIN public.buyer_card_ownership o ON o.card_code = c.card_code
  WHERE o.user_id = auth.uid()
  ORDER BY o.created_at DESC, c.card_code;
$$;

REVOKE ALL ON FUNCTION public.buyer_v2_list_cards() FROM public;
GRANT EXECUTE ON FUNCTION public.buyer_v2_list_cards() TO authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_v2_list_cards() TO service_role;

-- 2. Create public.buyer_v2_update_card(p_card_code, p_business_name, p_review_url)
CREATE OR REPLACE FUNCTION public.buyer_v2_update_card(
  p_card_code text,
  p_business_name text,
  p_review_url text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_mode text;
BEGIN
  IF auth.uid() IS NULL
     OR p_card_code IS NULL OR p_card_code !~ '^[A-Za-z0-9_-]{8,30}$'
     OR p_business_name IS NULL OR length(btrim(p_business_name)) NOT BETWEEN 1 AND 150
     OR p_review_url IS NULL OR length(p_review_url) > 2048
     OR p_review_url !~ '^https://search[.]google[.]com/local/writereview[?]placeid=ChI[A-Za-z0-9_-]{5,250}$' THEN
    RETURN false;
  END IF;

  SELECT claim_mode INTO v_mode FROM public.card WHERE card_code = p_card_code FOR UPDATE;
  IF NOT FOUND OR v_mode <> 'google_first_claim' THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.buyer_card_ownership
    WHERE card_code = p_card_code AND user_id = auth.uid()
  ) THEN
    RETURN false;
  END IF;

  UPDATE public.card
  SET business_name = btrim(p_business_name),
      review_url = p_review_url
  WHERE card_code = p_card_code;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.buyer_v2_update_card(text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.buyer_v2_update_card(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_v2_update_card(text, text, text) TO service_role;

-- 3. Update public.v2_pause_guard() to allow buyer updates on already claimed card
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

   -- 3b. Buyer Self-Serve Claim & Management
   IF auth.uid() IS NOT NULL THEN
     IF TG_TABLE_NAME='buyer_claim_limits' AND TG_OP IN ('INSERT','UPDATE') AND (n->>'user_id')::uuid = auth.uid() THEN
       RETURN NEW;
     END IF;
     IF TG_TABLE_NAME='buyer_card_ownership' AND TG_OP='INSERT' AND n->>'card_code' ~ '^[A-Za-z0-9_-]{8,30}$' AND (n->>'user_id')::uuid = auth.uid() THEN
       RETURN NEW;
     END IF;
     -- Initial claim/activation (v2_activated_at IS NULL -> NOT NULL)
     IF TG_TABLE_NAME='card' AND TG_OP='UPDATE' AND o->>'claim_mode'='google_first_claim' AND n->>'claim_mode'='google_first_claim' AND o->>'v2_activated_at' IS NULL AND n->>'v2_activated_at' IS NOT NULL AND n->'id'=o->'id' AND n->'created_at'=o->'created_at' AND n->>'review_url' ~ '^https://search[.]google[.]com/local/writereview[?]placeid=ChI[A-Za-z0-9_-]{5,250}$' AND length(btrim(n->>'business_name')) BETWEEN 1 AND 150 THEN
       RETURN NEW;
     END IF;
     -- Buyer updating their already-claimed card (business_name & review_url)
     IF TG_TABLE_NAME='card' AND TG_OP='UPDATE' AND o->>'claim_mode'='google_first_claim' AND n->>'claim_mode'='google_first_claim' AND o->>'v2_activated_at' IS NOT NULL AND n->>'v2_activated_at' IS NOT NULL AND n->'id'=o->'id' AND n->'created_at'=o->'created_at' AND n->'card_code'=o->'card_code' AND n->'v2_activated_at'=o->'v2_activated_at' AND n->>'review_url' ~ '^https://search[.]google[.]com/local/writereview[?]placeid=ChI[A-Za-z0-9_-]{5,250}$' AND length(btrim(n->>'business_name')) BETWEEN 1 AND 150 AND EXISTS (SELECT 1 FROM public.buyer_card_ownership WHERE card_code=o->>'card_code' AND user_id=auth.uid()) THEN
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
END
$function$;

-- 4. Resync fingerprint atomically and assert ACL
UPDATE rr_v2_control.state SET fingerprint = rr_v2_test.fingerprint() WHERE id;
SELECT rr_v2_test.assert_acl();

COMMIT;
