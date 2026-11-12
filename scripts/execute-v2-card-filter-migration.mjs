import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');
const execute = process.argv.includes('--execute');

async function psql(query, retries = 3) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-execute-card-filter-migration'
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
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
    } catch (e) {
      if (attempt === retries) throw e;
      console.warn(`[RETRY] Attempt ${attempt} failed: ${e.message}. Retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function main() {
  console.log(`=== V2 CARD FILTER ANALYTICS MIGRATION (${execute ? 'LIVE EXECUTE' : 'DRY RUN ONLY'}) ===\n`);

  // 1. Preflight Database State
  console.log('1. Checking preflight database state...');
  const preRaw = await psql(`
    SELECT json_build_object(
      'total_cards', (SELECT count(*) FROM public.card),
      'lbwjjda8_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = 'LBWJJDA8'),
      'pilot_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = 'iKRb7_7PyK6kg4Ye7EqvOhYu'),
      'fingerprint_matches', (SELECT s.fingerprint = rr_v2_test.fingerprint() FROM rr_v2_control.state s WHERE s.id)
    )::text;
  `);
  const pre = JSON.parse(preRaw.split(/\r?\n/).find(l => l.trim().startsWith('{')));
  console.log('Preflight status:', pre);

  if (pre.total_cards !== 10 || !pre.lbwjjda8_active || !pre.pilot_active || !pre.fingerprint_matches) {
    throw new Error('Preflight checks failed! Database baseline is unexpected.');
  }

  // 2. Read migration SQL
  const migrationSql = fs.readFileSync('supabase/migrations/20261110000300_v2_card_filter_analytics.sql', 'utf8');

  // 3. Dry-run simulation first
  console.log('\n2. Running dry-run simulation with ROLLBACK...');
  const dryRunSql = `
    BEGIN;
    ${migrationSql.replace(/^BEGIN;/m, '').replace(/^COMMIT;/m, '')}
    SELECT 'dry_run_success';
    ROLLBACK;
  `;
  const dryRes = await psql(dryRunSql);
  if (!dryRes.includes('dry_run_success')) {
    throw new Error('Dry run simulation failed! ' + dryRes);
  }
  console.log('Dry run simulation: SUCCESSFUL');

  if (!execute) {
    console.log('\nDry run completed successfully. Rerun with --execute to apply.');
    return;
  }

  // 4. Live execution
  console.log('\n3. Applying migration to database...');
  await psql(migrationSql);
  console.log('Migration committed to database successfully.');

  // 5. Postflight verification
  console.log('\n4. Verifying postflight database state...');
  const postRaw = await psql(`
    SELECT json_build_object(
      'total_cards', (SELECT count(*) FROM public.card),
      'has_analytics_rpc', (SELECT count(*) = 1 FROM pg_proc WHERE proname = 'buyer_v2_analytics'),
      'analytics_args', (SELECT pg_get_function_arguments(oid) FROM pg_proc WHERE proname = 'buyer_v2_analytics'),
      'fingerprint_matches', (SELECT s.fingerprint = rr_v2_test.fingerprint() FROM rr_v2_control.state s WHERE s.id)
    )::text;
  `);
  const post = JSON.parse(postRaw.split(/\r?\n/).find(l => l.trim().startsWith('{')));
  console.log('Postflight status:', post);

  if (post.total_cards !== 10 || !post.has_analytics_rpc || !post.fingerprint_matches) {
    throw new Error('Postflight verification failed!');
  }

  console.log('\n=== MIGRATION COMPLETED SAFELY ===');
}

main().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
