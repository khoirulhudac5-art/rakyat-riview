// New deployment-envelope checks only: no database, OAuth login or old A/B rerun.
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {clientFiles,serverFiles,secretMatches} from '../scripts/prepare-pilot-deployment-review.mjs';
import {config,cookies} from '../lib/buyer-service.mjs';
import buyer from '../api/buyer.js';import pilotRedirect from '../api/pilot-redirect.js';
const card='iKRb7_7PyK6kg4Ye7EqvOhYu',origin='https://rakyat-riview.vercel.app';
function response(){return {code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(d){this.body=d;return this;},end(){return this;}};}
test('deployment overlay has no local tooling, extra Admin APIs, SQL, or secret values in public files',()=>{
 assert.deepEqual(secretMatches(clientFiles),[]);assert.equal(clientFiles.length,21);assert.equal(serverFiles.filter(f=>f.startsWith('api/')).length,4);
 assert.ok(![...clientFiles,...serverFiles].some(f=>/^scripts\/|^supabase\/|^\.env|claim-test|auth-check|test-wizard/.test(f)));assert.ok(!serverFiles.includes('api/convert-review.js'));assert.ok(!serverFiles.some(f=>/api\/admin|api\/v2-admin/.test(f)));
});
test('pilot rewrite scope is exact and every other card keeps the existing V1 destination',()=>{
 const routes=JSON.parse(fs.readFileSync('vercel.json')).rewrites;
 assert.equal(routes.length,4);for(const [i,suffix] of ['', '/'].entries()){assert.equal(routes[i].source,'/r/'+card+suffix);assert.equal(routes[i].destination,'/api/pilot-redirect?code='+card);}
 for(const code of ['LEGACY-CARD','OTHER-V2-CARD',card+'X','other']){assert.ok(!routes.slice(0,2).some(r=>r.source==='/r/'+code));assert.equal(routes[2].destination,'/r/001/index.html');}
});
test('public files do not import backend modules; development diagnostic import is localhost-and-mode guarded',()=>{
 for(const f of clientFiles.filter(f=>/\.(js|mjs|html)$/.test(f))){const s=fs.readFileSync(f,'utf8');assert.doesNotMatch(s,/(?:from\s*|import\s*\()\s*['"][^'"]*(?:\/lib\/|\/api\/)/);}
 const wizard=fs.readFileSync('pembeli/wizard.mjs','utf8');assert.match(wizard,/mode\.auth_wizard_test===true&&\['127\.0\.0\.1','localhost'\]/);assert.ok(!clientFiles.includes('pembeli/auth-wizard-test.mjs'));
});
test('HTTPS production profile stays pilot-only and permission denial never falls back to original RPCs',async()=>{
 const old={...process.env},fetchBefore=globalThis.fetch,calls=[];
 Object.assign(process.env,{NODE_ENV:'production',VERCEL:'1',BUYER_PILOT_ENABLED:'true',BUYER_INTEGRATION_ENABLED:'true',BUYER_RESTRICTED_APP:'false',BUYER_FIRST_CLAIM_ENABLED:'false',BUYER_LOCAL_HTTP:'0',BUYER_APP_ORIGIN:origin,SUPABASE_URL:'https://svuagnobufhfpgzmsyxx.supabase.co',SUPABASE_PUBLISHABLE_KEY:'fixture-key-not-real',PILOT_SYNTHETIC_LOCAL:'false'});
 try{
  globalThis.fetch=async(url)=>{calls.push(new URL(url).pathname);if(new URL(url).pathname==='/auth/v1/user')return new Response(JSON.stringify({id:'f1111111-1111-4111-8111-111111111111',identities:[{provider:'google'}]}));return new Response(JSON.stringify({code:'42501',message:'permission denied'}),{status:403});};
  const mode=response();await buyer({method:'GET',query:{action:'mode'},headers:{}},mode);assert.equal(mode.body.mode,'pilot');assert.equal(mode.body.fixture,undefined);assert.equal(mode.body.capabilities.update,false);
  const r=response();await buyer({method:'GET',query:{action:'cards'},headers:{cookie:'__Host-rr_buyer_a=fixture-token'}},r);assert.equal(r.code,401);assert.ok(!r.body.cards);assert.deepEqual(calls,['/auth/v1/user','/rest/v1/rpc/buyer_pilot_list_cards']);
  assert.match(r.headers['Cache-Control'],/no-store/);assert.doesNotMatch(JSON.stringify(r.body),/fixture-token|permission denied|42501/);
  const c=cookies({access_token:'fixture-token',refresh_token:'fixture-refresh',expires_in:3600},config());assert.ok(c.every(v=>v.startsWith('__Host-')&&v.includes('Secure')&&v.includes('HttpOnly')&&v.includes('Path=/')));
  process.env.BUYER_PILOT_ENABLED='false';const disabled=response();await pilotRedirect({method:'GET',query:{code:card}},disabled);assert.equal(disabled.code,503);assert.equal(calls.length,2);
 }finally{globalThis.fetch=fetchBefore;for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);}
});
