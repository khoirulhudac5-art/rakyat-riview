import path from 'node:path';
import { spawn } from 'node:child_process';

const candidateId = 'dpl_6Q5x35ggJHEmeNio73AYrSKjXc6v';
const baselineId = 'dpl_688bSUnLPMcAxBLatpP5Wg7biACV';
const scope = 'rakprem';
const binary = path.resolve('.local-tools/npm-cache/_npx/69f9afb961c37556/node_modules/vercel/dist/vc.js');

async function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', code => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`CLI error (${code}): ${err}`));
    });
  });
}

async function main() {
  console.log(`=== PROMOTING CANDIDATE ${candidateId} TO PRODUCTION ===\n`);

  console.log('1. Promoting candidate deployment to production domain...');
  const res = await cli(['promote', candidateId, '--scope', scope, '--yes']);
  console.log(res);

  console.log('\n2. Waiting 8s for edge propagation...');
  await new Promise(r => setTimeout(r, 8000));

  console.log('3. Verifying active production deployment...');
  const apiRes = await cli(['api', '/v13/deployments/rakyat-riview.vercel.app', '--scope', scope]);
  const active = JSON.parse(apiRes);

  if (active.id !== candidateId) {
    throw new Error(`Promotion verification failed! Expected ${candidateId}, got ${active.id}`);
  }

  console.log('\n======================================================');
  console.log('   PROMOTION SUCCESSFUL: CANDIDATE IS LIVE ON PROD    ');
  console.log('   Active Deployment: ' + active.id);
  console.log('   Domain: https://rakyat-riview.vercel.app           ');
  console.log('   Rollback Target: ' + baselineId);
  console.log('======================================================\n');
}

main().catch(err => {
  console.error('\nPROMOTION FAILED:', err.message);
  process.exit(1);
});
