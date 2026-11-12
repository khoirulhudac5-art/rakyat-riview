import path from 'node:path';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const bin = path.resolve('.backups/tooling/pgsql/bin');

async function psql(query) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-diagnose-write-scope'
  };

  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(bin, 'psql.exe'),
      ['-X', '-q', '-w', '-A', '-c', query],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '', err = '';
    child.stdout.on('data', x => out += x);
    child.stderr.on('data', x => err += x);
    child.on('close', code => {
      if (code === 0) resolve(out.trim());
      else reject(Error(`psql failed (${code}): ${err}`));
    });
  });
}

const updatedGuardDef = `
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

 -- 3. V2 Production Card Generation (admin_generate_v2_cards_with_tokens)
 IF TG_OP='INSERT' THEN
   IF TG_TABLE_NAME='card' AND n->>'claim_mode'='google_first_claim' AND n->>'pin_hash' IS NULL AND n->>'review_url' IS NULL AND n->>'business_name' IS NULL AND n->>'v2_activated_at' IS NULL AND n->>'card_code' ~ '^[A-Za-z0-9_-]{24}$' THEN
     RETURN NEW;
   END IF;
   IF TG_TABLE_NAME='buyer_card_inventory' AND n->>'state'='ready' AND n->>'ready_at' IS NOT NULL AND n->>'claimed_at' IS NULL AND n->>'card_code' ~ '^[A-Za-z0-9_-]{24}$' THEN
     RETURN NEW;
   END IF;
 END IF;

 -- 4. V2 Production Buyer Self-Serve Claim (buyer_claim_v2_with_token)
 IF TG_TABLE_NAME='buyer_claim_limits' AND TG_OP IN ('INSERT','UPDATE') THEN
   RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='buyer_card_ownership' AND TG_OP='INSERT' AND n->>'card_code' ~ '^[A-Za-z0-9_-]{24}$' AND n->>'user_id' IS NOT NULL THEN
   RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='card' AND TG_OP='UPDATE' AND o->>'claim_mode'='google_first_claim' AND n->>'claim_mode'='google_first_claim' AND o->>'v2_activated_at' IS NULL AND n->>'v2_activated_at' IS NOT NULL AND n->'id'=o->'id' AND n->'created_at'=o->'created_at' AND n->>'review_url' ~ '^https://search\\\\.google\\\\.com/local/writereview\\\\?placeid=ChI[A-Za-z0-9_-]{5,250}$' AND length(btrim(n->>'business_name')) BETWEEN 1 AND 150 THEN
   RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='buyer_card_inventory' AND TG_OP='UPDATE' AND o->>'state'='ready' AND n->>'state'='claimed' AND n->>'claimed_at' IS NOT NULL AND n->>'card_code'=o->>'card_code' THEN
   RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='buyer_ownership_audit' AND TG_OP='INSERT' AND n->>'reason'='v2_token_claim' AND n->>'new_owner' IS NOT NULL THEN
   RETURN NEW;
 END IF;

 -- 5. Default pause guard & test isolation
 IF TG_TABLE_NAME='card' THEN scoped:=coalesce(o->>'claim_mode','legacy')='google_first_claim' OR coalesce(n->>'claim_mode','legacy')='google_first_claim';
 ELSIF TG_TABLE_NAME IN ('card_activation','card_pin_attempts') THEN
  SELECT EXISTS(SELECT 1 FROM public.card WHERE card_code IN(o->>'card_code',n->>'card_code') AND claim_mode='google_first_claim') INTO scoped;
 END IF;
 IF scoped AND NOT rr_v2_test.write_allowed(TG_TABLE_NAME,TG_OP,o,n) THEN RAISE EXCEPTION 'Restricted write scope denied' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $function$;
`;

async function main() {
  console.log('=== DRY-RUN SIMULATION OF V2 PRODUCTION WRITE SCOPE FIX ===');

  const simulationQuery = `
    BEGIN;

    -- 1. Snapshot initial state
    SELECT count(*) as card_count_before FROM public.card;
    SELECT count(*) as batch_count_before FROM public.buyer_card_batch;

    -- 2. Apply updated guard
    ${updatedGuardDef}

    -- 3. Resync fingerprint atomically
    UPDATE rr_v2_control.state SET fingerprint = rr_v2_test.fingerprint() WHERE id;

    -- 4. Verify ACL and Admin Read access
    SELECT rr_v2_test.assert_acl();
    SET ROLE service_role;
    SELECT jsonb_array_length((public.admin_read_v2_inventory(200, NULL))->'cards') as inventory_cards_count_before;
    SELECT (public.admin_read_v2_audit(200, NULL))->>'events' as audit_events;
    SET ROLE postgres;

    -- 5. Test pilot redirect admission
    SELECT rr_claim_pilot.admit('redirect', 'iKRb7_7PyK6kg4Ye7EqvOhYu', false) as pilot_redirect_ok;

    -- 6. Test admin_generate_v2_cards_with_tokens in transaction
    SELECT public.admin_generate_v2_cards_with_tokens(
      '00000000-0000-4000-8000-000000000099'::uuid,
      1,
      '[{"card_code":"TESTTESTTESTTESTTESTTEST","token_hash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}]'::jsonb,
      'admin:simulation-test'
    ) as generate_result;

    -- 7. Verify inventory sees the new card in this transaction
    SET ROLE service_role;
    SELECT jsonb_array_length((public.admin_read_v2_inventory(200, NULL))->'cards') as inventory_cards_count_during_sim;
    SET ROLE postgres;

    -- 8. Verify rogue write (e.g. TRUNCATE or illegal update) is strictly denied
    DO $$
    BEGIN
      UPDATE public.card SET pin_hash = 'illegal' WHERE card_code = 'TESTTESTTESTTESTTESTTEST';
      RAISE EXCEPTION 'Rogue write was incorrectly allowed!';
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        -- Expected: 42501 Restricted write scope denied
        NULL;
    END $$;

    -- 9. Check card count inside transaction
    SELECT count(*) as card_count_during_sim FROM public.card;

    -- 10. ALWAYS ROLLBACK
    ROLLBACK;

    -- 11. Final verification that remote database was unchanged
    SELECT count(*) as card_count_after FROM public.card;
    SELECT count(*) as batch_count_after FROM public.buyer_card_batch;
  `;

  const output = await psql(simulationQuery);
  console.log(output);
  console.log('\n=== DRY-RUN PASSED CLEANLY AND ROLLED BACK ===');
}

main().catch(err => {
  console.error('Dry-run failed:', err);
  process.exit(1);
});
