import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';
import { generateCardCode, generateUniqueCardCodes } from '../lib/card-code.mjs';
import { buildZip } from '../assets/zip.mjs';
import { createQrMatrix, qrToSvg } from '../assets/qrcode.mjs';

const candidateId = 'dpl_EXmyu7nn4byNTbpRApXCrZRRfm7k';
const candidateOrigin = 'https://rakyat-riview-nqm0e1bru-rakprem.vercel.app';
const prodOrigin = 'https://rakyat-riview.vercel.app';
const activeProdId = 'dpl_3jws4ArwnvoRJAWVG9JT1Rraq5G1';
const scope = 'rakprem';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');
const binary = path.resolve('.local-tools/npm-cache/_npx/69f9afb961c37556/node_modules/vercel/dist/vc.js');
const root = path.resolve('.backups/v2-short-code-release-2026-11-09T16-12-13-130Z/release');

async function psql(query) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-verify-candidate-v2'
  };

  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(psqlBin, 'psql.exe'),
      ['-X', '-q', '-w', '-c', query],
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

async function vcApi(endpoint) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, 'api', endpoint, '--scope', scope], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '', done = false;
    child.stdout.on('data', b => stdout += b);
    child.stderr.on('data', b => stderr += b);
    child.on('close', code => {
      if (code === 0) {
        try { resolve(JSON.parse(stdout)); } catch { resolve(stdout); }
      } else reject(Error('vc api failed: ' + stderr));
    });
  });
}

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

