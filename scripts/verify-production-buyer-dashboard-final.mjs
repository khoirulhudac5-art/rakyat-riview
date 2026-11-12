import { spawn } from 'node:child_process';
import path from 'node:path';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');
const origin = 'https://rakyat-riview.vercel.app';
const targetCard = 'LBWJJDA8';
const pilotCard = 'iKRb7_7PyK6kg4Ye7EqvOhYu';
const v2OldCard = '1jb6cDk5ABDpacSkkHsq5T8i';

async function psql(query, retries = 3) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=on -c lock_timeout=3000 -c statement_timeout=15000',
    PGAPPNAME: 'rr-verify-final'
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
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function get(url, headers = {}) {
  const r = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  let json = null;
  const body = await r.text();
  try { json = JSON.parse(body); } catch {}
  return { status: r.status, headers: r.headers, body, json, location: r.headers.get('location') };
}

async function post(url, body = {}, headers = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      'x-buyer-request': '1',
      ...headers
    },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(20000)
  });
  let json = null;
  const text = await r.text();
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, body: text, json };
}

async function main() {
  console.log('=== RAKYAT REVIEW V2 — FINAL PRODUCTION VERIFICATION ===\n');

  const results = [];
  const assert = (title, condition, detail = '') => {
    results.push({ title, pass: !!condition, detail });
    console.log(`[${condition ? 'PASS' : 'FAIL'}] ${title} ${detail ? '(' + detail + ')' : ''}`);
    if (!condition) throw new Error('ASSERTION FAILED: ' + title);
  };

  // 1. Database Integrity Checks
  console.log('--- 1. Database Integrity Checks ---');
  const dbRaw = await psql(`
    SELECT json_build_object(
      'total_cards', (SELECT count(*) FROM public.card),
      'lbwjjda8_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = '${targetCard}'),
      'lbwjjda8_owner', (SELECT user_id FROM public.buyer_card_ownership WHERE card_code = '${targetCard}'),
      'lbwjjda8_business', (SELECT business_name FROM public.card WHERE card_code = '${targetCard}'),
      'lbwjjda8_review', (SELECT review_url FROM public.card WHERE card_code = '${targetCard}'),
      'pilot_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = '${pilotCard}'),
      'v2_old_ready', (SELECT v2_activated_at IS NULL FROM public.card WHERE card_code = '${v2OldCard}'),
      'fingerprint_match', (SELECT s.fingerprint = rr_v2_test.fingerprint() FROM rr_v2_control.state s WHERE s.id),
      'has_v2_list_func', (SELECT count(*) = 1 FROM pg_proc WHERE proname = 'buyer_v2_list_cards'),
      'has_v2_update_func', (SELECT count(*) = 1 FROM pg_proc WHERE proname = 'buyer_v2_update_card')
    )::text;
  `);

  const db = JSON.parse(dbRaw.split(/\r?\n/).find(l => l.trim().startsWith('{')));
  assert('Total cards in database remains exactly 10', db.total_cards === 10, `count: ${db.total_cards}`);
  assert('Target card LBWJJDA8 remains active', db.lbwjjda8_active === true);
  assert('Target card LBWJJDA8 owner is intact', db.lbwjjda8_owner === '4ab200cb-2ccd-4a2e-90a3-85f7d16e5893', db.lbwjjda8_owner);
  assert('Target card LBWJJDA8 business name is RUNGKAT BOS', db.lbwjjda8_business === 'RUNGKAT BOS', db.lbwjjda8_business);
  assert('Pilot card remains active', db.pilot_active === true);
  assert('V2 old card remains ready (unclaimed)', db.v2_old_ready === true);
  assert('Security state fingerprint matches test fingerprint', db.fingerprint_match === true);
  assert('RPC buyer_v2_list_cards is present', db.has_v2_list_func === true);
  assert('RPC buyer_v2_update_card is present', db.has_v2_update_func === true);

  await psql('SELECT rr_v2_test.assert_acl();');
  assert('ACL assertion rr_v2_test.assert_acl() passes cleanly', true);

  // 2. HTTP & Routing Live Checks
  console.log('\n--- 2. HTTP & Routing Live Checks ---');

  const dashRes = await get(origin + '/dashboard.html');
  assert('GET /dashboard.html returns HTTP 200', dashRes.status === 200);

  const kartuRes = await get(origin + '/kartu.html');
  assert('GET /kartu.html redirects cleanly to /dashboard.html', kartuRes.status === 200 && kartuRes.body.includes('/dashboard.html'));

  const jsRes = await get(origin + '/assets/buyer.js');
  assert('GET /assets/buyer.js loads refined dashboard logic',
    jsRes.status === 200 &&
    jsRes.body.includes('DASHBOARD PEMBELI') &&
    jsRes.body.includes('google-alert-banner') &&
    jsRes.body.includes('btn-logout')
  );

  const cssRes = await get(origin + '/assets/buyer.css');
  assert('GET /assets/buyer.css loads responsive & mobile styles',
    cssRes.status === 200 &&
    cssRes.body.includes('google-alert-banner') &&
    cssRes.body.includes('workspace-user-card')
  );

  const adminRes = await get(origin + '/admin-v2.html');
  assert('GET /admin-v2.html returns HTTP 200', adminRes.status === 200 && adminRes.body.includes('Admin V2'));

  // 3. Card Redirects
  console.log('\n--- 3. Card Redirects Live Checks ---');

  const pilotRes = await get(origin + '/r/' + pilotCard);
  assert(
    'Pilot card /r/' + pilotCard + ' returns HTTP 302 to Google Review',
    pilotRes.status === 302 && pilotRes.location?.includes('search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'),
    `status: ${pilotRes.status}, location: ${pilotRes.location}`
  );

  const targetRoutingRes = await get(origin + '/r/' + targetCard);
  assert('Card LBWJJDA8 /r/' + targetCard + ' routing page loads HTTP 200', targetRoutingRes.status === 200);

  const oldV2RoutingRes = await get(origin + '/r/' + v2OldCard);
  assert('Old V2 card /r/' + v2OldCard + ' routing page loads HTTP 200', oldV2RoutingRes.status === 200);

  // 4. API Security & Anonymous Protection
  console.log('\n--- 4. API Security & Anonymous Protection ---');

  const anonSession = await get(origin + '/api/buyer?action=session');
  assert('GET /api/buyer?action=session rejects anonymous request with HTTP 401', anonSession.status === 401);

  const anonCards = await get(origin + '/api/buyer?action=cards');
  assert('GET /api/buyer?action=cards rejects anonymous request with HTTP 401', anonCards.status === 401);

  const anonUpdate = await post(origin + '/api/buyer', {
    action: 'update',
    card_code: targetCard,
    business_name: 'Attacker Business',
    review_url: 'https://search.google.com/local/writereview?placeid=ChIJw73p24BC1i0R2jo9I4cr2qs'
  });
  assert('POST /api/buyer (update) rejects anonymous request with HTTP 401/403', [401, 403].includes(anonUpdate.status));

  console.log('\n======================================================');
  console.log('   ALL 16 VERIFICATION CHECKS PASSED WITH 100% SUCCESS ');
  console.log('======================================================\n');
}

main().catch(err => {
  console.error('\nVERIFICATION FAILED:', err.message);
  process.exit(1);
});
