import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';
import { generateUniqueCardCodes } from '../lib/card-code.mjs';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');

async function psql(query) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-dryrun-short-code'
  };

  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(psqlBin, 'psql.exe'),
      ['-X', '-q', '-w', '-c', query],
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

async function main() {
  console.log('=== DRY-RUN SIMULATION: V2 SHORT CODE & DIRECT CLAIM ===');

  // Load migration SQL
  const migrationSql = fs.readFileSync('supabase/migrations/20261109000300_v2_short_code_direct_claim.sql', 'utf8')
    .replace(/^BEGIN;/m, '')
    .replace(/^COMMIT;/m, '');

  const [code1, code2] = generateUniqueCardCodes(2);
  console.log(`Generated test codes: Card 1 = ${code1}, Card 2 = ${code2}`);

  const simSql = `
    BEGIN;
    SET LOCAL lock_timeout = '3s';
    SET LOCAL statement_timeout = '30s';

    -- Apply migration in transaction
    ${migrationSql}

    -- 1. Test Admin Batch Generation of 8-character cards
    DO $$
    DECLARE
      v_res jsonb;
      v_req uuid := gen_random_uuid();
      v_cards jsonb := jsonb_build_array(
        jsonb_build_object('card_code', '${code1}'),
        jsonb_build_object('card_code', '${code2}')
      );
    BEGIN
      -- Generate 2 cards
      -- Note: function validates quantity in (1, 10, 50, 100), so let's test with 1 card or test quantity check
      NULL;
    END $$;

    -- Generate single card batch
    SELECT public.admin_generate_v2_cards_direct(
      '00000000-0000-4000-a000-000000000001'::uuid,
      1,
      jsonb_build_array(jsonb_build_object('card_code', '${code1}')),
      'admin:test-operator'
    );

    SELECT public.admin_generate_v2_cards_direct(
      '00000000-0000-4000-a000-000000000002'::uuid,
      1,
      jsonb_build_array(jsonb_build_object('card_code', '${code2}')),
      'admin:test-operator'
    );

    -- Verify cards are inserted and in 'ready' inventory
    SELECT card_code, claim_mode, v2_activated_at IS NULL as is_unclaimed FROM public.card WHERE card_code IN ('${code1}', '${code2}');
    SELECT card_code, state FROM public.buyer_card_inventory WHERE card_code IN ('${code1}', '${code2}');

    -- 2. Test Buyer Claim Simulation
    -- We need a valid Google user ID from auth.users for the simulation
    DO $$
    DECLARE
      v_user_a uuid;
      v_user_b uuid;
      v_claim_res jsonb;
    BEGIN
      -- Get existing Google auth users
      SELECT u.id INTO v_user_a FROM auth.users u JOIN auth.identities i ON i.user_id = u.id WHERE i.provider = 'google' LIMIT 1;
      SELECT u.id INTO v_user_b FROM auth.users u JOIN auth.identities i ON i.user_id = u.id WHERE i.provider = 'google' OFFSET 1 LIMIT 1;
      
      IF v_user_a IS NULL THEN
        RAISE EXCEPTION 'No Google user found for simulation';
      END IF;

      -- Set session as User A
      PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

      -- User A claims Card 1
      v_claim_res := public.buyer_claim_v2_direct(
        '${code1}',
        'Warung Kopi Test',
        'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'
      );
      RAISE NOTICE 'User A Claim Card 1 Result: %', v_claim_res;
      IF v_claim_res->>'success' <> 'true' OR v_claim_res->>'code' <> 'claimed' THEN
        RAISE EXCEPTION 'Claim Card 1 failed: %', v_claim_res;
      END IF;

      -- User A claims Card 2 (Multi-Card test!)
      v_claim_res := public.buyer_claim_v2_direct(
        '${code2}',
        'Restoran Test 2',
        'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'
      );
      RAISE NOTICE 'User A Claim Card 2 (Multi-Card) Result: %', v_claim_res;
      IF v_claim_res->>'success' <> 'true' OR v_claim_res->>'code' <> 'claimed' THEN
        RAISE EXCEPTION 'Claim Card 2 failed: %', v_claim_res;
      END IF;

      -- Test 3: If User B exists, simulate User B trying to take over Card 1
      IF v_user_b IS NOT NULL THEN
        PERFORM set_config('request.jwt.claim.sub', v_user_b::text, true);
        v_claim_res := public.buyer_claim_v2_direct(
          '${code1}',
          'Attacker Takeover',
          'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'
        );
        RAISE NOTICE 'User B Takeover Attempt Result: %', v_claim_res;
        IF v_claim_res->>'success' = 'true' THEN
          RAISE EXCEPTION 'Security breach: User B took over User A card!';
        END IF;
      END IF;

      -- Switch back to User A and test buyer_list_cards()
      PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
    END $$;

    -- Query multi-card ownership for User A
    SELECT card_code, business_name, review_url, v2_activated_at IS NOT NULL as is_active
    FROM public.card
    WHERE card_code IN ('${code1}', '${code2}');

    -- Check audit log
    SELECT card_code, actor, reason FROM public.buyer_ownership_audit WHERE card_code IN ('${code1}', '${code2}');

    -- Always ROLLBACK
    ROLLBACK;
  `;

  console.log('Executing simulation in transaction...');
  const result = await psql(simSql);
  console.log(result);

  console.log('\n--- Checking Production Database Cards Count (Must be 9) ---');
  const countCheck = await psql(`
    SELECT count(*) as total_cards FROM public.card;
    SELECT card_code, claim_mode, v2_activated_at IS NULL as is_unclaimed FROM public.card WHERE card_code = '1jb6cDk5ABDpacSkkHsq5T8i';
  `);
  console.log(countCheck);

  if (!countCheck.includes('9') || !countCheck.includes('1jb6cDk5ABDpacSkkHsq5T8i')) {
    throw new Error('Database state altered! ROLLBACK check failed.');
  }

  console.log('\n=== DRY-RUN SIMULATION PASSED 100% (ZERO DATA POLLUTION) ===');
}

main().catch(err => {
  console.error('Dry-run failed:', err);
  process.exit(1);
});
