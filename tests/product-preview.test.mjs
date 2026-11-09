import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProductModel,demoAccounts} from '../scripts/product-model.mjs';
import {createProductPreview} from '../scripts/preview-product.mjs';
const review='https://search.google.com/local/writereview?placeid=ChITestFixtureOnly';
const input=code=>({card_code:code,business_name:'Usaha sintetis',review_url:review});

test('product model: first claim race, retry, cross-account update and atomic reset (synthetic model)',async()=>{
 const model=createProductModel(),code=model.next(),a=demoAccounts.first,b=demoAccounts.second;
 const results=await Promise.all([Promise.resolve().then(()=>model.claim(a,input(code))),Promise.resolve().then(()=>model.claim(b,input(code)))]);
 assert.deepEqual(results.map(r=>r.status),[200,409]);
 assert.equal(model.claim(a,{...input(code),business_name:'Retry must not edit'}).status,200);
 assert.equal(model.rows(a)[0].business_name,'Usaha sintetis');
 assert.equal(model.update(b,input(code)).status,403);
 assert.equal(model.rows(b).length,0);
 assert.equal(model.update(a,{...input(code),business_name:'Usaha baru'}).status,200);
 const before=model.rows(a)[0],body={card_code:code,confirmation:code,acknowledged:true,expected_revision:before.activation_revision,reason:'Permintaan reset fixture lokal untuk pengujian.'};
 for(const invalid of [{confirmation:'wrong'},{acknowledged:false},{expected_revision:99},{reason:'short'}])assert.equal(model.reset({...body,...invalid}).status,400);
 assert.equal(model.reset(body).status,200);assert.equal(model.rows(a).length,0);
 assert.equal(model.update(a,input(code)).status,403);
 assert.equal(model.claim(b,input(code)).status,200);
 assert.equal(model.rows(b)[0].card_code,before.card_code);assert.equal(model.rows(b)[0].created_at,before.created_at);
 assert.equal(model.claim(a,input(code)).status,409);
 assert.equal(model.audit().filter(e=>e.action==='reset').length,1);
});
test('product model: inventory generation, recorded scans and server-side persistence',async()=>{
 const file=join(await mkdtemp(join(tmpdir(),'rr-product-')),'state.json');
 const m=createProductModel({file}),code=m.next();
 assert.equal(m.statistics().visits,0);assert.equal(m.statistics().redirects,0);
 assert.equal(m.rows().every(c=>!c.owner_label&&!c.review_url),true);
 assert.match(m.scan(code).location,/mulai.html/);m.claim(demoAccounts.first,input(code));
 assert.equal(m.scan(code).location,review);m.scan(code,false);
 assert.equal(m.statistics().visits,2);assert.equal(m.statistics().redirects,1);
 assert.equal(m.statistics().google_reviews.available,false);
 const restored=createProductModel({file});assert.equal(restored.rows(demoAccounts.first).length,1);assert.equal(restored.statistics().visits,2);
 const bulk=m.create(1000);assert.equal(bulk.data.cards.length,1000);assert.equal(new Set(m.rows().map(c=>c.card_code)).size,1003);
 assert.equal(m.create(1001).status,400);assert.equal(JSON.parse(await readFile(file)).synthetic,true);
});
test('product HTTP: cookie sessions, unauthenticated redirects, reset authorization and private fixtures',async()=>{
 const server=createProductPreview({file:null});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 let buyerCookie='',adminCookie='';
 const request=async(path,body,cookie='',admin=false)=>{
  const response=await fetch(base+path,{redirect:'manual',method:body?'POST':'GET',headers:{cookie,...(body?{origin:base,'Content-Type':'application/json',[admin?'X-Admin-Request':'X-Buyer-Request']:'1'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {response,data:response.status===302?null:await response.json()};
 };
 try{
  assert.equal((await request('/api/buyer?action=cards')).response.status,401);
  assert.equal((await request('/.env.backup')).response.status,404);
  const scan=await request('/preview-new-card'),code=scan.response.headers.get('location').split('/').pop();
  assert.equal((await request('/r/'+code)).response.status,302);
  const sign=await request('/api/buyer',{action:'demo-signin',account:'first'});buyerCookie=sign.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/buyer?action=session',undefined,buyerCookie)).data.user.id,demoAccounts.first.id);
  assert.equal((await request('/api/buyer',{action:'first-claim',...input(code)},buyerCookie)).response.status,200);
  assert.equal((await request('/r/'+code)).response.headers.get('location'),review);
  assert.equal((await request('/api/v2-admin?action=reset',{card_code:code},buyerCookie,true)).response.status,401);
  const login=await request('/api/v2-admin?action=login',{password:'demo-admin'},'',true);adminCookie=login.response.headers.get('set-cookie').split(';')[0];
  const cards=(await request('/api/v2-admin?action=cards',undefined,adminCookie)).data.cards;
  const card=cards.find(c=>c.card_code===code);assert.equal(card.card_url,base+'/r/'+code);
  const reset=await request('/api/v2-admin?action=reset',{card_code:code,confirmation:code,expected_revision:card.activation_revision,reason:'Permintaan reset kartu sintetis melalui HTTP.',acknowledged:true},adminCookie,true);
  assert.equal(reset.response.status,200);
  assert.equal((await request('/api/buyer',{action:'update',...input(code)},buyerCookie)).response.status,403);
  assert.equal((await request('/api/buyer',{action:'signout'},buyerCookie)).response.status,200);
  assert.equal((await request('/api/buyer?action=session',undefined,buyerCookie)).response.status,401);
  const cross=await fetch(base+'/api/buyer',{method:'POST',headers:{'Content-Type':'application/json','X-Buyer-Request':'1',Origin:'https://unrelated.example'},body:JSON.stringify({action:'demo-signin'})});assert.equal(cross.status,403);
  const convert=await request('/api/convert-review',{maps_url:review});assert.equal(convert.response.status,200);assert.equal(convert.data.review_url,review);
 }finally{await new Promise(r=>server.close(r));}
});
