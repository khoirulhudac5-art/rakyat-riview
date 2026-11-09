// Production-origin browser simulation: all requests are intercepted locally.
// No real Google, Supabase, Vercel request or customer credential is used.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {randomBytes} from 'node:crypto';
import {createProductionAdmin} from '../lib/admin-production.mjs';
const {chromium}=createRequire(import.meta.url)(path.resolve('.local-tools/browser-tests/node_modules/playwright'));
const origin='https://rakyat-riview.vercel.app',saved={...process.env},password=randomBytes(32).toString('hex');
const folder=path.resolve('test-results/admin-production-browser-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(folder,{recursive:true});
const files=new Map(['/admin-v2.html','/assets/admin-v2.js','/assets/admin-v2.css','/assets/rakyat-review-logo.png','/pembeli/dashboard-data.mjs'].map(f=>[f,f.slice(1)]));
const reports=[],browsers={};const nativeFetch=globalThis.fetch;
try{
 Object.assign(process.env,{NODE_ENV:'production',VERCEL:'1',ADMIN_V2_READONLY_PRODUCTION:'true',ADMIN_V2_ORIGIN:origin,ADMIN_V2_READ_CONTRACT_READY:'true',ADMIN_V2_SESSION_SECRET:randomBytes(40).toString('hex'),ADMIN_PASSWORD:password,SUPABASE_URL:'https://svuagnobufhfpgzmsyxx.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_synthetic_not_real'});
 globalThis.fetch=()=>{throw Error('Real network forbidden in browser simulation');};
 for(const [engine,width] of [['chrome',1440],['chrome',320],['msedge',375],['msedge',400]]){
  browsers[engine]||=await chromium.launch({channel:engine,headless:true});let scenario='data';
  const handler=createProductionAdmin({readPage:async kind=>kind==='audit'?{events:[{id:'ownership:1',at:'2026-11-07T00:00:00Z',action:'claim',card_code:'P'.repeat(24),actor:'synthetic-test-only',reason:'first_claim',old_owner:null,new_owner:'11111111-2222-4333-8444-555555555555'}],next_cursor:null}:scenario==='empty'?{cards:[],next_cursor:null}:scenario==='error'?Promise.reject(Error('Synthetic upstream outage')):{cards:[{card_code:'P'.repeat(24),business_name:'Synthetic browser test',review_url:null,created_at:null,owner_id:'11111111-2222-4333-8444-555555555555',active:true,activation_revision:0,inventory_state:'claimed'}],next_cursor:null}});
  const context=await browsers[engine].newContext({viewport:{width,height:1000}});
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();
   if(url.pathname==='/api/v2-admin'){
    const req={method:request.method(),headers:{...await request.allHeaders(),host:url.host},query:Object.fromEntries(url.searchParams),body:request.postData()?JSON.parse(request.postData()):{}};
    const res={code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(value){this.body=JSON.stringify(value);}};await handler(req,res);return route.fulfill({status:res.code,headers:{...res.headers,'Content-Type':'application/json'},body:res.body});
   }
   const file=files.get(url.pathname);if(!file)return route.fulfill({status:404,body:''});return route.fulfill({status:200,contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/javascript',body:fs.readFileSync(file)});
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/admin-v2.html');await page.fill('#admin-password',password);await page.click('#admin-login-submit');await page.locator('#inventory-body tbody tr').first().waitFor({timeout:10000});
  assert.match(await page.locator('.environment').first().textContent(),/SUPABASE READ-ONLY/);assert.equal(await page.locator('#open-create').isDisabled(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.reload();await page.locator('#inventory-body tbody tr').first().waitFor();
  if(width<769)await page.click('#menu-open');await page.locator('[data-view="audit"]').click();await page.locator('.audit-item').waitFor();
  if(width<769)await page.click('#menu-open');await page.locator('[data-view="cards"]').click();scenario='empty';await page.click('#reload-cards');await page.waitForFunction(()=>document.getElementById('inventory-body').textContent.includes('Inventaris Anda siap dimulai'));scenario='error';await page.click('#reload-cards');await page.locator('#page-error:not([hidden])').waitFor();
  await page.screenshot({path:path.join(folder,engine+'-'+width+'.png'),fullPage:true});
  if(width<769)await page.click('#menu-open');await page.click('#admin-logout');await page.locator('#admin-password').waitFor();assert.equal(errors.length,0);
  reports.push({engine,width,checks:['production secure-cookie login','read-only inventory','session after refresh','audit navigation','no horizontal overflow','empty versus error','logout','no browser errors'],pass:true});await context.close();console.log(engine+' '+width+': PASS');
 }
 fs.writeFileSync(path.join(folder,'RESULT.json'),JSON.stringify({status:'PASS',upstream:'explicit synthetic injection',productionNetworkAccess:false,reports},null,2));console.log(JSON.stringify({status:'PASS',folder,cases:reports.length,checks:reports.reduce((n,r)=>n+r.checks.length,0)}));
}finally{for(const browser of Object.values(browsers))await browser.close();globalThis.fetch=nativeFetch;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
