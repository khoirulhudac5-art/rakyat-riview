import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,randomBytes} from 'node:crypto';
import {createLiveAdminGenerate,createLiveGenerateTransport} from '../lib/admin-generate-live.mjs';import {sessionCookie} from '../lib/admin-session.mjs';
async function fixture(run){const saved={...process.env};try{Object.assign(process.env,{ADMIN_V2_READONLY_LOCAL:'true',ADMIN_V2_READ_CONTRACT_READY:'true',ADMIN_V2_READ_ORIGIN:'http://127.0.0.1:4194',ADMIN_GENERATE_LIVE_LOCAL:'true',ADMIN_GENERATE_DOMAIN_CONFIRMED:'false',SUPABASE_URL:'https://svuagnobufhfpgzmsyxx.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_unit_server_only',ADMIN_PASSWORD:'strong-unit-Admin-password-123',ADMIN_SESSION_SECRET:randomBytes(40).toString('hex')});delete process.env.VERCEL;delete process.env.NODE_ENV;await run();}finally{for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}}
const req=(body,cookie=sessionCookie().split(';')[0])=>({method:'POST',headers:{host:'127.0.0.1:4194',origin:'http://127.0.0.1:4194','content-type':'application/json','x-admin-request':'1',cookie},body:{action:'create',...body}});
async function call(h,q){const r={code:200,setHeader(){},status(n){this.code=n;return this;},json(d){this.data=d;return this;}};await h(q,r);return r;}
test('real backend keeps create gated despite valid Admin session; anon/buyer/reset cannot invoke',()=>fixture(async()=>{
 let n=0;const h=createLiveAdminGenerate({invoke:async()=>{n++;throw Error();},readPage:async()=>({cards:[],next_cursor:null})});
 assert.equal((await call(h,req({quantity:1,request_id:randomUUID()}))).code,423);
 for(const c of ['', 'rr_buyer_a=synthetic-google','__Host-rr_admin=invalid'])assert.equal((await call(h,req({quantity:1,request_id:randomUUID()},c))).code,401);
 const r=req({});r.body.action='reset';assert.equal((await call(h,r)).code,405);assert.equal(n,0);
}));
test('future single-card scope enforces UUID/quantity/CSRF and server actor; transport injected, not live',()=>fixture(async()=>{
 const id=randomUUID();let args,n=0;const h=createLiveAdminGenerate({approvedRequestId:id,invoke:async a=>{n++;args=a;return {success:true,batch_id:id,cards:[{card_code:'L'.repeat(24)}]};},readPage:async()=>({cards:[],next_cursor:null})});
 for(const b of [{quantity:2,request_id:id},{quantity:1,request_id:randomUUID()}])assert.equal((await call(h,req(b))).code,403);
 const cross=req({quantity:1,request_id:id});cross.headers.origin='https://outside.example';assert.equal((await call(h,cross)).code,403);
 const csrf=req({quantity:1,request_id:id});delete csrf.headers['x-admin-request'];assert.equal((await call(h,csrf)).code,403);assert.equal(n,0);
 const r=await call(h,req({quantity:1,request_id:id,p_actor:'forged'}));assert.equal(r.code,200);assert.equal(args.p_actor,'admin:configured-owner');assert.equal(r.data.cards[0].card_url,null);assert.equal(r.data.data_source,'supabase');assert.equal(r.data.capabilities.reset,false);
}));
test('real POST transport uses fixed project/RPC, server-only key and no retries; no scope means no fetch',()=>fixture(async()=>{
 let n=0;const id=randomUUID(),args={p_request_id:id,p_quantity:1,p_actor:'admin:configured-owner'},fake=async(url,opts)=>{n++;assert.equal(url,'https://svuagnobufhfpgzmsyxx.supabase.co/rest/v1/rpc/admin_generate_v2_batch');assert.equal(opts.redirect,'error');assert.equal(opts.method,'POST');assert.equal(opts.headers.apikey,process.env.SUPABASE_SECRET_KEY);assert.equal(opts.headers.Authorization,undefined);throw Error('synthetic timeout after commit');};
 await assert.rejects(createLiveGenerateTransport({fetchImpl:fake})(args));assert.equal(n,0);
 await assert.rejects(createLiveGenerateTransport({approvedRequestId:id,fetchImpl:fake})(args));assert.equal(n,1);
}));
