import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createAdminReadonly,supabaseAdminReadPage,getCardPublicOrigin} from '../lib/admin-readonly.mjs';
import {sessionCookie} from '../lib/admin-session.mjs';
import admin from '../api/v2-admin.js';
import create from '../api/admin-create-v2.js';
import reset from '../api/admin-reset-v2.js';
const uid='11111111-2222-4333-8444-555555555555',origin='http://127.0.0.1:4191',target='https://svuagnobufhfpgzmsyxx.supabase.co';
const row=code=>({card_code:code.repeat(24),business_name:'Fixture',review_url:null,created_at:null,owner_id:uid,active:true,activation_revision:1,inventory_state:'claimed',pin_hash:'MUST-NOT-LEAK',credentials:'MUST-NOT-LEAK'});
const response=()=>({code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(d){this.data=d;return this;}});
const req=(action='cards',body)=>({method:body?'POST':'GET',query:{action},body:body?{action,...body}:undefined,headers:{host:'127.0.0.1:4191',origin,'sec-fetch-site':'same-origin','content-type':'application/json','x-admin-request':'1',cookie:sessionCookie().split(';')[0]}});
const call=async(handler,request)=>{const res=response();await handler(request,res);return res;};
async function fixture(run){const env={...process.env},before=globalThis.fetch;try{Object.assign(process.env,{ADMIN_V2_READONLY_LOCAL:'true',ADMIN_V2_READ_ORIGIN:origin,ADMIN_V2_READ_CONTRACT_READY:'true',ADMIN_SESSION_SECRET:'test-only-signing-secret-at-least-32-characters',ADMIN_PASSWORD:'test-only-password',SUPABASE_URL:target,SUPABASE_SECRET_KEY:'sb_secret_fixture_server_only',CARD_PUBLIC_ORIGIN:'https://cards.example.test',BUYER_RESTRICTED_APP:'true',RR_TEST_APP_WRITES:'true',ADMIN_V2_RESET_ENABLED:'true',ADMIN_V2_CREATION_ENABLED:'true'});globalThis.fetch=()=>{throw Error('Unexpected external request');};await run();}finally{globalThis.fetch=before;for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);}}
test('read-only Admin rejects missing/buyer/forged cookies, cross-origin and nonlocal runtime before transport',()=>fixture(async()=>{
 let reads=0;const handler=createAdminReadonly({readPage:async()=>{reads++;return {cards:[],next_cursor:null};}});
 for(const cookie of ['', 'rr_buyer_a=valid-google-buyer-token', '__Host-rr_admin=forged']){const request=req();request.headers.cookie=cookie;assert.equal((await call(handler,request)).code,401);}
 const cross=req();cross.headers.origin='https://outside.example';assert.equal((await call(handler,cross)).code,403);
 for(const [key,value] of [['NODE_ENV','production'],['VERCEL','1'],['ADMIN_V2_READONLY_LOCAL','false'],['ADMIN_V2_READ_ORIGIN','https://production.example']]){const old=process.env[key];process.env[key]=value;assert.equal((await call(handler,req())).code,503);if(old===undefined)delete process.env[key];else process.env[key]=old;}
 assert.equal(reads,0);
}));
test('unapproved read contract fails closed, never probes existing/closed RPCs and never returns fake empty inventory',()=>fixture(async()=>{
 process.env.ADMIN_V2_READ_CONTRACT_READY='false';let calls=0;const handler=createAdminReadonly({readPage:async()=>{calls++;return {};}});
 const s=await call(handler,req('session'));assert.equal(s.data.authenticated,true);assert.equal(s.data.capabilities.list,false);
 const r=await call(handler,req());assert.equal(r.code,503);assert.equal(r.data.cards,undefined);assert.equal(calls,0);
}));
test('Admin inventory is paged, whitelisted and UID-based; missing dates/URLs remain unavailable',()=>fixture(async()=>{
 const pages=[];const handler=createAdminReadonly({readPage:async(kind,cursor)=>{pages.push(cursor);return cursor?{cards:[row('Z')],next_cursor:null}:{cards:[row('A')],next_cursor:'A'.repeat(24)};}});
 let r=await call(handler,req());assert.equal(r.code,200);assert.equal(r.data.mode,'admin_readonly');assert.equal(r.data.cards.length,2);assert.deepEqual(pages,[null,'A'.repeat(24)]);assert.equal(r.data.cards[0].owner_id,uid);assert.equal(r.data.cards[0].owner_label,uid);assert.equal(r.data.cards[0].created_at,null);assert.equal(r.data.cards[0].card_url,'https://cards.example.test/r/'+'A'.repeat(24));assert.equal(r.data.statistics.available,false);assert.equal(r.data.capabilities.create,false);assert.equal(r.data.capabilities.reset,false);assert.equal(JSON.stringify(r.data).includes('MUST-NOT-LEAK'),false);assert.match(r.headers['Cache-Control'],/no-store/);
 delete process.env.CARD_PUBLIC_ORIGIN;r=await call(createAdminReadonly({readPage:async()=>({cards:[row('A')],next_cursor:null})}),req());assert.equal(r.data.cards[0].card_url,null);
}));
test('audit reads unique source IDs and projected ownership events, excluding secrets',()=>fixture(async()=>{
 const handler=createAdminReadonly({readPage:async()=>({events:[{id:'reset:1',at:'2026-11-07T00:00:00Z',action:'reset',card_code:'A'.repeat(24),actor:'admin-session:fixture',reason:'Recorded fixture event',old_owner:uid,new_owner:null,secret:'MUST-NOT-LEAK'}],next_cursor:null})});
 const r=await call(handler,req('audit'));assert.equal(r.code,200);assert.equal(r.data.events[0].old_owner,uid);assert.equal(r.data.events[0].id,'reset:1');assert.equal(JSON.stringify(r.data).includes('MUST-NOT-LEAK'),false);
}));
test('empty data differs from malformed, duplicate and incomplete data; no partial inventory is exposed',()=>fixture(async()=>{
 let r=await call(createAdminReadonly({readPage:async()=>({cards:[],next_cursor:null})}),req());assert.deepEqual(r.data.cards,[]);
 const audit=await call(createAdminReadonly({readPage:async()=>({events:[],next_cursor:null})}),req('audit'));assert.equal(audit.code,200);assert.deepEqual(audit.data.events,[]);
 for(const payload of [{cards:null,next_cursor:null},{cards:[row('A'),row('A')],next_cursor:null},{cards:[],next_cursor:'A'.repeat(24)},{cards:[{...row('A'),owner_id:'not-a-uuid'}],next_cursor:null}]){r=await call(createAdminReadonly({readPage:async()=>payload}),req());assert.equal(r.code,502);assert.equal(r.data.cards,undefined);}
 r=await call(createAdminReadonly({readPage:async()=>({cards:[row('A')],next_cursor:'A'.repeat(24)})}),req());assert.equal(r.code,502);
}));
test('HTTP RPC transport uses GET only, fixed names, server key, no redirects or error detail leaks',()=>fixture(async()=>{
 const calls=[];globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});return {ok:true,json:async()=>({cards:[],next_cursor:null})};};
 await supabaseAdminReadPage('cards',null);await supabaseAdminReadPage('audit','opaque_cursor');for(const c of calls){assert.equal(c.options.method,'GET');assert.equal(c.options.redirect,'error');assert.ok(c.url.startsWith(target+'/rest/v1/rpc/admin_read_v2_'));assert.equal(c.options.headers.apikey,'sb_secret_fixture_server_only');assert.equal(c.options.headers.Authorization,undefined);}
 const legacy='fixture.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.test';process.env.SUPABASE_SECRET_KEY=legacy;await supabaseAdminReadPage('cards',null);assert.equal(calls.at(-1).options.headers.Authorization,'Bearer '+legacy);process.env.SUPABASE_SECRET_KEY='sb_secret_fixture_server_only';
 await assert.rejects(supabaseAdminReadPage('admin_reset_v2_activation',null));
 for(const status of [401,403,404,405,500]){globalThis.fetch=async()=>({ok:false,status,json:async()=>({secret:'MUST-NOT-LEAK'})});const r=await call(createAdminReadonly(),req());assert.equal(r.code,status===500?502:503);assert.equal(JSON.stringify(r.data).includes('sb_secret_fixture'),false);assert.equal(r.data.cards,undefined);}
}));
test('read-only profile rejects all direct mutation routes despite permissive old write flags',()=>fixture(async()=>{
 let reads=0;const handler=createAdminReadonly({readPage:async()=>{reads++;return {};}});
 for(const action of ['create','reset','ready','recover','unknown']){const r=await call(handler,req(action,{}));assert.equal(r.code,405);assert.equal(r.data.capabilities.create,false);assert.equal(r.data.capabilities.reset,false);}
 assert.equal((await call(admin,req('reset',{}))).code,405);assert.equal((await call(create,req('create',{quantity:1}))).code,503);assert.equal((await call(reset,req('reset',{}))).code,405);process.env.BUYER_RESTRICTED_APP='false';assert.equal((await call(create,req('create',{quantity:1}))).code,405);assert.equal((await call(reset,req('reset',{}))).code,405);assert.equal(reads,0);
}));
test('permanent URL derivation: active cards, unclaimed cards, canonical origin fallback, and invalid data rejection',()=>fixture(async()=>{
 const activeRow={card_code:'A'.repeat(24),business_name:'fahhh99',review_url:'https://g.page/r/pilot-review',created_at:'2026-11-01T00:00:00Z',owner_id:uid,active:true,activation_revision:1,inventory_state:'claimed'};
 const unclaimedRow={card_code:'B'.repeat(24),business_name:null,review_url:null,created_at:null,owner_id:null,active:false,activation_revision:0,inventory_state:'ready'};

 // 1. Active card under CARD_PUBLIC_ORIGIN: card_url formed properly, never equals review_url
 let handler=createAdminReadonly({readPage:async()=>({cards:[activeRow],next_cursor:null})});
 let r=await call(handler,req());
 assert.equal(r.code,200);
 assert.equal(r.data.cards[0].card_url,'https://cards.example.test/r/'+'A'.repeat(24));
 assert.notEqual(r.data.cards[0].card_url,activeRow.review_url);

 // 2. Unclaimed/ready card under CARD_PUBLIC_ORIGIN: card_url formed properly for production export
 handler=createAdminReadonly({readPage:async()=>({cards:[unclaimedRow],next_cursor:null})});
 r=await call(handler,req());
 assert.equal(r.code,200);
 assert.equal(r.data.cards[0].card_url,'https://cards.example.test/r/'+'B'.repeat(24));
 assert.equal(r.data.cards[0].active,false);
 assert.equal(r.data.cards[0].owner_id,null);

 // 3. Canonical origin fallback when CARD_PUBLIC_ORIGIN is absent but ADMIN_V2_ORIGIN is configured
 delete process.env.CARD_PUBLIC_ORIGIN;
 process.env.ADMIN_V2_ORIGIN='https://rakyat-riview.vercel.app';
 handler=createAdminReadonly({readPage:async()=>({cards:[activeRow,unclaimedRow],next_cursor:null})});
 r=await call(handler,req());
 assert.equal(r.code,200);
 assert.equal(r.data.cards[0].card_url,'https://rakyat-riview.vercel.app/r/'+'A'.repeat(24));
 assert.equal(r.data.cards[1].card_url,'https://rakyat-riview.vercel.app/r/'+'B'.repeat(24));

 // 4. Production environment fallback (VERCEL or NODE_ENV=production)
 assert.equal(getCardPublicOrigin({VERCEL:'1'}),'https://rakyat-riview.vercel.app');
 assert.equal(getCardPublicOrigin({NODE_ENV:'production'}),'https://rakyat-riview.vercel.app');
 handler=createAdminReadonly({readPage:async()=>({cards:[activeRow],next_cursor:null}),validateRequest:()=>{}});
 r=await call(handler,req());
 assert.equal(r.code,200);
 assert.equal(r.data.cards[0].card_url,'https://rakyat-riview.vercel.app/r/'+'A'.repeat(24));

 // 5. Invalid data handling: malformed card_code, non-boolean active, negative revision throw 502
 for(const badCode of ['too-short','inv@lid!ch@rs###########',12345,null,undefined,'']){
  handler=createAdminReadonly({readPage:async()=>({cards:[{...activeRow,card_code:badCode}],next_cursor:null})});
  r=await call(handler,req());
  assert.equal(r.code,502);
  assert.equal(r.data.cards,undefined);
 }
 for(const badActive of ['true',1,null,undefined]){
  handler=createAdminReadonly({readPage:async()=>({cards:[{...activeRow,active:badActive}],next_cursor:null})});
  r=await call(handler,req());
  assert.equal(r.code,502);
 }
 handler=createAdminReadonly({readPage:async()=>({cards:[{...activeRow,activation_revision:-1}],next_cursor:null})});
 r=await call(handler,req());
 assert.equal(r.code,502);

 // 6. Insecure/malformed origin candidates are rejected by getCardPublicOrigin
 for(const badOrigin of ['http://insecure.test','https://user:pass@evil.com','javascript:alert(1)','not-a-url','']){
  assert.equal(getCardPublicOrigin({CARD_PUBLIC_ORIGIN:badOrigin}),null);
 }

 // 7. Frontend permanentUrl behavior in assets/admin-v2.js
 const source=fs.readFileSync('assets/admin-v2.js','utf8');
 const ctx={
  location:{origin:'https://rakyat-riview.vercel.app'},
  state:{urlsAvailable:true,readOnly:true},
  URL:globalThis.URL,
  encodeURIComponent:globalThis.encodeURIComponent
 };
 const script=new vm.Script(
  source.slice(source.indexOf('function safeUrl(value)'),source.indexOf('function renderChart()'))
 );
 vm.createContext(ctx);
 script.runInContext(ctx);

 // Active card with backend card_url
 assert.equal(ctx.permanentUrl({card_code:'A'.repeat(24),card_url:'https://rakyat-riview.vercel.app/r/'+'A'.repeat(24),review_url:'https://g.page/r/test'}),'https://rakyat-riview.vercel.app/r/'+'A'.repeat(24));
 // Unclaimed card with backend card_url
 assert.equal(ctx.permanentUrl({card_code:'B'.repeat(24),card_url:'https://rakyat-riview.vercel.app/r/'+'B'.repeat(24),active:false}),'https://rakyat-riview.vercel.app/r/'+'B'.repeat(24));
 // Active card without backend card_url on canonical domain falls back to canonical URL
 assert.equal(ctx.permanentUrl({card_code:'A'.repeat(24),card_url:null}),'https://rakyat-riview.vercel.app/r/'+'A'.repeat(24));
 // URLs unconfirmed suppresses URL
 ctx.state.urlsAvailable=false;
 assert.equal(ctx.permanentUrl({card_code:'A'.repeat(24),card_url:'https://rakyat-riview.vercel.app/r/'+'A'.repeat(24)}),'');
 ctx.state.urlsAvailable=true;
 // Empty or invalid card code returns empty string
 assert.equal(ctx.permanentUrl({card_code:''}),'');
 assert.equal(ctx.permanentUrl(null),'');
}));
