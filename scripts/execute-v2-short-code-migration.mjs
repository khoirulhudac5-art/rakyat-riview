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
    PGAPPNAME: 'rr-execute-migration'
  };

  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(psqlBin, 'psql.exe'),
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

async function main() {
  console.log(`=== V2 SHORT CODE MIGRATION EXECUTION (MODE: ${execute ? 'LIVE EXECUTE' : 'DRY RUN ONLY'}) ===\n`);

  // 1. Pre-flight snapshot
  console.log('1. Taking pre-flight snapshot of production database...');
  const preSnapshotRaw = await psql(`
    SELECT json_build_object(
      'total_cards', (SELECT count(*) FROM public.card),
      'v2_unclaimed', (SELECT v2_activated_at IS NULL FROM public.card WHERE card_code = '1jb6cDk5ABDpacSkkHsq5T8i'),
      'pilot_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = 'iKRb7_7PyK6kg4Ye7EqvOhYu'),
      'control_state', (SELECT to_jsonb(s) FROM rr_v2_control.state s WHERE id)
    )::text;
  `);
  
  const lines = preSnapshotRaw.split(/\r?\n/).filter(l => l.trim().startsWith('{'));
  const preSnapshot = JSON.parse(lines[0] || preSnapshotRaw);
  console.log('Pre-migration state:', preSnapshot);

  if (preSnapshot.total_cards !== 9 || !preSnapshot.v2_unclaimed || !preSnapshot.pilot_active) {
    throw new Error('Pre-flight check failed! Database state unexpected.');
  }

  const backupDir = path.resolve('.backups/v2-migration-snapshot-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'PRE_SNAPSHOT.json'), JSON.stringify(preSnapshot, null, 2));

  // 2. Migration script loading
  const migrationFile = 'supabase/migrations/20261109000300_v2_short_code_direct_claim.sql';
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
    throw new Error('Dry-run simulation failed! Output: ' + dryRunResult);
  }
  console.log('   [PASS] Dry-run simulation completed successfully.');

  if (!execute) {
    console.log('\nDry run complete. Use --execute to apply migration to production.');
    return;
  }

  // 4. Live Execution
  console.log('\n3. Applying migration to production database...');
  const execResult = await psql(migrationSql);
  console.log('Migration execution result:', execResult);

  // 5. Post-flight verification
  console.log('\n4. Verifying post-migration database state...');
  const postCheck = await psql(`
    SELECT json_build_object(
      'total_cards', (SELECT count(*) FROM public.card),
      'has_generate_rpc', (SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'admin_generate_v2_cards_direct')),
      'has_claim_rpc', (SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'buyer_claim_v2_direct')),
      'v2_unclaimed', (SELECT v2_activated_at IS NULL FROM public.card WHERE card_code = '1jb6cDk5ABDpacSkkHsq5T8i'),
      'pilot_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = 'iKRb7_7PyK6kg4Ye7EqvOhYu'),
      'acl_valid', (SELECT rr_v2_test.fingerprint() = (SELECT fingerprint FROM rr_v2_control.state WHERE id))
    )::text;
  `);

  const postLines = postCheck.split(/\r?\n/).filter(l => l.trim().startsWith('{'));
  const postState = JSON.parse(postLines[0] || postCheck);
  console.log('Post-migration state:', postState);

  fs.writeFileSync(path.join(backupDir, 'POST_SNAPSHOT.json'), JSON.stringify(postState, null, 2));

  if (postState.total_cards !== 9) throw new Error('Post-migration check failed: total_cards is not 9');
  if (!postState.has_generate_rpc) throw new Error('Post-migration check failed: admin_generate_v2_cards_direct missing');
  if (!postState.has_claim_rpc) throw new Error('Post-migration check failed: buyer_claim_v2_direct missing');
  if (!postState.v2_unclaimed) throw new Error('Post-migration check failed: 1jb6 card is claimed');
  if (!postState.pilot_active) throw new Error('Post-migration check failed: pilot card is not active');
  if (!postState.acl_valid) throw new Error('Post-migration check failed: ACL fingerprint mismatch');

  console.log('\n=== MIGRATION APPLIED AND VERIFIED 100% SUCCESSFULLY ===');
}

main().catch(err => {
  console.error('\nMigration failed:', err);
  process.exit(1);
});
