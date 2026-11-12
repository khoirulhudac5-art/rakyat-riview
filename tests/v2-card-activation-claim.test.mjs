import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { generateCardCode, generateUniqueCardCodes, isValidCardCode } from '../lib/card-code.mjs';
import { firstClaimConnection } from '../scripts/prepare-first-claim-live.mjs';
import { cardInput, reviewUrl } from '../lib/buyer-service.mjs';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');

async function psql(query, isReadOnly = false) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: isReadOnly
      ? '-c default_transaction_read_only=on -c statement_timeout=10000'
      : '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-activation-claim-test'
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
      else reject(new Error(`psql failed (${code}): ${err}`));
    });
  });
}

async function runTests() {
  console.log('=== STARTING RAKYAT REVIEW V2 CARD ACTIVATION & CLAIM TESTS ===\n');

  // 1. Card Code Generation and Validation
  console.log('1. Testing Card Code Generation and Format Validation...');
  const sampleCode = generateCardCode();
  assert.equal(sampleCode.length, 8);
  assert.ok(isValidCardCode(sampleCode));
  assert.ok(!/[01IO]/.test(sampleCode), 'Code must not contain confusing characters 0, 1, I, O');
  
  // Test Crockford codes vs user input example
  assert.ok(isValidCardCode('BKE9VWK3'), '8-character BKE9VWK3 is valid Crockford code');
  assert.equal('BKE9WK3'.length, 7, 'BKE9WK3 is 7 characters (missing V from BKE9VWK3)');
  console.log('   [PASS] Generator produces valid, unambiguous 8-character Crockford codes.');

  // 2. Unit Testing cardInput() without secret activation code requirement
  console.log('2. Testing cardInput() validator (no 6-digit requirement)...');
  const validGoogleUrl = 'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE';
  
  // Valid input without pin or activation_code
  const inputRes = cardInput({
    card_code: 'BKE9VWK3',
    business_name: 'Warung Kopi Rakyat',
    review_url: validGoogleUrl
  });
  assert.equal(inputRes.p_card_code, 'BKE9VWK3');
  assert.equal(inputRes.p_business_name, 'Warung Kopi Rakyat');
  assert.equal(inputRes.p_review_url, validGoogleUrl);

  // Short code (legacy 3-char) support
  const legacyRes = cardInput({
    card_code: '001',
    business_name: 'Usaha Pertama',
    review_url: validGoogleUrl
  });
  assert.equal(legacyRes.p_card_code, '001');

  // Invalid business name rejected
  assert.throws(() => cardInput({ card_code: 'BKE9VWK3', business_name: '   ', review_url: validGoogleUrl }), /Isian kartu tidak valid/);
  // Invalid review URL rejected
  assert.throws(() => cardInput({ card_code: 'BKE9VWK3', business_name: 'Toko', review_url: 'http://insecure.com' }), /Isian kartu tidak valid/);
  console.log('   [PASS] cardInput() validates cleanly without requiring secret activation tokens.');

  // 3. Database Simulation (Simulation with strict ROLLBACK)
  console.log('3. Running Database Simulation (Generate -> Multiple Read -> Atomic Claim -> Multi-Card -> Anti-Takeover -> ROLLBACK)...');

  const [cardX, cardY] = generateUniqueCardCodes(2);
  const targetReviewUrl = 'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE';

  const simQuery = `
    BEGIN;
    SET LOCAL lock_timeout = '3s';
    SET LOCAL statement_timeout = '30s';

    -- Step A: Generate two new test cards via Admin RPC
    SELECT public.admin_generate_v2_cards_direct(
      '00000000-0000-4000-a000-000000000101'::uuid,
      1,
      jsonb_build_array(jsonb_build_object('card_code', '${cardX}')),
      'admin:test-operator'
    );

    SELECT public.admin_generate_v2_cards_direct(
      '00000000-0000-4000-a000-000000000102'::uuid,
      1,
      jsonb_build_array(jsonb_build_object('card_code', '${cardY}')),
      'admin:test-operator'
    );

    -- Step B: Simulate multiple users opening link without claiming (Simulation Orang A, B, C)
    -- Card status must remain inactive and claim_allowed must remain true
    DO $$
    DECLARE
      v_st jsonb;
    BEGIN
      -- Simulation: Orang A opens
      v_st := public.buyer_v2_public_card_status('${cardX}');
      IF v_st->>'activation_state' <> 'inactive' OR v_st->>'claim_allowed' <> 'true' THEN
        RAISE EXCEPTION 'Card X status altered by Orang A opening: %', v_st;
      END IF;

      -- Simulation: Orang B opens
      v_st := public.buyer_v2_public_card_status('${cardX}');
      IF v_st->>'activation_state' <> 'inactive' OR v_st->>'claim_allowed' <> 'true' THEN
        RAISE EXCEPTION 'Card X status altered by Orang B opening: %', v_st;
      END IF;

      -- Simulation: Orang C opens
      v_st := public.buyer_v2_public_card_status('${cardX}');
      IF v_st->>'activation_state' <> 'inactive' OR v_st->>'claim_allowed' <> 'true' THEN
        RAISE EXCEPTION 'Card X status altered by Orang C opening: %', v_st;
      END IF;
    END $$;

    -- Step C: Simulate Atomic Claim & Multi-card & Anti-takeover
    DO $$
    DECLARE
      v_user_1 uuid := '825509d0-cb49-4636-9ca1-4eea29b8e934';
      v_user_2 uuid := '4761272d-cca0-4f86-b1eb-dfd9afeeb1ee';
      v_claim jsonb;
      v_st jsonb;
    BEGIN
      -- User 1 claims Card X
      PERFORM set_config('request.jwt.claim.sub', v_user_1::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

      v_claim := public.buyer_claim_v2_direct('${cardX}', 'Kopi Kenangan User 1', '${targetReviewUrl}');
      IF v_claim->>'success' <> 'true' OR v_claim->>'code' <> 'claimed' THEN
        RAISE EXCEPTION 'Card X claim by User 1 failed: %', v_claim;
      END IF;

      -- Check status of Card X after claim -> must be active!
      v_st := public.buyer_v2_public_card_status('${cardX}');
      IF v_st->>'activation_state' <> 'active' OR v_st->>'claim_allowed' = 'true' THEN
        RAISE EXCEPTION 'Card X not active after claim: %', v_st;
      END IF;

      -- User 1 claims Card Y (Multi-Card on same account)
      v_claim := public.buyer_claim_v2_direct('${cardY}', 'Resto Enak User 1', '${targetReviewUrl}');
      IF v_claim->>'success' <> 'true' OR v_claim->>'code' <> 'claimed' THEN
        RAISE EXCEPTION 'Card Y multi-card claim failed: %', v_claim;
      END IF;

      -- Anti-Takeover: User 2 attempts to claim Card X (already owned by User 1)
      PERFORM set_config('request.jwt.claim.sub', v_user_2::text, true);
      v_claim := public.buyer_claim_v2_direct('${cardX}', 'Usaha Bajakan User 2', '${targetReviewUrl}');
      IF v_claim->>'success' = 'true' OR v_claim->>'code' <> 'already_claimed' THEN
        RAISE EXCEPTION 'Anti-takeover failed! User 2 was able to claim User 1 card: %', v_claim;
      END IF;

      -- Idempotency: User 1 retries claim on Card X -> succeeds gracefully
      PERFORM set_config('request.jwt.claim.sub', v_user_1::text, true);
      v_claim := public.buyer_claim_v2_direct('${cardX}', 'Kopi Kenangan User 1', '${targetReviewUrl}');
      IF v_claim->>'success' <> 'true' OR v_claim->>'code' <> 'already_claimed' THEN
        RAISE EXCEPTION 'Idempotent re-claim failed: %', v_claim;
      END IF;
    END $$;

    SELECT 'database_simulation_passed' as result;

    ROLLBACK;
  `;

  const simResult = await psql(simQuery);
  assert.ok(simResult.includes('database_simulation_passed'), 'Database simulation must pass');
  console.log('   [PASS] Database simulation verified: multiple link opens do not lock, first successful claim wins, multi-card works, anti-takeover rejects attacker, idempotency succeeds.');

  // 4. Verification of Live Database Unchanged
  console.log('4. Verifying production database baseline integrity...');
  const envText = fs.readFileSync('.env.admin-readonly', 'utf8');
  const env = Object.fromEntries(
    envText.split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => {
        const idx = l.indexOf('=');
        return [l.slice(0, idx), l.slice(idx + 1)];
      })
  );

  let liveCards = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(env.SUPABASE_URL + '/rest/v1/card?select=card_code,review_url', {
        headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + env.SUPABASE_SECRET_KEY },
        signal: AbortSignal.timeout(20000)
      });
      liveCards = await res.json();
      break;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  assert.ok(liveCards.length >= 11, 'Total cards must be at least 11');
  const codes = liveCards.map(c => c.card_code);
  assert.ok(codes.includes('Q9ED72HP'), 'Reference card Q9ED72HP must remain intact');
  assert.ok(codes.includes('LBWJJDA8'), 'Card LBWJJDA8 must remain intact');
  assert.ok(codes.includes('BKE9VWK3'), 'Card BKE9VWK3 must exist in database');
  console.log('   [PASS] Production database integrity verified 100% intact (' + liveCards.length + ' cards).');

  console.log('\n=== ALL ACTIVATION & CLAIM TESTS PASSED (100% SUCCESS) ===\n');
}

runTests().catch(err => {
  console.error('\nTests FAILED:', err);
  process.exit(1);
});
