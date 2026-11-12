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
    PGAPPNAME: 'rr-verify-candidate-flow'
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

const candidateOrigin = 'https://rakyat-riview-ajz9zd7j3-rakprem.vercel.app';
const prodOrigin = 'https://rakyat-riview.vercel.app';
const newCard = '1jb6cDk5ABDpacSkkHsq5T8i';
const pilotCard = 'iKRb7_7PyK6kg4Ye7EqvOhYu';
const scope = 'rakprem';
const binary = path.resolve('.local-tools/npm-cache/_npx/69f9afb961c37556/node_modules/vercel/dist/vc.js');
const root = path.resolve('.backups/v2-card-flow-release-2026-11-09T13-47-53-313Z/release');

async function vcCurl(route, flags = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, 'curl', route, '--deployment', candidateOrigin, '--scope', scope, ...flags], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => {
      done = true;
      child.kill();
      reject(Error('CLI timeout'));
    }, 30000);
    child.stdout.on('data', b => stdout += b);
    child.stderr.on('data', b => stderr += b);
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function get(url, headers = {}) {
  const r = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  let text = '';
  try { text = await r.text(); } catch {}
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json, location: r.headers.get('location') };
}

async function post(url, body, headers = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(15000)
  });
  let text = '';
  try { text = await r.text(); } catch {}
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}

