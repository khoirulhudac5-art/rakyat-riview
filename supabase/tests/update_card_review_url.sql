-- ONLY an isolated local test database. Roll back every fixture and assertion.
\set ON_ERROR_STOP on
BEGIN;
DO $test$
DECLARE
  v_code text := 'rpc-pin-synthetic';
  v_pin text := 'legacy synthetic PIN';
  v_hash text;
  v_url text := 'https://www.google.com/maps';
  v_before text := 'https://www.google.com/original';
  v_deadline timestamptz;
  v_i integer;
  v_result boolean;
BEGIN
  -- Refuse collisions rather than editing existing rows.
  IF EXISTS (SELECT 1 FROM public.card WHERE card_code = v_code)
    OR EXISTS (SELECT 1 FROM public.card_pin_attempts WHERE card_code = v_code) THEN
    RAISE EXCEPTION 'Synthetic fixture collision';
  END IF;
  v_hash := extensions.crypt(v_pin, extensions.gen_salt('bf'));
  INSERT INTO public.card(card_code, business_name, review_url, pin_hash)
  VALUES (v_code, 'Synthetic test only', v_before, v_hash);

  v_result := public.update_card_review_url(v_code, NULL, v_url);
  IF v_result IS DISTINCT FROM false
    OR EXISTS (SELECT 1 FROM public.card_pin_attempts WHERE card_code = v_code)
    OR (SELECT review_url FROM public.card WHERE card_code = v_code) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'NULL PIN must fail without writes';
  END IF;

  FOR v_i IN 1..5 LOOP
    v_result := public.update_card_review_url(v_code, 'wrong synthetic PIN', v_url);
    IF v_result IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'Incorrect PIN accepted';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.card_pin_attempts
      WHERE card_code = v_code AND attempts = v_i
      AND CASE WHEN v_i < 5 THEN locked_until IS NULL
        ELSE locked_until = now() + interval '15 minutes' END) THEN
      RAISE EXCEPTION 'Unexpected counter/lock on attempt %', v_i;
    END IF;
  END LOOP;
  SELECT locked_until INTO v_deadline FROM public.card_pin_attempts WHERE card_code = v_code;
  IF public.update_card_review_url(v_code, NULL, v_url) IS DISTINCT FROM false
    OR public.update_card_review_url(v_code, v_pin, v_url) IS DISTINCT FROM false
    OR public.update_card_review_url(v_code, 'wrong synthetic PIN', v_url) IS DISTINCT FROM false
    OR NOT EXISTS (SELECT 1 FROM public.card_pin_attempts
      WHERE card_code = v_code AND attempts = 5 AND locked_until = v_deadline) THEN
    RAISE EXCEPTION 'Active lock must reject all PINs without extending lock';
  END IF;

  -- At the exact expiry boundary, the next failure starts at one.
  UPDATE public.card_pin_attempts SET locked_until = now() WHERE card_code = v_code;
  v_result := public.update_card_review_url(v_code, 'wrong synthetic PIN', v_url);
  IF v_result IS DISTINCT FROM false
    OR NOT EXISTS (SELECT 1 FROM public.card_pin_attempts
      WHERE card_code = v_code AND attempts = 1 AND locked_until IS NULL) THEN
    RAISE EXCEPTION 'Expired lock did not reset to one';
  END IF;
  FOR v_i IN 2..5 LOOP
    PERFORM public.update_card_review_url(v_code, 'wrong synthetic PIN', v_url);
    IF NOT EXISTS (SELECT 1 FROM public.card_pin_attempts
      WHERE card_code = v_code AND attempts = v_i
      AND CASE WHEN v_i < 5 THEN locked_until IS NULL
        ELSE locked_until = now() + interval '15 minutes' END) THEN
      RAISE EXCEPTION 'Second cycle counter/lock mismatch';
    END IF;
  END LOOP;

  UPDATE public.card_pin_attempts SET locked_until = now() - interval '1 second'
  WHERE card_code = v_code;
  v_result := public.update_card_review_url(v_code, v_pin, v_url);
  IF v_result IS DISTINCT FROM true
    OR NOT EXISTS (SELECT 1 FROM public.card_pin_attempts
      WHERE card_code = v_code AND attempts = 0 AND locked_until IS NULL)
    OR NOT EXISTS (SELECT 1 FROM public.card
      WHERE card_code = v_code AND review_url = v_url AND pin_hash = v_hash
      AND business_name = 'Synthetic test only') THEN
    RAISE EXCEPTION 'Legacy bcrypt PIN failed or existing card/hash changed';
  END IF;

  IF public.update_card_review_url(v_code, v_pin, NULL) IS DISTINCT FROM false
    OR public.update_card_review_url(v_code, v_pin, 'https://invalid.example/') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'URL validation changed';
  END IF;

  UPDATE public.card SET pin_hash = NULL WHERE card_code = v_code;
  IF public.update_card_review_url(v_code, v_pin, v_before) IS DISTINCT FROM false
    OR (SELECT review_url FROM public.card WHERE card_code = v_code) IS DISTINCT FROM v_url THEN
    RAISE EXCEPTION 'Unknown verification result must fail';
  END IF;
  RAISE NOTICE 'PASS: NULL rejection, bcrypt compatibility, counters, expiry, and fail-closed verification';
END;
$test$;
ROLLBACK;
