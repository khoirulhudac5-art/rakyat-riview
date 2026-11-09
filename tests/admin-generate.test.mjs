import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {randomUUID,randomBytes,webcrypto} from 'node:crypto';
import {createAdminGenerate,confirmedCardOrigin} from '../lib/admin-generate.mjs';import {sessionCookie} from '../lib/admin-session.mjs';
async function fixture(run){const saved={...process.env};try{Object.assign(process.env,{ADMIN_GENERATE_LOCAL:'isolated_postgres',ADMIN_GENERATE_ENABLED:'true',ADMIN_GENERATE_DOMAIN_CONFIRMED:'false',ADMIN_OPERATOR_ID:'admin:unit-owner',ADMIN_V2_READONLY_LOCAL:'true',ADMIN_V2_READ_CONTRACT_READY:'true',ADMIN_V2_READ_ORIGIN:'http://127.0.0.1:4193',ADMIN_PASSWORD:'unit-local-password-only',ADMIN_SESSION_SECRET:randomBytes(40).toString('hex')});delete process.env.VERCEL;delete process.env.NODE_ENV;await run();}finally{for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}}
const req=(body,cookie=sessionCookie().split(';')[0])=>({method:'POST',headers:{host:'127.0.0.1:4193',origin:'http://127.0.0.1:4193','content-type':'application/json','x-admin-request':'1',cookie},body:{action:'create',...body}});
async function call(handler,request){const r={code:200,setHeader(){},status(n){this.code=n;return this;},json(d){this.data=d;return this;}};await handler(request,r);return r;}
const result=id=>({success:true,batch_id:id,cards:[{card_code:'A'.repeat(24)}]});
test('generate Admin boundary: real session/CSRF/local opt-in required and no default production write transport',()=>fixture(async()=>{
 let invokes=0;const handler=createAdminGenerate({invoke:async a=>{invokes++;return result(a.p_request_id);},readPage:async()=>({cards:[],next_cursor:null})});const body={quantity:1,request_id:randomUUID()};
 for(const cookie of ['', 'rr_buyer_a=synthetic-google','__Host-rr_admin=fake'])assert.equal((await call(handler,req(body,cookie))).code,401);
 const cross=req(body);cross.headers.origin='https://external.example';assert.equal((await call(handler,cross)).code,403);
 const csrf=req(body);delete csrf.headers['x-admin-request'];assert.equal((await call(handler,csrf)).code,403);
 assert.equal(invokes,0);assert.equal((await call(createAdminGenerate(),req(body))).code,503);
 for(const [k,v] of [['NODE_ENV','production'],['ADMIN_GENERATE_LOCAL','false'],['VERCEL','1']]){const old=process.env[k];process.env[k]=v;assert.equal((await call(handler,req(body))).code,503);if(old===undefined)delete process.env[k];else process.env[k]=old;}
}));
test('valid batch response is UI-compatible, server actor fixed, reset denied and domain unconfirmed means no URL',()=>fixture(async()=>{
 let args;const handler=createAdminGenerate({invoke:async a=>{args=a;return result(a.p_request_id);},readPage:async()=>({cards:[],next_cursor:null})});const id=randomUUID();
 const r=await call(handler,req({quantity:1,request_id:id,p_actor:'forged',origin:'https://evil.example'}));assert.equal(r.code,200);assert.equal(r.data.success,true);assert.equal(args.p_actor,'admin:unit-owner');assert.equal(r.data.cards[0].card_url,null);assert.equal(r.data.cards[0].qr_url,null);assert.equal(r.data.production_urls_available,false);assert.equal(r.data.capabilities.reset,false);
 assert.equal((await call(handler,{...req({}),body:{action:'reset'}})).code,405);
 for(const quantity of [null,0,1001,1.5,'1'])assert.equal((await call(handler,req({quantity,request_id:id}))).code,400);
 assert.equal((await call(handler,req({quantity:1,request_id:'bad'}))).code,400);
}));
test('confirmed URL contract preserves exact NFC/QR /r/ URL; reserved domains never become production export URLs',()=>fixture(async()=>{
 for(const domain of ['https://example.com','https://cards.example.test','http://localhost:4193','https://127.0.0.1'])assert.equal(confirmedCardOrigin({ADMIN_GENERATE_DOMAIN_CONFIRMED:'true',CARD_PUBLIC_ORIGIN:domain}),null);
 process.env.ADMIN_GENERATE_DOMAIN_CONFIRMED='true';process.env.CARD_PUBLIC_ORIGIN='https://cards.synthetic-business.id';
 const h=createAdminGenerate({invoke:async a=>result(a.p_request_id),readPage:async()=>({cards:[],next_cursor:null})});const r=await call(h,req({quantity:1,request_id:randomUUID()}));const c=r.data.cards[0];assert.equal(c.card_url,'https://cards.synthetic-business.id/r/'+'A'.repeat(24));assert.equal(c.qr_url,c.nfc_url);assert.equal(c.qr_url,c.card_url);
}));
test('ambiguous commit response never auto retries or silently falls back',()=>fixture(async()=>{
 let n=0;const h=createAdminGenerate({invoke:async()=>{n++;throw Error('secret internal SQL details');},readPage:async()=>({cards:[],next_cursor:null})});const id=randomUUID(),r=await call(h,req({quantity:1,request_id:id}));assert.equal(n,1);assert.equal(r.code,503);assert.equal(r.data.success,false);assert.equal(r.data.request_id,id);assert.equal(JSON.stringify(r.data).includes('internal SQL'),false);
}));
test('existing UI persists UUID through error/refresh and clears it only after confirmed batch',async()=>{
 const source=fs.readFileSync('assets/admin-v2.js','utf8');const fn=source.slice(source.indexOf('async function createCards(event)'),source.indexOf('async function resetCard(event)'));
 const store=new Map(),nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='create-quantity'?'1':'',hidden:false,textContent:'',close(){}});return nodes.get(id);};let attempts=[],fail=true;
 const context={state:{busy:false,capabilities:{create:true,idempotent_create:true},urlsAvailable:false},byId:node,sessionStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},crypto:webcrypto,lockDialog(){},icon(){return '';},number:String,notify(){},loadCards:async()=>true,request:async(a,b)=>{attempts.push(b.request_id);if(fail)throw Error('lost response');return {...result(b.request_id)};}};
 vm.createContext(context);vm.runInContext(fn,context);await context.createCards({preventDefault(){}});assert.ok(store.size===1);const first=attempts[0];
 // Re-evaluate the handler as on refresh while preserving sessionStorage.
 vm.runInContext(fn,context);fail=false;await context.createCards({preventDefault(){}});assert.equal(attempts[1],first);assert.equal(store.size,0);
 assert.match(source,/state\.urlsAvailable===false\|\|!state\.capabilities\.list/);
});
