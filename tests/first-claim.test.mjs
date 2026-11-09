import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreview} from '../scripts/preview-accounts.mjs';
import {firstClaimModel} from '../scripts/first-claim-model.mjs';
import buyer from '../api/buyer.js';
import recover from '../api/admin-recover-v2-owner.js';
import create from '../api/admin-create-v2.js';
import inventory from '../api/admin-set-v2-ready.js';
import {sessionCookie} from '../lib/admin-session.mjs';
const review='https://search.google.com/local/writereview?placeid=ChIMockFixtureOnly';
const response=()=>({code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.data=v;return this;}});

test('production handler: only verified Google session, opt-in flag, canonical URL and database result authorize claim',async()=>{
  const old={...process.env},fetchBefore=globalThis.fetch;let google=true,result={success:true,code:'claimed'},requests=[];
  const call=async(body,cookie='__Host-rr_buyer_a=real-user-token')=>{const res=response();await buyer({method:'POST',headers:{origin:'https://review.example','content-type':'application/json','x-buyer-request':'1',cookie},body:{action:'first-claim',card_code:'A'.repeat(24),business_name:'Mock business',review_url:review,...body}},res);return res;};
  try{
    Object.assign(process.env,{BUYER_INTEGRATION_ENABLED:'true',BUYER_APP_ORIGIN:'https://review.example',SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_PUBLISHABLE_KEY:'mock-public'});
    delete process.env.BUYER_FIRST_CLAIM_ENABLED;
    globalThis.fetch=async(url,opts)=>{requests.push({url,opts});return{ok:true,json:async()=>url.endsWith('/user')?{id:'10000000-0000-0000-0000-000000000001',email:'mock@example.test',identities:[{provider:google?'google':'email'}],user_metadata:{provider:'google'}}:result};};
    assert.equal((await call({})).code,503);
    process.env.BUYER_FIRST_CLAIM_ENABLED='true';
    assert.equal((await call({},'rr_preview=synthetic-cookie')).code,401);
    google=false;assert.equal((await call({google:true,user_id:'forged'})).code,403);google=true;
    assert.equal((await call({card_code:'002'})).code,400);assert.equal((await call({review_url:'https://google.com/maps'})).code,400);
    const ok=await call({user_id:'forged',ready:true,inventory_state:'ready'});assert.equal(ok.code,200);
    const args=JSON.parse(requests.at(-1).opts.body);assert.equal(args.p_card_code,'A'.repeat(24));assert.equal(args.p_user_id,undefined);assert.equal(requests.at(-1).opts.headers.Authorization,'Bearer real-user-token');
    assert.equal(args.p_ready,undefined);assert.equal(args.inventory_state,undefined);
    result={success:false,code:'not_ready'};assert.match((await call({ready:true})).data.error,/inventaris/);
    result={success:false,code:'rate_limited'};const limited=await call({});assert.equal(limited.code,429);assert.equal(limited.headers['Retry-After'],'900');
    result={success:false,code:'already_claimed'};assert.equal((await call({})).code,409);
  }finally{globalThis.fetch=fetchBefore;for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);}
});

test('inventory model consumes readiness once and never treats client readiness as authority',()=>{
 const card={card_code:'R'.repeat(24),claim_mode:'google_first_claim',inventory_state:'draft'},user={id:'mock-owner',google:true},limits=new Map();
 const body={card_code:card.card_code,business_name:'Synthetic',review_url:review,ready:true};
 assert.equal(firstClaimModel([card],user,body,limits).status,409);assert.equal(card.owner,undefined);
 card.inventory_state='ready';assert.equal(firstClaimModel([card],user,body,limits).status,200);assert.equal(card.inventory_state,'claimed');
 assert.equal(firstClaimModel([card],{id:'other',google:true},body,limits).status,409);
 assert.equal(firstClaimModel([card],user,{...body,business_name:'overwrite'},limits).status,200);assert.equal(card.business_name,'Synthetic');
});

test('inventory readiness endpoint requires admin, explicit feature flag and server-derived actor',async()=>{
 const old={...process.env},fetchBefore=globalThis.fetch;let sent;
 const req={method:'POST',headers:{'x-admin-request':'1','sec-fetch-site':'same-origin'},body:{card_code:'R'.repeat(24),ready:true,actor:'forged'}};
 try{
  process.env.ADMIN_SESSION_SECRET='mock-secret-at-least-32-characters-long';process.env.SUPABASE_URL='https://fixture.supabase.co';process.env.SUPABASE_SECRET_KEY='server-only';
  let r=response();await inventory(req,r);assert.equal(r.code,401);
  req.headers.cookie=sessionCookie().split(';')[0];delete process.env.ADMIN_V2_INVENTORY_ENABLED;r=response();await inventory(req,r);assert.equal(r.code,503);
  process.env.ADMIN_V2_INVENTORY_ENABLED='true';globalThis.fetch=async(url,opts)=>{sent={url,body:JSON.parse(opts.body)};return{ok:true,json:async()=>true};};
  r=response();await inventory(req,r);assert.equal(r.code,200);assert.ok(sent.url.endsWith('/admin_set_v2_card_ready'));assert.equal(sent.body.p_ready,true);assert.match(sent.body.p_actor,/^admin-session:/);assert.notEqual(sent.body.p_actor,'forged');
  r=response();await inventory({...req,body:{...req.body,ready:'true'}},r);assert.equal(r.code,400);
 }finally{globalThis.fetch=fetchBefore;for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);}
});

