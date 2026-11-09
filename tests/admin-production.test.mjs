import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {randomBytes,createHmac} from 'node:crypto';
import {createProductionAdmin} from '../lib/admin-production.mjs';
const secret=()=>randomBytes(40).toString('hex'),origin='https://rakyat-riview.vercel.app';
test('Production HTTP Admin uses independent server session and only read contracts',async t=>{
 const saved={...process.env},originalFetch=globalThis.fetch;let server,upstream=0,scenario='empty';
 const env={NODE_ENV:'production',VERCEL:'1',ADMIN_V2_READONLY_PRODUCTION:'true',ADMIN_V2_ORIGIN:origin,ADMIN_V2_READ_CONTRACT_READY:'true',ADMIN_V2_SESSION_SECRET:secret(),ADMIN_PASSWORD:secret(),SUPABASE_URL:'https://svuagnobufhfpgzmsyxx.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_'+secret()};
 Object.assign(process.env,env);
 const owner='11111111-2222-4333-8444-555555555555',code='P'.repeat(24);
 try{
  globalThis.fetch=async(url,options)=>{
   if(String(url).startsWith('http://127.0.0.1:'))return originalFetch(url,options);
   upstream++;const u=new URL(url);assert.equal(u.origin,env.SUPABASE_URL);assert.ok(['/rest/v1/rpc/admin_read_v2_inventory','/rest/v1/rpc/admin_read_v2_audit'].includes(u.pathname));assert.equal(options.method,'GET');assert.equal(options.headers.apikey,env.SUPABASE_SECRET_KEY);assert.equal(options.redirect,'error');
   if(scenario==='network')throw Error('No real upstream in this test');if(scenario==='denied')return new Response('{}',{status:403});if(scenario==='malformed')return new Response('{bad');
   const audit=u.pathname.endsWith('_audit');return new Response(JSON.stringify(audit?{events:scenario==='empty'?[]:[{id:'ownership:1',at:'2026-11-07T00:00:00Z',action:'claim',card_code:code,actor:'synthetic-test',reason:'first_claim',old_owner:null,new_owner:owner,password:'DO_NOT_LEAK'}],next_cursor:null}:{cards:scenario==='empty'?[]:[{card_code:code,business_name:'Synthetic test only',owner_id:owner,review_url:null,created_at:null,active:true,activation_revision:0,inventory_state:'claimed',pin_hash:'DO_NOT_LEAK'}],next_cursor:null}));
  };
  const handler=createProductionAdmin();server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;req.body=raw?JSON.parse(raw):{};req.query=Object.fromEntries(new URL(req.url,'http://local').searchParams);const output={setHeader:(...args)=>res.setHeader(...args),status(n){this.code=n;return this;},json(v){res.writeHead(this.code||200,{'Content-Type':'application/json'});res.end(JSON.stringify(v));}};await handler(req,output);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const local='http://127.0.0.1:'+server.address().port;
  const request=(action,{cookie='',body,headers={},method}={})=>new Promise((resolve,reject)=>{const req=http.request(local+'/?action='+action,{method:method||(body===undefined?'GET':'POST'),headers:{host:new URL(origin).host,...(cookie?{cookie}:{}),...(body===undefined?{}:{origin,'content-type':'application/json','x-admin-request':'1'}),...headers}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve(new Response(text,{status:res.statusCode,headers:res.headers})));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify({action,...body}));});
  await t.test('anon, buyer, legacy and forged sessions denied before Supabase',async()=>{for(const cookie of ['', 'rr_buyer_a=google-user','__Host-rr_admin=legacy-admin','__Host-rr_admin_v2=forged'])for(const action of ['cards','audit'])assert.equal((await request(action,{cookie})).status,401);assert.equal(upstream,0);});
  await t.test('configuration fails closed without changing production environment',async()=>{for(const [key,value] of [['ADMIN_V2_READONLY_PRODUCTION','false'],['ADMIN_V2_SESSION_SECRET',''],['ADMIN_PASSWORD','demo-admin'],['ADMIN_V2_ORIGIN','https://evil.example'],['SUPABASE_URL','https://other.supabase.co']]){process.env[key]=value;assert.equal((await request('cards')).status,503);process.env[key]=env[key];}assert.equal(upstream,0);});
  await t.test('origin, host, content-type, request header and method checked',async()=>{
   for(const headers of [{origin:'https://evil.example'},{origin:''},{host:'evil.example'},{'content-type':'text/plain'},{'x-admin-request':''},{'sec-fetch-site':'cross-site'}])assert.equal((await request('login',{body:{password:env.ADMIN_PASSWORD},headers})).status,403);
   assert.equal((await request('session',{method:'DELETE'})).status,405);assert.equal((await request('login',{body:{password:'x'.repeat(5000)}})).status,413);
  });
  let cookie;
  await t.test('configured Admin password emits scoped Secure HttpOnly session',async()=>{assert.equal((await request('login',{body:{password:'wrong'}})).status,401);const response=await request('login',{body:{password:env.ADMIN_PASSWORD}});assert.equal(response.status,200);const header=response.headers.get('set-cookie');assert.match(header,/^__Host-rr_admin_v2=/);for(const flag of ['Path=/','HttpOnly','Secure','SameSite=Strict','Max-Age=1800'])assert.ok(header.includes(flag));cookie=header.split(';')[0];assert.equal(upstream,0);assert.equal((await request('session',{cookie})).status,200);});
  await t.test('valid Admin reads empty arrays as real-mode empty, not errors or mock fallback',async()=>{for(const action of ['cards','audit']){const response=await request(action,{cookie}),data=await response.json();assert.equal(response.status,200);assert.deepEqual(data[action==='cards'?'cards':'events'],[]);assert.equal(data.mode,'admin_readonly');assert.equal(data.data_source,'supabase');assert.equal(data.read_only,true);assert.equal(data.capabilities.create,false);assert.equal(data.capabilities.reset,false);assert.match(response.headers.get('cache-control'),/no-store/);}});
  await t.test('projection strips sensitive extras and returns ownership UID only to Admin',async()=>{scenario='data';for(const action of ['cards','audit']){const response=await request(action,{cookie}),text=await response.text();assert.equal(response.status,200);for(const value of [...Object.values(env).filter(v=>v.length>=32),'DO_NOT_LEAK'])if(!value.startsWith('https:'))assert.equal(text.includes(value),false);}const cardsRes=await(await request('cards',{cookie})).json();assert.equal(cardsRes.cards[0].owner_id,owner);assert.equal(cardsRes.cards[0].card_url,origin+'/r/'+code);});
  await t.test('upstream errors are not disguised as empty inventory',async()=>{for(const [value,status] of [['network',502],['denied',503],['malformed',502]]){scenario=value;const response=await request('cards',{cookie}),data=await response.json();assert.equal(response.status,status);assert.ok(data.error);assert.equal(data.cards,undefined);}scenario='data';});
  await t.test('duplicate, invalid, expired and wrong-audience sessions rejected per request',async()=>{const before=upstream;const payloads=[{aud:'rr-admin-v2-readonly',iat:1,exp:1801,nonce:'a'.repeat(32)},{aud:'buyer',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+1800,nonce:'a'.repeat(32)}];for(const s of payloads){const p=Buffer.from(JSON.stringify(s)).toString('base64url'),sig=createHmac('sha256',env.ADMIN_V2_SESSION_SECRET).update(p).digest('base64url');assert.equal((await request('cards',{cookie:'__Host-rr_admin_v2='+p+'.'+sig})).status,401);}assert.equal((await request('cards',{cookie:cookie+'; '+cookie})).status,401);assert.equal((await request('cards',{cookie,headers:{origin:'https://evil.example'}})).status,403);assert.equal(upstream,before);});
  await t.test('generate/reset/ready/recover have no production write route even for Admin',async()=>{const before=upstream;for(const action of ['create','reset','ready','recover'])assert.equal((await request(action,{cookie,body:{}})).status,405);assert.equal(upstream,before);});
  await t.test('bad passwords are throttled on a warm instance',async()=>{for(let i=0;i<5;i++)assert.equal((await request('login',{body:{password:'wrong'},headers:{'x-vercel-forwarded-for':'192.0.2.1'}})).status,401);const response=await request('login',{body:{password:'wrong'},headers:{'x-vercel-forwarded-for':'192.0.2.1'}});assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'900');});
  await t.test('logout clears only V2 cookie and leaves V1/buyer cookies untouched',async()=>{const response=await request('logout',{cookie,body:{}});assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/^__Host-rr_admin_v2=;.*Max-Age=0/);assert.equal((await request('session')).status,401);});
  await t.test('ADMIN_V2_PASSWORD prioritizes over legacy ADMIN_PASSWORD when valid',async()=>{
   const v2Pass=secret();
   process.env.ADMIN_PASSWORD='synthetic-short';
   process.env.ADMIN_V2_PASSWORD=v2Pass;
   try{
    assert.equal((await request('session')).status,401);
    assert.equal((await request('login',{body:{password:'synthetic-short'}})).status,401);
    const ok=await request('login',{body:{password:v2Pass}});
    assert.equal(ok.status,200);
    assert.match(ok.headers.get('set-cookie')||'',/^__Host-rr_admin_v2=/);
   }finally{
    delete process.env.ADMIN_V2_PASSWORD;
    process.env.ADMIN_PASSWORD=env.ADMIN_PASSWORD;
   }
  });
  await t.test('ADMIN_V2_PASSWORD unavailable falls back to valid ADMIN_PASSWORD or fails if legacy is short/absent',async()=>{
   delete process.env.ADMIN_V2_PASSWORD;
   process.env.ADMIN_PASSWORD=env.ADMIN_PASSWORD;
   const ok=await request('login',{body:{password:env.ADMIN_PASSWORD}});
   assert.equal(ok.status,200);
   process.env.ADMIN_PASSWORD='synthetic-short';
   assert.equal((await request('session')).status,503);
   delete process.env.ADMIN_PASSWORD;
   assert.equal((await request('session')).status,503);
   process.env.ADMIN_PASSWORD=env.ADMIN_PASSWORD;
  });
  await t.test('ADMIN_V2_PASSWORD weak or demo fails policy even if legacy ADMIN_PASSWORD is long',async()=>{
   process.env.ADMIN_PASSWORD=env.ADMIN_PASSWORD;
   for(const weak of ['short-v2','demo-admin','password','changeme','test-only-password']){
    process.env.ADMIN_V2_PASSWORD=weak;
    assert.equal((await request('session')).status,503);
    assert.equal((await request('login',{body:{password:weak}})).status,503);
   }
   delete process.env.ADMIN_V2_PASSWORD;
  });
 }finally{globalThis.fetch=originalFetch;if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
});
