import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from '../scripts/prepare-first-claim-live.mjs';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');

async function psql(query, retries = 3) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=15000',
    PGAPPNAME: 'rr-test-analytics'
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

test('1. Syntax and static structure checks', () => {
  const buyerJs = fs.readFileSync('assets/buyer.js', 'utf8');
  assert.ok(buyerJs.includes('renderBarChart'), 'buyer.js contains renderBarChart');
  assert.ok(buyerJs.includes('changeAnalyticsPeriod'), 'buyer.js contains changeAnalyticsPeriod');
  assert.ok(buyerJs.includes('card-scan-badge'), 'buyer.js contains card-scan-badge');
  assert.ok(buyerJs.includes('Total Scan'), 'buyer.js contains Total Scan');
  assert.ok(buyerJs.includes('Scan Hari Ini'), 'buyer.js contains Scan Hari Ini');
  assert.ok(buyerJs.includes('Total Kartu Dimiliki'), 'buyer.js contains Total Kartu Dimiliki');

  const buyerCss = fs.readFileSync('assets/buyer.css', 'utf8');
  assert.ok(buyerCss.includes('.filter-pills'), 'buyer.css contains filter-pills');
  assert.ok(buyerCss.includes('.chart-container'), 'buyer.css contains chart-container');
  assert.ok(buyerCss.includes('.card-scan-badge'), 'buyer.css contains card-scan-badge');

  const vercelJson = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
  const cardRewrite = vercelJson.rewrites.find(r => r.source === '/r/:code');
  assert.ok(cardRewrite, 'vercel.json has /r/:code rewrite');
  assert.strictEqual(cardRewrite.destination, '/api/card-redirect?code=:code', 'Routes to /api/card-redirect');
});

test('2. Database Schema, RPCs, and ACL Verification', async () => {
  const schemaRaw = await psql(`
    SELECT json_build_object(
      'total_cards', (SELECT count(*) FROM public.card),
      'has_table', (SELECT count(*) = 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'card_scans'),
      'has_resolve_rpc', (SELECT count(*) = 1 FROM pg_proc WHERE proname = 'resolve_and_record_card_scan'),
      'has_analytics_rpc', (SELECT count(*) = 1 FROM pg_proc WHERE proname = 'buyer_v2_analytics'),
      'fingerprint_match', (SELECT s.fingerprint = rr_v2_test.fingerprint() FROM rr_v2_control.state s WHERE s.id)
    )::text;
  `);

  const schema = JSON.parse(schemaRaw.split(/\r?\n/).find(l => l.trim().startsWith('{')));
  assert.strictEqual(schema.total_cards, 10, 'Total cards remains exactly 10');
  assert.strictEqual(schema.has_table, true, 'card_scans table exists');
  assert.strictEqual(schema.has_resolve_rpc, true, 'resolve_and_record_card_scan exists');
  assert.strictEqual(schema.has_analytics_rpc, true, 'buyer_v2_analytics exists');
  assert.strictEqual(schema.fingerprint_match, true, 'Fingerprint matches rr_v2_test.fingerprint()');

  await psql('SELECT rr_v2_test.assert_acl();');
});

test('3. Scan resolution, anti-duplication & bot filtering test', async () => {
  const testResRaw = await psql(`
    BEGIN;

    SELECT public.resolve_and_record_card_scan('LBWJJDA8', 'unit_test_hash_1', false);
    SELECT public.resolve_and_record_card_scan('LBWJJDA8', 'unit_test_hash_1', false);
    SELECT public.resolve_and_record_card_scan('LBWJJDA8', 'unit_test_bot_hash', true);
    SELECT public.resolve_and_record_card_scan('1jb6cDk5ABDpacSkkHsq5T8i', 'unit_test_hash_2', false);

    SELECT json_build_object(
      'recorded_count', (SELECT count(*) FROM public.card_scans WHERE card_code = 'LBWJJDA8' AND visitor_hash = 'unit_test_hash_1'),
      'bot_count', (SELECT count(*) FROM public.card_scans WHERE card_code = 'LBWJJDA8' AND visitor_hash = 'unit_test_bot_hash'),
      'inactive_count', (SELECT count(*) FROM public.card_scans WHERE card_code = '1jb6cDk5ABDpacSkkHsq5T8i'),
      'inactive_result', public.resolve_and_record_card_scan('1jb6cDk5ABDpacSkkHsq5T8i', 'hash_3', false)
    )::text;

    ROLLBACK;
  `);

  const targetLine = testResRaw.split(/\r?\n/).find(l => l.includes('recorded_count'));
  assert.ok(targetLine, 'Found JSON line with recorded_count');
  const testRes = JSON.parse(targetLine.trim());
  assert.strictEqual(testRes.recorded_count, 1, 'Duplicate scan was filtered (count = 1)');
  assert.strictEqual(testRes.bot_count, 0, 'Bot scan was not recorded (count = 0)');
  assert.strictEqual(testRes.inactive_count, 0, 'Inactive card scan was not recorded (count = 0)');
  assert.strictEqual(testRes.inactive_result?.status, 'inactive', 'Inactive card returned status inactive');
  assert.ok(testRes.inactive_result?.redirect_url?.includes('/pembeli/mulai.html'), 'Inactive card redirects to wizard');
});

test('4. Buyer analytics and list cards with scan_count test', async () => {
  const analyticsResRaw = await psql(`
    BEGIN;

    SELECT public.resolve_and_record_card_scan('LBWJJDA8', 'sim_hash_1', false);
    SELECT public.resolve_and_record_card_scan('LBWJJDA8', 'sim_hash_2', false);
    SELECT public.resolve_and_record_card_scan('LBWJJDA8', 'sim_hash_3', false);

    SET LOCAL "request.jwt.claim.sub" = '4ab200cb-2ccd-4a2e-90a3-85f7d16e5893';
    SET LOCAL ROLE authenticated;

    SELECT json_build_object(
      'analytics_7', public.buyer_v2_analytics(7),
      'analytics_30', public.buyer_v2_analytics(30),
      'cards', (SELECT jsonb_agg(row_to_json(c)) FROM public.buyer_v2_list_cards() c)
    )::text;

    ROLLBACK;
  `);

  const targetLine = analyticsResRaw.split(/\r?\n/).find(l => l.includes('analytics_7'));
  assert.ok(targetLine, 'Found JSON line with analytics_7');
  const data = JSON.parse(targetLine.trim());

  const a7 = data.analytics_7;
  assert.strictEqual(a7.total_cards, 1, 'Total cards is 1');
  assert.ok(a7.total_scans >= 3, 'Total scans recorded >= 3');
  assert.ok(a7.scans_today >= 3, 'Scans today >= 3');
  assert.strictEqual(a7.chart_data.length, 7, 'Chart data has exactly 7 days');

  const a30 = data.analytics_30;
  assert.strictEqual(a30.chart_data.length, 30, 'Chart data has exactly 30 days');

  const cardList = data.cards;
  assert.ok(Array.isArray(cardList), 'Cards list is an array');
  const lbCard = cardList.find(c => c.card_code === 'LBWJJDA8');
  assert.ok(lbCard, 'Found LBWJJDA8 in list');
  assert.ok(lbCard.scan_count >= 3, 'LBWJJDA8 has scan_count >= 3');
});
