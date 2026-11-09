// Auth-session preparation ONLY. No SQL runner import, PostgreSQL connection,
// dummy creation, open_run, restricted-run timer or automatic live activation.
import fs from 'node:fs';
import {createProductPreview} from './preview-product.mjs';
import {startRealProduct} from './preview-product-real.mjs';
import {createLiveClaimSession} from './first-claim-live-session.mjs';
if(process.argv.includes('--restricted-run')||process.argv.includes('--approved'))throw Error('Session preparation cannot open restricted card access.');
const plan=JSON.parse(fs.readFileSync('.local-tools/first-claim-live/plan.json','utf8'));
if(plan.project_ref!=='svuagnobufhfpgzmsyxx'||!plan.accounts?.A?.uid||!plan.accounts?.B?.uid||plan.accounts.A.uid===plan.accounts.B.uid)throw Error('Private selected-account plan is invalid.');
const harness=createLiveClaimSession(plan,{preparationOnly:true});
const app=await startRealProduct(options=>createProductPreview({...options,restrictedRun:false,claimTest:harness}));
process.once('SIGINT',()=>{harness.clear();app.server.close();app.frontdoor.close();process.exit(0);});
process.once('SIGTERM',()=>{harness.clear();app.server.close();app.frontdoor.close();process.exit(0);});
console.log('SESSION PREPARATION ONLY: http://127.0.0.1:4180/pembeli/claim-test.html\nNo open_run, no card writes, no preparation countdown. Both sessions ready does not open access.');
