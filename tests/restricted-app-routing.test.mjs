import test from 'node:test';
import assert from 'node:assert/strict';
import buyer from '../api/buyer.js';
import status from '../api/buyer-status.js';
import create from '../api/admin-create-v2.js';
import list from '../api/admin-v2-cards.js';
import reset from '../api/admin-reset-v2.js';
import ready from '../api/admin-set-v2-ready.js';
import recover from '../api/admin-recover-v2-owner.js';
import admin from '../api/v2-admin.js';
const target='https://svuagnobufhfpgzmsyxx.supabase.co',origin='http://127.0.0.1:4189';
const response=()=>({code:200,setHeader(){},status(n){this.code=n;return this;},json(data){this.data=data;return this;}});
const req=(action,body)=>({method:body?'POST':'GET',headers:{host:'127.0.0.1:4189',origin,'content-type':'application/json','x-buyer-request':'1',cookie:'rr_buyer_a=fixture-only'},query:{action,card:'T'.repeat(24)},body:body?{...body,action}:undefined});
test('application routing: restricted buyer/status use wrappers only; original Admin operations remain unavailable (mock transport)',async()=>{
 const env={...process.env},oldFetch=globalThis.fetch,calls=[];
 try{
  Object.assign(process.env,{BUYER_RESTRICTED_APP:'true',RR_TEST_RUN_ID:'11111111-2222-4333-8444-555555555555',BUYER_INTEGRATION_ENABLED:'true',BUYER_LOCAL_HTTP:'1',BUYER_APP_ORIGIN:origin,SUPABASE_URL:target,SUPABASE_PUBLISHABLE_KEY:'test-public'});
  delete process.env.RR_TEST_APP_WRITES;
  globalThis.fetch=async(url,options)=>{
   calls.push(url);assert.ok(url===target+'/auth/v1/user'||url===target+'/rest/v1/rpc/buyer_test_action');
   const data=url.endsWith('/user')?{id:'fixture-only',identities:[{provider:'google'}]}:JSON.parse(options.body).p_op==='status'?{success:true,status:{code:'T'.repeat(24),claim_allowed:true,activation_state:'inactive'}}:{success:true,cards:[]};
   return {ok:true,status:200,json:async()=>data};
  };
  let res=response();await buyer(req('mode'),res);assert.equal(res.data.mode,'restricted');assert.equal(res.data.activation_flow,'first_claim');assert.equal(calls.length,0);
  res=response();await buyer(req('cards'),res);assert.equal(res.code,200);assert.equal(res.data.mode,'restricted');
  res=response();await status(req('status'),res);assert.equal(res.data.claim_allowed,true);
  const count=calls.length;
  res=response();await buyer(req('first-claim',{card_code:'T'.repeat(24)}),res);assert.equal(res.code,503);
  res=response();await buyer(req('claim',{pin:'unused'}),res);assert.equal(res.code,400);
  for(const handler of [create,list,ready,recover]){res=response();await handler(req('unknown',{}),res);assert.equal(res.code,503);}
  res=response();await reset(req('reset',{}),res);assert.equal(res.code,503);assert.equal(calls.length,count);
  process.env.BUYER_RESTRICTED_APP='false';res=response();await admin(req('session'),res);assert.equal(res.code,503);assert.equal(res.data.capabilities.list,false);assert.equal(calls.length,count);
 }finally{globalThis.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);}
});
