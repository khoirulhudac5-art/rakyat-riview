import path from 'node:path';
import { spawn } from 'node:child_process';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';

const psqlBin = path.resolve('.backups/tooling/pgsql/bin');
const baseEnv = firstClaimConnection();
const env = { ...baseEnv, PGOPTIONS: '-c default_transaction_read_only=off -c statement_timeout=10000' };

const query = `
BEGIN;
UPDATE rr_v2_control.state SET fingerprint = rr_v2_test.fingerprint() WHERE id;
SELECT rr_v2_test.assert_acl();
COMMIT;
`;

const child = spawn(
  path.join(psqlBin, 'psql.exe'),
  ['-X', '-q', '-w', '-c', query],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
);
let out = '', err = '';
child.stdout.on('data', x => out += x);
child.stderr.on('data', x => err += x);
child.on('close', code => {
  console.log('Code:', code, 'Out:\n' + out);
  if (err) console.error('Err:\n' + err);
});
