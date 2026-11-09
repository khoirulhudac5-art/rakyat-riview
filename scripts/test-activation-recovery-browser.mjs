// Local app/HTTP end-to-end. Default: deliberately unavailable/mock resolver.
// --live: only Productmate resolves a known public Maps link; identities/cards
// remain synthetic and Google destinations are never navigated or submitted to.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createProductPreview} from './preview-product.mjs';
import {publicReviewExample as example} from '../pembeli/review-fallback.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH=path.resolve('.local-tools/browsers');
const require=createRequire(import.meta.url),{chromium,firefox}=require(path.resolve('.local-tools/browser-tests/node_modules/playwright'));
const live=process.argv.includes('--live'),out=path.resolve('test-results/activation-recovery-'+(live?'live-':'mock-')+new Date().toISOString().replace(/[:.]/g,'-'));
await fs.mkdir(out,{recursive:true});
const browsers={},reports=[];
let preview4186=null;
try{
 if(live){
  const base='http://127.0.0.1:4186';
  const r=await fetch(base+'/api/convert-review',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify({maps_url:example.maps_url}),signal:AbortSignal.timeout(20000)});
  const data=await r.json();assert.equal(r.status,200,'running preview 4186 must resolve the public Maps link');assert.equal(data.review_url,example.review_url);
  preview4186={status:r.status,review_url:data.review_url,source:'real Productmate',verification:data.verification};
 }
 browsers.chromium=await chromium.launch({headless:true});browsers.firefox=await firefox.launch({headless:true});
 const matrix=live?[['chromium',1440],['firefox',375]]:[['chromium',1440],['chromium',320],['chromium',375],['chromium',400],['firefox',1440],['firefox',375]];
 for(const [engine,width] of matrix){
  let unavailable=true,calls=0;const errors=[],checks=[];
  const mockConvert=(req,res)=>{calls++;return unavailable?res.status(503).json({code:'RESOLVER_NETWORK_BLOCKED',error:'Server lokal belum diizinkan mengakses layanan konversi. Ini bukan kesalahan link Anda.'}):res.status(200).json({review_url:example.review_url,verification:'not_verified'});};
  const server=createProductPreview({file:null,...(live?{}:{convert:mockConvert})});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const context=await browsers[engine].newContext({viewport:{width,height:1000}});
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const layout=async name=>{assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name+' overflow');await page.screenshot({path:path.join(out,`${engine}-${width}-${name}.png`),fullPage:true});checks.push(name+' responsive');};
  try{
   await page.goto(base+'/preview-new-card');await page.locator('#business').waitFor({state:'visible'});
   const code=new URL(page.url()).searchParams.get('card');assert.equal(code.length,24);
   const beforeName='Uji Lokal Aktivasi A',afterName='Uji Lokal Usaha Diperbarui';
   if(!live){
    await page.fill('#maps',example.review_url);assert.equal(await page.locator('#continue').isDisabled(),true,'missing business still blocks next');assert.equal(calls,0,'direct URL must never call resolver');
    await page.fill('#maps','https://maps.app.goo.gl/NetworkFixture');await page.fill('#business',beforeName);
    await page.waitForFunction(()=>document.getElementById('conversion').dataset.state==='error');
    assert.match(await page.locator('#conversion').textContent(),/belum diizinkan/);assert.equal(await page.locator('#continue').isDisabled(),true);
    assert.equal(await page.locator('.local-review-fallback').getAttribute('open')!==null,true);await layout('resolver-blocked');checks.push('network failure preserves disabled next and offers recovery');
    await page.fill('#maps-direct-review','https://evil.example/review');assert.equal(await page.locator('.use-direct-review').isDisabled(),true);assert.match(await page.inputValue('#maps'),/NetworkFixture/);
    await page.fill('#maps-direct-review',example.review_url);await page.locator('.use-direct-review').click();assert.equal(await page.inputValue('#maps'),example.review_url);assert.equal(await page.locator('#continue').isEnabled(),true);assert.equal(await page.inputValue('#business'),beforeName);assert.equal(calls,1);checks.push('explicit direct URL works without resolver or fabricated conversion');
    unavailable=false;await page.locator('.retry-review-conversion').click();await page.waitForFunction(()=>document.getElementById('conversion').dataset.state==='ready');assert.match(await page.inputValue('#maps'),/NetworkFixture/);assert.equal(calls,2);checks.push('retry restores previous Maps input and uses resolver result');
   }else{
    await page.fill('#business',beforeName);await page.fill('#maps',example.maps_url);
    await page.waitForFunction(()=>document.getElementById('conversion').dataset.state==='ready',null,{timeout:25000});
    assert.equal(await page.locator('#try-link').getAttribute('href'),example.review_url);checks.push('real public Maps to Productmate to direct Google Review URL');
   }
   await layout('wizard-ready');await page.click('#continue');await page.locator('#demo').waitFor({state:'visible'});await page.click('#demo');await page.locator('#claim-card').waitFor({state:'visible'});
   await page.reload();await page.locator('#claim-card').waitFor({state:'visible'});assert.equal(await page.locator('#draft-form').isHidden(),true);assert.equal(await page.inputValue('#business'),beforeName);checks.push('draft and account survive refresh without duplicate form');
   await page.click('#claim-card');await page.waitForURL('**/dashboard.html');await page.locator('#owned-list .buyer-card').waitFor();assert.match(await page.locator('#owned-list').textContent(),new RegExp(beforeName));checks.push('demo A claim and owned dashboard');
   await page.locator('#owned-list a.primary').click();await page.locator('#edit-form').waitFor();await page.fill('#business_name',afterName);
   if(!live){
    unavailable=true;await page.fill('#review_url','https://maps.app.goo.gl/EditFailureFixture');await page.waitForFunction(()=>document.querySelector('#edit-form .message').textContent.includes('belum diizinkan'));
    assert.equal(await page.locator('#edit-form button[type=submit]').isDisabled(),true);
    assert.match(await page.locator('.public-review-example').textContent(),/bukan usaha Anda/);
    await page.locator('.use-public-example').click();assert.equal(await page.inputValue('#review_url'),example.review_url);checks.push('edit outage recovered by explicitly labeled public example');
   }else{
    await page.fill('#review_url',example.review_url+'&hl=id');checks.push('edit accepts and normalizes direct link without resolver');
   }
   await page.waitForFunction(()=>!document.querySelector('#edit-form button[type=submit]').disabled);await page.locator('#edit-form button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#edit-form .message')?.textContent.includes('berhasil disimpan'));
   assert.equal(await page.inputValue('#review_url'),example.review_url);assert.equal(await page.inputValue('#business_name'),afterName);await layout('edited-card');checks.push('card edit saved');
   const scan=await context.request.get(base+'/r/'+code,{maxRedirects:0});assert.equal(scan.status(),302);assert.equal(scan.headers().location,example.review_url);
   const anon=await browsers[engine].newContext();try{const r=await anon.request.get(base+'/r/'+code,{maxRedirects:0});assert.equal(r.status(),302);assert.equal(r.headers().location,example.review_url);}finally{await anon.close();}checks.push('scan again redirects correctly without account');
   assert.deepEqual(errors,[]);reports.push({engine,width,passed:true,checks,source:live?'real external resolver; synthetic buyer/cards':'mock resolver; synthetic buyer/cards'});console.log(`${engine} ${width}px ${live?'LIVE resolver':'outage recovery'}: ${checks.length} checks passed`);
  }finally{await context.close();await new Promise(r=>server.close(r));}
 }
}finally{
 for(const browser of Object.values(browsers))await browser.close();
 await fs.writeFile(path.join(out,'RESULT.json'),JSON.stringify({liveResolver:live,googleOAuth:false,supabaseConnected:false,preview4186,reports},null,2));console.log('Report + screenshots: '+out);
}
