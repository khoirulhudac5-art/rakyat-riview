import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes,createHmac} from 'node:crypto';
import {createAdminReadonlyServer} from '../scripts/admin-readonly-server.mjs';
import {adminConfigStatus,applyAdminReadConfig} from '../scripts/admin-readonly-config.mjs';
import {createAdminReadonly} from '../lib/admin-readonly.mjs';
const random=()=>randomBytes(40).toString('hex');
const config=()=>({ADMIN_V2_READONLY_LOCAL:'true',ADMIN_V2_READ_ORIGIN:'http://127.0.0.1:4192',ADMIN_V2_READ_CONTRACT_READY:'true',SUPABASE_URL:'https://svuagnobufhfpgzmsyxx.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_'+random(),ADMIN_PASSWORD:random(),ADMIN_SESSION_SECRET:random()});
test('real-mode configuration rejects absent, demo, buyer-key and foreign-project credentials without exposing values',()=>{
 const env=config();assert.equal(adminConfigStatus(env).ready,true);
 for(const [key,value] of [['ADMIN_PASSWORD','demo-admin'],['ADMIN_PASSWORD','test-only-password'],['ADMIN_SESSION_SECRET','example-signing-secret-value-at-least-32-chars'],['SUPABASE_SECRET_KEY','sb_publishable_not_a_server_key'],['SUPABASE_URL','https://other.supabase.co'],['ADMIN_V2_READ_CONTRACT_READY','false'],['VERCEL','1']]){
  const bad={...env,[key]:value};assert.equal(adminConfigStatus(bad).ready,false);assert.throws(()=>applyAdminReadConfig(bad),e=>!e.message.includes(env.ADMIN_SESSION_SECRET)&&!e.message.includes(env.SUPABASE_SECRET_KEY));
 }
 assert.deepEqual(adminConfigStatus({...env,ADMIN_PASSWORD:'',ADMIN_SESSION_SECRET:'',SUPABASE_SECRET_KEY:''}).missing,['SUPABASE_SECRET_KEY','ADMIN_PASSWORD','ADMIN_SESSION_SECRET']);
});
test('nonfixture backend independently refuses demo password before login or upstream access',async()=>{
 const saved={...process.env};try{
  Object.assign(process.env,config(),{ADMIN_PASSWORD:'demo-admin'});delete process.env.VERCEL;delete process.env.NODE_ENV;
  let reads=0;const handler=createAdminReadonly({readPage:async()=>{reads++;throw Error('Must not execute');}});
  const result={code:200,setHeader(){},status(n){this.code=n;return this;},json(d){this.data=d;}};
  await handler({method:'POST',headers:{host:'127.0.0.1:4192',origin:'http://127.0.0.1:4192','content-type':'application/json','x-admin-request':'1'},body:{action:'login',password:'demo-admin'}},result);
  assert.equal(result.code,503);assert.equal(reads,0);
 }finally{for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
});
test('real loopback HTTP: server-signed Admin session required per request; upstream simulated explicitly',async t=>{
 const saved={...process.env},nativeFetch=globalThis.fetch,env=config();let server,calls=0,scenario='empty';
 try{
  delete process.env.VERCEL;delete process.env.NODE_ENV;applyAdminReadConfig(env);
  globalThis.fetch=async(url,options)=>{
   if(String(url).startsWith('http://127.0.0.1:'))return nativeFetch(url,options);
   calls++;assert.ok(String(url).startsWith(env.SUPABASE_URL+'/rest/v1/rpc/admin_read_v2_'));assert.equal(options.method,'GET');assert.equal(options.headers.apikey,env.SUPABASE_SECRET_KEY);assert.equal(options.redirect,'error');
   if(scenario==='network')throw Error('synthetic network unavailable');
   if(scenario==='denied')return {ok:false,status:403};
   if(scenario==='error')return {ok:false,status:500};
   if(scenario==='malformed')return {ok:true,json:async()=>({cards:null,next_cursor:null})};
   const audit=String(url).includes('_audit');
   const card={card_code:'H'.repeat(24),business_name:'Synthetic HTTP fixture',review_url:null,created_at:null,owner_id:'11111111-2222-4333-8444-555555555555',active:true,activation_revision:1,inventory_state:'claimed',pin_hash:'DO_NOT_EXPOSE'};
   const event={id:'ownership:1',at:'2026-11-07T00:00:00Z',action:'claim',card_code:card.card_code,actor:'synthetic-http',reason:'first_claim',old_owner:null,new_owner:card.owner_id,secret:'DO_NOT_EXPOSE'};
   return {ok:true,json:async()=>audit?{events:scenario==='empty'?[]:[event],next_cursor:null}:{cards:scenario==='empty'?[]:[card],next_cursor:null}};
  };
  // Explicit fixture label applies to mocked upstream only. Actual HTTP/session code is unchanged.
  server=createAdminReadonlyServer({fixture:true});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;process.env.ADMIN_V2_READ_ORIGIN=origin;
  async function request(action,{cookie='',body,headers={}}={}){
   return nativeFetch(origin+'/api/v2-admin?action='+action,{method:body?'POST':'GET',headers:{...(cookie?{cookie}:{}),...(body?{origin,'content-type':'application/json','x-admin-request':'1'}:{}),...headers},body:body?JSON.stringify({action,...body}):undefined});
  }
  await t.test('anon, buyer and forged cookies denied before upstream',async()=>{
   for(const cookie of ['', 'rr_buyer_a=synthetic-google-buyer','__Host-rr_admin=forged'])for(const action of ['cards','audit'])assert.equal((await request(action,{cookie})).status,401);
   assert.equal(calls,0);
  });
  await t.test('login validates server password, CSRF and emits hardened cookie',async()=>{
   assert.equal((await request('login',{body:{password:'wrong'}})).status,401);
   assert.equal((await request('login',{body:{password:env.ADMIN_PASSWORD},headers:{origin:'https://outside.example'}})).status,403);
  });
  const login=await request('login',{body:{password:env.ADMIN_PASSWORD}});assert.equal(login.status,200);
  const setCookie=login.headers.get('set-cookie');for(const flag of ['HttpOnly','Secure','SameSite=Strict'])assert.ok(setCookie.includes(flag));
  const cookie=setCookie.split(';')[0];
  await t.test('valid Admin sees explicit empty inventory/audit, unavailable statistics and no write capabilities',async()=>{
   for(const action of ['cards','audit']){const r=await request(action,{cookie}),d=await r.json();assert.equal(r.status,200);assert.deepEqual(d[action==='cards'?'cards':'events'],[]);assert.equal(d.data_source,'contract_fixture');assert.equal(d.capabilities.create,false);assert.equal(d.capabilities.reset,false);assert.match(r.headers.get('cache-control'),/no-store/);}
  });
  await t.test('projection strips secrets and preserves owner UID; UI/static paths expose no backend config',async()=>{
   scenario='success';for(const action of ['cards','audit']){const r=await request(action,{cookie}),text=await r.text();assert.equal(r.status,200);for(const s of [env.SUPABASE_SECRET_KEY,env.ADMIN_PASSWORD,env.ADMIN_SESSION_SECRET,'DO_NOT_EXPOSE'])assert.equal(text.includes(s),false);}
   const r=await request('cards',{cookie});assert.equal((await r.json()).cards[0].owner_id,'11111111-2222-4333-8444-555555555555');
   for(const file of ['/.env.admin-readonly','/.env.backup','/lib/admin-readonly.mjs'])assert.equal((await nativeFetch(origin+file)).status,404);
   assert.equal((await nativeFetch(origin+'/admin-v2.html')).status,200);
  });
  await t.test('network/API/permission/malformed failures never masquerade as empty data',async()=>{
   for(const [mode,status] of [['network',502],['error',502],['denied',503],['malformed',502]]){scenario=mode;const r=await request('cards',{cookie}),d=await r.json();assert.equal(r.status,status);assert.equal(d.cards,undefined);assert.ok(d.error);}
  });
  await t.test('session checked on every call: duplicate, expired and cross-origin denied',async()=>{
   const before=calls;assert.equal((await request('cards',{cookie:cookie+'; '+cookie})).status,401);
   const payload=Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)-1,nonce:'synthetic-expired'})).toString('base64url');
   const signature=createHmac('sha256',env.ADMIN_SESSION_SECRET).update(payload).digest('base64url');assert.equal((await request('cards',{cookie:'__Host-rr_admin='+payload+'.'+signature})).status,401);
   assert.equal((await request('cards',{cookie,headers:{origin:'https://outside.example'}})).status,403);assert.equal(calls,before);
  });
  await t.test('generate/reset and unsupported API routes remain closed',async()=>{
   for(const action of ['create','reset','ready','recover'])assert.equal((await request(action,{cookie,body:{}})).status,405);
   assert.equal((await nativeFetch(origin+'/api/create-card',{method:'POST'})).status,405);
  });
  await t.test('logout clears matching cookie; next unauthenticated request denied',async()=>{
   const r=await request('logout',{cookie,body:{}});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/Max-Age=0/);assert.equal((await request('cards')).status,401);
  });
 }finally{
  if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});globalThis.fetch=nativeFetch;
  for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);
 }
});
