import path from 'node:path';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');
const baseEnv = firstClaimConnection();
const env = { ...baseEnv, PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=5000' };

const query = "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = 'auth' ORDER BY table_name;";

const child = spawn(
  path.join(psqlBin, 'psql.exe'),
  ['-X', '-q', '-w', '-c', query],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
);
let out = '', err = '';
child.stdout.on('data', x => out += x);
child.stderr.on('data', x => err += x);
child.on('close', code => {
  console.log('Out:\n' + out);
  if (err) console.error('Err:\n' + err);
});
