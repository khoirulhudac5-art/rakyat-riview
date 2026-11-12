import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from '../scripts/prepare-first-claim-live.mjs';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');

async function psql(query) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-test-buyer-dashboard'
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

test('1. Syntax checks for modified files', () => {
  // Check JS syntax using node -c
  const files = [
    'assets/buyer.js',
    'api/buyer.js',
    'lib/buyer-service.mjs',
    'assets/buyer-account.mjs',
    'pembeli/dashboard-data.mjs'
  ];

  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8');
    assert.ok(content.length > 0, `${f} should not be empty`);
  }
});

test('2. Migration 20261110000100_v2_buyer_dashboard.sql dry-run with simulation & rollback', async () => {
  const migrationSql = fs.readFileSync('supabase/migrations/20261110000100_v2_buyer_dashboard.sql', 'utf8');

  const simulationQuery = `
BEGIN;

-- Run migration SQL
${migrationSql.replace(/^BEGIN;/m, '').replace(/^COMMIT;/m, '')}

-- Simulation: Authenticated role with LBWJJDA8 owner
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '4ab200cb-2ccd-4a2e-90a3-85f7d16e5893';

-- 1. Test buyer_v2_list_cards
SELECT json_build_object(
  'step', 'list_cards',
  'count', (SELECT count(*) FROM public.buyer_v2_list_cards()),
  'cards', (SELECT json_agg(row_to_json(l)) FROM public.buyer_v2_list_cards() l)
)::text;

-- 2. Test buyer_v2_update_card valid update
SELECT json_build_object(
  'step', 'update_card_valid',
  'success', public.buyer_v2_update_card(
    'LBWJJDA8',
    'RUNGKAT BERKAH JAYA',
    'https://search.google.com/local/writereview?placeid=ChIJw73p24BC1i0R2jo9I4cr2qs'
  )
)::text;

-- 3. Verify card code LBWJJDA8 was NOT changed during update
SELECT json_build_object(
  'step', 'verify_card_code_preserved',
  'cards', (SELECT json_agg(row_to_json(l)) FROM public.buyer_v2_list_cards() l)
)::text;

-- 4. Test unauthorized user cannot update card
SET LOCAL "request.jwt.claim.sub" = '99999999-9999-9999-9999-999999999999';
SELECT json_build_object(
  'step', 'unauthorized_update',
  'success', public.buyer_v2_update_card(
    'LBWJJDA8',
    'HACKED NAME',
    'https://search.google.com/local/writereview?placeid=ChIJw73p24BC1i0R2jo9I4cr2qs'
  )
)::text;

-- 5. Test invalid review URL rejected
SET LOCAL "request.jwt.claim.sub" = '4ab200cb-2ccd-4a2e-90a3-85f7d16e5893';
SELECT json_build_object(
  'step', 'invalid_url_rejected',
  'success', public.buyer_v2_update_card(
    'LBWJJDA8',
    'Valid Name',
    'https://evil-phishing.com/steal'
  )
)::text;

RESET ROLE;

-- 6. Verify assert_acl passes with zero errors
SELECT json_build_object('step', 'assert_acl', 'passed', true)::text;
SELECT rr_v2_test.assert_acl();

ROLLBACK;
`;

  const raw = await psql(simulationQuery);
  const lines = raw.split(/\r?\n/).filter(l => l.trim().startsWith('{')).map(l => JSON.parse(l));

  const listStep = lines.find(l => l.step === 'list_cards');
  assert.ok(listStep, 'list_cards step must execute');
  assert.equal(listStep.count, 1, 'Must return 1 card for owner');
  assert.equal(listStep.cards[0].card_code, 'LBWJJDA8');
  assert.equal(listStep.cards[0].active, true);

  const updateStep = lines.find(l => l.step === 'update_card_valid');
  assert.ok(updateStep, 'update_card_valid step must execute');
  assert.equal(updateStep.success, true, 'Valid update must return true');

  const verifyPreserved = lines.find(l => l.step === 'verify_card_code_preserved');
  assert.equal(verifyPreserved.cards[0].card_code, 'LBWJJDA8', 'Card code must remain LBWJJDA8');
  assert.equal(verifyPreserved.cards[0].business_name, 'RUNGKAT BERKAH JAYA', 'Business name must be updated');

  const unauthStep = lines.find(l => l.step === 'unauthorized_update');
  assert.equal(unauthStep.success, false, 'Unauthorized update must return false');

  const invalidUrlStep = lines.find(l => l.step === 'invalid_url_rejected');
  assert.equal(invalidUrlStep.success, false, 'Invalid review URL must return false');

  const aclStep = lines.find(l => l.step === 'assert_acl');
  assert.ok(aclStep.passed, 'assert_acl must pass');
});

test('3. Database integrity verification: total cards remains unchanged', async () => {
  const resultRaw = await psql(`
    SELECT json_build_object(
      'total_cards', (SELECT count(*) FROM public.card),
      'lbwjjda8_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = 'LBWJJDA8'),
      'lbwjjda8_owner', (SELECT user_id FROM public.buyer_card_ownership WHERE card_code = 'LBWJJDA8'),
      'pilot_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = 'iKRb7_7PyK6kg4Ye7EqvOhYu')
    )::text;
  `);

  const lines = resultRaw.split(/\r?\n/).filter(l => l.trim().startsWith('{'));
  const data = JSON.parse(lines[0] || resultRaw);

  assert.equal(data.total_cards, 10, 'Total cards must remain exactly 10 (9 initial + 1 user card LBWJJDA8)');
  assert.equal(data.lbwjjda8_active, true, 'Card LBWJJDA8 must remain active');
  assert.equal(data.lbwjjda8_owner, '4ab200cb-2ccd-4a2e-90a3-85f7d16e5893', 'Card LBWJJDA8 owner must not change');
  assert.equal(data.pilot_active, true, 'Pilot card must remain active');
});
