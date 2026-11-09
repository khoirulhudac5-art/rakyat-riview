import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/buyer.js';
import { cookies, config } from '../lib/buyer-service.mjs';
import { createPreview } from '../scripts/preview-accounts.mjs';

test('Supabase buyer handler: fail-closed config, verified user token, CSRF, and no token disclosure', async () => {
  const oldEnv={...process.env}, oldFetch=globalThis.fetch;
  const run=async({method='GET',action='session',body={},cookie,headers={}}={})=>{
    const res={code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(s){this.code=s;return this;},json(data){this.data=data;return this;}};
    await handler({method,query:{action},body:{...body,action},headers:{origin:'https://buyer.example','content-type':'application/json','x-buyer-request':'1',...(cookie?{cookie}:{}),...headers}},res);return res;
  };
  try{
    delete process.env.BUYER_INTEGRATION_ENABLED;
    let called=0;globalThis.fetch=async()=>{called++;throw Error('unexpected fetch');};
    assert.equal((await run()).code,503);assert.equal(called,0);
    Object.assign(process.env,{BUYER_INTEGRATION_ENABLED:'true',BUYER_APP_ORIGIN:'https://buyer.example',SUPABASE_URL:'https://project.supabase.co',SUPABASE_PUBLISHABLE_KEY:'synthetic-publishable',SUPABASE_SECRET_KEY:'never-forward-service-key'});
    process.env.SUPABASE_PUBLISHABLE_KEY='sb_secret_synthetic';assert.equal((await run()).code,503);
    process.env.SUPABASE_PUBLISHABLE_KEY='synthetic-publishable';
    const cfg=config(), cookie=cookies({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600},cfg).map(x=>x.split(';')[0]).join('; ');
    assert.equal((await run()).code,401);
    assert.equal((await run({method:'POST',action:'update',cookie,headers:{origin:'https://evil.example'}})).code,403);
    assert.equal((await run({method:'POST',action:'update',cookie,headers:{'sec-fetch-site':'cross-site'}})).code,403);
    assert.equal((await run({cookie:cookie+'; __Host-rr_buyer_a=duplicate'})).code,401);
    const requests=[];
    globalThis.fetch=async(url,options)=>{
      requests.push({url,options});
      assert.equal(options.headers.apikey,'synthetic-publishable');
      assert.notEqual(options.headers.Authorization,'Bearer never-forward-service-key');
      return {ok:true,json:async()=>url.endsWith('/auth/v1/user')?{id:'verified-user',email:'synthetic@example.test'}:url.includes('/token?')?{access_token:'new-access',refresh_token:'new-refresh',expires_in:3600}:url.includes('/signup?')?{id:'pending-user'}:url.endsWith('/buyer_list_cards')?[]:true};
    };
    const session=await run({cookie});assert.equal(session.data.user.id,'verified-user');
    const listing=await run({action:'cards',cookie});assert.deepEqual(listing.data.cards,[]);assert.equal(listing.data.statistics.visits,null);
    assert.equal(requests.at(-1).options.headers.Authorization,'Bearer synthetic-access');
    const update=await run({method:'POST',action:'update',cookie,body:{card_code:'002',business_name:'Synthetic',review_url:'https://www.google.com/maps',user_id:'attacker-selected-id'}});
    assert.equal(update.code,200);assert.deepEqual(JSON.parse(requests.at(-1).options.body),{p_card_code:'002',p_business_name:'Synthetic',p_review_url:'https://www.google.com/maps'});
    const invalid=await run({method:'POST',action:'activate',cookie,body:{card_code:'002',business_name:'Synthetic',review_url:'https://www.google.com/maps',pin:null,activation_code:'synthetic-code'}});assert.equal(invalid.code,400);
    const sign=await run({method:'POST',action:'signin',body:{email:'synthetic@example.test',password:'synthetic-pass'}});assert.equal(sign.code,200);assert.equal(sign.data.signed_in,true);assert.ok(!JSON.stringify(sign.data).includes('new-access'));
    for(const c of sign.headers['Set-Cookie']){assert.match(c,/HttpOnly/);assert.match(c,/SameSite=Strict/);assert.match(c,/Secure/);assert.match(c,/__Host-/);}
    const signup=await run({method:'POST',action:'signup',body:{email:'synthetic@example.test',password:'synthetic-pass'}});assert.equal(signup.data.signed_in,false);assert.match(signup.data.message,/verifikasi/);
    assert.equal((await run({method:'POST',action:'refresh',cookie})).code,200);
    globalThis.fetch=async()=>({ok:false,status:401,json:async()=>({message:'private upstream error'})});
    const revoked=await run({cookie});assert.equal(revoked.code,401);assert.ok(!JSON.stringify(revoked.data).includes('private upstream'));
    assert.equal((await run({method:'POST',action:'signout',cookie})).headers['Set-Cookie'].length,2);
  }finally{globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in oldEnv))delete process.env[k];Object.assign(process.env,oldEnv);}
});

test('local synthetic integration: two accounts, activation, legacy claim, ownership, edit, logout', async () => {
  const server=createPreview();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const call=async(action,body,cookie)=>{
    const r=await fetch(origin+'/api/buyer'+(body?'':'?action='+action),{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json','X-Buyer-Request':'1',...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify({...body,action})}:{})});
    return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  };
  try{
    for(const path of ['/pembeli/','/pembeli/dashboard.html','/pembeli/aktivasi.html','/pembeli/account.js','/pembeli/account.css','/assets/buyer.css'])assert.equal((await fetch(origin+path)).status,200);
    assert.equal((await fetch(origin+'/.env')).status,404);assert.equal((await fetch(origin+'/api/activate-card',{method:'POST'})).status,405);
    assert.equal((await call('session')).status,401);
    const a=(await call('signup',{email:'a@example.test',password:'synthetic-password'})).cookie;
    const b=(await call('signup',{email:'b@example.test',password:'synthetic-password'})).cookie;
    assert.ok(a&&b&&a!==b);
    assert.deepEqual((await call('cards',undefined,a)).data.cards,[]);
    const fields={card_code:'SYN-NEW',business_name:'Synthetic A',review_url:'https://www.google.com/maps',activation_code:'SYNTHETIC-ONLY',pin:'synthetic-new-pin'};
    assert.equal((await call('activate',fields,a)).status,200);
    assert.equal((await call('activate',fields,b)).status,400);
    assert.equal((await call('cards',undefined,a)).data.cards.length,1);
    assert.equal((await call('cards',undefined,b)).data.cards.length,0);
    assert.equal((await call('update',{...fields,business_name:'Hijacked'},b)).status,400);
    assert.equal((await call('update',{...fields,business_name:'Updated A'},a)).status,200);
    assert.equal((await call('cards',undefined,a)).data.cards[0].business_name,'Updated A');
    assert.equal((await call('claim',{card_code:'SYN-NEW',pin:'synthetic-new-pin'},b)).status,400);
    assert.equal((await call('claim',{card_code:'SYN-OLD',pin:null},b)).status,400);
    assert.equal((await call('claim',{card_code:'SYN-OLD',pin:'synthetic-pin'},b)).status,200);
    assert.equal((await call('cards',undefined,b)).data.cards[0].review_url,'https://www.google.com/maps');
    assert.equal((await call('cards',undefined,b)).data.statistics.visits,null);
    assert.equal((await call('signout',{},a)).status,200);
    assert.equal((await call('session',undefined,a)).status,401);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
