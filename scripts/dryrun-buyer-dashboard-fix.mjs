import { spawn } from 'node:child_process';
import path from 'node:path';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');

async function psql(query) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-dryrun-buyer'
  };

  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(psqlBin, 'psql.exe'),
      ['-X', '-q', '-w', '-t', '-A', '-c', query],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '', err = '';
    child.stdout.on('data', x => out += x);
    child.stderr.on('data', x => err += x);
    child.on('close', code => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`psql failed (${code}): ${err}`));
    });
  });
}

async function main() {
  const dryRunSql = `
BEGIN;

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

GRANT EXECUTE ON FUNCTION public.buyer_v2_list_cards() TO authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_v2_list_cards() TO service_role;

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

GRANT EXECUTE ON FUNCTION public.buyer_v2_update_card(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_v2_update_card(text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.v2_pause_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE o jsonb;n jsonb;scoped boolean:=true;
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Restricted TRUNCATE denied' USING ERRCODE='42501'; END IF;
 IF TG_OP<>'INSERT' THEN o:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN n:=to_jsonb(NEW); END IF;

 IF rr_claim_pilot.write_allowed(TG_TABLE_NAME,TG_OP,o,n) THEN
   IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
 END IF;

 IF TG_OP='INSERT' THEN
   IF rr_v2_generate.write_allowed(TG_TABLE_NAME,TG_OP,n) THEN
     RETURN NEW;
   END IF;
 END IF;

 IF current_user = 'postgres' THEN
   IF TG_OP='INSERT' THEN
     IF TG_TABLE_NAME='card' AND n->>'claim_mode'='google_first_claim' AND n->>'pin_hash' IS NULL AND n->>'review_url' IS NULL AND n->>'business_name' IS NULL AND n->>'v2_activated_at' IS NULL AND n->>'card_code' ~ '^[A-Za-z0-9_-]{8,30}$' THEN
       RETURN NEW;
     END IF;
     IF TG_TABLE_NAME='buyer_card_inventory' AND n->>'state'='ready' AND n->>'ready_at' IS NOT NULL AND n->>'claimed_at' IS NULL AND n->>'card_code' ~ '^[A-Za-z0-9_-]{8,30}$' THEN
       RETURN NEW;
     END IF;
   END IF;

   IF auth.uid() IS NOT NULL THEN
     IF TG_TABLE_NAME='buyer_claim_limits' AND TG_OP IN ('INSERT','UPDATE') AND (n->>'user_id')::uuid = auth.uid() THEN
       RETURN NEW;
     END IF;
     IF TG_TABLE_NAME='buyer_card_ownership' AND TG_OP='INSERT' AND n->>'card_code' ~ '^[A-Za-z0-9_-]{8,30}$' AND (n->>'user_id')::uuid = auth.uid() THEN
       RETURN NEW;
     END IF;
     IF TG_TABLE_NAME='card' AND TG_OP='UPDATE' AND o->>'claim_mode'='google_first_claim' AND n->>'claim_mode'='google_first_claim' AND o->>'v2_activated_at' IS NULL AND n->>'v2_activated_at' IS NOT NULL AND n->'id'=o->'id' AND n->'created_at'=o->'created_at' AND n->>'review_url' ~ '^https://search[.]google[.]com/local/writereview[?]placeid=ChI[A-Za-z0-9_-]{5,250}$' AND length(btrim(n->>'business_name')) BETWEEN 1 AND 150 THEN
       RETURN NEW;
     END IF;
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

 IF TG_TABLE_NAME='card' THEN scoped:=coalesce(o->>'claim_mode','legacy')='google_first_claim' OR coalesce(n->>'claim_mode','legacy')='google_first_claim';
 ELSIF TG_TABLE_NAME IN ('card_activation','card_pin_attempts') THEN
  SELECT EXISTS(SELECT 1 FROM public.card WHERE card_code IN(o->>'card_code',n->>'card_code') AND claim_mode='google_first_claim') INTO scoped;
 END IF;
 IF scoped AND NOT rr_v2_test.write_allowed(TG_TABLE_NAME,TG_OP,o,n) THEN RAISE EXCEPTION 'Restricted write scope denied' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END
$function$;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '4ab200cb-2ccd-4a2e-90a3-85f7d16e5893';

SELECT json_build_object(
  'update_called', public.buyer_v2_update_card('LBWJJDA8', 'RUNGKAT BERKAH JAYA', 'https://search.google.com/local/writereview?placeid=ChIJw73p24BC1i0R2jo9I4cr2qs')
)::text;

SELECT json_build_object(
  'verified_via_buyer_v2_list_cards', (SELECT json_agg(row_to_json(l)) FROM public.buyer_v2_list_cards() l)
)::text;

RESET ROLE;

SELECT json_build_object(
  'verified_via_superuser', (SELECT business_name FROM public.card WHERE card_code = 'LBWJJDA8')
)::text;

SELECT rr_v2_test.assert_acl();

ROLLBACK;
`;

  const result = await psql(dryRunSql);
  console.log('Dry-run output:\n', result);
}

main().catch(console.error);
