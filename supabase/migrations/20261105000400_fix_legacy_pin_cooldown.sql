-- Additional forward-only patch; earlier migration files remain unchanged.
-- Based on the restored V1 RPC and verified only in isolated local PostgreSQL.
-- Production execution requires separate explicit approval.
-- CREATE OR REPLACE preserves the owner and EXECUTE ACL. No data backfill.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

CREATE OR REPLACE FUNCTION public.update_card_review_url(
  p_card_code text, p_pin text, p_review_url text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_hash text;
  v_attempts integer;
  v_locked_until timestamptz;
BEGIN
  -- Do not add new length/format restrictions to verification of legacy PINs.
  IF p_pin IS NULL OR p_review_url IS NULL
    OR length(p_review_url) > 2048
    OR p_review_url !~* '^https://(maps\.app\.goo\.gl|www\.google\.com|google\.com|search\.google\.com)/'
  THEN
    RETURN false;
  END IF;

  INSERT INTO public.card_pin_attempts (card_code)
  VALUES (p_card_code)
  ON CONFLICT (card_code) DO NOTHING;

  SELECT attempts, locked_until
  INTO v_attempts, v_locked_until
  FROM public.card_pin_attempts
  WHERE card_code = p_card_code
  FOR UPDATE;

  IF v_locked_until > now() THEN
    RETURN false;
  END IF;

  SELECT pin_hash INTO v_hash
  FROM public.card
  WHERE card_code = p_card_code;

  -- NULL/unknown verification results must never authorize an update.
  IF (v_hash = extensions.crypt(p_pin, v_hash)) IS NOT TRUE THEN
    v_attempts := CASE
      WHEN v_locked_until <= now() THEN 1
      ELSE v_attempts + 1
    END;

    UPDATE public.card_pin_attempts
    SET attempts = v_attempts,
        locked_until = CASE
          WHEN v_attempts >= 5 THEN now() + interval '15 minutes'
          ELSE NULL
        END
    WHERE card_code = p_card_code;
    RETURN false;
  END IF;

  UPDATE public.card
  SET review_url = p_review_url
  WHERE card_code = p_card_code;

  UPDATE public.card_pin_attempts
  SET attempts = 0, locked_until = NULL
  WHERE card_code = p_card_code;

  RETURN true;
END;
$function$;

COMMIT;