test('mock first claim: competing accounts, idempotency, logout/login, cross-session reads, owner edits and public redirect',async()=>{
  const server=createPreview({experience:true,firstClaim:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  const post=async(body,cookie='')=>{const r=await fetch(origin+'/api/buyer',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Buyer-Request':'1',Cookie:cookie},body:JSON.stringify(body)});return{status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
  const list=async cookie=>(await(await fetch(origin+'/api/buyer?action=cards',{headers:{Cookie:cookie}})).json()).cards;
  try{
    const entry=await fetch(origin+'/preview-new-card',{redirect:'manual'}),code=entry.headers.get('location').split('/').at(-1);assert.match(code,/^[A-Za-z0-9_-]{24}$/);
    assert.equal((await(await fetch(origin+'/api/buyer-status?card='+code)).json()).claim_allowed,true);
    const a=(await post({action:'demo-signin'})).cookie,b=(await post({action:'demo-signin',account:'second'})).cookie;
    const email=(await post({action:'signup',email:'email@example.test',password:'mock-password'})).cookie;
    const fields={action:'first-claim',card_code:code,business_name:'Winner',review_url:review};
    assert.equal((await post({...fields,google:true},email)).status,403);
    const race=await Promise.all([post(fields,a),post(fields,b)]);assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
    const aWins=race[0].status===200,winner=aWins?a:b,loser=aWins?b:a;
    assert.equal((await post({...fields,business_name:'Do not overwrite'},winner)).status,200);
    assert.equal((await list(winner)).find(c=>c.card_code===code).business_name,'Winner');assert.ok(!(await list(loser)).some(c=>c.card_code===code));
    assert.equal((await post({action:'update',card_code:code,business_name:'Hijack',review_url:review},loser)).status,400);
    assert.equal((await post({action:'update',card_code:code,business_name:'Updated owner',review_url:review},winner)).status,200);
    assert.equal((await fetch(origin+'/r/'+code,{redirect:'manual'})).headers.get('location'),review);
    await post({action:'signout'},winner);
    assert.equal((await fetch(origin+'/api/buyer?action=session',{headers:{Cookie:winner}})).status,401);
    const again=(await post({action:'demo-signin',...(aWins?{}:{account:'second'})})).cookie;
    assert.notEqual(again,winner);assert.equal((await list(again)).find(c=>c.card_code===code).business_name,'Updated owner');
    assert.equal((await post({...fields,card_code:'SYN-OLD'},again)).status,400);
  }finally{await new Promise(r=>server.close(r));}
});

test('synthetic model rate limits attempts and never enables legacy or PIN cards',()=>{
  const cards=[{card_code:'L'.repeat(24),claim_mode:'legacy',active:false,pin:'old-pin'}],limits=new Map(),user={id:'mock-google',google:true};
  const body={card_code:'L'.repeat(24),business_name:'Mock',review_url:review};
  for(let i=0;i<20;i++)assert.equal(firstClaimModel(cards,user,body,limits,1000000).status,409);
  assert.equal(firstClaimModel(cards,user,body,limits,1000000).status,429);
  assert.equal(firstClaimModel(cards,user,body,limits,1900000).status,409);assert.equal(cards[0].pin,'old-pin');assert.equal(cards[0].owner,undefined);
});

test('admin recovery and issuance require authenticated admin; actor is server-derived and recovery opt-in',async()=>{
  const env={...process.env},previous=globalThis.fetch;let requested;
  try{
    process.env.ADMIN_SESSION_SECRET='mock-secret-at-least-32-characters-long';process.env.SUPABASE_URL='https://fixture.supabase.co';process.env.SUPABASE_SECRET_KEY='server-only';process.env.CARD_PUBLIC_ORIGIN='https://cards.example';process.env.ADMIN_V2_CREATION_ENABLED='true';
    const req={method:'POST',headers:{'x-admin-request':'1','sec-fetch-site':'same-origin'},body:{card_code:'A'.repeat(24),confirmation:'A'.repeat(24),new_owner:'10000000-0000-0000-0000-000000000002',reason:'Verified support request and documented purchase evidence.',actor:'forged'}};
    let res=response();await recover(req,res);assert.equal(res.code,401);
    req.headers.cookie=sessionCookie().split(';')[0];delete process.env.ADMIN_BUYER_RECOVERY_ENABLED;
    res=response();await recover(req,res);assert.equal(res.code,503);
    process.env.ADMIN_BUYER_RECOVERY_ENABLED='true';
    globalThis.fetch=async(url,opts)=>{requested={url,body:JSON.parse(opts.body)};return{ok:true,json:async()=>true};};
    res=response();await recover(req,res);assert.equal(res.code,200);assert.match(requested.body.p_actor,/^admin-session:/);assert.notEqual(requested.body.p_actor,'forged');assert.ok(!JSON.stringify(res.data).includes('server-only'));
    globalThis.fetch=async()=>({ok:true,json:async()=>[{card_code:'B'.repeat(24)}]});res=response();await create({...req,body:{quantity:1}},res);assert.equal(res.code,200);assert.equal(res.data.cards[0].card_url,'https://cards.example/r/'+'B'.repeat(24));
  }finally{globalThis.fetch=previous;for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);}
});
