import path from 'node:path';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const bin = path.resolve('.backups/tooling/pgsql/bin');

async function psql(query) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-verify-migration'
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

async function main() {
  console.log('--- POST-MIGRATION VERIFICATION ---');
  const q = `
    SELECT count(*) as total_cards FROM public.card;
    SELECT rr_v2_test.assert_acl() as acl_check;
    SET ROLE anon;
    SELECT public.buyer_v2_public_card_status('1jb6cDk5ABDpacSkkHsq5T8i') as new_card_status;
    SELECT public.buyer_v2_public_card_status('iKRb7_7PyK6kg4Ye7EqvOhYu') as pilot_status;
    SET ROLE service_role;
    SELECT jsonb_array_length((public.admin_read_v2_inventory(200, NULL))->'cards') as inventory_count;
  `;
  console.log(await psql(q));

  console.log('\n--- VERIFY LIVE PILOT REDIRECT (HTTP 302) ---');
  const res = await fetch('https://rakyat-riview.vercel.app/r/iKRb7_7PyK6kg4Ye7EqvOhYu', { redirect: 'manual' });
  console.log('Pilot HTTP Status:', res.status);
  console.log('Pilot Location:', res.headers.get('location'));
}

main().catch(console.error);
