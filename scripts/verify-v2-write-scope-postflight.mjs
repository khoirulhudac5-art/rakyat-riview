import path from 'node:path';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const bin = path.resolve('.backups/tooling/pgsql/bin');

async function psql(query) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-postflight-write-scope'
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

async function verifyDatabase() {
  console.log('1. Checking database invariants post-execution...');
  const q = `
    SELECT count(*) as total_cards FROM public.card;
    SELECT count(*) as total_batches FROM public.buyer_card_batch;
    SELECT count(*) as total_activations FROM public.buyer_card_activation;
    SELECT count(*) as total_batch_items FROM public.buyer_card_batch_items;
    
    -- Assert ACL
    SELECT rr_v2_test.assert_acl() as acl_status;

    -- Verify Admin Read Inventory as service_role
    SET ROLE service_role;
    SELECT jsonb_array_length((public.admin_read_v2_inventory(200, NULL))->'cards') as inventory_cards_count;
    SELECT (public.admin_read_v2_audit(200, NULL))->>'events' as audit_events;
    SET ROLE postgres;

    -- Verify illegal write is rejected
    DO $$
    BEGIN
      SET LOCAL ROLE anon;
      INSERT INTO public.card(card_code, claim_mode) VALUES('TESTILLEGALWRITE00000001', 'google_first_claim');
      RAISE EXCEPTION 'Illegal insert should have failed!';
    EXCEPTION
      WHEN SQLSTATE '42501' THEN
        NULL;
    END $$;
  `;

  const out = await psql(q);
  console.log(out);
}

async function verifyLivePilot() {
  console.log('\n2. Checking live pilot redirect on production domain...');
  const res = await fetch('https://rakyat-riview.vercel.app/r/iKRb7_7PyK6kg4Ye7EqvOhYu', {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000)
  });
  console.log('Pilot HTTP Status:', res.status);
  console.log('Pilot Location:', res.headers.get('location'));
  if (res.status !== 302 || !res.headers.get('location')?.includes('writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE')) {
    throw Error('Pilot HTTP 302 redirect check FAILED!');
  }
}

async function verifyLiveAdminSession() {
  console.log('\n3. Checking live Admin V2 endpoint status...');
  const res = await fetch('https://rakyat-riview.vercel.app/api/v2-admin?action=session', {
    signal: AbortSignal.timeout(10000)
  });
  console.log('Anonymous Admin V2 Session HTTP Status:', res.status);
  if (res.status !== 401) {
    throw Error('Anonymous Admin session should return 401!');
  }
}

async function main() {
  await verifyDatabase();
  await verifyLivePilot();
  await verifyLiveAdminSession();
  console.log('\n=== ALL POSTFLIGHT VERIFICATIONS PASSED ===');
}

main().catch(err => {
  console.error('Postflight verification failed:', err);
  process.exit(1);
});
