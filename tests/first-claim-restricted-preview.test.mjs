// Regression only, mocked PostgREST/Auth. This does NOT prove live First Claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createProductPreview} from '../scripts/preview-product.mjs';
test('restricted preview accepts two registered cards, reads only their public redirect, routes claim to wrapper and expires closed',async()=>{
 const saved={...process.env},nativeFetch=globalThis.fetch;let server;
 const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
 const a='A'.repeat(24),b='B'.repeat(24),run='11111111-2222-4333-8444-555555555555',target='https://svuagnobufhfpgzmsyxx.supabase.co',review='https://search.google.com/local/writereview?placeid=ChITestFixtureOnly';
 let clock=Date.now(),calls=[],active=false;
 try{
  Object.assign(process.env,{BUYER_INTEGRATION_ENABLED:'true',BUYER_LOCAL_HTTP:'1',BUYER_APP_ORIGIN:origin,SUPABASE_URL:target,SUPABASE_PUBLISHABLE_KEY:'test-only-public',BUYER_GOOGLE_ENABLED:'true',BUYER_RESTRICTED_APP:'true',RR_TEST_APP_WRITES:'true',RR_TEST_RUN_ID:run,RR_TEST_CARD_CODES:a+','+b,RR_TEST_RUN_EXPIRES_AT:new Date(clock+1800000).toISOString()});
  for(const patch of [{RR_TEST_CARD_CODES:a},{RR_TEST_CARD_CODES:a+','+a},{RR_TEST_RUN_EXPIRES_AT:'invalid'},{RR_TEST_RUN_EXPIRES_AT:new Date(clock-1).toISOString()}]){const before={};for(const key of Object.keys(patch)){before[key]=process.env[key];process.env[key]=patch[key];}assert.throws(()=>createProductPreview({integration:true,restrictedRun:true,now:()=>clock}));Object.assign(process.env,before);}
  globalThis.fetch=async(url,options)=>{
   calls.push({url:String(url),options});
   if(String(url).startsWith(target+'/rest/v1/card_public?')){assert.ok(!options.headers.Authorization);const u=new URL(url),code=u.searchParams.get('card_code').slice(3);assert.ok([a,b].includes(code));return {ok:true,status:200,json:async()=>active?[{card_code:code,review_url:review}]:[]};}
   if(String(url)===target+'/auth/v1/user')return {ok:true,status:200,json:async()=>({id:'test-only-google-user',identities:[{provider:'google'}]})};
   assert.equal(String(url),target+'/rest/v1/rpc/buyer_test_action');const body=JSON.parse(options.body);assert.equal(body.p_run,run);assert.equal(body.p_op,'claim');assert.equal(body.p_card_code,a);assert.equal(body.p_review_url,review);return {ok:true,status:200,json:async()=>({success:true,card_code:a})};
  };
  server=createProductPreview({integration:true,restrictedRun:true,now:()=>clock});await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const request=(path,body)=>nativeFetch(origin+path,{redirect:'manual',method:body?'POST':'GET',headers:body?{Origin:origin,'Content-Type':'application/json','X-Buyer-Request':'1',Cookie:'rr_buyer_a=test-only-access'}:{},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await request('/preview-new-card?card='+b)).headers.get('location'),'/pembeli/mulai.html?card='+b);
  assert.equal((await request('/preview-new-card?card='+'C'.repeat(24))).status,404);
  assert.equal((await request('/r/001')).status,404);assert.equal((await request('/r/'+'C'.repeat(24))).status,404);assert.equal(calls.length,0);
  let r=await request('/r/'+a);assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/pembeli/mulai.html?card='+a);
  r=await request('/api/buyer',{action:'first-claim',card_code:a,business_name:'Synthetic fixture',review_url:review});assert.equal(r.status,200);
  active=true;r=await request('/r/'+a);assert.equal(r.status,302);assert.equal(r.headers.get('location'),review);
  const before=calls.length;clock+=1800001;
  for(const path of ['/r/'+a,'/preview-new-card','/api/buyer-status?card='+a])assert.equal((await request(path)).status,403);
  assert.equal((await request('/api/buyer',{action:'first-claim',card_code:a,business_name:'Expired',review_url:review})).status,403);assert.equal(calls.length,before);
  assert.equal((await request('/api/buyer?action=mode').then(r=>r.json())).card_access,'closed');
 }finally{if(server)await new Promise(r=>server.close(r));globalThis.fetch=nativeFetch;for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
});
