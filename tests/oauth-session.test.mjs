import test from 'node:test';
import assert from 'node:assert/strict';
import buyer from '../api/buyer.js';
import {googleLogin,safeReturn} from '../pembeli/drafts.mjs';

test('local preparation preserves expected account and explicitly chooses Google account without changing normal OAuth (mock API)',async()=>{
 const keys=['location','sessionStorage','fetch'],old=Object.fromEntries(keys.map(k=>[k,globalThis[k]]));
 try{
  const origin='http://127.0.0.1:4180',data=new Map();let target;
  globalThis.location={origin,protocol:'http:',hostname:'127.0.0.1',pathname:'/pembeli/claim-test.html',assign:v=>target=v};
  globalThis.sessionStorage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};
  globalThis.fetch=async()=>({ok:true,json:async()=>({state:'s'.repeat(43),url:'https://fixture.supabase.co/auth/v1/authorize?provider=google'})});
  assert.equal(safeReturn('/pembeli/claim-test.html?account=B&other=ignored',origin),'/pembeli/claim-test.html?account=B');
  assert.equal(safeReturn('/pembeli/claim-test.html?account=third',origin),'/pembeli/claim-test.html');
  assert.equal(safeReturn('/pembeli/claim-test.html?account=B','https://buyer.example'),'/pembeli/dashboard.html');
  assert.equal(safeReturn('/dashboard.html',origin),'/dashboard.html');
  assert.equal(safeReturn('/kartu.html?id=ABC_123&next=ignored',origin),'/kartu.html?id=ABC_123');
  assert.equal(safeReturn('https://outside.example/dashboard.html',origin),'/pembeli/dashboard.html');
  assert.equal(safeReturn('/kartu.html?id=../other',origin),'/pembeli/dashboard.html');
  await googleLogin('/pembeli/claim-test.html?account=B',{selectAccount:true});assert.equal(new URL(target).searchParams.get('prompt'),'select_account');assert.equal(data.get('rr-oauth-return'),'/pembeli/claim-test.html?account=B');
  location.pathname='/pembeli/mulai.html';await googleLogin('/pembeli/dashboard.html',{selectAccount:true});assert.equal(new URL(target).searchParams.has('prompt'),false);
 }finally{for(const k of keys)if(old[k]===undefined)delete globalThis[k];else globalThis[k]=old[k];}
});

test('logout revokes refresh-backed session when access cookie has expired (mock Supabase)',async()=>{
  const env={...process.env},fetchBefore=globalThis.fetch;
  try{
    Object.assign(process.env,{BUYER_INTEGRATION_ENABLED:'true',BUYER_APP_ORIGIN:'https://buyer.example',SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_PUBLISHABLE_KEY:'fixture-public'});
    const calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>url.includes('grant_type=refresh_token')?{access_token:'renewed-access'}:{}};};
    const res={code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.data=v;return this;}};
    await buyer({method:'POST',body:{action:'signout'},headers:{origin:'https://buyer.example','content-type':'application/json','x-buyer-request':'1',cookie:'__Host-rr_buyer_r=fixture-refresh'}},res);
    assert.equal(res.code,200);assert.equal(calls.length,2);assert.ok(calls[0].url.includes('grant_type=refresh_token'));assert.ok(calls[1].url.includes('/logout?scope=local'));assert.equal(calls[1].options.headers.Authorization,'Bearer renewed-access');
    assert.ok(res.headers['Set-Cookie'].every(c=>c.includes('Max-Age=0')));assert.deepEqual(res.data,{success:true});
  }finally{globalThis.fetch=fetchBefore;for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);}
});

test('OAuth callback removes query, binds tab state, restores wizard and clears pending state (mock API)',async()=>{
  const keys=['location','history','sessionStorage','fetch','document'],old=Object.fromEntries(keys.map(k=>[k,globalThis[k]]));
  try{
    const data=new Map([['rr-oauth-state','s'.repeat(43)],['rr-oauth-return','/pembeli/mulai.html?card=fixture']]);let target,cleaned=false;
    globalThis.location={search:'?code=fixture-code',hash:'',pathname:'/pembeli/oauth.html',origin:'https://buyer.example',replace:v=>target=v};
    globalThis.history={replaceState(){cleaned=true;}};
    globalThis.sessionStorage={getItem:k=>data.get(k),removeItem:k=>data.delete(k),setItem:(k,v)=>data.set(k,v)};
    globalThis.document={getElementById:()=>({textContent:''})};
    globalThis.fetch=async(url,options)=>{assert.ok(cleaned);assert.equal(url,'/api/buyer-google');assert.deepEqual(JSON.parse(options.body),{action:'callback',code:'fixture-code',state:'s'.repeat(43)});return{ok:true,json:async()=>({success:true})};};
    await import('../pembeli/oauth.mjs?callback-test');assert.equal(target,'/pembeli/mulai.html?card=fixture');assert.equal(data.has('rr-oauth-state'),false);assert.equal(data.has('rr-oauth-return'),false);assert.equal(JSON.parse(data.get('rr-oauth-callback-check')).path,target);
  }finally{for(const k of keys)if(old[k]===undefined)delete globalThis[k];else globalThis[k]=old[k];}
});

test('OAuth provider error fragment is cleared and never exchanged (mock browser)',async()=>{
  const keys=['location','history','sessionStorage','fetch','document'],old=Object.fromEntries(keys.map(k=>[k,globalThis[k]]));
  try{
    let cleared=false;const note={textContent:''};globalThis.location={search:'',hash:'#error=access_denied',pathname:'/pembeli/oauth.html'};globalThis.history={replaceState(){cleared=true;}};globalThis.document={getElementById:()=>note};globalThis.fetch=()=>{throw Error('must not exchange');};
    await import('../pembeli/oauth.mjs?error-test');assert.ok(cleared);assert.match(note.textContent,/dibatalkan/);
  }finally{for(const k of keys)if(old[k]===undefined)delete globalThis[k];else globalThis[k]=old[k];}
});
