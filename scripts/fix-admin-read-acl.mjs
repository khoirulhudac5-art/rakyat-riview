import path from 'node:path';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const bin = path.resolve('.backups/tooling/pgsql/bin');

async function psql(query, isDryRun = true) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-admin-acl-fixer'
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

export async function runDryRun() {
  console.log('Running dry-run simulation of Admin Read ACL fix...');
  const dryRunSql = `
    BEGIN;
    -- 1. Check before state
    SELECT count(*) as cards_before FROM public.card;
    
    -- 2. Revoke execute on legacy buyer_first_claim from authenticated
    REVOKE ALL ON FUNCTION public.buyer_first_claim(text,text,text) FROM authenticated;
    
    -- 3. Resync fingerprint atomically
    UPDATE rr_v2_control.state SET fingerprint = rr_v2_test.fingerprint() WHERE id;
    
    -- 4. Verify ACL assertion
    SELECT rr_v2_test.assert_acl();
    
    -- 5. Test reading inventory as service_role
    SET ROLE service_role;
    SELECT public.admin_read_v2_inventory(200, NULL);
    
    -- 6. Test reading audit as service_role
    SELECT public.admin_read_v2_audit(200, NULL);
    
    -- 7. Test pilot admit
    SET ROLE postgres;
    SELECT rr_claim_pilot.admit('redirect', 'iKRb7_7PyK6kg4Ye7EqvOhYu', false);
    
    -- 8. Verify card count unchanged
    SELECT count(*) as cards_after FROM public.card;
    
    ROLLBACK;
  `;

  const result = await psql(dryRunSql);
  return { success: true, result };
}

export async function executeFix() {
  console.log('EXECUTING CONTROLLED FIX ON SUPABASE PRODUCTION...');
  const fixSql = `
    BEGIN;
    -- 1. Revoke rogue execute on buyer_first_claim from authenticated
    REVOKE ALL ON FUNCTION public.buyer_first_claim(text,text,text) FROM authenticated;
    
    -- 2. Resync state fingerprint
    UPDATE rr_v2_control.state SET fingerprint = rr_v2_test.fingerprint() WHERE id;
    
    -- 3. Assertions
    SELECT rr_v2_test.assert_acl();
    COMMIT;
  `;

  return await psql(fixSql);
}

// When run directly with --execute, performs the fix. Otherwise runs dry-run.
if (process.argv[1] && process.argv[1].endsWith('fix-admin-read-acl.mjs')) {
  if (process.argv.includes('--execute')) {
    await executeFix();
    console.log('Fix executed successfully on Supabase production.');
  } else {
    const res = await runDryRun();
    console.log('Dry run simulation passed completely:\n', res.result);
  }
}
