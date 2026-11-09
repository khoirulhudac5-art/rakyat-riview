import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createLiveClaimSession} from '../scripts/first-claim-live-session.mjs';
import {frozenWrite,approvedPreparation} from '../scripts/first-claim-live-control.mjs';

test('explicit continuation only accepts previously unopened preparation with verified closure; never retries an attempted run',()=>{
 const plan={run_id:'unit-run',status:'CLOSED_RETIRED',fixtures:[{card_code:null},{card_code:null}]};
 const previous={runId:'unit-run',openRunAttempted:false,closedVerified:true,originalRPCsClosed:true,wrappersClosed:true,customerDataUnchanged:true,dummyCleanup:{registered:0,owned:0}};
 assert.equal(approvedPreparation(plan,previous,{continuePreparation:true}),'continued-unopened-preparation');
 assert.throws(()=>approvedPreparation(plan,previous));
 for(const patch of [{openRunAttempted:true},{closedVerified:false},{runId:'other'},{dummyCleanup:{registered:2,owned:0}},{originalRPCsClosed:false},{wrappersClosed:false}])assert.throws(()=>approvedPreparation(plan,{...previous,...patch},{continuePreparation:true}));
 assert.throws(()=>approvedPreparation({...plan,fixtures:[{card_code:'allocated'},{}]},previous,{continuePreparation:true}));
});
test('live harness: selected identities only, no token response, real logout/new-session proof and finished closure (mock Auth)',async()=>{
 const saved={...process.env},nativeFetch=globalThis.fetch;let server;
 const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');const access=(id,session)=>encode({alg:'test-only'})+'.'+encode({sub:id,session_id:session,exp:Math.floor(Date.now()/1000)+3600})+'.fixture';
 const a=access('unit-A','first'),next=access('unit-A','next'),b=access('unit-B','b'),other=access('unit-C','c');
 const harness=createLiveClaimSession({accounts:{A:{uid:'unit-A'},B:{uid:'unit-B'}}});
 try{
  Object.assign(process.env,{BUYER_INTEGRATION_ENABLED:'true',BUYER_LOCAL_HTTP:'1',BUYER_APP_ORIGIN:'http://127.0.0.1:4180',SUPABASE_URL:'https://svuagnobufhfpgzmsyxx.supabase.co',SUPABASE_PUBLISHABLE_KEY:'test-public'});
  globalThis.fetch=async(url,options)=>{assert.equal(url,'https://svuagnobufhfpgzmsyxx.supabase.co/auth/v1/user');const jwt=options.headers.Authorization.slice(7),id=JSON.parse(Buffer.from(jwt.split('.')[1],'base64url')).sub;return {ok:true,status:200,json:async()=>({id,identities:[{provider:'google'}]})};};
  server=http.createServer(async(req,res)=>{if(!await harness.handle(req,res,new URL(req.url,'http://127.0.0.1')))res.writeHead(404).end();});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const register=async(jwt,origin='http://127.0.0.1:4180')=>{const r=await nativeFetch(base+'/api/claim-test',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Buyer-Request':'1',Cookie:'rr_buyer_a='+jwt},body:JSON.stringify({action:'register'})});return {status:r.status,data:await r.json()};};
  assert.equal((await register(a,'https://outside.example')).status,403);assert.equal((await register(other)).status,403);
  const result=await register(a);assert.equal(result.status,200);assert.equal(result.data.label,'A');assert.equal(JSON.stringify(result.data).includes(a),false);assert.equal(harness.ready,false);
  assert.equal((await register(b)).status,200);assert.equal(harness.ready,true);
  harness.noteSignout({headers:{cookie:'rr_buyer_a='+a}});assert.equal(harness.ready,false);assert.equal((await register(next)).data.freshSession,true);assert.equal(harness.ready,true);
  harness.phase='FINISHED';harness.clear();const closed=await register(next);assert.equal(closed.status,409);assert.equal(closed.data.code,'PREPARATION_CLOSED');assert.equal(closed.data.loginRequired,false);assert.equal(harness.sessions.size,0);
 }finally{if(server)await new Promise(r=>server.close(r));globalThis.fetch=nativeFetch;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
});
test('live frozen SQL transport rejects checksum drift before connecting or writing',async()=>{
 await assert.rejects(frozenWrite({execution_files:{open:{file:'open-run.sql',sha256:'invalid'}}},'open'),/checksum mismatch/);
 await assert.rejects(frozenWrite({execution_files:{open:{file:'outside.sql',sha256:'invalid'}}},'open'),/identity invalid/);
});
