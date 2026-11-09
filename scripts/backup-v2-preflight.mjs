import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { firstClaimConnection } from './prepare-first-claim-live.mjs';
import { readSnapshot } from './admin-readonly-postflight.mjs';

const root = process.cwd();
const bin = path.resolve('.backups/tooling/pgsql/bin');

const shaFile = async file => {
  const h = createHash('sha256');
  for await (const b of fs.createReadStream(file)) h.update(b);
  return h.digest('hex');
};

async function tool(name, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(bin, name + '.exe'), args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => {
      done = true;
      child.kill();
      reject(Error('Tool timeout: ' + name));
    }, 120000);
    child.stdout.on('data', x => out += x);
    child.stderr.on('data', x => err += x);
    child.on('error', err => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve({ out, warnings: err.trim().length > 0, err });
      else reject(Error(`Tool ${name} failed with code ${code}: ${err.trim()}`));
    });
  });
}

async function main() {
  const folder = path.resolve('.backups/v2-production-backup-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  console.log('Initiating pre-migration production backup into:', folder);

  const env = firstClaimConnection();

  // 1. Snapshot metadata & row counts
  let metadata = {};
  await readSnapshot({ executable: path.join(bin, 'psql.exe'), env }, async s => {
    metadata.database = JSON.parse(await s.query("SELECT json_build_object('database', current_database(), 'user', current_user, 'version', current_setting('server_version'), 'server_version_num', current_setting('server_version_num')::int)"));
    metadata.pilotCard = JSON.parse(await s.query("SELECT row_to_json(c) FROM public.card c WHERE card_code = 'iKRb7_7PyK6kg4Ye7EqvOhYu'"));
    metadata.totalCards = Number(await s.query("SELECT count(*) FROM public.card"));
    metadata.tableCounts = JSON.parse(await s.query(`SELECT json_build_object(
      'card', (SELECT count(*) FROM public.card),
      'card_activation', (SELECT count(*) FROM public.card_activation),
      'card_pin_attempts', (SELECT count(*) FROM public.card_pin_attempts),
      'buyer_card_inventory', (SELECT count(*) FROM public.buyer_card_inventory),
      'buyer_card_ownership', (SELECT count(*) FROM public.buyer_card_ownership),
      'buyer_claim_limits', (SELECT count(*) FROM public.buyer_claim_limits),
      'buyer_ownership_audit', (SELECT count(*) FROM public.buyer_ownership_audit)
    )`));
  });

  fs.writeFileSync(path.join(folder, 'metadata.json'), JSON.stringify(metadata, null, 2));
  console.log('Metadata captured. Tables status:', metadata.tableCounts);

  // 2. Full binary pg_dump
  console.log('Running pg_dump binary capture...');
  const dumpFile = path.join(folder, 'database.dump');
  await tool('pg_dump', ['--no-password', '--serializable-deferrable', '--format=custom', '--lock-wait-timeout=10s', '--file', dumpFile], env);

  const dumpStat = fs.statSync(dumpFile);
  if (dumpStat.size < 10000) throw Error('Dump file too small or incomplete: ' + dumpStat.size);
  const dumpSha = await shaFile(dumpFile);

  const manifest = {
    status: 'BACKUP_VERIFIED',
    at: new Date().toISOString(),
    project_ref: 'svuagnobufhfpgzmsyxx',
    dump: {
      file: 'database.dump',
      bytes: dumpStat.size,
      sha256: dumpSha
    },
    metadata
  };

  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({
    success: true,
    folder,
    dumpBytes: dumpStat.size,
    dumpSha256: dumpSha,
    totalCards: metadata.totalCards,
    pilotCardPreserved: Boolean(metadata.pilotCard?.card_code === 'iKRb7_7PyK6kg4Ye7EqvOhYu' && metadata.pilotCard?.v2_activated_at)
  }, null, 2));
}

main().catch(err => {
  console.error('BACKUP FAILED:', err.message);
  process.exit(1);
});
