-- Integration test for an isolated local/staging database AFTER applying migration.
-- Requires a privileged test connection (creates a temporary-in-transaction trigger).
-- Never run on production. All test DDL and rows are rolled back.
\set ON_ERROR_STOP on
BEGIN;

DO $test$
BEGIN
  IF has_function_privilege('anon', 'public.create_review_card(text,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.create_review_card(text,text)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.create_review_card(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected RPC execution grants';
  END IF;
END;
$test$;

CREATE FUNCTION public.rr_test_fail_activation_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $test$
BEGIN
  IF NEW.card_code = current_setting('rr_test.fail_code', true) THEN
    RAISE EXCEPTION 'Forced second insert failure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$test$;

CREATE TRIGGER rr_test_fail_activation_insert
BEFORE INSERT ON public.card_activation
FOR EACH ROW EXECUTE FUNCTION public.rr_test_fail_activation_insert();

SET LOCAL ROLE service_role;
DO $test$
DECLARE
  v_code text;
  v_hash text := repeat('a', 64);
BEGIN
  -- Find an unused numeric code; never overwrite existing cards.
  LOOP
    v_code := (9900000000::bigint + floor(random() * 100000000)::bigint)::text;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.card WHERE card_code = v_code)
      AND NOT EXISTS (SELECT 1 FROM public.card_activation WHERE card_code = v_code);
  END LOOP;

  PERFORM set_config('rr_test.fail_code', v_code, true);
  BEGIN
    PERFORM public.create_review_card(v_code, v_hash);
    RAISE EXCEPTION 'Expected second insert failure';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.card WHERE card_code = v_code)
    OR EXISTS (SELECT 1 FROM public.card_activation WHERE card_code = v_code) THEN
    RAISE EXCEPTION 'Atomicity failed: orphaned row after second insert failure';
  END IF;

  PERFORM set_config('rr_test.fail_code', '', true);
  IF public.create_review_card(v_code, v_hash) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'RPC did not return true';
  END IF;
  IF (SELECT count(*) FROM public.card WHERE card_code = v_code) <> 1
    OR (SELECT count(*) FROM public.card_activation
        WHERE card_code = v_code AND activation_code_hash = v_hash) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one matching pair';
  END IF;

  BEGIN
    PERFORM public.create_review_card(v_code, repeat('b', 64));
    RAISE EXCEPTION 'Expected duplicate code rejection';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  IF (SELECT count(*) FROM public.card WHERE card_code = v_code) <> 1
    OR (SELECT count(*) FROM public.card_activation
        WHERE card_code = v_code AND activation_code_hash = v_hash) <> 1 THEN
    RAISE EXCEPTION 'Duplicate request changed existing card';
  END IF;

  BEGIN
    PERFORM public.create_review_card('bad-code', v_hash);
    RAISE EXCEPTION 'Expected invalid code rejection';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.create_review_card(v_code, 'invalid-hash');
    RAISE EXCEPTION 'Expected invalid hash rejection';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$test$;
RESET ROLE;
ROLLBACK;
