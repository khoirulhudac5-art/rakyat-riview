import test from 'node:test';
import assert from 'node:assert/strict';
import {mapsInput,directReview,converter} from '../pembeli/maps.mjs';
import {saveDraft,loadDraft,safeReturn} from '../pembeli/drafts.mjs';
import convert from '../api/convert-review.js';
import google from '../api/buyer-google.js';
import {createPreview} from '../scripts/preview-accounts.mjs';
import {createHash} from 'node:crypto';
const review='https://search.google.com/local/writereview?placeid=ChITestFixtureOnly'; // Mock-only identifier; never a resolver result in the preview.
const response=()=>({code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(s){this.code=s;return this;},json(data){this.data=data;return this;}});

test('Google URL contract rejects SSRF inputs, credentials, open redirect paths and malformed review URLs',()=>{
  for(const s of ['http://google.com/maps','https://127.0.0.1/maps','https://google.evil.com/maps','https://google.com.evil.test/maps','https://google.com/url?q=https://evil.example','https://user:pw@maps.app.goo.gl/x','https://google.com:8443/maps','https://goo.gl/arbitrary','file:///etc/passwd'])assert.equal(mapsInput(s),false,s);
  for(const s of ['https://maps.app.goo.gl/example','https://www.google.com/maps/place/example','https://maps.google.com/?q=example','https://goo.gl/maps/example',review])assert.equal(mapsInput(s),true,s);
  assert.equal(directReview(review+'&next=https://evil.example'),review);
  assert.equal(directReview(review+'&placeid=ChIOtherFixture'),null);
  assert.equal(directReview('https://google.com/url?q='+encodeURIComponent(review)),null);
});

test('auto-convert debounces, invalidates stale success/failure and handles resolver errors',async()=>{
  let scheduled;const pending=[],updates=[];
  const controller=converter({schedule:fn=>{scheduled=fn;return 1;},cancel(){},resolve:(value,signal)=>new Promise((resolve,reject)=>pending.push({value,signal,resolve,reject})),update:r=>updates.push(r)});
  controller.input('https://maps.app.goo.gl/first');const first=scheduled();
  controller.input('https://maps.app.goo.gl/second');const second=scheduled();
  assert.equal(pending[0].signal.aborted,true);
  pending[1].resolve({review_url:review});await second;assert.equal(updates.at(-1).state,'ready');
  pending[0].resolve({review_url:review.replace('FixtureOnly','OldFixture')});await first;assert.equal(updates.at(-1).url,review);
  controller.input('https://maps.app.goo.gl/fail');const failed=scheduled();pending[2].reject(Error('Resolver timeout'));await failed;assert.equal(updates.at(-1).state,'error');assert.equal(updates.at(-1).url,null);
  controller.input('https://evil.example');assert.equal(updates.at(-1).state,'error');controller.dispose();
});

test('converter server short-circuits direct links, validates provider output and handles outages',async()=>{
  const previous=globalThis.fetch;let calls=0;
  try{
    globalThis.fetch=async()=>{calls++;throw Error('no network');};
    let r=response();await convert({method:'POST',body:{maps_url:review}},r);assert.equal(r.code,200);assert.equal(calls,0);
    r=response();await convert({method:'POST',body:{maps_url:'https://google.evil.com/maps'}},r);assert.equal(r.code,400);assert.equal(calls,0);
    for(const [ok,status,data,expected]of [[true,200,{review_url:review},200],[true,200,{review_url:'https://evil.example'},502],[false,429,{},429]]){
      globalThis.fetch=async(url,opts)=>{assert.equal(url,'https://productmate.com/api/v1/google-review-link');assert.equal(opts.redirect,'error');return{ok,status,json:async()=>data};};r=response();await convert({method:'POST',body:{maps_url:'https://maps.app.goo.gl/fixture'}},r);assert.equal(r.code,expected);
    }
    globalThis.fetch=async()=>{throw Error('timeout');};r=response();await convert({method:'POST',body:{maps_url:'https://maps.app.goo.gl/fixture'}},r);assert.equal(r.code,502);
  }finally{globalThis.fetch=previous;}
});

test('draft survives OAuth return without credentials and rejects foreign return URLs',()=>{
  const values=new Map(),storage={setItem:(k,v)=>values.set(k,v),getItem:k=>values.get(k)};
  saveDraft(storage,'002',{name:'Synthetic store',maps:'https://maps.app.goo.gl/fixture'});
  assert.equal(loadDraft(storage,'002').name,'Synthetic store');assert.equal(loadDraft(storage,'003'),null);
  const d=JSON.parse(values.get('rr-review-draft:002'));d.time=1;values.set('rr-review-draft:002',JSON.stringify(d));assert.equal(loadDraft(storage,'002'),null);
  assert.equal(safeReturn('https://evil.example','https://review.example'),'/pembeli/dashboard.html');
  assert.equal(safeReturn('/pembeli/mulai.html?card=002','https://review.example'),'/pembeli/mulai.html?card=002');
  assert.equal(safeReturn('/pembeli/aktivasi.html?next=https://evil.example','https://review.example'),'/pembeli/aktivasi.html');
});

