import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';
import { readSnapshot } from './admin-readonly-postflight.mjs';

const root = process.cwd();
const bin = path.resolve('.backups/tooling/pgsql/bin');
const migrationFile = path.resolve('supabase/migrations/20261109000100_v2_card_production_and_activation.sql');

async function tool(name, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(bin, name + '.exe'), args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => {
      done = true;
      child.kill();
      reject(Error('Migration tool timeout'));
    }, 60000);
    child.stdout.on('data', x => out += x);
    child.stderr.on('data', x => err += x);
    child.on('error', err => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve({ out, warnings: err.trim().length > 0, err });
      else reject(Error(`Migration execution failed with code ${code}: ${err.trim()}`));
    });
  });
}

async function main() {
  console.log('Validating migration script before execution...');
  if (!fs.existsSync(migrationFile)) throw Error('Migration file missing');
  const sqlContent = fs.readFileSync(migrationFile, 'utf8');
  if (!sqlContent.includes('BEGIN;') || !sqlContent.includes('COMMIT;')) throw Error('Transaction boundaries missing in migration file');

  const baseEnv = firstClaimConnection();
  const writeEnv = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rakyat-review-v2-migration-executor'
  };

  console.log('Executing controlled transaction against Supabase production (svuagnobufhfpgzmsyxx)...');
  const result = await tool('psql', ['-X', '-q', '-w', '-v', 'ON_ERROR_STOP=1', '-f', migrationFile], writeEnv);
  console.log('Migration executed successfully:', result.out || 'OK');

  console.log('Running post-migration verification in READ ONLY snapshot...');
  const verifyReport = {};

  await readSnapshot({ executable: path.join(bin, 'psql.exe'), env: baseEnv }, async s => {
    // 1. Verify tables created
    const tables = JSON.parse(await s.query(`
      SELECT json_object_agg(table_name, json_build_object(
        'exists', true,
        'rls', (SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=table_name)
      ))
      FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('buyer_card_activation','buyer_card_batch','buyer_card_batch_items')
    `));
    verifyReport.newTables = tables;

    // 2. Verify table permissions
    const permissions = JSON.parse(await s.query(`
      SELECT json_build_object(
        'activation_anon_denied', NOT has_table_privilege('anon', 'public.buyer_card_activation', 'SELECT'),
        'activation_auth_denied', NOT has_table_privilege('authenticated', 'public.buyer_card_activation', 'SELECT'),
        'activation_service_granted', has_table_privilege('service_role', 'public.buyer_card_activation', 'ALL'),
        'batch_anon_denied', NOT has_table_privilege('anon', 'public.buyer_card_batch', 'SELECT'),
        'batch_service_granted', has_table_privilege('service_role', 'public.buyer_card_batch', 'ALL'),
        'batch_items_anon_denied', NOT has_table_privilege('anon', 'public.buyer_card_batch_items', 'SELECT'),
        'batch_items_service_granted', has_table_privilege('service_role', 'public.buyer_card_batch_items', 'ALL')
      )
    `));
    verifyReport.permissions = permissions;

    // 3. Verify RPC functions created & permissions
    const rpcList = JSON.parse(await s.query(`
      SELECT json_object_agg(proname, json_build_object(
        'security_definer', prosecdef,
        'service_role_execute', has_function_privilege('service_role', p.oid, 'EXECUTE'),
        'authenticated_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
        'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE')
      ))
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND proname IN ('admin_generate_v2_cards_with_tokens','buyer_claim_v2_with_token','admin_reissue_v2_activation_token','buyer_first_claim')
    `));
    verifyReport.newRPCs = rpcList;

    // 4. Verify pilot card intact
    const pilot = JSON.parse(await s.query(`
      SELECT json_build_object(
        'card_code', card_code,
        'claim_mode', claim_mode,
        'active', v2_activated_at IS NOT NULL,
        'has_review_url', review_url IS NOT NULL
      )
      FROM public.card WHERE card_code = 'iKRb7_7PyK6kg4Ye7EqvOhYu'
    `));
    verifyReport.pilotCard = pilot;

    // 5. Total card count
    verifyReport.totalCards = Number(await s.query("SELECT count(*) FROM public.card"));
  });

  const reportFile = path.resolve('.backups/v2-migration-result-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(reportFile, JSON.stringify(verifyReport, null, 2));

  console.log('POST_MIGRATION_RESULT:', JSON.stringify(verifyReport, null, 2));
}

main().catch(err => {
  console.error('MIGRATION_FAILED:', err.message);
  process.exit(1);
});
