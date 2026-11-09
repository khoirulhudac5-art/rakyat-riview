// Latest real-mode frontend and the existing PKCE/session handlers. Auth HTTP
// transport below is mocked for automated regression; no fake Google page or
// demo account is supplied by the application. Real consent is a separate test.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {createProductPreview} from './preview-product.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH=path.resolve('.local-tools/browsers');
const require=createRequire(import.meta.url),{chromium,firefox}=require(path.resolve('.local-tools/browser-tests/node_modules/playwright'));
const target='https://svuagnobufhfpgzmsyxx.supabase.co',review='https://search.google.com/local/writereview?placeid=ChITestFixtureOnly';
const out=path.resolve('test-results/real-mode-ui-'+new Date().toISOString().replace(/[:.]/g,'-'));await fs.mkdir(out,{recursive:true});
const saved={...process.env},nativeFetch=globalThis.fetch,browsers={},reports=[];
try{
 browsers.chromium=await chromium.launch({headless:true});browsers.firefox=await firefox.launch({headless:true});
 for(const [engine,width] of [['chromium',1440],['chromium',320],['chromium',375],['chromium',400],['firefox',1440],['firefox',375]]){
  const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const base='http://127.0.0.1:'+port;
  Object.assign(process.env,{BUYER_INTEGRATION_ENABLED:'true',BUYER_LOCAL_HTTP:'1',BUYER_APP_ORIGIN:base,SUPABASE_URL:target,SUPABASE_PUBLISHABLE_KEY:'test-only-public',BUYER_GOOGLE_ENABLED:'true',BUYER_RESTRICTED_APP:'true'});
  const calls=[],errors=[],checks=[];let challenge,signedIn=false,expireAccess=false,refreshes=0;
  globalThis.fetch=async(url,options)=>{
   const u=String(url);calls.push(u);assert.ok(u.startsWith(target+'/auth/v1/'),'no card, RPC, or real external access');
   if(u.includes('grant_type=pkce')){assert.equal(createHash('sha256').update(JSON.parse(options.body).code_verifier).digest('base64url'),challenge);signedIn=true;return {ok:true,status:200,json:async()=>({access_token:'mock-real-mode-access',refresh_token:'mock-real-mode-refresh',expires_in:3600})};}
   if(u.includes('grant_type=refresh_token')){refreshes++;if(!signedIn)return {ok:false,status:400,json:async()=>({})};expireAccess=false;return {ok:true,status:200,json:async()=>({access_token:'mock-renewed-access',refresh_token:'mock-renewed-refresh',expires_in:3600})};}
   if(u.endsWith('/user'))return !signedIn||expireAccess?{ok:false,status:401,json:async()=>({})}:{ok:true,status:200,json:async()=>({id:'unit-browser-google',email:'browser@example.test',identities:[{provider:'google'}],user_metadata:{full_name:'Penguji Otomatis'}})};
   if(u.includes('/logout?scope=local')){signedIn=false;return {ok:true,status:200,json:async()=>({})};}
   throw Error('Unsupported mocked Auth endpoint');
  };
  const server=createProductPreview({integration:true});await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const context=await browsers[engine].newContext({viewport:{width,height:1000}});await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const screenshot=async label=>{assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label+' overflow');await page.screenshot({path:path.join(out,`${engine}-${width}-${label}.png`),fullPage:true});checks.push(label+' responsive');};
  async function startFrom(button){const waiting=page.waitForRequest(r=>r.url().startsWith(target+'/auth/v1/authorize'));await page.click(button);const req=await waiting;const url=new URL(req.url());assert.equal(url.searchParams.get('provider'),'google');assert.equal(url.searchParams.get('code_challenge_method'),'s256');assert.equal(url.searchParams.get('redirect_to'),base+'/pembeli/oauth.html');challenge=url.searchParams.get('code_challenge');}
  try{
   await page.goto(base+'/preview-new-card');await page.locator('#business').waitFor({state:'visible'});const wizard=page.url();await page.fill('#business','Usaha Draft Pengujian');await page.fill('#maps',review);await page.click('#continue');await page.waitForFunction(()=>!document.getElementById('google').disabled);
   assert.equal(await page.locator('#demo').isHidden(),true);assert.equal(await page.locator('.local-review-fallback').count(),0);assert.match(await page.locator('#mode').textContent(),/GOOGLE ASLI/);await screenshot('before-google');
   await startFrom('#google');await page.goto(base+'/pembeli/oauth.html?error=access_denied');await page.waitForFunction(()=>document.getElementById('status').textContent.includes('dibatalkan'));assert.equal(new URL(page.url()).search,'');await page.click('#oauth-return');await page.locator('#summary').waitFor({state:'visible'});assert.equal(page.url(),wizard);assert.equal(await page.inputValue('#business'),'Usaha Draft Pengujian');checks.push('canceled login returns safely to same draft');
   await page.waitForFunction(()=>!document.getElementById('google').disabled);await startFrom('#google');await page.goto(base+'/pembeli/oauth.html?code=unit-browser-only');await page.waitForURL(wizard);await page.waitForFunction(()=>document.getElementById('step-3').dataset.state==='done');
   assert.equal(await page.inputValue('#business'),'Usaha Draft Pengujian');assert.equal(await page.inputValue('#maps'),review);assert.equal(await page.locator('#claim-card').isHidden(),true);assert.match(await page.locator('#claim-title').textContent(),/closed/);checks.push('PKCE callback restores card/form with verified mock Google identity and no claim');
   expireAccess=true;await page.reload();await page.waitForFunction(()=>document.getElementById('step-3').dataset.state==='done');assert.ok(refreshes>0);assert.equal(await page.locator('#draft-form').isHidden(),true);await screenshot('after-callback');checks.push('expired access recovers with mocked refresh token');
   await page.click('#wizard-logout');await page.waitForFunction(()=>document.getElementById('step-3').dataset.state==='active');assert.equal(await page.locator('#google').isVisible(),true);assert.equal(await page.inputValue('#business'),'Usaha Draft Pengujian');checks.push('logout resets all wizard UI and preserves draft');
   await startFrom('#google');await page.goto(base+'/pembeli/oauth.html?code=unit-login-again');await page.waitForURL(wizard);await page.waitForFunction(()=>document.getElementById('step-3').dataset.state==='done');await page.click('#dashboard-link');await page.waitForURL('**/dashboard.html');await page.waitForFunction(()=>document.querySelector('#content')?.textContent.includes('Akun Anda sudah masuk.'));assert.equal(await page.locator('.buyer-card').count(),0);assert.equal(await page.locator('#logout').isVisible(),true);await screenshot('dashboard-closed');checks.push('relogin and dashboard distinguish Auth success from card access closed');
   await page.click('#logout');await page.waitForURL('**/index.html');await page.locator('#google-signin').waitFor();assert.equal(await page.locator('#demo-signin').count(),0);assert.equal(await page.locator('#google-signin').isEnabled(),true);checks.push('login page uses one real Google entry and no demo');
   const r=await context.request.post(base+'/api/buyer',{headers:{Origin:base,'X-Buyer-Request':'1'},data:{action:'first-claim',card_code:'A'.repeat(24)}});assert.equal(r.status(),403);assert.equal((await r.json()).code,'V2_ACCESS_CLOSED');assert.equal(calls.some(u=>u.includes('/rest/')),false);assert.deepEqual(errors,[]);
   reports.push({engine,width,passed:true,checks});console.log(`${engine} ${width}px real-mode UI with mocked Auth: ${checks.length} checks passed`);
  }finally{await context.close();await new Promise(r=>server.close(r));}
 }
}finally{
 globalThis.fetch=nativeFetch;for(const b of Object.values(browsers))await b.close();for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);
 await fs.writeFile(path.join(out,'RESULT.json'),JSON.stringify({realGoogleLogin:false,authTransport:'MOCKED',liveDatabaseContacted:false,reports},null,2));console.log('Report + screenshots: '+out);
}
