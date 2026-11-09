// Headless browser regression. REAL UI + PKCE handler; SIMULATED provider,
// Auth tokens, resolver and account database. Never loads .env or production.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash,randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {createPreview} from './preview-accounts.mjs';
import google from '../api/buyer-google.js';
if(process.env.NODE_ENV==='production'||process.env.VERCEL)throw Error('Local tests only');
process.env.PLAYWRIGHT_BROWSERS_PATH=path.resolve('.local-tools/browsers');
const require=createRequire(import.meta.url),{chromium,firefox}=require(path.resolve('.local-tools/browser-tests/node_modules/playwright'));
const out=path.resolve('test-results/buyer-'+new Date().toISOString().replace(/[:.]/g,'-'));await fs.mkdir(out,{recursive:true});
const originalEnv={...process.env},originalFetch=globalThis.fetch,engines={},reports=[];
const review='https://search.google.com/local/writereview?placeid=ChITestFixtureOnly';
try{
 engines.chromium=await chromium.launch({headless:true});engines.firefox=await firefox.launch({headless:true});
 for(const [engine,width]of [['chromium',1440],['chromium',320],['chromium',375],['chromium',400],['firefox',1440],['firefox',375]]){
  const server=createPreview({experience:true,firstClaim:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  Object.assign(process.env,{BUYER_INTEGRATION_ENABLED:'true',BUYER_LOCAL_HTTP:'1',BUYER_APP_ORIGIN:base,SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',BUYER_GOOGLE_ENABLED:'true'});
  const codes=new Map(),contexts=[],errors=[],checks=[];let refreshes=0,claimExpired=false,editExpired=false,sessionExpired=false;
  globalThis.fetch=async(url,options)=>{
   if(String(url)!=='https://fixture.supabase.co/auth/v1/token?grant_type=pkce')throw Error('External request blocked by browser test');
   const body=JSON.parse(options.body),challenge=codes.get(body.auth_code);codes.delete(body.auth_code);
   if(!challenge||createHash('sha256').update(body.code_verifier).digest('base64url')!==challenge)return{ok:false,status:400,json:async()=>({})};
   return{ok:true,json:async()=>({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600})};
  };
  async function context(browser,account='first'){
   const c=await browser.newContext({viewport:{width,height:900}});contexts.push(c);
   await c.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url());
    if(u.origin===base)return route.continue();
    if(req.url()===review)return route.fulfill({contentType:'text/html',body:'<h1>Simulated review destination</h1>'});
    if(u.origin==='https://fixture.supabase.co'&&u.pathname==='/auth/v1/authorize'){
     assert.equal(u.searchParams.get('provider'),'google');assert.equal(u.searchParams.get('code_challenge_method'),'s256');
     const callback=new URL(u.searchParams.get('redirect_to'));assert.equal(callback.href,base+'/pembeli/oauth.html');
     const code=randomBytes(12).toString('hex');codes.set(code,u.searchParams.get('code_challenge'));callback.searchParams.set('code',code);
     return route.fulfill({contentType:'text/html',body:'<h1>SIMULATED GOOGLE — no real login</h1><button id="simulate-google">Continue test</button><script>document.getElementById("simulate-google").onclick=()=>location.href='+JSON.stringify(callback.href)+'</script>'});
    }
    return route.abort();
   });
   await c.route(base+'/api/convert-review',route=>route.fulfill({json:{review_url:review,verification:'not_verified'}}));
   await c.route(base+'/api/buyer-google',async route=>{
    const req=route.request(),body=req.method()==='POST'?req.postDataJSON():{},headers=await req.allHeaders();
    const res={code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.data=v;return this;}};
    await google({method:req.method(),headers,body},res);
    for(const raw of res.headers['Set-Cookie']||[]){const parts=raw.split(';').map(s=>s.trim()),eq=parts[0].indexOf('='),age=Number(parts.find(s=>s.startsWith('Max-Age='))?.slice(8));await c.addCookies([{name:parts[0].slice(0,eq),value:parts[0].slice(eq+1),url:base,httpOnly:true,sameSite:parts.includes('SameSite=Lax')?'Lax':'Strict',expires:age===0?1:Date.now()/1000+age}]);}
    if(body.action==='callback'&&res.code===200){const signed=await c.request.post(base+'/api/buyer',{headers:{Origin:base,'X-Buyer-Request':'1'},data:{action:'demo-signin',account}});assert.ok(signed.ok());}
    return route.fulfill({status:res.code,json:res.data});
   });
   await c.route(base+'/api/buyer',async route=>{
    const req=route.request();if(req.method()==='POST'){const a=req.postDataJSON().action;if(a==='refresh')refreshes++;
     if(a==='first-claim'&&!claimExpired){claimExpired=true;return route.fulfill({status:401,json:{error:'Synthetic expired session'}});}
     if(a==='update'&&!editExpired){editExpired=true;return route.fulfill({status:401,json:{error:'Synthetic expired session'}});}
    }return route.continue();
   });
   await c.route(base+'/api/buyer?action=session',route=>{
    if(claimExpired&&!sessionExpired){sessionExpired=true;return route.fulfill({status:401,json:{error:'Synthetic expired session'}});}return route.continue();
   });
   c.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));return c;
  }
  async function noOverflow(page,label){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),label+' overflow');checks.push(label+' fits viewport');}
  try{
   const a=await context(engines[engine]),page=await a.newPage();await page.goto(base+'/preview-new-card');const code=new URL(page.url()).searchParams.get('card');assert.match(code,/^[A-Za-z0-9_-]{24}$/);
   await page.locator('#business').fill('E2E Synthetic business');await page.locator('#maps').fill('https://maps.app.goo.gl/LocalFixture');await page.waitForFunction(()=>!document.getElementById('continue').disabled);
   await noOverflow(page,'wizard');await page.screenshot({path:path.join(out,engine+'-'+width+'-wizard.png'),fullPage:true});
   await page.locator('#continue').click();await page.locator('#google').click();await page.locator('#simulate-google').click();await page.locator('#claim-card').waitFor({state:'visible'});
   await page.locator('#claim-card').click();await page.waitForURL('**/pembeli/dashboard.html');await page.locator('#owned-list').getByText('E2E Synthetic business',{exact:true}).waitFor();checks.push('scan, mock OAuth PKCE callback, claim and dashboard');
   assert.equal(await page.evaluate(code=>sessionStorage.getItem('rr-review-draft:'+code),code),null);checks.push('successful claim clears draft');await noOverflow(page,'dashboard');
   const retry=await a.request.post(base+'/api/buyer',{headers:{Origin:base,'X-Buyer-Request':'1'},data:{action:'first-claim',card_code:code,business_name:'Overwrite attempt',review_url:review}});assert.equal(retry.status(),200);checks.push('same-owner claim retry is idempotent');
   await page.goto(base+'/pembeli/dashboard.html?card='+code);await page.locator('#edit-form').waitFor();await page.locator('#business_name').fill('E2E Updated business');await page.locator('#review_url').fill('https://maps.app.goo.gl/AnotherLocalFixture');await page.waitForFunction(()=>!document.querySelector('#edit-form button[type=submit]').disabled);
   await page.locator('#edit-form button[type=submit]').click();await page.locator('#owned-list').getByText('E2E Updated business',{exact:true}).waitFor();assert.ok(refreshes>=3);checks.push('session refresh during claim, dashboard and update');await noOverflow(page,'card detail');
   const b=await context(engines[engine],'second');await b.request.post(base+'/api/buyer',{headers:{Origin:base,'X-Buyer-Request':'1'},data:{action:'demo-signin',account:'second'}});
   const denied=await b.request.post(base+'/api/buyer',{headers:{Origin:base,'X-Buyer-Request':'1'},data:{action:'first-claim',card_code:code,business_name:'Other account',review_url:review}});assert.equal(denied.status(),409);
   const deniedEdit=await b.request.post(base+'/api/buyer',{headers:{Origin:base,'X-Buyer-Request':'1'},data:{action:'update',card_code:code,business_name:'Other account',review_url:review}});assert.ok(deniedEdit.status()>=400);
   const pb=await b.newPage();await pb.goto(base+'/pembeli/dashboard.html');await pb.locator('#owned-list').waitFor();assert.equal(await pb.getByText('E2E Updated business',{exact:true}).count(),0);checks.push('different account cannot claim, list or edit owned card');
   await page.locator('#logout').click();await page.waitForURL('**/pembeli/index.html');
   const other=await context(engines[engine==='chromium'?'firefox':'chromium']),p2=await other.newPage();await p2.goto(base+'/pembeli/index.html');await p2.locator('#google-signin').click();await p2.locator('#simulate-google').click();await p2.waitForURL('**/pembeli/dashboard.html');await p2.getByText('E2E Updated business',{exact:true}).waitFor();checks.push('logout and same-account login in another browser');
   const publicContext=await context(engines[engine]),publicPage=await publicContext.newPage();const publicScan=await publicContext.request.get(base+'/r/'+code,{maxRedirects:0});assert.equal(publicScan.status(),302);assert.equal(publicScan.headers().location,review);checks.push('active scan returns review redirect without application login');
   await publicPage.goto(base+'/pembeli/oauth.html?code=invalid');await publicPage.waitForFunction(()=>document.getElementById('status').textContent.includes('tidak valid'));assert.equal(new URL(publicPage.url()).search,'');checks.push('invalid callback rejected and URL query cleared');
   assert.deepEqual(errors,[]);reports.push({engine,width,status:'PASSED',checks});console.log(JSON.stringify({engine,width,status:'PASSED',checks:checks.length}));
  }catch(e){reports.push({engine,width,status:'FAILED',error:e.message});throw e;}
  finally{for(const c of contexts)await c.close();await new Promise(r=>server.close(r));}
 }
}finally{
 for(const browser of Object.values(engines))await browser.close();globalThis.fetch=originalFetch;for(const k of Object.keys(process.env))if(!(k in originalEnv))delete process.env[k];Object.assign(process.env,originalEnv);
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify({reports,realGoogleOAuth:false,provider:'SIMULATED',database:'IN-MEMORY SYNTHETIC',productionConnected:false},null,2));console.log('Browser report: '+out);
}
