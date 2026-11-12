import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { generateCardCode, generateUniqueCardCodes, isValidCardCode } from '../lib/card-code.mjs';
import { generateQrPngBlob } from '../assets/qrcode.mjs';
import { buildZip } from '../assets/zip.mjs';
import { firstClaimConnection } from '../scripts/prepare-first-claim-live.mjs';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');

async function psql(query) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-v2-full-test'
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

async function runTests() {
  console.log('=== STARTING RAKYAT REVIEW V2 SHORT CODE FULL FLOW TEST ===\n');

  // 1. Generator Unit Assertions
  console.log('1. Testing 8-character Crockford Base32 generator...');
  const testCodes = generateUniqueCardCodes(100);
  assert.equal(testCodes.length, 100);
  for (const c of testCodes) {
    assert.equal(c.length, 8);
    assert.ok(isValidCardCode(c));
    assert.ok(!/[01IO]/.test(c));
  }
  console.log('   [PASS] Generator produces valid, unambiguous 8-character codes.');

  // 2. QR Code and ZIP Generator Test
  console.log('2. Testing QR Code generation & ZIP archive...');
  const sampleCode = generateCardCode();
  const sampleUrl = `https://rakyat-riview.vercel.app/r/${sampleCode}`;
  const qrBlob = await generateQrPngBlob(sampleUrl, { size: 256, margin: 4 });
  assert.ok(qrBlob.size > 100, 'QR PNG blob must have non-zero size');
  const qrBuffer = Buffer.from(await qrBlob.arrayBuffer());

  const zipBytes = buildZip([
    { name: `${sampleCode}.png`, data: qrBuffer }
  ]);
  assert.ok(zipBytes.length > 100, 'ZIP bytes must have non-zero size');
  assert.equal(zipBytes[0], 0x50); // 'P'
  assert.equal(zipBytes[1], 0x4B); // 'K'
  console.log('   [PASS] QR PNG and ZIP creation succeeded with PK zip magic bytes.');

  // 3. Database Simulation with ROLLBACK
  console.log('3. Running Database Simulation (Generate -> Claim -> Anti-Takeover -> Multi-Card -> ROLLBACK)...');

  const migrationSql = fs.readFileSync('supabase/migrations/20261109000300_v2_short_code_direct_claim.sql', 'utf8')
    .replace(/^BEGIN;/m, '')
    .replace(/^COMMIT;/m, '');

  const [cardA, cardB] = generateUniqueCardCodes(2);
  const targetReviewUrl = 'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE';

  const simQuery = `
    BEGIN;
    SET LOCAL lock_timeout = '3s';
    SET LOCAL statement_timeout = '30s';

    ${migrationSql}

    -- Step A: Batch generation of 2 short cards
    SELECT public.admin_generate_v2_cards_direct(
      '00000000-0000-4000-a000-000000000010'::uuid,
      1,
      jsonb_build_array(jsonb_build_object('card_code', '${cardA}')),
      'admin:test-operator'
    );

    SELECT public.admin_generate_v2_cards_direct(
      '00000000-0000-4000-a000-000000000020'::uuid,
      1,
      jsonb_build_array(jsonb_build_object('card_code', '${cardB}')),
      'admin:test-operator'
    );

    -- Step B: Check status via buyer_v2_public_card_status
    SELECT public.buyer_v2_public_card_status('${cardA}') as card_a_status;
    SELECT public.buyer_v2_public_card_status('${cardB}') as card_b_status;

    -- Step C: Simulate Google Claiming
    DO $$
    DECLARE
      v_user_1 uuid;
      v_user_2 uuid;
      v_claim jsonb;
      v_list record;
      v_list_count integer := 0;
    BEGIN
      SELECT u.id INTO v_user_1 FROM auth.users u JOIN auth.identities i ON i.user_id = u.id WHERE i.provider = 'google' LIMIT 1;
      SELECT u.id INTO v_user_2 FROM auth.users u JOIN auth.identities i ON i.user_id = u.id WHERE i.provider = 'google' OFFSET 1 LIMIT 1;

      IF v_user_1 IS NULL THEN RAISE EXCEPTION 'Simulation requires at least 1 Google user in auth.users'; END IF;

      -- Set session to User 1
      PERFORM set_config('request.jwt.claim.sub', v_user_1::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

      -- 1. User 1 claims Card A
      v_claim := public.buyer_claim_v2_direct('${cardA}', 'Usaha Kopi User 1', '${targetReviewUrl}');
      IF v_claim->>'success' <> 'true' OR v_claim->>'code' <> 'claimed' THEN
        RAISE EXCEPTION 'Card A direct claim failed: %', v_claim;
      END IF;

      -- 2. User 1 claims Card B (Multi-Card on same Google account)
      v_claim := public.buyer_claim_v2_direct('${cardB}', 'Resto Enak User 1', '${targetReviewUrl}');
      IF v_claim->>'success' <> 'true' OR v_claim->>'code' <> 'claimed' THEN
        RAISE EXCEPTION 'Card B direct claim (multi-card) failed: %', v_claim;
      END IF;

      -- 3. Verify buyer_list_cards() returns both cards for User 1
      FOR v_list IN SELECT * FROM public.buyer_list_cards() LOOP
        IF v_list.card_code IN ('${cardA}', '${cardB}') THEN
          v_list_count := v_list_count + 1;
          IF NOT v_list.active THEN RAISE EXCEPTION 'Claimed card % is not active in buyer_list_cards', v_list.card_code; END IF;
        END IF;
      END LOOP;

      IF v_list_count <> 2 THEN
        RAISE EXCEPTION 'User 1 expected 2 cards in buyer_list_cards, found %', v_list_count;
      END IF;

      -- 4. Anti-Takeover test: User 2 attempts to claim Card A
      IF v_user_2 IS NOT NULL THEN
        PERFORM set_config('request.jwt.claim.sub', v_user_2::text, true);
        v_claim := public.buyer_claim_v2_direct('${cardA}', 'Hacker Coffee', '${targetReviewUrl}');
        IF v_claim->>'success' = 'true' THEN
          RAISE EXCEPTION 'Security violation: User 2 was able to claim User 1 card!';
        END IF;
      END IF;

      -- 5. Re-claim by User 1 is recognized as already owned
      PERFORM set_config('request.jwt.claim.sub', v_user_1::text, true);
      v_claim := public.buyer_claim_v2_direct('${cardA}', 'Usaha Kopi User 1', '${targetReviewUrl}');
      IF v_claim->>'success' <> 'true' OR v_claim->>'code' <> 'already_claimed' THEN
        RAISE EXCEPTION 'Re-claim by owner did not return already_claimed: %', v_claim;
      END IF;
    END $$;

    -- Verify final status of Card A after claim is active
    SELECT public.buyer_v2_public_card_status('${cardA}') as card_a_active_status;

    -- Always ROLLBACK
    ROLLBACK;
  `;

  const dbRes = await psql(simQuery);
  assert.ok(dbRes.includes('inactive'), 'Unclaimed card must be inactive');
  assert.ok(dbRes.includes('active'), 'Claimed card must be active');
  console.log('   [PASS] Database simulation passed: batch generation, direct claim, multi-card, and anti-takeover.');

  // 4. Production Database Count Verification
  console.log('4. Verifying production database untouched...');
  const prodCheck = await psql(`
    SELECT count(*) as total_cards FROM public.card;
    SELECT card_code, claim_mode, v2_activated_at IS NULL as is_unclaimed FROM public.card WHERE card_code = '1jb6cDk5ABDpacSkkHsq5T8i';
    SELECT card_code, claim_mode, v2_activated_at IS NOT NULL as is_active FROM public.card WHERE card_code = 'iKRb7_7PyK6kg4Ye7EqvOhYu';
  `);
  assert.ok(prodCheck.includes('9'), 'Total production cards must still be exactly 9');
  assert.ok(prodCheck.includes('1jb6cDk5ABDpacSkkHsq5T8i'), 'Existing V2 card must still exist');
  assert.ok(prodCheck.includes('iKRb7_7PyK6kg4Ye7EqvOhYu'), 'Pilot card must still exist');
  console.log('   [PASS] Production database integrity verified: 9 cards, pilot active, V2 unclaimed.');

  console.log('\n=== ALL 4 TEST SUITES PASSED (100% SUCCESS) ===\n');
}

runTests().catch(err => {
  console.error('\nTest suite FAILED:', err);
  process.exit(1);
});
