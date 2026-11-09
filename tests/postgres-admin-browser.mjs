// Real Admin DOM + actual API handlers + SQL; PostgREST/Auth transport is local.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {adminLocalAdapter} from '../scripts/admin-local-adapter.mjs';
import {sessionCookie} from '../lib/admin-session.mjs';
export async function runAdminDatabaseBrowser({q,base}){
 const savedEnv={...process.env},realFetch=globalThis.fetch;
 Object.assign(process.env,{ADMIN_SESSION_SECRET:'isolated-browser-only-session-secret-64-chars-long',SUPABASE_URL:'https://local-sql.invalid',SUPABASE_SECRET_KEY:'local-test-only',ADMIN_V2_CREATION_ENABLED:'true',ADMIN_V2_RESET_ENABLED:'true',CARD_PUBLIC_ORIGIN:'https://card.example.invalid',PLAYWRIGHT_BROWSERS_PATH:path.resolve('.local-tools/browsers')});
 const literal=x=>"'"+String(x).replaceAll("'","''")+"'";
 const expr=(name,a)=>{
  if(name==='admin_create_v2_cards')return `(SELECT coalesce(json_agg(t),'[]'::json) FROM public.admin_create_v2_cards(${Number(a.p_quantity)}) t)`;
  if(name==='admin_list_v2_activation_cards')return "(SELECT coalesce(json_agg(t),'[]'::json) FROM public.admin_list_v2_activation_cards() t)";
  if(name==='admin_reset_v2_activation')return `to_json(public.admin_reset_v2_activation(${[a.p_card_code,a.p_confirmation].map(literal)},${Number(a.p_expected_revision)},${literal(a.p_actor)},${literal(a.p_reason)}))`;
  throw Error('Unexpected RPC');
 };
 globalThis.fetch=async(u,options)=>{
  if(new URL(u).hostname!=='local-sql.invalid')return realFetch(u,options);
  try{const name=new URL(u).pathname.split('/').at(-1),value=await q('BEGIN; SET LOCAL ROLE service_role; SELECT '+expr(name,JSON.parse(options.body))+'; COMMIT;');return new Response(value,{status:200});}catch{return new Response('{}',{status:403});}
 };
 const adapter=adminLocalAdapter(),files=new Map([['/admin.html','admin.html'],['/assets/admin-v2-reset.js','assets/admin-v2-reset.js'],['/assets/admin-v2-reset.css','assets/admin-v2-reset.css']]);
 const server=http.createServer(async(req,res)=>{try{if(await adapter(req,res))return;const p=new URL(req.url,'http://localhost').pathname;if(files.has(p)){res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html');return res.end(await fs.readFile(files.get(p)));}if(p==='/api/list-cards'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({success:true,cards:[{card_code:'OPS-LEGACY',business_name:'Synthetic V1'}]}));}res.writeHead(404);res.end();}catch{res.writeHead(500);res.end();}});
 let browser,phase='HTTP authorization',activePage;
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  assert.equal((await realFetch(origin+'/api/admin-v2-cards')).status,401);
  const cookie=sessionCookie().split(';')[0];
  assert.equal((await realFetch(origin+'/api/admin-reset-v2',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
  const {chromium}=createRequire(import.meta.url)(path.resolve('.local-tools/browser-tests/node_modules/playwright'));
  phase='launch Chromium';browser=await chromium.launch({headless:true});
  const reports=[];
  for(const width of [1440,375]){
   const context=await browser.newContext({viewport:{width,height:1000}});
   // Signed session fixture travels through a local HTTP proxy. Playwright
   // route.continue ignores Cookie overrides; do not weaken the real cookie.
   await context.route('**/*',async route=>{
    const request=route.request();if(new URL(request.url()).origin!==origin)return route.abort();
    const response=await realFetch(request.url(),{method:request.method(),headers:{...request.headers(),cookie},...(request.postData()!==null?{body:request.postData()}: {})});
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
   });
   phase='load Admin '+width;const page=await context.newPage();activePage=page;await page.goto(origin+'/admin.html');await page.waitForFunction(()=>document.querySelector('#v2-create')?.disabled===false);
   const before=JSON.parse(await q('SELECT coalesce(json_agg(card_code),\'[]\'::json) FROM public.card'));
   phase='create card '+width;await page.locator('#v2-create').click();await page.waitForFunction(()=>document.querySelector('#v2-result').textContent.includes('dibuat dan siap diklaim'));
   const codes=JSON.parse(await q('SELECT json_agg(card_code) FROM public.card'));const code=codes.find(c=>!before.includes(c));assert.ok(code);
   const A='f1111111-1111-4111-8111-111111111111',B='f2222222-2222-4222-8222-222222222222',url='https://search.google.com/local/writereview?placeid=ChITestFixtureOnly';
   const as=async(uid,call)=>JSON.parse(await q(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub"='${uid}'; SELECT to_json(${call}); COMMIT;`));
   // Clear only synthetic account limiter on this isolated database.
   await q(`DELETE FROM public.buyer_claim_limits WHERE user_id IN ('${A}','${B}')`);
   phase='claim '+width;assert.equal((await as(A,`public.buyer_first_claim('${code}','Browser SQL','${url}')`)).success,true);
   await page.locator('#v2-reload').click();const button=page.locator(`[data-v2-reset="${code}"]`);await button.click();
   await page.locator('#v2-confirmation').fill('wrong');await page.locator('#v2-reason').fill('Local SQL browser reset regression');await page.locator('#v2-ack').check();assert.ok(await page.locator('#v2-submit').isDisabled());await page.locator('#v2-cancel').click();
   phase='reset '+width;await button.click();await page.locator('#v2-confirmation').fill(code);await page.locator('#v2-reason').fill('Local SQL browser reset regression');await page.locator('#v2-ack').check();await page.locator('#v2-submit').click();await page.waitForFunction(()=>document.querySelector('#v2-result').textContent.includes('Reset berhasil'));
   assert.equal(await as(A,`public.buyer_update_card('${code}','Denied','${url}')`),false);
   assert.equal((await as(B,`public.buyer_first_claim('${code}','New owner','${url}')`)).success,true);
   assert.equal((await as(A,`public.buyer_first_claim('${code}','Denied','${url}')`)).success,false);
   assert.equal(await q(`SELECT count(*) FROM public.buyer_activation_reset_audit WHERE card_code='${code}'`),'1');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(base,`admin-sql-${width}.png`)});reports.push({width,status:'PASSED'});await context.close();
  }
  await fs.writeFile(path.join(base,'admin-sql-browser.json'),JSON.stringify({reports,backend:'actual isolated PostgreSQL via simulated PostgREST transport',realGoogleJWT:false},null,2));
 }catch(e){let ui='';if(activePage&&!activePage.isClosed())ui=await activePage.locator('#v2-result').textContent({timeout:1000}).catch(()=>'');throw {reason:phase+': '+String(e.reason||e.message).split('\n')[0]+' '+ui};}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));globalThis.fetch=realFetch;for(const k of Object.keys(process.env))if(!(k in savedEnv))delete process.env[k];Object.assign(process.env,savedEnv);}
}
