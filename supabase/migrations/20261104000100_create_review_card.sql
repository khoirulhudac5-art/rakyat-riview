-- Review and apply manually after validating the existing schema in staging.
-- No existing tables, card rows, activation RPCs, or RLS policies are changed.
BEGIN;

CREATE FUNCTION public.create_review_card(
  p_card_code text,
  p_activation_code_hash text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF p_card_code IS NULL OR p_card_code !~ '^[0-9]{3,10}$' THEN
    RAISE EXCEPTION 'Invalid card code' USING ERRCODE = '22023';
  END IF;
  IF p_activation_code_hash IS NULL OR p_activation_code_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid activation hash' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.card (card_code) VALUES (p_card_code);
  INSERT INTO public.card_activation (card_code, activation_code_hash)
  VALUES (p_card_code, p_activation_code_hash);

  -- Do not catch insert errors: PostgreSQL rolls back both writes on failure.
  RETURN true;
END;
$function$;

-- Only the backend Supabase secret/service-role key may call this function.
REVOKE ALL ON FUNCTION public.create_review_card(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_review_card(text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
