// Future closed installation acceptance only. Do not run before approved installation.
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {verifyGenerateReview,healthSQL,dataSQL} from './admin-generate-preflight.mjs';
import {generateProtectedSQL,inventoryFunctionSQL,closedProfileSQL,validateClosedGenerateProfile} from './admin-generate-review-controls.mjs';
import {firstClaimConnection} from './prepare-first-claim-live.mjs';import {readSnapshot,setReadRole,viewDigestSQL} from './admin-readonly-postflight.mjs';
export async function checkClosedGenerate(beforeFile){
 const report={status:'RUNNING',writeAttempted:false,at:new Date().toISOString()},file=path.resolve('.backups/generate-closed-postflight-'+Date.now()+'.json');
 try{
  const m=verifyGenerateReview(),before=JSON.parse(fs.readFileSync(beforeFile,'utf8'));
  if(before.status!=='GENERATE_LIVE_PREFLIGHT_PASS'||before.package_id!==m.package_id||before.state.fingerprint!==m.expected_fingerprint||!before.generateProtectedFP||!before.inventoryFunctionFP||Date.now()-Date.parse(before.at)>15*60000)throw Error('Fresh matching pre-install report required');
  await readSnapshot({executable:path.resolve('.backups/tooling/pgsql/bin/psql.exe'),env:firstClaimConnection()},async s=>{
   const h=JSON.parse(await s.query(healthSQL));if(h.readonly!=='on'||h.user!=='postgres'||h.database!=='postgres'||h.recovery||h.long_idle||h.long_active||h.waiting||h.strong_locks||h.connections>=h.max_connections*.8)throw Error('Postflight health/read-only guard failed');report.health=h;
   const p=JSON.parse(await s.query(closedProfileSQL));validateClosedGenerateProfile(p,m.package_id);report.profile=p;
   await s.query("SELECT rr_v2_test.verify_state('closed')");await s.query('SELECT rr_v2_generate.assert_acl()');
   if(await s.query(generateProtectedSQL)!==before.generateProtectedFP||await s.query(inventoryFunctionSQL)!==before.inventoryFunctionFP||await s.query(dataSQL)!==before.dataDigest||await s.query(viewDigestSQL)!==before.viewDigest)throw Error('V1/First Claim/data/reader baseline mismatch; STOP');
   report.protectedBaselineUnchanged=true;report.originalRPCsClosed=11;report.testWrappersClosed=2;report.newGenerateClosed=true;
   await setReadRole(s,'service_role');report.readers={};
   for(const [name,key] of [['admin_read_v2_inventory','cards'],['admin_read_v2_audit','events']]){const page=JSON.parse(await s.query('SELECT public.'+name+'(200,NULL)'));if(!Array.isArray(page[key])||!Object.hasOwn(page,'next_cursor'))throw Error('Admin reader contract failed');report.readers[key]={pass:true,rows:page[key].length};}
  });
  report.status='GENERATE_INSTALLED_VERIFIED_CLOSED';
 }catch{report.status='STOPPED';report.reason='Closed-only postflight failed; no writes/retry/rollback attempted; inspect safely before any further action';process.exitCode=1;}
 fs.writeFileSync(file,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({status:report.status,writeAttempted:false,file}));return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){if(process.argv[2]!=='--read-only'||!process.argv[3])throw Error('Use --read-only with fresh pre-install report path');await checkClosedGenerate(process.argv[3]);}
