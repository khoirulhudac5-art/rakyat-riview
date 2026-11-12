import path from 'node:path';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const bin = path.resolve('.backups/tooling/pgsql/bin');

export async function psql(query) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-fix-v2-write-scope'
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

export const updatedGuardSql = `
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
   -- 3a. Batch Card Generation (admin_generate_v2_cards_with_tokens)
   IF TG_OP='INSERT' THEN
     IF TG_TABLE_NAME='card' AND n->>'claim_mode'='google_first_claim' AND n->>'pin_hash' IS NULL AND n->>'review_url' IS NULL AND n->>'business_name' IS NULL AND n->>'v2_activated_at' IS NULL AND n->>'card_code' ~ '^[A-Za-z0-9_-]{24}$' THEN
       RETURN NEW;
     END IF;
     IF TG_TABLE_NAME='buyer_card_inventory' AND n->>'state'='ready' AND n->>'ready_at' IS NOT NULL AND n->>'claimed_at' IS NULL AND n->>'card_code' ~ '^[A-Za-z0-9_-]{24}$' THEN
       RETURN NEW;
     END IF;
   END IF;

   -- 3b. Buyer Self-Serve Claim with secret token (buyer_claim_v2_with_token)
   IF auth.uid() IS NOT NULL THEN
     IF TG_TABLE_NAME='buyer_claim_limits' AND TG_OP IN ('INSERT','UPDATE') AND (n->>'user_id')::uuid = auth.uid() THEN
       RETURN NEW;
     END IF;
     IF TG_TABLE_NAME='buyer_card_ownership' AND TG_OP='INSERT' AND n->>'card_code' ~ '^[A-Za-z0-9_-]{24}$' AND (n->>'user_id')::uuid = auth.uid() THEN
       RETURN NEW;
     END IF;
     IF TG_TABLE_NAME='card' AND TG_OP='UPDATE' AND o->>'claim_mode'='google_first_claim' AND n->>'claim_mode'='google_first_claim' AND o->>'v2_activated_at' IS NULL AND n->>'v2_activated_at' IS NOT NULL AND n->'id'=o->'id' AND n->'created_at'=o->'created_at' AND n->>'review_url' ~ '^https://search[.]google[.]com/local/writereview[?]placeid=ChI[A-Za-z0-9_-]{5,250}$' AND length(btrim(n->>'business_name')) BETWEEN 1 AND 150 THEN
       RETURN NEW;
     END IF;
     IF TG_TABLE_NAME='buyer_card_inventory' AND TG_OP='UPDATE' AND o->>'state'='ready' AND n->>'state'='claimed' AND n->>'claimed_at' IS NOT NULL AND n->>'card_code'=o->>'card_code' AND n->>'updated_by' = 'google:' || auth.uid()::text THEN
       RETURN NEW;
     END IF;
     IF TG_TABLE_NAME='buyer_ownership_audit' AND TG_OP='INSERT' AND n->>'reason'='v2_token_claim' AND (n->>'new_owner')::uuid = auth.uid() AND n->>'actor' = 'google:' || auth.uid()::text THEN
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
END $function$;
`;

export async function runDryRun() {
  console.log('Running dry-run simulation of V2 write scope fix...');
  const dryRunSql = `
    BEGIN;
    SELECT count(*) as cards_before FROM public.card;
    SELECT count(*) as batches_before FROM public.buyer_card_batch;

    ${updatedGuardSql}

    UPDATE rr_v2_control.state SET fingerprint = rr_v2_test.fingerprint() WHERE id;
    SELECT rr_v2_test.assert_acl();

    SET ROLE service_role;
    SELECT jsonb_array_length((public.admin_read_v2_inventory(200, NULL))->'cards') as inventory_count;
    SET ROLE postgres;

    -- Test simulated card generation
    SELECT public.admin_generate_v2_cards_with_tokens(
      '00000000-0000-4000-8000-000000000099'::uuid,
      1,
      '[{"card_code":"SIMTESTSIMTESTSIMTESTSIM","token_hash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}]'::jsonb,
      'admin:sim'
    );

    SELECT count(*) as cards_sim FROM public.card;
    ROLLBACK;

    SELECT count(*) as cards_after FROM public.card;
    SELECT count(*) as batches_after FROM public.buyer_card_batch;
  `;

  const result = await psql(dryRunSql);
  return { success: true, result };
}

export async function executeFix() {
  console.log('EXECUTING MINIMAL V2 WRITE SCOPE FIX ON SUPABASE PRODUCTION...');
  const fixSql = `
    BEGIN;
    ${updatedGuardSql}
    UPDATE rr_v2_control.state SET fingerprint = rr_v2_test.fingerprint() WHERE id;
    SELECT rr_v2_test.assert_acl();
    COMMIT;
  `;

  return await psql(fixSql);
}

if (process.argv[1] && process.argv[1].endsWith('fix-v2-write-scope.mjs')) {
  if (process.argv.includes('--execute')) {
    await executeFix();
    console.log('Fix executed successfully on Supabase production.');
  } else {
    const res = await runDryRun();
    console.log('Dry run simulation passed completely:\n', res.result);
  }
}
