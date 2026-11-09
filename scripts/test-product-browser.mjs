// Real local UI + HTTP server; explicit synthetic identities and card data.
// No OAuth provider, Supabase, production fixtures or external destinations.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createProductPreview} from './preview-product.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH=path.resolve('.local-tools/browsers');
const require=createRequire(import.meta.url),{chromium,firefox}=require(path.resolve('.local-tools/browser-tests/node_modules/playwright'));
const out=path.resolve('test-results/product-'+new Date().toISOString().replace(/[:.]/g,'-'));
await fs.mkdir(out,{recursive:true});
const reports=[],review='https://search.google.com/local/writereview?placeid=ChITestFixtureOnly';
const updated=review+'Updated';
const engines={};
try{
 engines.chromium=await chromium.launch({headless:true});engines.firefox=await firefox.launch({headless:true});
 for(const [engine,width] of [['chromium',1440],['chromium',320],['chromium',375],['chromium',400],['firefox',1440],['firefox',375]]){
  const server=createProductPreview({file:null});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port,contexts=[],errors=[],checks=[];
  async function context(){
   const ctx=await engines[engine].newContext({viewport:{width,height:960},acceptDownloads:true});contexts.push(ctx);
   await ctx.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
   ctx.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));return ctx;
  }
  async function layout(page,label){
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${engine}/${width}: horizontal overflow at ${label}`);
   await page.screenshot({path:path.join(out,`${engine}-${width}-${label}.png`),fullPage:true});checks.push(label);
  }
  const post=(ctx,action,body)=>ctx.request.post(base+'/api/buyer',{headers:{Origin:base,'X-Buyer-Request':'1'},data:{action,...body}});
  try{
   const a=await context(),page=await a.newPage();
   await page.goto(base+'/preview-new-card');await page.locator('#business').waitFor({state:'visible'});
   const code=new URL(page.url()).searchParams.get('card');assert.equal(code.length,24);
   await layout(page,'wizard');
   await page.fill('#business','Kopi Simulasi A');await page.fill('#maps',review);
   await page.waitForFunction(()=>!document.getElementById('continue').disabled);
   await page.click('#continue');await page.locator('#demo').waitFor({state:'visible'});await page.click('#demo');
   await page.locator('#claim-card').waitFor({state:'visible'});
   assert.equal(await page.locator('#step-3').getAttribute('data-state'),'done');
   await page.click('#wizard-logout');await page.locator('#demo').waitFor({state:'visible'});
   assert.equal(await page.locator('#step-3').getAttribute('data-state'),'active');assert.equal(await page.inputValue('#business'),'Kopi Simulasi A');
   await page.click('#demo');await page.locator('#claim-card').waitFor({state:'visible'});
   await page.reload();await page.locator('#claim-card').waitFor({state:'visible'});assert.equal(await page.inputValue('#business'),'Kopi Simulasi A');
   await page.click('#claim-card');await page.waitForURL('**/pembeli/dashboard.html');
   await page.locator('#owned-list .buyer-card').waitFor();assert.equal(await page.locator('#owned-list .buyer-card').count(),1);
   await layout(page,'buyer-dashboard');
   if(width<1040){const boxes=await page.locator('.buyer-metric').evaluateAll(nodes=>nodes.map(node=>({top:node.getBoundingClientRect().top,width:node.getBoundingClientRect().width})));assert.equal(boxes[0].top,boxes[1].top);assert.equal(boxes[2].top,boxes[3].top);assert.equal(boxes[0].width,boxes[3].width);}
   const ticks=await page.locator('#scan-chart svg text').allTextContents();assert.equal(new Set(ticks.slice(0,3)).size,3,'integer scan scale must not repeat labels');
   await page.locator('#owned-list a.primary').click();await page.locator('#edit-form').waitFor();
   await page.fill('#business_name','Kopi Simulasi Diperbarui');await page.fill('#review_url',updated);
   await page.waitForFunction(()=>!document.querySelector('#edit-form button[type=submit]').disabled);
   await page.locator('#edit-form button[type=submit]').click();
   await page.waitForFunction(()=>document.querySelector('#edit-form [role=status]')?.textContent.includes('berhasil disimpan'));
   assert.equal(await page.inputValue('#review_url'),updated);await layout(page,'buyer-edit');
   await page.click('#logout');await page.waitForURL('**/pembeli/index.html');await page.locator('#demo-signin').waitFor();
   assert.equal(await page.locator('#google-signin').count(),1);assert.equal(await page.locator('#google-login').count(),0);
   await layout(page,'buyer-login');await page.click('#demo-signin');await page.waitForURL('**/dashboard.html');await page.locator('#owned-list .buyer-card').waitFor();
   await page.reload();await page.locator('#owned-list .buyer-card').waitFor();checks.push('logout-relogin-refresh-persisted');
   const b=await context(),pageB=await b.newPage();await pageB.goto(base+'/pembeli/');await pageB.click('#demo-signin-second');await pageB.waitForURL('**/dashboard.html');
   await pageB.locator('.buyer-empty').waitFor();assert.equal(await pageB.locator('#owned-list .buyer-card').count(),0);
   assert.equal((await post(b,'first-claim',{card_code:code,business_name:'Forbidden',review_url:review})).status(),409);
   assert.equal((await post(b,'update',{card_code:code,business_name:'Forbidden',review_url:review})).status(),403);checks.push('account-isolation');
   const anon=await context(),redirect=await anon.request.get(base+'/r/'+code,{maxRedirects:0});assert.equal(redirect.status(),302);assert.equal(redirect.headers().location,updated);checks.push('public-redirect-no-login');
   const admin=await context(),pa=await admin.newPage();await pa.goto(base+'/admin-v2.html');await pa.fill('#admin-password','demo-admin');await pa.click('#admin-login-submit');await pa.locator('#inventory-count').waitFor();
   await pa.waitForFunction(()=>document.getElementById('inventory-count')?.textContent==='3');await layout(pa,'admin-dashboard');
   await pa.click('#open-create');await pa.fill('#create-quantity','2');await pa.click('#create-submit');await pa.waitForFunction(()=>document.getElementById('inventory-count')?.textContent==='5');checks.push('admin-create-ready');
   const downloadPromise=pa.waitForEvent('download');await pa.click('#export-cards');const download=await downloadPromise;
   const csv=await fs.readFile(await download.path(),'utf8');const rows=csv.trim().split(/\r?\n/).slice(1);assert.equal(rows.length,5);
   for(const row of rows){const values=row.match(/"(?:[^"]|"")*"/g);assert.equal(values[4],values[5]);}checks.push('csv-nfc-qr-identical');
   await pa.fill('#card-search',code);await pa.locator('[data-detail]').first().click();await pa.locator('#detail-dialog').waitFor({state:'visible'});await layout(pa,'admin-detail');
   await pa.click('#open-reset');await pa.fill('#reset-confirmation',code);await pa.fill('#reset-reason','Reset aktivasi kartu sintetis untuk pengujian antarakun.');await pa.check('#reset-ack');await pa.click('#reset-submit');
   await pa.waitForFunction(()=>!document.getElementById('reset-dialog').open);await pa.locator('#inventory-body .status.ready').waitFor();checks.push('admin-confirmed-reset');
   assert.equal((await post(a,'update',{card_code:code,business_name:'Former owner',review_url:review})).status(),403);
   await page.reload();await page.locator('.buyer-empty').waitFor();
   await pageB.goto(base+'/pembeli/mulai.html?card='+code);await pageB.locator('#business').waitFor({state:'visible'});await pageB.fill('#business','Usaha Simulasi B');await pageB.fill('#maps',review);
   await pageB.waitForFunction(()=>!document.getElementById('continue').disabled);await pageB.click('#continue');await pageB.locator('#claim-card').waitFor({state:'visible'});await pageB.click('#claim-card');await pageB.waitForURL('**/dashboard.html');await pageB.locator('#owned-list .buyer-card').waitFor();checks.push('reclaim-after-reset');
   if(width<769){await pa.click('#menu-open');}await pa.locator('[data-view="audit"]').click();await pa.locator('.audit-item').first().waitFor();assert.match(await pa.locator('#audit-body').textContent(),/Reset Aktivasi/);await layout(pa,'admin-audit');
   assert.deepEqual(errors,[]);reports.push({engine,width,checks,passed:true});console.log(`${engine} ${width}px: ${checks.length} checks passed`);
  }finally{for(const c of contexts)await c.close();await new Promise(r=>server.close(r));}
 }
 await fs.writeFile(path.join(out,'RESULT.json'),JSON.stringify({synthetic:true,google_oauth_tested:false,production_contacted:false,reports},null,2));console.log('Screenshots + report: '+out);
}finally{for(const browser of Object.values(engines))await browser.close();}
