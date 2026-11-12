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
    PGAPPNAME: 'rr-v2-status-migration'
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

export async function runDryRun() {
  console.log('Running dry-run simulation of 20261109000200_v2_public_card_status.sql...');
  const newCard = '1jb6cDk5ABDpacSkkHsq5T8i';
  const pilotCard = 'iKRb7_7PyK6kg4Ye7EqvOhYu';
  const legacyCard = '001';

  const dryRunSql = `
    BEGIN;
    SELECT count(*) as cards_before FROM public.card;

    -- Apply migration
    ${migrationSql}

    -- Resync fingerprint atomically
    UPDATE rr_v2_control.state SET fingerprint = rr_v2_test.fingerprint() WHERE id;

    -- Assert ACL
    SELECT rr_v2_test.assert_acl() as acl_status;

    -- Test status query as anon for new V2 card
    SET ROLE anon;
    SELECT public.buyer_v2_public_card_status('${newCard}') as v2_status_anon;

    -- Test status query as anon for pilot card
    SELECT public.buyer_v2_public_card_status('${pilotCard}') as pilot_status_anon;

    -- Test status query as anon for legacy card
    SELECT public.buyer_v2_public_card_status('${legacyCard}') as legacy_status_anon;

    -- Verify Admin Read Inventory as service_role
    SET ROLE service_role;
    SELECT jsonb_array_length((public.admin_read_v2_inventory(200, NULL))->'cards') as inventory_count;
    SET ROLE postgres;

    -- ALWAYS ROLLBACK
    ROLLBACK;
    SELECT count(*) as cards_after FROM public.card;
  `;

  const result = await psql(dryRunSql);
  return { success: true, result };
}

export async function executeMigration() {
  console.log('EXECUTING 20261109000200_v2_public_card_status.sql ON PRODUCTION SUPABASE...');
  const fixSql = `
    BEGIN;
    ${migrationSql}
    UPDATE rr_v2_control.state SET fingerprint = rr_v2_test.fingerprint() WHERE id;
    SELECT rr_v2_test.assert_acl();
    COMMIT;
  `;

  return await psql(fixSql);
}

if (process.argv[1] && process.argv[1].endsWith('prepare-v2-card-status-migration.mjs')) {
  if (process.argv.includes('--execute')) {
    await executeMigration();
    console.log('Migration executed successfully on Supabase production.');
  } else {
    const res = await runDryRun();
    console.log('Dry run simulation passed completely:\n', res.result);
  }
}