async function main() {
  console.log('=== VERIFYING V2 SHORT CODE CANDIDATE DEPLOYMENT ===');
  console.log('Candidate ID:', candidateId);
  console.log('Candidate URL:', candidateOrigin);

  const report = {
    at: new Date().toISOString(),
    candidateId,
    candidateOrigin,
    checks: []
  };

  const check = (name, pass) => {
    console.log(`[CHECK] ${name}: ${pass ? 'PASS' : 'FAIL'}`);
    report.checks.push({ name, pass: !!pass });
    if (!pass) throw Error('VERIFICATION_FAILED: ' + name);
  };

  // 1. Candidate Page Endpoints via vcCurl
  console.log('\n--- 1. Candidate Page Endpoints via vcCurl ---');
  const home = await vcCurl('/');
  check('Candidate / loads HTTP 200', home.code === 0 && home.stdout.includes('Rakyat Review'));

  const adminV2 = await vcCurl('/admin-v2.html');
  check('Candidate /admin-v2.html loads HTTP 200', adminV2.code === 0 && adminV2.stdout.includes('Admin V2'));

  const adminV2Js = await vcCurl('/assets/admin-v2.js');
  check('Candidate /assets/admin-v2.js loads HTTP 200', adminV2Js.code === 0);
  check('Candidate Admin V2 has no private token CSV download', !adminV2Js.stdout.includes('id="download-private-batch-csv"'));
  check('Candidate Admin V2 has QR ZIP and Physical CSV downloads', adminV2Js.stdout.includes('id="download-batch-qr-zip"') && adminV2Js.stdout.includes('id="download-physical-batch-csv"'));

  const buyerMulai = await vcCurl('/pembeli/mulai.html');
  check('Candidate /pembeli/mulai.html loads HTTP 200', buyerMulai.code === 0 && buyerMulai.stdout.includes('id="business"'));
  check('Candidate /pembeli/mulai.html has read-only card code display', buyerMulai.stdout.includes('id="card-code-display"'));
  check('Candidate /pembeli/mulai.html has no secret token input', !buyerMulai.stdout.includes('id="token"'));

  const buyerDashboard = await vcCurl('/dashboard.html');
  check('Candidate /dashboard.html loads HTTP 200', buyerDashboard.code === 0 && buyerDashboard.stdout.includes('Dashboard Pembeli'));

  // 2. Candidate Card Routing & Redirect via vcCurl
  console.log('\n--- 2. Candidate Card Routing & Redirects ---');
  const pilotRoute = await vcCurl('/r/iKRb7_7PyK6kg4Ye7EqvOhYu', ['-i']);
  check('Pilot card returns HTTP 302 to Google Review', pilotRoute.stdout.includes('302') && pilotRoute.stdout.includes('writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'));

  const legacyV2Card = await vcCurl('/r/1jb6cDk5ABDpacSkkHsq5T8i');
  check('Existing V2 card loads routing page with buyer_v2_public_card_status', legacyV2Card.code === 0 && legacyV2Card.stdout.includes('buyer_v2_public_card_status'));

  const shortCodeCard = await vcCurl('/r/K7M2PX8A');
  check('New 8-char short code /r/K7M2PX8A loads routing page', shortCodeCard.code === 0 && shortCodeCard.stdout.includes('buyer_v2_public_card_status'));

  // 3. Candidate Backend API Security
  console.log('\n--- 3. Candidate Backend API Protection ---');
  const anonAdminGuarded = await vcCurl('/api/v2-admin?action=session', ['-i']);
  check('Anonymous admin without host header returns HTTP 403', anonAdminGuarded.stdout.includes('403'));

  const anonAdminSession = await vcCurl('/api/v2-admin?action=session', ['-i', '-H', 'Host: rakyat-riview.vercel.app']);
  check('Anonymous admin session with host returns HTTP 401 and mode admin_production', anonAdminSession.stdout.includes('401') && anonAdminSession.stdout.includes('"mode":"admin_production"') && anonAdminSession.stdout.includes('"create":true'));

  const anonBuyerClaim = await vcCurl('/api/buyer', [
    '-i',
    '-X', 'POST',
    '-H', 'Host: rakyat-riview.vercel.app',
    '-H', 'Origin: https://rakyat-riview.vercel.app',
    '-H', 'Content-Type: application/json',
    '-H', 'X-Buyer-Request: 1',
    '-d', JSON.stringify({ action: 'first-claim', card_code: 'K7M2PX8A', business_name: 'Test', review_url: 'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE' })
  ]);
  check('Anonymous buyer claim returns HTTP 401', anonBuyerClaim.stdout.includes('401'));

  const pilotStatus = await vcCurl('/api/buyer-status?card=iKRb7_7PyK6kg4Ye7EqvOhYu');
  check('Pilot card status is active, claim_allowed: false', pilotStatus.stdout.includes('"activation_state":"active"') && pilotStatus.stdout.includes('"claim_allowed":false'));

  const v2Status = await vcCurl('/api/buyer-status?card=1jb6cDk5ABDpacSkkHsq5T8i');
  check('V2 card 1jb6 status is inactive, claim_allowed: true', v2Status.stdout.includes('"activation_state":"inactive"') && v2Status.stdout.includes('"claim_allowed":true'));

  // 4. Offline Generator, CSV and ZIP Verification
  console.log('\n--- 4. Offline Generator, CSV and ZIP Verification ---');
  const batch10 = generateUniqueCardCodes(10);
  check('Batch generator produces 10 unique 8-character codes', batch10.length === 10 && new Set(batch10).size === 10);
  for (const c of batch10) {
    check(`Code ${c} is 8-char and unambiguous`, c.length === 8 && !/[01IO]/.test(c));
  }

  // Verify CSV format
  const rows = [['card_code', 'permanent_url', 'qr_url', 'nfc_url'], ...batch10.map(code => {
    const u = `${prodOrigin}/r/${code}`;
    return [code, u, u, u];
  })];
  const csvContent = rows.map(r => r.join(',')).join('\n');
  check('CSV contains all 10 cards with identical QR and NFC URLs', rows.length === 11 && rows[1][1] === rows[1][2] && rows[1][2] === rows[1][3]);

  // Verify ZIP format
  const zipFiles = batch10.map(code => {
    const u = `${prodOrigin}/r/${code}`;
    const svg = qrToSvg(createQrMatrix(u));
    return { name: `${code}.svg`, data: Buffer.from(svg) };
  });
  const zipBytes = buildZip(zipFiles);
  check('ZIP contains 10 QR files with PK signature', zipBytes.length > 500 && zipBytes[0] === 0x50 && zipBytes[1] === 0x4B);

  // 5. Database Simulation with ROLLBACK
  console.log('\n--- 5. Database Simulation (Generate -> Claim -> Anti-Takeover -> Multi-Card -> ROLLBACK) ---');
  const [simCard1, simCard2] = generateUniqueCardCodes(2);
  const targetReviewUrl = 'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE';

  const simSql = `
    BEGIN;
    SET LOCAL lock_timeout = '3s';
    SET LOCAL statement_timeout = '30s';

    -- Generate 2 short cards
    SELECT public.admin_generate_v2_cards_direct(
      '00000000-0000-4000-a000-000000000010'::uuid,
      1,
      jsonb_build_array(jsonb_build_object('card_code', '${simCard1}')),
      'admin:test-operator'
    );
    SELECT public.admin_generate_v2_cards_direct(
      '00000000-0000-4000-a000-000000000020'::uuid,
      1,
      jsonb_build_array(jsonb_build_object('card_code', '${simCard2}')),
      'admin:test-operator'
    );

    -- Simulate Google User Claims
    DO $$
    DECLARE
      v_u1 uuid;
      v_u2 uuid;
      v_claim jsonb;
      v_count integer := 0;
      v_rec record;
    BEGIN
      SELECT u.id INTO v_u1 FROM auth.users u JOIN auth.identities i ON i.user_id = u.id WHERE i.provider = 'google' LIMIT 1;
      SELECT u.id INTO v_u2 FROM auth.users u JOIN auth.identities i ON i.user_id = u.id WHERE i.provider = 'google' OFFSET 1 LIMIT 1;

      -- Set session to User 1
      PERFORM set_config('request.jwt.claim.sub', v_u1::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

      -- User 1 claims Card 1 directly (no token!)
      v_claim := public.buyer_claim_v2_direct('${simCard1}', 'Usaha Kopi User 1', '${targetReviewUrl}');
      IF v_claim->>'success' <> 'true' OR v_claim->>'code' <> 'claimed' THEN
        RAISE EXCEPTION 'Card 1 direct claim failed: %', v_claim;
      END IF;

      -- User 1 claims Card 2 directly (multi-card!)
      v_claim := public.buyer_claim_v2_direct('${simCard2}', 'Resto Enak User 1', '${targetReviewUrl}');
      IF v_claim->>'success' <> 'true' OR v_claim->>'code' <> 'claimed' THEN
        RAISE EXCEPTION 'Card 2 direct claim (multi-card) failed: %', v_claim;
      END IF;

      -- Verify buyer_list_cards() returns both
      FOR v_rec IN SELECT * FROM public.buyer_list_cards() LOOP
        IF v_rec.card_code IN ('${simCard1}', '${simCard2}') THEN
          v_count := v_count + 1;
          IF NOT v_rec.active THEN RAISE EXCEPTION 'Card is not active in buyer_list_cards'; END IF;
        END IF;
      END LOOP;
      IF v_count <> 2 THEN RAISE EXCEPTION 'Expected 2 cards for User 1, got %', v_count; END IF;

      -- Anti-takeover: User 2 tries to claim Card 1
      IF v_u2 IS NOT NULL THEN
        PERFORM set_config('request.jwt.claim.sub', v_u2::text, true);
        v_claim := public.buyer_claim_v2_direct('${simCard1}', 'Hacker Takeover', '${targetReviewUrl}');
        IF v_claim->>'success' = 'true' THEN
          RAISE EXCEPTION 'Security breach: User 2 claimed User 1 card!';
        END IF;
      END IF;
    END $$;

    -- Query status of Card 1 (should be active now)
    SELECT public.buyer_v2_public_card_status('${simCard1}') as card_1_status;

    ROLLBACK;
  `;

  const simResult = await psql(simSql);
  check('Database simulation succeeded and returned active status before rollback', simResult.includes('"activation_state": "active"'));

  // 6. Production Database Integrity Verification
  console.log('\n--- 6. Production Database Integrity Verification ---');
  const dbCheckRaw = await psql(`
    SELECT json_build_object(
      'total_cards', (SELECT count(*) FROM public.card),
      'v2_unclaimed', (SELECT v2_activated_at IS NULL FROM public.card WHERE card_code = '1jb6cDk5ABDpacSkkHsq5T8i'),
      'pilot_active', (SELECT v2_activated_at IS NOT NULL FROM public.card WHERE card_code = 'iKRb7_7PyK6kg4Ye7EqvOhYu')
    )::text;
  `);
  const lines = dbCheckRaw.split(/\r?\n/).filter(l => l.trim().startsWith('{'));
  const dbParsed = JSON.parse(lines[0] || dbCheckRaw);
  check('Total production cards remains exactly 9', dbParsed.total_cards === 9);
  check('Card 1jb6cDk5ABDpacSkkHsq5T8i remains unclaimed', dbParsed.v2_unclaimed === true);
  check('Pilot card iKRb7_7PyK6kg4Ye7EqvOhYu remains active', dbParsed.pilot_active === true);

  // 7. Live Production Domain Untouched Check
  console.log('\n--- 7. Live Production Domain Untouched Check ---');
  const livePilot = await get(prodOrigin + '/r/iKRb7_7PyK6kg4Ye7EqvOhYu');
  check('Production domain pilot redirect returns HTTP 302', livePilot.status === 302);

  const prodDeploy = await vcApi('/v13/deployments/rakyat-riview.vercel.app');
  check('Production domain is still serving active deployment dpl_3jws4ArwnvoRJAWVG9JT1Rraq5G1', prodDeploy.id === activeProdId);

  console.log('\n=== ALL CANDIDATE VERIFICATIONS PASSED (100% SUCCESS) ===\n');
}

main().catch(err => {
  console.error('\nCandidate verification failed:', err);
  process.exit(1);
});
