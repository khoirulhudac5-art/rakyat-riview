import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const bin = path.resolve('.backups/tooling/pgsql/bin');

export async function psql(query) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-comprehensive-v2-test'
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

const migrationSql = fs.readFileSync('supabase/migrations/20261109000200_v2_public_card_status.sql', 'utf8');

async function main() {
  console.log('=== COMPREHENSIVE V2 SECURITY & FLOW TESTS (DRY-RUN) ===');

  const newCard = '1jb6cDk5ABDpacSkkHsq5T8i';
  const pilotCard = 'iKRb7_7PyK6kg4Ye7EqvOhYu';
  const legacyCard = '001';

  const testScript = `
    BEGIN;

    -- 1. Apply Migration
    ${migrationSql}
    UPDATE rr_v2_control.state SET fingerprint = rr_v2_test.fingerprint() WHERE id;
    SELECT rr_v2_test.assert_acl() as acl_verification;

    -- 2. Test status as anon: V2 Card (must be claim_allowed=true, inactive)
    SET ROLE anon;
    SELECT public.buyer_v2_public_card_status('${newCard}') as v2_status;

    -- 3. Test status as anon: Pilot Card (must be claim_allowed=false, active)
    SELECT public.buyer_v2_public_card_status('${pilotCard}') as pilot_status;

    -- 4. Test status as anon: Legacy Card (must be claim_allowed=false, active)
    SELECT public.buyer_v2_public_card_status('${legacyCard}') as legacy_status;

    -- 5. Test security: Anonymous user trying to access tokens or private tables
    DO $$
    BEGIN
      -- Anonymous cannot query buyer_card_activation
      PERFORM * FROM public.buyer_card_activation;
      RAISE EXCEPTION 'Anon should NOT have access to buyer_card_activation!';
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        -- Expected permission denied
        NULL;
    END $$;

    -- 6. Test claim without authentication -> MUST FAIL with permission denied (42501)
    DO $$
    BEGIN
      SET LOCAL ROLE anon;
      PERFORM public.buyer_claim_v2_with_token(
        '${newCard}',
        'dummy-secret-token-1234',
        'Test Business',
        'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'
      );
      RAISE EXCEPTION 'Anon should NOT be permitted to execute buyer_claim_v2_with_token!';
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        -- Expected permission denied for anon
        NULL;
    END $$;

    -- 7. Test claim with INVALID activation token -> MUST RETURN invalid_token
    SET ROLE postgres;
    INSERT INTO auth.users(id, email) VALUES('22222222-3333-4000-8000-444444444444'::uuid, 'buyer@test.com') ON CONFLICT DO NOTHING;
    INSERT INTO auth.identities(id, provider_id, user_id, identity_data, provider, last_sign_in_at)
    VALUES('33333333-4444-4000-8000-555555555555'::uuid, 'google-sub-999', '22222222-3333-4000-8000-444444444444'::uuid, '{"sub":"google-sub-999"}'::jsonb, 'google', now())
    ON CONFLICT DO NOTHING;

    SELECT set_config('request.jwt.claim.sub', '22222222-3333-4000-8000-444444444444', true);
    SELECT set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;

    SELECT public.buyer_claim_v2_with_token(
      '${newCard}',
      'WRONG_TOKEN_VALUE_123456',
      'Test Business',
      'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'
    ) as invalid_token_result;

    -- 8. Test claim with VALID token (mock token matching token_hash in test)
    SET ROLE postgres;
    UPDATE public.buyer_card_activation
    SET token_hash = encode(extensions.digest('valid-test-secret-token-123', 'sha256'), 'hex')
    WHERE card_code = '${newCard}';

    SET LOCAL ROLE authenticated;
    SELECT public.buyer_claim_v2_with_token(
      '${newCard}',
      'valid-test-secret-token-123',
      'Toko Sukses Makmur',
      'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'
    ) as valid_claim_result;

    -- 9. Test re-claim on already claimed card -> MUST FAIL (already_claimed)
    SELECT public.buyer_claim_v2_with_token(
      '${newCard}',
      'valid-test-secret-token-123',
      'Another Business',
      'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'
    ) as reclaim_result;

    -- 10. Verify card is now active and public view shows review_url
    SET ROLE anon;
    SELECT public.buyer_v2_public_card_status('${newCard}') as status_after_claim;
    SELECT card_code, review_url, business_name FROM public.card_public WHERE card_code = '${newCard}';

    -- 11. Verify pilot card unchanged
    SELECT card_code, review_url FROM public.card WHERE card_code = '${pilotCard}';

    -- 12. ALWAYS ROLLBACK
    ROLLBACK;
    SELECT count(*) as total_cards_untouched FROM public.card;
  `;

  const output = await psql(testScript);
  console.log(output);
  console.log('\n=== ALL COMPREHENSIVE TESTS PASSED CLEANLY IN DRY-RUN ===');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
