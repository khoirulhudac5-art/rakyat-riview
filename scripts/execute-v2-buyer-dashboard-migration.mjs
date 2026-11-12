import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');
const execute = process.argv.includes('--execute');

async function psql(query) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-execute-dashboard-migration'
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
  console.log(`=== V2 BUYER DASHBOARD MIGRATION EXECUTION (MODE: ${execute ? 'LIVE EXECUTE' : 'DRY RUN ONLY'}) ===\n`);

  // 1. Pre-flight snapshot
  console.log('1. Taking pre-flight snapshot of database...');
  const preSnapshotRaw = await psql(`
    SELECT json_build_object(
      'total_cards', (SELECT count(*) FROM public.card),
      'lbwjjda8_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = 'LBWJJDA8'),
      'lbwjjda8_owner', (SELECT user_id FROM public.buyer_card_ownership WHERE card_code = 'LBWJJDA8'),
      'pilot_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = 'iKRb7_7PyK6kg4Ye7EqvOhYu'),
      'v2_unclaimed', (SELECT v2_activated_at IS NULL FROM public.card WHERE card_code = '1jb6cDk5ABDpacSkkHsq5T8i')
    )::text;
  `);

  const lines = preSnapshotRaw.split(/\r?\n/).filter(l => l.trim().startsWith('{'));
  const preSnapshot = JSON.parse(lines[0] || preSnapshotRaw);
  console.log('Pre-migration state:', preSnapshot);

  if (preSnapshot.total_cards !== 10 || !preSnapshot.lbwjjda8_active || !preSnapshot.pilot_active) {
    throw new Error('Pre-flight check failed! Database state unexpected: ' + JSON.stringify(preSnapshot));
  }

  const backupDir = path.resolve('.backups/v2-buyer-dashboard-snapshot-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'PRE_SNAPSHOT.json'), JSON.stringify(preSnapshot, null, 2));

  // 2. Migration script loading
  const migrationFile = 'supabase/migrations/20261110000100_v2_buyer_dashboard.sql';
  const migrationSql = fs.readFileSync(migrationFile, 'utf8');

  // 3. Dry-run simulation first (Always, even in execute mode)
  console.log('\n2. Running dry-run simulation with ROLLBACK...');
  const dryRunSql = `
    BEGIN;
    ${migrationSql.replace(/^BEGIN;/m, '').replace(/^COMMIT;/m, '')}
    SELECT 'dry_run_success';
    ROLLBACK;
  `;
  const dryRunResult = await psql(dryRunSql);
  if (!dryRunResult.includes('dry_run_success')) {
    throw new Error('Dry run simulation failed! Result: ' + dryRunResult);
  }
  console.log('Dry run simulation: SUCCESSFUL');

  if (!execute) {
    console.log('\nDry run completed successfully. To apply to production database, rerun with --execute.');
    return;
  }

  // 4. Live execution
  console.log('\n3. Applying migration to production database...');
  await psql(migrationSql);
  console.log('Migration applied successfully.');

  // 5. Post-migration verification
  console.log('\n4. Verifying post-migration state...');
  const postSnapshotRaw = await psql(`
    SELECT json_build_object(
      'total_cards', (SELECT count(*) FROM public.card),
      'lbwjjda8_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = 'LBWJJDA8'),
      'has_buyer_v2_list_cards', (SELECT count(*) = 1 FROM pg_proc WHERE proname = 'buyer_v2_list_cards'),
      'has_buyer_v2_update_card', (SELECT count(*) = 1 FROM pg_proc WHERE proname = 'buyer_v2_update_card'),
      'has_authenticated_list_grant', (SELECT has_function_privilege('authenticated', 'public.buyer_v2_list_cards()', 'EXECUTE')),
      'has_authenticated_update_grant', (SELECT has_function_privilege('authenticated', 'public.buyer_v2_update_card(text, text, text)', 'EXECUTE'))
    )::text;
  `);

  const postLines = postSnapshotRaw.split(/\r?\n/).filter(l => l.trim().startsWith('{'));
  const postSnapshot = JSON.parse(postLines[0] || postSnapshotRaw);
  console.log('Post-migration state:', postSnapshot);

  if (
    postSnapshot.total_cards !== 10 ||
    !postSnapshot.lbwjjda8_active ||
    !postSnapshot.has_buyer_v2_list_cards ||
    !postSnapshot.has_buyer_v2_update_card ||
    !postSnapshot.has_authenticated_list_grant ||
    !postSnapshot.has_authenticated_update_grant
  ) {
    throw new Error('Post-migration verification failed! ' + JSON.stringify(postSnapshot));
  }

  // 6. ACL verification
  console.log('\n5. Running rr_v2_test.assert_acl()...');
  await psql('SELECT rr_v2_test.assert_acl();');
  console.log('assert_acl() check: PASSED');

  fs.writeFileSync(path.join(backupDir, 'POST_SNAPSHOT.json'), JSON.stringify(postSnapshot, null, 2));
  console.log('\n=== MIGRATION COMPLETED AND VERIFIED 100% ===');
}

main().catch(err => {
  console.error('\nMIGRATION ERROR:', err.message);
  process.exit(1);
});
