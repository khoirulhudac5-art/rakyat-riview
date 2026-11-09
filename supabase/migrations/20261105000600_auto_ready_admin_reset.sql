-- Forward-only LOCAL preparation. Production requires explicit approval.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
ALTER TABLE public.buyer_card_inventory ADD COLUMN activation_revision bigint NOT NULL DEFAULT 0 CHECK(activation_revision>=0);
CREATE TABLE public.buyer_activation_reset_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 card_code text NOT NULL REFERENCES public.card(card_code),
 old_owner uuid NOT NULL REFERENCES auth.users(id),
 old_activated_at timestamptz NOT NULL,
 previous_revision bigint NOT NULL,
 actor text NOT NULL,
 reason text NOT NULL,
 reset_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.buyer_activation_reset_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buyer_activation_reset_audit FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE public.buyer_activation_reset_audit_id_seq FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.buyer_activation_reset_audit FROM service_role;
REVOKE ALL ON SEQUENCE public.buyer_activation_reset_audit_id_seq FROM service_role;
GRANT SELECT ON public.buyer_activation_reset_audit TO service_role;
-- New decision also releases pristine V2 drafts; never touch V1 or claimed rows.
UPDATE public.buyer_card_inventory i SET state='ready',ready_at=now(),updated_at=now(),updated_by='migration:auto-ready'
FROM public.card c WHERE c.card_code=i.card_code AND c.claim_mode='google_first_claim' AND i.state='draft'
AND c.v2_activated_at IS NULL AND c.pin_hash IS NULL AND c.review_url IS NULL
AND NOT EXISTS(SELECT 1 FROM public.buyer_card_ownership o WHERE o.card_code=c.card_code)
AND NOT EXISTS(SELECT 1 FROM public.card_activation a WHERE a.card_code=c.card_code);
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
    INSERT INTO public.buyer_card_inventory(card_code,state,ready_at,updated_by) VALUES(v_code,'ready',now(),'inventory:create');
    card_code:=v_code; RETURN NEXT;
  END LOOP;
END;
$f$;
REVOKE ALL ON FUNCTION public.admin_create_v2_cards(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_v2_cards(integer) TO service_role;


CREATE OR REPLACE FUNCTION public.admin_recover_v2_owner(p_card_code text,p_new_owner uuid,p_actor text,p_reason text)
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
  UPDATE public.buyer_card_inventory SET activation_revision=activation_revision+1,updated_at=now(),updated_by=p_actor WHERE card_code=p_card_code;
  INSERT INTO public.buyer_ownership_audit(card_code,old_owner,new_owner,actor,reason)
  VALUES(p_card_code,v_owner,p_new_owner,p_actor,btrim(p_reason));
  RETURN true;
END;
$f$;
REVOKE ALL ON FUNCTION public.admin_recover_v2_owner(text,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_recover_v2_owner(text,uuid,text,text) TO service_role;

CREATE FUNCTION public.admin_list_v2_activation_cards()
RETURNS TABLE(card_code text,business_name text,active boolean,activation_revision bigint,inventory_state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $f$
 SELECT c.card_code,c.business_name,c.v2_activated_at IS NOT NULL,i.activation_revision,i.state
 FROM public.card c JOIN public.buyer_card_inventory i USING(card_code)
 WHERE c.claim_mode='google_first_claim' ORDER BY c.created_at DESC,c.card_code;
$f$;
REVOKE ALL ON FUNCTION public.admin_list_v2_activation_cards() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_v2_activation_cards() TO service_role;
CREATE FUNCTION public.admin_reset_v2_activation(p_card_code text,p_confirmation text,p_expected_revision bigint,p_actor text,p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$
DECLARE v_card public.card%ROWTYPE; v_owner uuid; v_revision bigint; v_state text;
BEGIN
 IF p_card_code IS NULL OR p_confirmation IS DISTINCT FROM p_card_code OR p_expected_revision IS NULL OR p_expected_revision<0
 OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 150 OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 20 AND 1000 THEN RETURN false; END IF;
 SELECT * INTO v_card FROM public.card WHERE card_code=p_card_code FOR UPDATE;
 IF NOT FOUND OR v_card.claim_mode<>'google_first_claim' OR v_card.v2_activated_at IS NULL OR v_card.pin_hash IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.card_activation WHERE card_code=p_card_code) THEN RETURN false; END IF;
 SELECT activation_revision,state INTO v_revision,v_state FROM public.buyer_card_inventory WHERE card_code=p_card_code FOR UPDATE;
 IF NOT FOUND OR v_state<>'claimed' OR v_revision<>p_expected_revision THEN RETURN false; END IF;
 SELECT user_id INTO v_owner FROM public.buyer_card_ownership WHERE card_code=p_card_code FOR UPDATE;
 IF v_owner IS NULL THEN RETURN false; END IF;
 INSERT INTO public.buyer_activation_reset_audit(card_code,old_owner,old_activated_at,previous_revision,actor,reason)
 VALUES(p_card_code,v_owner,v_card.v2_activated_at,v_revision,p_actor,btrim(p_reason));
 DELETE FROM public.buyer_card_ownership WHERE card_code=p_card_code;
 UPDATE public.card SET business_name=NULL,review_url=NULL,v2_activated_at=NULL WHERE card_code=p_card_code;
 UPDATE public.buyer_card_inventory SET state='ready',ready_at=now(),claimed_at=NULL,activation_revision=activation_revision+1,updated_at=now(),updated_by=p_actor WHERE card_code=p_card_code;
 RETURN true;
END;
$f$;
REVOKE ALL ON FUNCTION public.admin_reset_v2_activation(text,text,bigint,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reset_v2_activation(text,text,bigint,text,text) TO service_role;
COMMIT;
