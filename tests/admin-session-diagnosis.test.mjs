// Focused reproductions only. No live secrets, HTTP, SQL or artifact modification.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {randomBytes} from 'node:crypto';
import {createProductionAdmin} from '../lib/admin-production.mjs';
import {config as buyerConfig} from '../lib/buyer-service.mjs';
const base={NODE_ENV:'production',VERCEL:'1',ADMIN_V2_READONLY_PRODUCTION:'true',ADMIN_V2_ORIGIN:'https://rakyat-riview.vercel.app',ADMIN_V2_READ_CONTRACT_READY:'true',SUPABASE_URL:'https://svuagnobufhfpgzmsyxx.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_'+randomBytes(32).toString('hex'),ADMIN_PASSWORD:randomBytes(32).toString('hex'),ADMIN_V2_SESSION_SECRET:randomBytes(40).toString('hex')};
const root=path.resolve('.backups/admin-production-release-2026-11-07T15-01-06-201Z/release/.vercel/output'),fn=path.join(root,'functions/api/admin-v2-readonly.js.func'),cfg=JSON.parse(fs.readFileSync(path.join(fn,'.vc-config.json'))),mod=await import(pathToFileURL(path.join(fn,cfg.handler)));
const built=typeof mod.default==='function'?mod.default:mod.default.default;
const cases=[
 ['fully configured anonymous',{},401],
 ['production flag absent',{ADMIN_V2_READONLY_PRODUCTION:''},503],
 ['contract disabled',{ADMIN_V2_READ_CONTRACT_READY:'false'},503],
 ['configured origin mismatch',{ADMIN_V2_ORIGIN:'https://wrong.example'},503],
 ['trailing slash fixed in source; historical artifact still rejects it',{SUPABASE_URL:base.SUPABASE_URL+'/'},401,503],
 ['server key missing',{SUPABASE_SECRET_KEY:''},503],
 ['publishable key in server slot',{SUPABASE_SECRET_KEY:'sb_publishable_synthetic'},503],
 ['legacy password below V2 minimum',{ADMIN_PASSWORD:'synthetic-short'},503],
 ['session signing secret missing',{ADMIN_V2_SESSION_SECRET:''},503],
 ['session secret rejected prefix',{ADMIN_V2_SESSION_SECRET:'example-'+randomBytes(40).toString('hex')},503],
];
test('patched source and historical sealed artifact preserve guard behavior except the intended URL fix',async t=>{
 const saved={...process.env},nativeFetch=globalThis.fetch,originalError=console.error;let network=0;
 try{console.error=()=>{};globalThis.fetch=async()=>{network++;throw Error('Network is forbidden in this test');};
  for(const [name,change,status,historicalStatus=status] of cases)await t.test(name,async()=>{
   Object.assign(process.env,base,change);
   for(const [index,handler] of [createProductionAdmin(),built].entries()){
    const r={code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(v){this.code=v;return this;},json(v){this.body=v;}};
    const expected=index===0?status:historicalStatus;await handler({method:'GET',headers:{host:'rakyat-riview.vercel.app'},query:{action:'session'}},r);assert.equal(r.code,expected);assert.equal(r.body.data_source,'supabase');assert.equal(r.body.capabilities.create,false);assert.equal(r.body.capabilities.reset,false);
    if(expected===503)assert.equal(r.body.error,'Admin V2 production belum dikonfigurasi. Akses tetap tertutup.');else assert.equal(r.body.error,'Silakan masuk sebagai Admin.');
   }
  });
  Object.assign(process.env,base);
  await t.test('wrong deployment hostname produces 403 after successful configuration',async()=>{for(const handler of [createProductionAdmin(),built]){const r={code:200,setHeader(){},status(v){this.code=v;return this;},json(v){this.body=v;}};await handler({method:'GET',headers:{host:'rakyat-riview-deehk7lj6-rakprem.vercel.app'},query:{action:'session'}},r);assert.equal(r.code,403);}});
  await t.test('existing buyer URL normalization stays unchanged',()=>{Object.assign(process.env,{SUPABASE_URL:base.SUPABASE_URL+'/',BUYER_INTEGRATION_ENABLED:'true',BUYER_APP_ORIGIN:base.ADMIN_V2_ORIGIN,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic'});assert.equal(buyerConfig().url,base.SUPABASE_URL);});
  await t.test('new route resolves to an existing Node 24 function; no middleware output',()=>{const c=JSON.parse(fs.readFileSync(path.join(root,'config.json')));const route=c.routes.find(r=>r.src==='^/api/v2-admin$');assert.equal(route.dest,'/api/admin-v2-readonly.js');assert.equal(cfg.runtime,'nodejs24.x');assert.equal(c.routes.some(r=>r.middlewarePath),false);assert.equal(fs.existsSync(path.join(fn,cfg.handler)),true);});
  await t.test('ADMIN_V2_PASSWORD resolution, policy enforcement and legacy isolation in source',async()=>{
   const handler=createProductionAdmin();
   const run=async()=>{const r={code:200,headers:{},setHeader(){},status(v){this.code=v;return this;},json(v){this.body=v;}};await handler({method:'GET',headers:{host:'rakyat-riview.vercel.app'},query:{action:'session'}},r);return r;};
   Object.assign(process.env,base,{ADMIN_PASSWORD:'synthetic-short',ADMIN_V2_PASSWORD:randomBytes(32).toString('hex')});
   assert.equal((await run()).code,401);
   for(const weak of ['short','demo-admin','password','changeme','test-only-password']){
    Object.assign(process.env,base,{ADMIN_PASSWORD:randomBytes(32).toString('hex'),ADMIN_V2_PASSWORD:weak});
    assert.equal((await run()).code,503);
   }
   delete process.env.ADMIN_V2_PASSWORD;
   Object.assign(process.env,base,{ADMIN_PASSWORD:randomBytes(32).toString('hex')});
   assert.equal((await run()).code,401);
   Object.assign(process.env,base,{ADMIN_PASSWORD:'synthetic-short'});
   assert.equal((await run()).code,503);
   delete process.env.ADMIN_PASSWORD;
   delete process.env.ADMIN_V2_PASSWORD;
   assert.equal((await run()).code,503);
  });
  assert.equal(network,0);
 }finally{console.error=originalError;globalThis.fetch=nativeFetch;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
});
