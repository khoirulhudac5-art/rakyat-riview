// Existing dashboard and actual local HTTP/wrapper adapter. Auth, RPC responses
// and statistics are MOCKED fixtures. No A/B OAuth/claim test or live DB access.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {createProductPreview} from './preview-product.mjs';
const require=createRequire(import.meta.url),{chromium}=require(path.resolve('.local-tools/browser-tests/node_modules/playwright'));
const target='https://svuagnobufhfpgzmsyxx.supabase.co',code='D'.repeat(24),other='E'.repeat(24),run='11111111-2222-4333-8444-555555555555';
const review='https://search.google.com/local/writereview?placeid=ChIDashboardFixtureOnly',nextReview=review+'Edited';
const out=path.resolve('test-results/buyer-dashboard-integration-'+new Date().toISOString().replace(/[:.]/g,'-'));await fs.mkdir(out,{recursive:true});
const nativeFetch=globalThis.fetch,saved={...process.env},reports=[],browsers={};
try{
 browsers.Chrome=await chromium.launch({channel:'chrome',headless:true});browsers.Edge=await chromium.launch({channel:'msedge',headless:true});
 for(const [engine,width] of [['Chrome',1440],['Chrome',320],['Chrome',375],['Edge',400]]){
  const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const base='http://127.0.0.1:'+port;
  Object.assign(process.env,{BUYER_INTEGRATION_ENABLED:'true',BUYER_LOCAL_HTTP:'1',BUYER_APP_ORIGIN:base,SUPABASE_URL:target,SUPABASE_PUBLISHABLE_KEY:'test-public',BUYER_GOOGLE_ENABLED:'true',BUYER_RESTRICTED_APP:'true',RR_TEST_APP_WRITES:'true',RR_TEST_RUN_ID:run,RR_TEST_CARD_CODES:code+','+other,RR_TEST_RUN_EXPIRES_AT:new Date(Date.now()+25*60000).toISOString()});
  let card={card_code:code,business_name:'Fixture Dashboard',review_url:review,active:true},failList=false;const calls=[],checks=[],errors=[];
  globalThis.fetch=async(url,options)=>{
   if(url===target+'/auth/v1/user')return {ok:true,status:200,json:async()=>({id:'fixture-owner',identities:[{provider:'google'}]})};
   assert.equal(url,target+'/rest/v1/rpc/buyer_test_action','only the existing restricted wrapper is used');
   const body=JSON.parse(options.body);calls.push(body);assert.equal(body.p_run,run);assert.ok(['list','update'].includes(body.p_op),'no repeated claim/reset tests');
   if(body.p_op==='list'){if(failList){failList=false;throw Error('Mock list outage');}return {ok:true,status:200,json:async()=>({success:true,cards:[card]})};}
   assert.equal(body.p_card_code,code);card={...card,business_name:body.p_business_name,review_url:body.p_review_url};return {ok:true,status:200,json:async()=>({success:true})};
  };
  const server=createProductPreview({integration:true,restrictedRun:true});await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const context=await browsers[engine].newContext({viewport:{width,height:1000}});await context.addCookies([{name:'rr_buyer_a',value:'fixture-dashboard-cookie',url:base,httpOnly:true,sameSite:'Strict'}]);
  await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  let injectedStatistics=null;
  await page.route('**/api/buyer?action=cards',async route=>{if(!injectedStatistics)return route.continue();const response=await route.fetch();const json=await response.json();await route.fulfill({response,json:{...json,statistics:injectedStatistics}});});
  const open=async()=>{await page.goto(base+'/dashboard.html');await page.locator('#card-list .buyer-card').waitFor();};
  const detail=async()=>{await page.goto(base+'/kartu.html?id='+code);await page.locator('#edit-form').waitFor();};
  const save=async()=>{await page.waitForFunction(()=>!document.getElementById('save').disabled);await page.locator('#save').click();};
  try{
   await open();assert.equal(await page.locator('.buyer-card').count(),1);assert.equal(await page.locator('.stat-value').nth(1).textContent(),'—');assert.equal(await page.locator('.stat-value').nth(2).textContent(),'—');assert.match(await page.locator('.chart-note').textContent(),/Rincian NFC/);assert.equal(await page.locator('.chart polyline').count(),0);assert.doesNotMatch(await page.locator('.demo-notice').textContent(),/masih closed/);checks.push('owned wrapper rows render; unavailable scans/redirect/NFC/QR stay unknown');
   await detail();await page.fill('#business-name','Fixture Dashboard Edited');await page.fill('#review-url',nextReview);await save();await page.waitForFunction(()=>document.getElementById('save-message')?.textContent.includes('berhasil disimpan'));await page.reload();await page.locator('#edit-form').waitFor();assert.equal(await page.inputValue('#business-name'),'Fixture Dashboard Edited');assert.equal(await page.inputValue('#review-url'),nextReview);assert.equal(calls.filter(c=>c.p_op==='update').length,1);checks.push('edit uses existing update wrapper; reloaded values come from server list');
   const day=offset=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
   injectedStatistics={available:true,synthetic:false,visits:20,redirects:15,nfc:null,qr:null,series:[-40,-10,-6,-1,0].map((n,i)=>({date:day(n),visits:i+1,redirects:i})),by_card:{[code]:{visits:20,redirects:15}}};
   await open();assert.equal(await page.locator('.stat-value').nth(1).textContent(),'20');assert.equal(await page.locator('.stats .stat').count(),3);assert.equal(await page.locator('.sidebar').count(),1);assert.equal(await page.locator('.hero-art').count(),1);assert.equal(await page.locator('.chart circle').count(),3);assert.equal(await page.locator('.chart polyline').count(),1);checks.push('unchanged chart renders supplied measurements and the original seven-day graph layout');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(out,`${engine}-${width}-dashboard.png`),fullPage:true});checks.push('existing desktop/mobile layout has no horizontal overflow');
   injectedStatistics={...injectedStatistics,synthetic:true,visits:98765};await open();assert.equal(await page.locator('.stat-value').nth(1).textContent(),'—');assert.equal(await page.locator('.chart polyline').count(),0);checks.push('synthetic statistics are rejected by the real-mode dashboard');injectedStatistics=null;
   await detail();await page.fill('#business-name','Saved Before Reload Outage');failList=true;await save();await page.locator('#retry').waitFor();assert.equal(await page.locator('.account-loading').count(),0);await page.click('#retry');await page.locator('#edit-form').waitFor();assert.equal(await page.inputValue('#business-name'),'Saved Before Reload Outage');checks.push('post-save list failure shows retry; retry reloads saved server values');
   server.closeRestrictedRun();await page.reload();await page.waitForFunction(()=>document.getElementById('view').textContent.includes('closed'));assert.equal(await page.locator('.buyer-card').count(),0);assert.equal(await page.locator('.chart polyline').count(),0);checks.push('closed state never falls back to demo cards or statistics');assert.deepEqual(errors,[]);
   reports.push({engine,width,checks,passed:true});console.log(`${engine} ${width}px: ${checks.length} dashboard checks passed`);
  }finally{await context.close();await new Promise(r=>server.close(r));}
 }
}finally{globalThis.fetch=nativeFetch;for(const b of Object.values(browsers))await b.close();for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);await fs.writeFile(path.join(out,'RESULT.json'),JSON.stringify({authTransport:'MOCKED',rpcTransport:'MOCKED',statistics:'NETWORK FIXTURES',liveDatabaseTouched:false,reports},null,2));console.log('Report: '+out);}
