// Actual installed Chrome/Edge engines, Auth transport mocked. No OAuth login,
// SQL runner, card RPC, customer data or external browser navigation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {createLiveClaimSession} from './first-claim-live-session.mjs';
import {createProductPreview} from './preview-product.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH=path.resolve('.local-tools/browsers');
const require=createRequire(import.meta.url),{chromium}=require(path.resolve('.local-tools/browser-tests/node_modules/playwright'));
const out=path.resolve('test-results/claim-session-preparation-'+new Date().toISOString().replace(/[:.]/g,'-'));await fs.mkdir(out,{recursive:true});
const saved={...process.env},nativeFetch=globalThis.fetch,browsers={},reports=[];
const plan={accounts:{A:{uid:'unit-A'},B:{uid:'unit-B'}}};
const jwt=(id,tag)=>'fixture.'+Buffer.from(JSON.stringify({sub:id,session_id:'session-'+id,exp:Math.floor(Date.now()/1000)+3600,tag})).toString('base64url')+'.test';
try{
 browsers.Chrome=await chromium.launch({channel:'chrome',headless:true});browsers.Edge=await chromium.launch({channel:'msedge',headless:true});
 for(const [chromeWidth,edgeWidth] of [[1440,1440],[375,375],[320,400]]){
  const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const base='http://127.0.0.1:'+port;
  Object.assign(process.env,{BUYER_INTEGRATION_ENABLED:'true',BUYER_LOCAL_HTTP:'1',BUYER_APP_ORIGIN:base,SUPABASE_URL:'https://svuagnobufhfpgzmsyxx.supabase.co',SUPABASE_PUBLISHABLE_KEY:'test-public',BUYER_GOOGLE_ENABLED:'true',BUYER_RESTRICTED_APP:'true'});
  let calls=0,refreshes=0,server,harness=createLiveClaimSession(plan,{preparationOnly:true});harness.phase='FINISHED';
  globalThis.fetch=async(url,options)=>{
   calls++;const u=String(url);assert.ok(u.endsWith('/auth/v1/user')||u.endsWith('/auth/v1/token?grant_type=refresh_token'),'no RPC, OAuth provider or external API');
   if(u.includes('grant_type=refresh_token')){refreshes++;return {ok:true,status:200,json:async()=>({access_token:jwt('unit-B','fresh'),refresh_token:'refreshed-unit-B',expires_in:3600})};}
   const data=JSON.parse(Buffer.from(options.headers.Authorization.slice(7).split('.')[1],'base64url'));
   if(data.tag==='stale')return {ok:false,status:401,json:async()=>({})};
   return {ok:true,status:200,json:async()=>({id:data.sub,identities:[{provider:'google'}]})};
  };
  const start=async()=>{server=createProductPreview({integration:true,claimTest:harness});await new Promise(r=>server.listen(port,'127.0.0.1',r));};await start();
  const contexts=[],pages=[],errors=[],checks=[];
  try{
   for(const [engine,width,id] of [['Chrome',chromeWidth,'unit-A'],['Edge',edgeWidth,'unit-B']]){
    const context=await browsers[engine].newContext({viewport:{width,height:960}});contexts.push(context);await context.addCookies([{name:'rr_buyer_a',value:jwt(id,id==='unit-B'?'stale':'fresh'),url:base,httpOnly:true,sameSite:'Strict'},{name:'rr_buyer_r',value:'refresh-'+id,url:base,httpOnly:true,sameSite:'Strict'}]);
    await context.route('**/*',r=>{const u=new URL(r.request().url());if(u.origin===base)return r.continue();if(u.href.startsWith('https://svuagnobufhfpgzmsyxx.supabase.co/auth/v1/authorize'))return r.fulfill({status:200,contentType:'text/html',body:'<p>Mock OAuth navigation only; no provider request.</p>'});return r.abort();});
    const page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/pembeli/claim-test.html');await page.waitForFunction(()=>document.getElementById('phase').textContent.includes('FINISHED'));assert.equal(await page.locator('#register').isDisabled(),true);assert.equal(await page.locator('#login').isHidden(),true);
   }
   assert.equal(calls,0);checks.push('FINISHED is identified as closed registration, not a failed Google login');
   harness.phase='WAITING_FOR_SESSIONS';
   for(const page of pages)await page.waitForFunction(()=>document.getElementById('phase').textContent.includes('SESSIONS_READY'),null,{timeout:20000});
   assert.match(await pages[0].locator('#identity').textContent(),/penguji A terdaftar di Chrome/);assert.match(await pages[1].locator('#identity').textContent(),/penguji B terdaftar di Edge/);assert.ok(refreshes>=1);checks.push('existing A cookie detected in Chrome; B renewed in Edge without Google login');
   for(let i=0;i<pages.length;i++){const page=pages[i];assert.equal(await page.locator('#login').isHidden(),true);assert.equal(await page.locator('#register').isEnabled(),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(out,`${i?'Edge':'Chrome'}-${i?edgeWidth:chromeWidth}-ready.png`),fullPage:true});}
   checks.push('Chrome and Edge layouts have no horizontal overflow');
   // A chosen browser does not determine the Google UID: reproduce Edge carrying
   // A while its page expects B. Diagnose the mismatch; never relabel A as B.
   await contexts[1].addCookies([{name:'rr_buyer_a',value:jwt('unit-A','fresh'),url:base,httpOnly:true,sameSite:'Strict'}]);
   await pages[1].goto(base+'/pembeli/claim-test.html?account=B');await pages[1].waitForFunction(()=>document.getElementById('identity').textContent.includes('halaman ini menunggu B'));
   assert.match(await pages[1].locator('#identity').textContent(),/Sesi aplikasi A/);assert.equal(await pages[1].locator('#switch-account').isVisible(),true);assert.match(await pages[1].locator('#switch-account').textContent(),/Google B/);
   const choosing=pages[1].waitForRequest(r=>r.url().startsWith('https://svuagnobufhfpgzmsyxx.supabase.co/auth/v1/authorize'));await pages[1].locator('#switch-account').click();assert.equal(new URL((await choosing).url()).searchParams.get('prompt'),'select_account');await pages[1].waitForURL('https://svuagnobufhfpgzmsyxx.supabase.co/auth/v1/authorize**');
   await contexts[1].addCookies([{name:'rr_buyer_a',value:jwt('unit-B','fresh'),url:base,httpOnly:true,sameSite:'Strict'}]);await pages[1].goto(base+'/pembeli/claim-test.html?account=B');await pages[1].waitForFunction(()=>document.getElementById('identity').textContent.includes('penguji B terdaftar di Edge'));
   checks.push('Edge carrying A is diagnosed; explicit B chooser retains context and verified B can register');
   const instance=(await contexts[0].request.get(base+'/api/claim-test').then(r=>r.json())).instanceId;
   await new Promise(r=>server.close(r));harness.clear();harness=createLiveClaimSession(plan,{preparationOnly:true});await start();
   const deadline=Date.now()+20000;let registered=false;
   while(Date.now()<deadline){const s=await contexts[0].request.get(base+'/api/claim-test').then(r=>r.json());if(s.instanceId!==instance&&s.ready.A&&s.ready.B){registered=true;break;}await new Promise(r=>setTimeout(r,200));}
   assert.equal(registered,true,'both browser tabs must register against the new server instance');
   const status=await contexts[0].request.get(base+'/api/claim-test').then(r=>r.json());assert.notEqual(status.instanceId,instance);assert.equal(status.runClockStarted,false);assert.equal(status.preparationOnly,true);assert.deepEqual(status.browsers,{A:'Chrome',B:'Edge'});checks.push('same tabs re-register cookies after server restart without relogin');
   const mode=await contexts[0].request.get(base+'/api/buyer?action=mode').then(r=>r.json());assert.equal(mode.card_access,'closed');
   const write=await contexts[0].request.post(base+'/api/buyer',{headers:{Origin:base,'X-Buyer-Request':'1'},data:{action:'first-claim',card_code:'A'.repeat(24)}});assert.equal(write.status(),403);checks.push('both ready never activates a run or writes cards');
   assert.deepEqual(errors,[]);reports.push({chromeWidth,edgeWidth,passed:true,checks});console.log(`Chrome ${chromeWidth}px + Edge ${edgeWidth}px: ${checks.length} checks passed`);
  }finally{for(const c of contexts)await c.close();if(server?.listening)await new Promise(r=>server.close(r));}
 }
}finally{globalThis.fetch=nativeFetch;for(const b of Object.values(browsers))await b.close();for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);await fs.writeFile(path.join(out,'RESULT.json'),JSON.stringify({authTransport:'MOCKED',realGoogleLoginTested:false,liveDatabaseTouched:false,reports},null,2));console.log('Report: '+out);}
