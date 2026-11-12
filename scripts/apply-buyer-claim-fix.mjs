import path from 'node:path';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');
const baseEnv = firstClaimConnection();
const env = { ...baseEnv, PGOPTIONS: '-c default_transaction_read_only=off -c statement_timeout=10000' };

const updateSql = `
CREATE OR REPLACE FUNCTION public.buyer_claim_v2_direct(p_card_code text, p_business_name text, p_review_url text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_card public.card%ROWTYPE;
  v_owner uuid;
  v_count integer;
BEGIN
  -- Buyer must be authenticated (supports both Email and Google auth)
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthenticated');
  END IF;

  -- Validate parameters (supports 1..30 character card codes)
  IF p_card_code IS NULL OR p_card_code !~ '^[A-Za-z0-9_-]{1,30}$'
     OR p_business_name IS NULL OR length(btrim(p_business_name)) NOT BETWEEN 1 AND 150
     OR p_review_url IS NULL OR length(p_review_url) > 2048
     OR p_review_url !~ '^https://search\\.google\\.com/local/writereview\\?placeid=ChI[A-Za-z0-9_-]{5,250}$' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_claim');
  END IF;

  -- Rate limiting protection (max 20 attempts per 15 minutes per buyer)
  INSERT INTO public.buyer_claim_limits(user_id, window_start, attempts) VALUES(auth.uid(), now(), 1)
  ON CONFLICT(user_id) DO UPDATE SET
    attempts = CASE WHEN buyer_claim_limits.window_start <= now() - interval '15 minutes' THEN 1 ELSE buyer_claim_limits.attempts + 1 END,
    window_start = CASE WHEN buyer_claim_limits.window_start <= now() - interval '15 minutes' THEN now() ELSE buyer_claim_limits.window_start END
  RETURNING attempts INTO v_count;
  IF v_count > 20 THEN
    RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
  END IF;

  -- Lock card row
  SELECT * INTO v_card FROM public.card WHERE card_code = p_card_code FOR UPDATE;
  IF NOT FOUND OR v_card.claim_mode <> 'google_first_claim' THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_claimable');
  END IF;

  -- Check ownership
  SELECT user_id INTO v_owner FROM public.buyer_card_ownership WHERE card_code = p_card_code;
  IF v_owner IS NOT NULL THEN
    RETURN jsonb_build_object('success', v_owner = auth.uid() AND v_card.v2_activated_at IS NOT NULL, 'code', 'already_claimed');
  END IF;

  -- Verify inventory state is ready
  PERFORM 1 FROM public.buyer_card_inventory WHERE card_code = p_card_code AND state = 'ready' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_ready');
  END IF;

  IF v_card.v2_activated_at IS NOT NULL OR v_card.pin_hash IS NOT NULL OR v_card.review_url IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_claimable');
  END IF;

  -- Atomic claim transaction
  INSERT INTO public.buyer_card_ownership(card_code, user_id) VALUES(p_card_code, auth.uid());
  UPDATE public.card SET business_name = btrim(p_business_name), review_url = p_review_url, v2_activated_at = now()
  WHERE card_code = p_card_code;
  UPDATE public.buyer_card_inventory SET state = 'claimed', claimed_at = now(), updated_at = now(), updated_by = 'google:' || auth.uid()::text
  WHERE card_code = p_card_code;
  INSERT INTO public.buyer_ownership_audit(card_code, new_owner, actor, reason)
  VALUES(p_card_code, auth.uid(), 'google:' || auth.uid()::text, 'v2_direct_claim');

  RETURN jsonb_build_object('success', true, 'code', 'claimed');
END;
$function$;

REVOKE ALL ON FUNCTION public.buyer_claim_v2_direct(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_claim_v2_direct(text, text, text) TO authenticated, service_role;
`;

const child = spawn(
  path.join(psqlBin, 'psql.exe'),
  ['-X', '-q', '-w', '-c', updateSql],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
);
let out = '', err = '';
child.stdout.on('data', x => out += x);
child.stderr.on('data', x => err += x);
child.on('close', code => {
  if (code === 0) {
    console.log('Successfully updated buyer_claim_v2_direct function!');
  } else {
    console.error('Failed with code', code, err);
    process.exit(1);
  }
});
