-- Migration: 20261109000200_v2_public_card_status.sql
-- Description: Provide safe, minimal public card readiness status for V2 cards without exposing tokens or owners.

CREATE OR REPLACE FUNCTION public.buyer_v2_public_card_status(p_card_code text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object(
    'code', c.card_code,
    'activation_state', CASE WHEN c.v2_activated_at IS NOT NULL OR c.pin_hash IS NOT NULL THEN 'active' ELSE 'inactive' END,
    'activation_reason', CASE WHEN c.claim_mode = 'google_first_claim' AND c.v2_activated_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.buyer_card_inventory i WHERE i.card_code = c.card_code AND i.state = 'ready') THEN 'inventory_not_ready' ELSE NULL END,
    'claim_allowed', EXISTS(SELECT 1 FROM public.buyer_card_inventory i WHERE i.card_code = c.card_code AND i.state = 'ready') AND c.claim_mode = 'google_first_claim' AND c.v2_activated_at IS NULL AND c.pin_hash IS NULL AND c.review_url IS NULL AND NOT EXISTS(SELECT 1 FROM public.buyer_card_ownership o WHERE o.card_code = c.card_code)
  )
  FROM public.card c WHERE c.card_code = p_card_code;
$$;

REVOKE ALL ON FUNCTION public.buyer_v2_public_card_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.buyer_v2_public_card_status(text) TO anon, authenticated, service_role;
