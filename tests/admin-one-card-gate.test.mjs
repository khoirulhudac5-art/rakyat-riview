import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {randomUUID,randomBytes} from 'node:crypto';
import {adminCookieHash,readOneCardPermit,createOneCardAdmin} from '../lib/admin-one-card-gate.mjs';import {sessionCookie} from '../lib/admin-session.mjs';
async function setup(run){const saved={...process.env};try{Object.assign(process.env,{ADMIN_V2_READONLY_LOCAL:'true',ADMIN_V2_READ_CONTRACT_READY:'true',ADMIN_V2_READ_ORIGIN:'http://127.0.0.1:4194',ADMIN_GENERATE_LIVE_LOCAL:'true',SUPABASE_URL:'https://svuagnobufhfpgzmsyxx.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_unit_only',ADMIN_PASSWORD:'strong-unit-only-password-123',ADMIN_SESSION_SECRET:randomBytes(40).toString('hex')});delete process.env.VERCEL;delete process.env.NODE_ENV;
 const dir=fs.mkdtempSync(path.resolve('.backups/one-card-gate-unit-')),file=path.join(dir,'permit.json'),cookie=sessionCookie().split(';')[0],id=randomUUID();
 const p={state:'armed',request_id:id,quantity:1,project_ref:'svuagnobufhfpgzmsyxx',expected_fingerprint:'5aefd8e4df29f1c365b8942629b911cd',session_hash:adminCookieHash(cookie),expires_at:Date.now()+120000};fs.writeFileSync(file,JSON.stringify(p));await run({file,cookie,id,p});
}finally{for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}}
function req(cookie,id){return {method:'POST',headers:{host:'127.0.0.1:4194',origin:'http://127.0.0.1:4194','content-type':'application/json','x-admin-request':'1',cookie},body:{action:'create',quantity:1,request_id:id}};}
async function call(h,q){const r={code:200,setHeader(){},status(n){this.code=n;return this;},json(d){this.data=d;}};await h(q,r);return r;}
test('private one-card permit binds session/project/UUID/expiry and fails closed',()=>setup(async({file,cookie,p})=>{
 assert.ok(readOneCardPermit(file,cookie));assert.equal(readOneCardPermit(file,'__Host-rr_admin=other'),null);
 for(const patch of [{state:'closed'},{quantity:2},{expected_fingerprint:'other'},{expires_at:Date.now()-1},{expires_at:Date.now()+3600000}]){fs.writeFileSync(file,JSON.stringify({...p,...patch}));assert.equal(readOneCardPermit(file,cookie),null);}
}));
test('one scoped dispatch is consumed before invocation; second request cannot create',()=>setup(async({file,cookie,id})=>{
 let n=0;const h=createOneCardAdmin({permitFile:file,invoke:async()=>{n++;assert.equal(JSON.parse(fs.readFileSync(file)).state,'closed');return {success:true,batch_id:id,cards:[{card_code:'J'.repeat(24)}]};},readPage:async()=>({cards:[],next_cursor:null})});
 const a=await call(h,req(cookie,id));assert.equal(a.code,200);assert.equal((await call(h,req(cookie,id))).code,423);assert.equal(n,1);assert.equal(JSON.parse(fs.readFileSync(file)).state,'closed');
}));
test('failed/ambiguous transport also permanently closes HTTP scope without retry',()=>setup(async({file,cookie,id})=>{
 let n=0;const h=createOneCardAdmin({permitFile:file,invoke:async()=>{n++;throw Error('synthetic lost response');},readPage:async()=>({cards:[],next_cursor:null})});
 assert.equal((await call(h,req(cookie,id))).code,503);assert.equal(readOneCardPermit(file,cookie),null);assert.equal((await call(h,req(cookie,id))).code,423);assert.equal(n,1);
}));