test('Google PKCE setup: explicit enable flag, CSRF, state, cookie and code exchange',async()=>{
  const env={...process.env},previous=globalThis.fetch;
  try{
    Object.assign(process.env,{BUYER_INTEGRATION_ENABLED:'true',SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_PUBLISHABLE_KEY:'fixture-public',BUYER_APP_ORIGIN:'https://review.example'});
    delete process.env.BUYER_GOOGLE_ENABLED;
    const req={method:'POST',headers:{origin:'https://review.example','content-type':'application/json','x-buyer-request':'1'},body:{action:'start'}};
    let r=response();await google(req,r);assert.equal(r.code,503);
    process.env.BUYER_GOOGLE_ENABLED='true';r=response();await google(req,r);assert.equal(r.code,200);
    const start=new URL(r.data.url),parts=r.headers['Set-Cookie'],jar=parts.map(s=>s.split(';')[0]).join('; '),verifier=parts[0].split(';')[0].split('=')[1];
    assert.equal(start.searchParams.get('code_challenge'),createHash('sha256').update(verifier).digest('base64url'));assert.ok(parts.every(s=>s.includes('HttpOnly')&&s.includes('Secure')));
    assert.equal(start.searchParams.get('redirect_to'),'https://review.example/pembeli/oauth.html');
    const state=r.data.state;assert.match(state,/^[A-Za-z0-9_-]{43}$/);let called=0;
    globalThis.fetch=async(url,options)=>{called++;assert.ok(url.includes('grant_type=pkce'));assert.equal(JSON.parse(options.body).code_verifier,verifier);return{ok:true,json:async()=>({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600})};};
    r=response();await google({...req,headers:{...req.headers,cookie:jar},body:{action:'callback',state:'bad',code:'fixture'}},r);assert.equal(r.code,400);assert.equal(called,0);
    r=response();await google({...req,headers:{...req.headers,cookie:jar},body:{action:'callback',state,code:'fixture'}},r);assert.equal(r.code,200);assert.equal(called,1);assert.deepEqual(r.data,{success:true});
    globalThis.fetch=async()=>({ok:false,status:400,json:async()=>({})});
    r=response();await google({...req,headers:{...req.headers,cookie:jar},body:{action:'callback',state,code:'expired-fixture'}},r);assert.equal(r.code,400);assert.match(r.data.error,/Google kedaluwarsa/);assert.ok(!r.headers['Set-Cookie']);
    r=response();await google({...req,headers:{...req.headers,origin:'https://evil.example'}},r);assert.equal(r.code,403);
  }finally{globalThis.fetch=previous;for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);}
});

test('new scan preview never treats login or frontend draft as ownership proof',async()=>{
  assert.throws(()=>createPreview({live:true,experience:true}));
  const server=createPreview({experience:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  try{
    const scan=await fetch(origin+'/r/SYN-DRAFT',{redirect:'manual'});assert.equal(scan.headers.get('location'),'/pembeli/mulai.html?card=SYN-DRAFT');
    const status=await(await fetch(origin+'/api/buyer-status?card=SYN-DRAFT')).json();assert.equal(status.claim_allowed,false);assert.equal(status.activation_state,'inactive');
    assert.equal((await fetch(origin+'/api/buyer-status?card=unknown')).status,404);
    for(const p of ['/pembeli/mulai.html','/pembeli/wizard.mjs','/pembeli/maps.mjs','/pembeli/oauth.html','/pembeli/experience.mjs'])assert.equal((await fetch(origin+p)).status,200);
    const post=body=>fetch(origin+'/api/buyer',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify(body)});
    const session=await post({action:'demo-signin'}),cookie=session.headers.get('set-cookie').split(';')[0];
    const attempted=await fetch(origin+'/api/buyer',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Buyer-Request':'1',Cookie:cookie},body:JSON.stringify({action:'activate',card_code:'SYN-DRAFT',business_name:'Hijack',review_url:review})});assert.equal(attempted.status,400);
    assert.equal((await(await fetch(origin+'/api/buyer-status?card=SYN-DRAFT')).json()).activation_state,'inactive');
    assert.equal((await fetch(origin+'/api/buyer-google',{method:'POST'})).status,503);
  }finally{await new Promise(r=>server.close(r));}
});
