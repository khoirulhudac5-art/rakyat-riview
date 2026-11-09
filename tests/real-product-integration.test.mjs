// Actual local HTTP routes + existing OAuth/session handlers; Supabase transport
// is mocked. This test is not evidence of a real Google account login.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createProductPreview} from '../scripts/preview-product.mjs';
const target='https://svuagnobufhfpgzmsyxx.supabase.co';
test('real product configuration rejects missing OAuth, wrong project and nonrestricted setup',()=>{
 const saved={...process.env};
 try{
  Object.assign(process.env,{BUYER_INTEGRATION_ENABLED:'true',BUYER_LOCAL_HTTP:'1',BUYER_APP_ORIGIN:'http://127.0.0.1:4189',SUPABASE_URL:target,SUPABASE_PUBLISHABLE_KEY:'test-public',BUYER_GOOGLE_ENABLED:'true',BUYER_RESTRICTED_APP:'true'});
  for(const [key,value] of [['BUYER_GOOGLE_ENABLED','false'],['SUPABASE_URL','https://foreign.supabase.co'],['BUYER_RESTRICTED_APP','false']]){const before=process.env[key];process.env[key]=value;assert.throws(()=>createProductPreview({integration:true,file:null}));process.env[key]=before;}
  delete process.env.RR_TEST_RUN_ID;delete process.env.RR_TEST_CARD_CODE;assert.throws(()=>createProductPreview({integration:true,restrictedRun:true}));
 }finally{for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
});
test('real product HTTP: PKCE callback/session/refresh/logout reused; every card operation stays closed (mock Auth)',async()=>{
 const saved={...process.env},nativeFetch=globalThis.fetch,calls=[];let server;
 const reservation=http.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));const base='http://127.0.0.1:'+port;
 try{
  Object.assign(process.env,{BUYER_INTEGRATION_ENABLED:'true',BUYER_LOCAL_HTTP:'1',BUYER_APP_ORIGIN:base,SUPABASE_URL:target,SUPABASE_PUBLISHABLE_KEY:'test-public',BUYER_GOOGLE_ENABLED:'true',BUYER_RESTRICTED_APP:'true',RR_TEST_APP_WRITES:'true'});
  let challenge;
  globalThis.fetch=async(url,options)=>{
   calls.push(String(url));assert.ok(String(url).startsWith(target+'/auth/v1/'),'no card RPC or PostgREST permitted');
   if(String(url).includes('grant_type=pkce'))assert.equal(createHash('sha256').update(JSON.parse(options.body).code_verifier).digest('base64url'),challenge);
   return {ok:true,status:200,json:async()=>String(url).endsWith('/user')?{id:'synthetic-http-unit',email:'unit@example.test',identities:[{provider:'google'}]}:{access_token:'test-access',refresh_token:'test-refresh',expires_in:3600}};
  };
  server=createProductPreview({integration:true,file:null});await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const jar=new Map();
  const call=async(path,body)=>{const r=await nativeFetch(base+path,{redirect:'manual',method:body?'POST':'GET',headers:{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...(body?{Origin:base,'Content-Type':'application/json','X-Buyer-Request':'1'}:{})},...(body?{body:JSON.stringify(body)}:{})});for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');if(c.includes('Max-Age=0'))jar.delete(pair.slice(0,i));else jar.set(pair.slice(0,i),pair.slice(i+1));}return {r,data:r.status===302?null:await r.json()};};
  const mode=await call('/api/buyer?action=mode');assert.equal(mode.data.real_auth,true);assert.equal(mode.data.mode,'restricted');assert.equal(mode.data.card_access,'closed');assert.equal(mode.data.product_preview,undefined);
  const card=await call('/preview-new-card');assert.match(card.r.headers.get('location'),/OAUTH-CONTEXT-LOCAL/);
  assert.equal((await call('/api/buyer',{action:'demo-signin'})).r.status,403);
  assert.equal((await call('/api/buyer-google')).data.enabled,true);
  let result=await call('/api/buyer-google',{action:'start'});const url=new URL(result.data.url),state=result.data.state;challenge=url.searchParams.get('code_challenge');assert.equal(url.searchParams.get('redirect_to'),base+'/pembeli/oauth.html');assert.equal(url.searchParams.get('code_challenge_method'),'s256');assert.equal(calls.length,0);
  assert.equal((await call('/api/buyer-google',{action:'callback',state:'invalid',code:'unit-only'})).r.status,400);assert.equal(calls.length,0);
  assert.equal((await call('/api/buyer-google',{action:'callback',state,code:'unit-only'})).r.status,200);
  assert.equal((await call('/api/buyer?action=session')).data.user.google,true);
  assert.equal((await call('/api/buyer',{action:'refresh'})).r.status,200);
  const before=calls.length;
  for(const path of ['/api/buyer?action=cards','/api/buyer?action=status','/api/buyer-status?card='+'A'.repeat(24),'/api/v2-admin?action=cards']){result=await call(path);assert.equal(result.r.status,403);assert.equal(result.data.code,'V2_ACCESS_CLOSED');}
  for(const action of ['first-claim','update','claim','activate'])assert.equal((await call('/api/buyer',{action,card_code:'A'.repeat(24)})).r.status,403);
  assert.equal(calls.length,before);assert.equal((await call('/api/buyer-status?card=OAUTH-CONTEXT-LOCAL')).data.claim_allowed,false);
  assert.equal((await call('/api/buyer',{action:'signout'})).r.status,200);assert.equal(jar.has('rr_buyer_a'),false);assert.equal(jar.has('rr_buyer_r'),false);assert.equal((await call('/api/buyer?action=session')).r.status,401);
 }finally{if(server)await new Promise(r=>server.close(r));globalThis.fetch=nativeFetch;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
});
