// Local protocol regression with mocked Auth transport, never a live login.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createLiveClaimSession} from '../scripts/first-claim-live-session.mjs';
import {createProductPreview} from '../scripts/preview-product.mjs';
test('session preparation survives 30 minutes, recognizes Chrome/Edge, refuses card writes and re-registers existing cookies after restart (mock Auth)',async()=>{
 const env={...process.env},nativeFetch=globalThis.fetch,plan={accounts:{A:{uid:'unit-A'},B:{uid:'unit-B'}}};let server,clock=Date.now(),calls=0;
 const jwt=id=>'fixture.'+Buffer.from(JSON.stringify({sub:id,session_id:'session-'+id,exp:Math.floor(clock/1000)+3600})).toString('base64url')+'.test';
 const localFetch=(url,options={})=>nativeFetch(url,{...options,headers:{...options.headers,Connection:'close'}});
 const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const base='http://127.0.0.1:'+port;
 try{
  Object.assign(process.env,{BUYER_INTEGRATION_ENABLED:'true',BUYER_LOCAL_HTTP:'1',BUYER_APP_ORIGIN:base,SUPABASE_URL:'https://svuagnobufhfpgzmsyxx.supabase.co',SUPABASE_PUBLISHABLE_KEY:'test-public',BUYER_GOOGLE_ENABLED:'true',BUYER_RESTRICTED_APP:'true',RR_TEST_APP_WRITES:'true'});
  globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,'https://svuagnobufhfpgzmsyxx.supabase.co/auth/v1/user','only Auth user checks, no SQL, RPC or provider login');const id=JSON.parse(Buffer.from(options.headers.Authorization.slice(7).split('.')[1],'base64url')).sub;return {ok:true,status:200,json:async()=>({id,identities:[{provider:'google'}]})};};
  let harness=createLiveClaimSession(plan,{preparationOnly:true,now:()=>clock});
  const start=async()=>{server=createProductPreview({integration:true,claimTest:harness,now:()=>clock});await new Promise(r=>server.listen(port,'127.0.0.1',r));};await start();
  const get=async()=>localFetch(base+'/api/claim-test').then(r=>r.json());
  const register=async(token,ua,expectedAccount)=>{const r=await localFetch(base+'/api/claim-test',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Buyer-Request':'1',Cookie:'rr_buyer_a='+token,'User-Agent':ua},body:JSON.stringify({action:'register',expectedAccount})});return {status:r.status,data:await r.json()};};
  const original=await get();clock+=31*60000;const a=jwt('unit-A'),b=jwt('unit-B');
  assert.equal((await register(a,'Mozilla/5.0 Chrome/130.0')).data.browser,'Chrome');
  const mismatch=await register(a,'Mozilla/5.0 Chrome/130.0 Edg/130.0','B');assert.equal(mismatch.status,409);assert.equal(mismatch.data.code,'ACCOUNT_MISMATCH');assert.equal(mismatch.data.label,'A');assert.equal(mismatch.data.identitySource,'Supabase Auth /auth/v1/user');assert.equal(mismatch.data.switchAccount,true);assert.equal((await get()).ready.B,false);
  assert.equal((await register(b,'Mozilla/5.0 Chrome/130.0 Edg/130.0','B')).data.browser,'Edge');
  let state=await get();assert.equal(state.phase,'SESSIONS_READY');assert.equal(state.runClockStarted,false);assert.equal(state.preparationOnly,true);assert.deepEqual(state.ready,{A:true,B:true});assert.equal(state.preparationStartedAt,original.preparationStartedAt);assert.equal(JSON.stringify(state).includes(a),false);
  assert.equal((await localFetch(base+'/api/buyer?action=mode').then(r=>r.json())).card_access,'closed');
  assert.equal((await localFetch(base+'/api/buyer',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Buyer-Request':'1',Cookie:'rr_buyer_a='+a},body:JSON.stringify({action:'first-claim',card_code:'A'.repeat(24)})})).status,403);
  await assert.rejects(harness.call('A','first-claim',{}),/Preparation-only/);assert.equal(calls,3);
  assert.equal((await register(jwt('unit-C'),'Chrome/130')).data.code,'ACCOUNT_NOT_ALLOWED');assert.equal(calls,4);
  assert.equal((await localFetch(base+'/pembeli/claim-test.mjs')).status,200);
  await new Promise(r=>server.close(r));harness.clear();harness=createLiveClaimSession(plan,{preparationOnly:true,now:()=>clock});await start();state=await get();assert.notEqual(state.instanceId,original.instanceId);assert.equal((await register(a,'Chrome/130')).status,200);assert.equal((await get()).ready.A,true);
 }finally{if(server?.listening)await new Promise(r=>server.close(r));globalThis.fetch=nativeFetch;for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);}
});