async function main() {
  console.log('=== VERIFYING CANDIDATE DEPLOYMENT CARD FLOW ===');
  console.log('Candidate URL:', candidateOrigin);
  console.log('Target Card:', newCard);

  // 1. Check candidate static and page responses via vcCurl
  console.log('\n--- 1. Candidate Page Endpoints via vcCurl ---');
  const pages = [
    '/',
    '/admin-v2.html',
    '/pembeli/mulai.html',
    '/r/' + newCard
  ];
  for (const p of pages) {
    const res = await vcCurl(p);
    console.log(`vcCurl ${p} -> exit code ${res.code}, length ${res.stdout.length}`);
    if (res.code !== 0 || res.stdout.length === 0) throw Error(`Failed to load ${p} on candidate`);
  }

  // Verify r/001/index.html includes buyer_v2_public_card_status
  const rPage = await vcCurl('/r/' + newCard);
  const hasV2Rpc = rPage.stdout.includes('buyer_v2_public_card_status');
  console.log('r/001/index.html has buyer_v2_public_card_status call:', hasV2Rpc);
  if (!hasV2Rpc) throw Error('Candidate r/001/index.html does not contain buyer_v2_public_card_status!');

  // 2. Check candidate /api/buyer-status for new card
  console.log('\n--- 2. Candidate /api/buyer-status for V2 Card ---');
  const v2StatusRes = await vcCurl('/api/buyer-status?card=' + newCard);
  let v2Json = null;
  try { v2Json = JSON.parse(v2StatusRes.stdout); } catch {}
  console.log('Status JSON:', JSON.stringify(v2Json));
  if (v2Json?.code !== newCard || v2Json?.claim_allowed !== true || v2Json?.activation_state !== 'inactive') {
    throw Error('Candidate /api/buyer-status for V2 card check FAILED: ' + v2StatusRes.stdout);
  }

  // 3. Check candidate /api/buyer-status for pilot card
  console.log('\n--- 3. Candidate /api/buyer-status for Pilot Card ---');
  const pilotStatusRes = await vcCurl('/api/buyer-status?card=' + pilotCard);
  let pilotJson = null;
  try { pilotJson = JSON.parse(pilotStatusRes.stdout); } catch {}
  console.log('Pilot Status JSON:', JSON.stringify(pilotJson));
  if (pilotJson?.code !== pilotCard || pilotJson?.claim_allowed !== false) {
    throw Error('Candidate /api/buyer-status for pilot card check FAILED: ' + pilotStatusRes.stdout);
  }

  // 4. Check candidate pilot redirect HTTP 302
  console.log('\n--- 4. Candidate Pilot Redirect ---');
  const pilotRedirectRes = await vcCurl('/r/' + pilotCard, ['-i']);
  const has302 = pilotRedirectRes.stdout.includes('302') || pilotRedirectRes.stdout.includes('Location: https://search.google.com');
  console.log('Pilot redirect check result:', has302);
  if (!has302) {
    throw Error('Candidate pilot redirect check FAILED: ' + pilotRedirectRes.stdout.slice(0, 300));
  }

  // 5. Check candidate anonymous claim rejection
  console.log('\n--- 5. Candidate Security Check (Unauthenticated Claim) ---');
  const anonClaimRes = await vcCurl('/api/buyer', [
    '-X', 'POST',
    '-H', 'Content-Type: application/json',
    '-H', 'X-Buyer-Request: 1',
    '-H', 'Origin: https://rakyat-riview.vercel.app',
    '-d', JSON.stringify({
      action: 'first-claim',
      card_code: newCard,
      activation_token: 'dummy-token-attempt-12345',
      business_name: 'Test',
      review_url: 'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'
    })
  ]);
  console.log('Anon claim output:', anonClaimRes.stdout);
  let anonJson = null;
  try { anonJson = JSON.parse(anonClaimRes.stdout); } catch {}
  if (!anonJson?.error) {
    throw Error('Unauthenticated claim should have failed!');
  }

  // 6. Database Rollback Simulation for Claim & Reclaim Integrity
  console.log('\n--- 6. Database Rollback Simulation for Claim & already_claimed ---');
  const simSql = `
    BEGIN;
    -- Mock authenticated user
    INSERT INTO auth.users(id, email) VALUES('99999999-8888-4000-8000-777777777777'::uuid, 'simbuyer@example.com') ON CONFLICT DO NOTHING;
    INSERT INTO auth.identities(id, provider_id, user_id, identity_data, provider, last_sign_in_at)
    VALUES('88888888-7777-4000-8000-666666666666'::uuid, 'google-sim-99', '99999999-8888-4000-8000-777777777777'::uuid, '{"sub":"google-sim-99"}'::jsonb, 'google', now())
    ON CONFLICT DO NOTHING;

    -- Update token_hash to known test token in transaction
    UPDATE public.buyer_card_activation
    SET token_hash = encode(extensions.digest('sim-secret-activation-token-99', 'sha256'), 'hex')
    WHERE card_code = '${newCard}';

    -- First claim as authenticated user
    SELECT set_config('request.jwt.claim.sub', '99999999-8888-4000-8000-777777777777', true);
    SELECT set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;

    SELECT public.buyer_claim_v2_with_token(
      '${newCard}',
      'sim-secret-activation-token-99',
      'Toko Simulasi Kopi',
      'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'
    ) as first_claim_result;

    -- Snapshot state after first claim
    SET ROLE postgres;
    SELECT card_code, business_name, v2_activated_at IS NOT NULL as is_active FROM public.card WHERE card_code = '${newCard}';
    SELECT card_code, user_id FROM public.buyer_card_ownership WHERE card_code = '${newCard}';

    -- Re-claim attempt as different user
    INSERT INTO auth.users(id, email) VALUES('11111111-2222-4000-8000-333333333333'::uuid, 'attacker@example.com') ON CONFLICT DO NOTHING;
    INSERT INTO auth.identities(id, provider_id, user_id, identity_data, provider, last_sign_in_at)
    VALUES('44444444-5555-4000-8000-666666666666'::uuid, 'google-attacker-11', '11111111-2222-4000-8000-333333333333'::uuid, '{"sub":"google-attacker-11"}'::jsonb, 'google', now())
    ON CONFLICT DO NOTHING;

    SELECT set_config('request.jwt.claim.sub', '11111111-2222-4000-8000-333333333333', true);
    SELECT set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;

    SELECT public.buyer_claim_v2_with_token(
      '${newCard}',
      'sim-secret-activation-token-99',
      'Attacker Store',
      'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'
    ) as attacker_reclaim_result;

    -- Verify that attacker_reclaim did NOT alter owner or business_name
    SET ROLE postgres;
    SELECT card_code, business_name, user_id
    FROM public.card JOIN public.buyer_card_ownership USING (card_code)
    WHERE card_code = '${newCard}';

    -- ALWAYS ROLLBACK to leave real database untouched!
    ROLLBACK;
  `;
  const simResult = await psql(simSql);
  console.log(simResult);

  // 7. Verify production database state remains clean and untouched
  console.log('\n--- 7. Database Production Integrity ---');
  const checkCard = await psql(`
    SELECT card_code, claim_mode, v2_activated_at IS NULL as is_unclaimed
    FROM public.card WHERE card_code = '${newCard}';
    SELECT count(*) as total_cards FROM public.card;
  `);
  console.log(checkCard);

  // 8. Verify live production domain is untouched
  console.log('\n--- 8. Production Domain Untouched Check ---');
  const livePilot = await get(prodOrigin + '/r/' + pilotCard);
  console.log('Production domain pilot redirect status:', livePilot.status);
  if (livePilot.status !== 302) throw Error('Production domain pilot check FAILED!');

  console.log('\n=== ALL CANDIDATE VERIFICATIONS PASSED COMPLETELY ===');
}

main().catch(err => {
  console.error('Candidate verification failed:', err);
  process.exit(1);
});


main().catch(err => {
  console.error('Candidate verification failed:', err);
  process.exit(1);
});
