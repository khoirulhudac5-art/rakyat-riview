import { spawn } from 'node:child_process';
import path from 'node:path';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');

async function psql(query) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=on -c lock_timeout=3000 -c statement_timeout=30000',
    PGAPPNAME: 'rr-schema-audit'
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

async function main() {
  console.log('--- 1. Columns of public.card ---');
  const cardCols = await psql(`
    SELECT column_name, data_type, character_maximum_length, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'card'
    ORDER BY ordinal_position;
  `);
  console.log(cardCols);

  console.log('\n--- 2. Constraints on public.card ---');
  const cardConstraints = await psql(`
    SELECT conname, pg_get_constraintdef(c.oid)
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public' AND c.conrelid = 'public.card'::regclass;
  `);
  console.log(cardConstraints);

  console.log('\n--- 3. Columns of public.buyer_card_activation ---');
  const actCols = await psql(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'buyer_card_activation'
    ORDER BY ordinal_position;
  `);
  console.log(actCols);

  console.log('\n--- 4. Columns of public.buyer_card_ownership ---');
  const ownCols = await psql(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'buyer_card_ownership'
    ORDER BY ordinal_position;
  `);
  console.log(ownCols);

  console.log('\n--- 5. Definition of public.card_public ---');
  const cardPubDef = await psql(`
    SELECT pg_get_viewdef('public.card_public'::regclass, true);
  `);
  console.log(cardPubDef);

  console.log('\n--- 6. Triggers on public.card ---');
  const cardTriggers = await psql(`
    SELECT tgname, pg_get_triggerdef(oid)
    FROM pg_trigger
    WHERE tgrelid = 'public.card'::regclass AND NOT tgisinternal;
  `);
  console.log(cardTriggers);

  console.log('\n--- 7. Existing Card Codes in Production ---');
  const cards = await psql(`
    SELECT card_code, claim_mode, business_name, v2_activated_at IS NOT NULL as is_v2_active,
           review_url IS NOT NULL as has_review_url, pin_hash IS NOT NULL as has_pin
    FROM public.card
    ORDER BY created_at;
  `);
  console.log(cards);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
