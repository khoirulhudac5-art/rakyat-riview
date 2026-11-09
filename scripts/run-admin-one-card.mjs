// Explicitly approved live one-card UI test. Exactly one persistent UUID and UI submit.
import fs from 'node:fs';import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';import {createRequire} from 'node:module';
import {firstClaimConnection} from './prepare-first-claim-live.mjs';import {readSnapshot} from './admin-readonly-postflight.mjs';
import {closedProfileSQL} from './admin-generate-review-controls.mjs';import {healthSQL} from './admin-generate-preflight.mjs';import {protectedSQL} from './admin-readonly-package.mjs';
import {readAdminEnv,adminConfigStatus} from './admin-readonly-config.mjs';import {adminCookieHash,closeOneCardPermit} from '../lib/admin-one-card-gate.mjs';
const require=createRequire(import.meta.url),{chromium}=require(path.resolve('.local-tools/browser-tests/node_modules/playwright'));
const dir=path.resolve('.local-tools/admin-generate-one-card'),planFile=path.join(dir,'plan.json'),permitFile=path.join(dir,'permit.json');
fs.mkdirSync(dir,{recursive:true});const expected='5aefd8e4df29f1c365b8942629b911cd',origin='http://127.0.0.1:4194';
const reportFile=path.join(dir,'RESULT.json'),profileSQL=closedProfileSQL.replace("'admin_read_v2_inventory','admin_read_v2_audit'","'admin_read_v2_inventory','admin_read_v2_audit','admin_generate_v2_batch'");
let plan,report={status:'PREPARING',startedAt:new Date().toISOString(),createAttempted:false,uiSubmitCount:0},browser,context,cookie='',stage='plan';
const save=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
const config=()=>({executable:path.resolve('.backups/tooling/pgsql/bin/psql.exe'),env:firstClaimConnection()});
function codeFilter(){return `NOT EXISTS(SELECT 1 FROM rr_v2_generate.cards g WHERE g.request_id='${plan.request_id}'::uuid AND g.card_code=c.card_code)`;}
function unrelatedDataSQL(){return `SELECT md5(jsonb_build_object(
 'cards',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card c WHERE ${codeFilter()}),
 'inventory',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.buyer_card_inventory c WHERE ${codeFilter()}),
 'pin',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card_pin_attempts c),
 'activation',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.card_activation c),
 'owners',(SELECT jsonb_agg(to_jsonb(c) ORDER BY card_code) FROM public.buyer_card_ownership c),
 'quota',(SELECT jsonb_agg(to_jsonb(c) ORDER BY user_id) FROM public.buyer_claim_limits c),
 'audit',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.buyer_ownership_audit c),
 'reset',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.buyer_activation_reset_audit c))::text)`;}
async function snapshot(){return readSnapshot(config(),async s=>{
 const h=JSON.parse(await s.query(healthSQL)),p=JSON.parse(await s.query(profileSQL));
 if(h.readonly!=='on'||h.database!=='postgres'||h.user!=='postgres'||h.version!==170011||h.recovery||h.waiting||h.strong_locks||h.long_idle||h.long_active||h.connections>=h.max_connections*.8)throw Error('Preflight health/identity failed');
 if(p.stage!==6||p.state!=='closed'||!p.match||p.fingerprint!==expected||p.enabled!==true||!p.allowlist_effective||p.total_rpcs!==16||p.context_count!==0||p.package_id!=='dda6227219ae8cdb4a2079feb45144e31998811a228a1df33bac71a3620bdde7')throw Error('Fingerprint/ACL/context mismatch');
 await s.query("SELECT rr_v2_test.verify_state('closed')");if(await s.query("SELECT count(*)=0 FROM rr_v2_test.runs WHERE status IN ('active','provisioning')")!=='t')throw Error('Restricted run active');
 return {health:h,profile:p,unrelatedData:await s.query(unrelatedDataSQL()),catalog:await s.query(protectedSQL)};
});}
async function reconcile(){return readSnapshot(config(),async s=>JSON.parse(await s.query(`SELECT json_build_object('batches',(SELECT count(*) FROM rr_v2_generate.batches WHERE request_id='${plan.request_id}'),
 'cards',(SELECT coalesce(json_agg(card_code ORDER BY ordinal),'[]') FROM rr_v2_generate.cards WHERE request_id='${plan.request_id}'))`)));}
