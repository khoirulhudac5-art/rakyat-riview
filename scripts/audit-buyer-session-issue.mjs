import { spawn } from 'node:child_process';
import path from 'node:path';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');

async function psql(query) {
  const baseEnv = firstClaimConnection();
  const env = {
    ...baseEnv,
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=15000',
    PGAPPNAME: 'rr-audit'
  };

  return new Promise((resolve, reject) => {
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
}

async function main() {
  const src = await psql(`
    SELECT prosrc FROM pg_proc WHERE oid = 'rr_v2_generate.previous_acl()'::regprocedure;
  `);
  console.log('rr_v2_generate.previous_acl():\n', src);
}

main().catch(console.error);
