import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/convert-review.js';
import {mapsInput} from '../pembeli/maps.mjs';
const input='https://maps.app.goo.gl/mock-only';
const review='https://search.google.com/local/writereview?placeid=ChIMockFixtureOnly';
const run=async(value=input)=>{const r={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(data){this.data=data;return this;}};await handler({method:'POST',body:{maps_url:value}},r);return r;};

test('resolver distinguishes local permissions, timeout, DNS, HTTP rejection, configuration and bad output',async()=>{
  const previous=globalThis.fetch;
  try{
    for(const [error,status,code]of [
      [Object.assign(new TypeError('fetch failed'),{cause:{code:'EACCES'}}),503,'RESOLVER_NETWORK_BLOCKED'],
      [Object.assign(new Error('deadline'),{name:'TimeoutError'}),504,'RESOLVER_TIMEOUT'],
      [Object.assign(new TypeError('fetch failed'),{cause:{code:'ENOTFOUND'}}),502,'RESOLVER_NETWORK_ERROR']
    ]){globalThis.fetch=async()=>{throw error;};const r=await run();assert.equal(r.statusCode,status);assert.equal(r.data.code,code);}
    for(const [status,expected,code]of [[401,503,'RESOLVER_ACCESS_DENIED'],[403,503,'RESOLVER_ACCESS_DENIED'],[422,422,'RESOLVER_INPUT_REJECTED'],[500,502,'RESOLVER_UPSTREAM_ERROR'],[429,429,'RESOLVER_RATE_LIMIT']]){
      globalThis.fetch=async()=>({ok:false,status,json:async()=>({error:{code:'upstream_fixture'}})});const r=await run();assert.equal(r.statusCode,expected);assert.equal(r.data.code,code);
    }
    globalThis.fetch=async()=>({ok:true,status:200,json:async()=>{throw Error('HTML instead of JSON');}});assert.equal((await run()).data.code,'RESOLVER_BAD_RESPONSE');
    globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({review_url:review,place_id:'ChIDifferentFixture'})});assert.equal((await run()).data.code,'RESOLVER_INVALID_RESULT');
    globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({review_url:review,place_id:'ChIMockFixtureOnly',verification:'not_verified'})});const success=await run();assert.equal(success.statusCode,200);assert.equal(success.data.review_url,review);assert.equal(success.data.verification,'not_verified');
    globalThis.fetch=async()=>{throw Error('Invalid input must not fetch');};assert.equal((await run('https://maps.app.goo.gl/')).statusCode,400);assert.equal(mapsInput('https://goo.gl/maps/'),false);
    const direct=await run(review);assert.equal(direct.statusCode,200);assert.equal(direct.data.verification,'user_provided');
  }finally{globalThis.fetch=previous;}
});