try{
 if(process.argv[2]!=='--approved-one-card')throw Error('Explicit one-card approval flag required');
 if(fs.existsSync(planFile)){
  plan=JSON.parse(fs.readFileSync(planFile));if(plan.createAttempted||fs.existsSync(reportFile))throw Error('Existing attempt recorded; reconcile existing UUID only, no new request');
 }else{
  plan={request_id:randomUUID(),quantity:1,project_ref:'svuagnobufhfpgzmsyxx',domain:'https://rakyat-riview.vercel.app',createAttempted:false,created_at:new Date().toISOString()};fs.writeFileSync(planFile,JSON.stringify(plan,null,2),{flag:'wx'});
 }
 report.request_id=plan.request_id;closeOneCardPermit(permitFile,'closed during preflight');save();
 stage='domain_readonly';const route=await fetch(plan.domain+'/r/RRROUTECHECK0000000000000',{redirect:'manual',signal:AbortSignal.timeout(20000)}),html=await route.text();
 if(route.status!==200||!html.includes('svuagnobufhfpgzmsyxx')||!html.includes('location.pathname'))throw Error('Domain routing check failed');
 report.domain={origin:plan.domain,routeStatus:200,dynamicCardCode:true,publicV2StatusPresent:html.includes('buyer_public_card_status'),exportEnabled:false};
 stage='fresh_preflight';report.before=await snapshot();if(report.before.profile.batch_count!==0||report.before.profile.card_count!==0)throw Error('Expected zero prior production batches');report.preflightPASS=true;save();
 stage='admin_browser_login';const e={...process.env,...readAdminEnv('.env.admin-readonly')};if(!adminConfigStatus(e).ready)throw Error('Admin backend config unavailable');
 browser=await chromium.launch({channel:'chrome',headless:true});context=await browser.newContext({viewport:{width:1440,height:960}});const page=await context.newPage();
 await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 await page.goto(origin+'/admin-v2.html');await page.locator('input[type=password]').fill(e.ADMIN_PASSWORD);await page.locator('button[type=submit]').click();await page.locator('#open-create').waitFor();
 const cookies=await context.cookies(origin),admin=cookies.find(c=>c.name==='__Host-rr_admin');if(!admin)throw Error('Valid Admin session missing');cookie=admin.name+'='+admin.value;
 stage='arm_scoped_permit';
 fs.writeFileSync(permitFile,JSON.stringify({state:'armed',request_id:plan.request_id,quantity:1,project_ref:plan.project_ref,expected_fingerprint:expected,session_hash:adminCookieHash(cookie),expires_at:Date.now()+5*60000,armed_at:new Date().toISOString()},null,2));
 // Seed only the request UUID, never ownership or credentials. Existing UI uses
 // this same persisted key after refresh and never generates a replacement here.
 await page.evaluate(p=>sessionStorage.setItem('rr-admin-generate-pending-v1',JSON.stringify({request_id:p.request_id,quantity:1})),plan);
 await page.reload();await page.locator('#open-create').waitFor();await page.waitForFunction(()=>!document.querySelector('#open-create')?.disabled);
 await page.locator('#open-create').click();await page.locator('#create-quantity').fill('1');
 stage='single_ui_submit';plan.createAttempted=true;plan.attempted_at=new Date().toISOString();fs.writeFileSync(planFile,JSON.stringify(plan,null,2));report.createAttempted=true;save();
 page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/v2-admin')&&r.postDataJSON()?.action==='create')report.uiSubmitCount++;});
 const pending=page.waitForResponse(r=>r.url().includes('/api/v2-admin')&&r.request().method()==='POST'&&r.request().postDataJSON()?.action==='create',{timeout:45000});
 await page.locator('#create-submit').click();const response=await pending,data=await response.json();report.httpCreateStatus=response.status();
 if(response.status()!==200||!data.success||data.batch_id!==plan.request_id||!Array.isArray(data.cards)||data.cards.length!==1||report.uiSubmitCount!==1)throw Error('Create response unconfirmed; reconcile same UUID');
 report.card_code=data.cards[0].card_code;report.committedResponse=true;closeOneCardPermit(permitFile,'successful UI response; close before verification');save();
 stage='post_commit_database';report.after=await snapshot();
 if(report.after.profile.batch_count!==1||report.after.profile.card_count!==1||report.before.unrelatedData!==report.after.unrelatedData||report.before.catalog!==report.after.catalog)throw Error('Unexpected data/catalog change or wrong card count');
 const verified=await readSnapshot(config(),async s=>{
  const r=JSON.parse(await s.query(`SELECT json_build_object('card_code',g.card_code,'valid',b.quantity=1 AND b.complete AND b.actor='admin:configured-owner' AND g.ordinal=1 AND c.claim_mode='google_first_claim' AND c.business_name IS NULL AND c.review_url IS NULL AND c.pin_hash IS NULL AND c.v2_activated_at IS NULL AND i.state='ready' AND i.ready_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.buyer_card_ownership o WHERE o.card_code=c.card_code) AND NOT EXISTS(SELECT 1 FROM public.card_activation a WHERE a.card_code=c.card_code),
  'audit_count',(SELECT count(*) FROM rr_v2_control.admin_read_audit a WHERE a.card_code=g.card_code AND a.action='create' AND a.actor=b.actor AND a.reason='batch:'||b.request_id::text))
  FROM rr_v2_generate.cards g JOIN rr_v2_generate.batches b USING(request_id) JOIN public.card c USING(card_code) JOIN public.buyer_card_inventory i USING(card_code) WHERE g.request_id='${plan.request_id}'`));return r;
 });
 if(!verified.valid||verified.audit_count!==1||verified.card_code!==report.card_code)throw Error('Ready inventory or persisted Admin audit mismatch');report.databaseVerified=verified;
 stage='dashboard_readers';await page.waitForFunction(()=>!document.querySelector('#create-dialog')?.open);await page.reload();await page.waitForFunction(code=>document.querySelector('#inventory-body')?.textContent.includes(code),report.card_code,{timeout:20000});
 if(!await page.locator('#open-create').isDisabled()||!await page.locator('#export-cards').isDisabled())throw Error('Create/export UI not closed');
 if(!await page.locator('#inventory-body').innerText().then(t=>t.includes(report.card_code)))throw Error('Created card missing from Dashboard');
 const auditHTTP=await page.evaluate(async()=>{const r=await fetch('/api/v2-admin?action=audit',{credentials:'same-origin',cache:'no-store'});return {status:r.status,data:await r.json()};});if(auditHTTP.status!==200||!auditHTTP.data.events.some(a=>a.card_code===report.card_code&&a.action==='create'))throw Error('HTTP audit missing');
 report.dashboardInventoryVerified=true;report.dashboardAuditVerified=true;
 await page.screenshot({path:path.join(dir,'dashboard-after.png'),fullPage:false});report.status='LIVE_ONE_CARD_PASS';
}catch{report.status='STOPPED';report.failedStage=stage;report.reason='Check failed; no automatic retry or replacement idempotency key. Sensitive details suppressed.';process.exitCode=1;}
finally{
 closeOneCardPermit(permitFile,'test finished or failed; no further create authorized');report.permitClosed=true;
 if(cookie){try{
  const h={origin,cookie,'content-type':'application/json','x-admin-request':'1'},r=await fetch(origin+'/api/v2-admin?action=create',{method:'POST',headers:h,body:JSON.stringify({action:'create',quantity:1,request_id:plan?.request_id}),signal:AbortSignal.timeout(10000)});report.finalCreateHTTP=r.status;
  if(r.status!==423){report.status='STOPPED';report.guardClosureFailed=true;process.exitCode=1;}
  await fetch(origin+'/api/v2-admin?action=logout',{method:'POST',headers:h,body:'{"action":"logout"}'});
 }catch{report.guardHTTPVerified=false;report.status='STOPPED';process.exitCode=1;}}
 if(plan?.request_id&&report.createAttempted&&!report.databaseVerified){try{report.reconciliation=await reconcile();if(report.reconciliation.cards.length===1)report.card_code=report.reconciliation.cards[0];}catch{report.reconciliation='Read-only reconciliation unavailable; preserve key and inspect before any further write';}}
 if(context)await context.close();if(browser)await browser.close();report.finishedAt=new Date().toISOString();save();
 console.log(JSON.stringify({status:report.status,card_code:report.card_code,request_id:plan?.request_id,uiSubmitCount:report.uiSubmitCount,guardCreate:report.finalCreateHTTP,permitClosed:true,databaseVerified:Boolean(report.databaseVerified),stage:report.failedStage,report:reportFile}));
}
