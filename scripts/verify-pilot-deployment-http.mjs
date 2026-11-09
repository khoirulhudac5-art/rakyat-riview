// Future GET-only deployment smoke checks. No login, POST, RPC write or deployment command.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
const origin='https://rakyat-riview.vercel.app',card='iKRb7_7PyK6kg4Ye7EqvOhYu';
const legacy=['/','/admin.html','/admin-login.html','/aktivasi.html','/r/RRROUTECHECK0000000000000'];
const digest=s=>createHash('sha256').update(s).digest('hex');
async function get(p){const r=await fetch(origin+p,{redirect:'manual',signal:AbortSignal.timeout(20000)});return {path:p,status:r.status,location:r.headers.get('location'),cache:r.headers.get('cache-control'),text:await r.text()};}
const folder=path.resolve('.backups/pilot-http-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(folder,{recursive:false});const report={origin,method:'GET_ONLY',changesMade:false,checks:[]};
const check=(name,pass)=>{report.checks.push({name,pass:!!pass});if(!pass)throw Error(name);};
try{
 if(process.argv[2]==='--capture-v1'){
  report.legacy=[];for(const p of legacy){const r=await get(p);check('baseline '+p,r.status===200);report.legacy.push({path:p,status:r.status,sha256:digest(r.text)});}report.status='V1_BASELINE_CAPTURED';
 }else if(process.argv[2]==='--verify-closed'){
  const before=JSON.parse(fs.readFileSync(process.argv[3]||''));if(before.status!=='V1_BASELINE_CAPTURED'||before.origin!==origin)throw Error('Verified pre-deployment baseline required');
  for(const b of before.legacy){if(!legacy.includes(b.path))throw Error('Unexpected baseline route');const r=await get(b.path);check('V1 unchanged '+b.path,r.status===b.status&&digest(r.text)===b.sha256);}
  for(const p of ['/dashboard.html','/kartu.html','/pembeli/index.html','/pembeli/mulai.html','/pembeli/oauth.html']){const r=await get(p);check('page '+p,r.status===200&&!/sb_secret_|-----BEGIN .*PRIVATE KEY/.test(r.text));}
  const mode=await get('/api/buyer?action=mode'),m=JSON.parse(mode.text);check('pilot profile; no demo or owner edit',mode.status===200&&m.mode==='pilot'&&!m.fixture&&m.capabilities?.update===false);
  for(const p of ['/r/'+card,'/api/buyer-status?card='+card]){const r=await get(p);check('closed '+p,[401,503].includes(r.status)&&!r.location&&r.cache?.includes('no-store')&&!/"(?:review_url|owner_id|user_id|business_name)"/.test(r.text));}
  const anon=await get('/api/buyer?action=cards');check('anonymous dashboard denied',anon.status===401);
  const google=await get('/api/buyer-google');check('Google config endpoint available',google.status===200&&typeof JSON.parse(google.text).enabled==='boolean');
  for(const p of ['/.env.backup','/.backups/','/lib/public-pilot.mjs','/supabase/pilots/001_first_claim_pilot.sql','/scripts/public-pilot-live.mjs'])check('private path denied '+p,[403,404].includes((await get(p)).status));
  report.status='CLOSED_DEPLOYMENT_HTTP_PASS';
 }else throw Error('Use --capture-v1 or --verify-closed <pre-deployment RESULT.json>; nothing is deployed by this script');
}catch(e){report.status='STOPPED';report.reason=e.message;process.exitCode=1;}
fs.writeFileSync(path.join(folder,'RESULT.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({folder,...report}));
