import test from 'node:test';
import assert from 'node:assert/strict';
import reset from '../api/admin-reset-v2.js';
import list from '../api/admin-v2-cards.js';
import {sessionCookie} from '../lib/admin-session.mjs';
const response=()=>({code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.data=v;return this;}});
test('admin reset: confirmation, CSRF, opt-in flag, revision and actor cannot be bypassed',async()=>{
 const env={...process.env},before=globalThis.fetch;let sent,result=true,calls=0;
 try{
  Object.assign(process.env,{ADMIN_SESSION_SECRET:'test-only-admin-secret-with-32-characters',SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SECRET_KEY:'private-server-only'});
  const req={method:'POST',headers:{'x-admin-request':'1','sec-fetch-site':'same-origin'},body:{card_code:'A'.repeat(24),confirmation:'A'.repeat(24),expected_revision:2,reason:'Synthetic documented reset request',acknowledged:true,actor:'forged'}};
  let r=response();await reset(req,r);assert.equal(r.code,401);req.headers.cookie=sessionCookie().split(';')[0];
  delete process.env.ADMIN_V2_RESET_ENABLED;r=response();await reset(req,r);assert.equal(r.code,503);process.env.ADMIN_V2_RESET_ENABLED='true';
  globalThis.fetch=async(url,opts)=>{calls++;sent={url,args:JSON.parse(opts.body)};return{ok:true,json:async()=>result};};
  for(const patch of [{confirmation:'wrong'},{acknowledged:false},{reason:'short'},{expected_revision:-1},{expected_revision:1e20},{card_code:'001'}]){r=response();await reset({...req,body:{...req.body,...patch}},r);assert.equal(r.code,400);}assert.equal(calls,0);
  r=response();await reset({...req,headers:{...req.headers,'sec-fetch-site':'cross-site'}},r);assert.equal(r.code,403);
  r=response();await reset(req,r);assert.equal(r.code,200);assert.equal(sent.args.p_expected_revision,2);assert.match(sent.args.p_actor,/^admin-session:/);assert.notEqual(sent.args.p_actor,'forged');assert.ok(!JSON.stringify(r.data).includes('private-server-only'));
  result=false;r=response();await reset(req,r);assert.equal(r.code,409);
  r=response();await list({method:'GET',headers:{}},r);assert.equal(r.code,401);
  globalThis.fetch=async()=>({ok:true,json:async()=>[]});r=response();await list({method:'GET',headers:req.headers},r);assert.equal(r.code,200);assert.equal(r.data.reset_enabled,true);
 }finally{globalThis.fetch=before;for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);}
});
