import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {saveDraft} from '../pembeli/drafts.mjs';
const html=await readFile(new URL('../pembeli/mulai.html',import.meta.url),'utf8');
test('wizard session UI: logout, re-login, failed checks and stale responses preserve draft without claiming (mock HTTP)',async()=>{
 const keys=['document','location','history','sessionStorage','fetch'],old=Object.fromEntries(keys.map(k=>[k,globalThis[k]]));
 const nodes=new Map(),storage=new Map(),calls=[];let signedIn=true,holdNext=false,release,fail=false;
 const code='AUTH-WIZARD-LOCAL',review='https://search.google.com/local/writereview?placeid=ChITestFixtureOnly';
 for(const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g))nodes.set(match[1],{value:'',textContent:'',hidden:/\bhidden\b/.test(match[0]),disabled:false,dataset:{},handlers:{},addEventListener(n,f){this.handlers[n]=f;},removeAttribute(n){delete this[n];},setAttribute(n,v){this[n]=v;},focus(){}});
 const el=id=>nodes.get(id),response=(status,data)=>({ok:status===200,status,json:async()=>data});
 const user={id:'synthetic-unit-user',email:'unit@example.test',google:true};
 try{
  globalThis.document={getElementById:el};globalThis.location={search:'?card='+code,pathname:'/pembeli/mulai.html',origin:'http://127.0.0.1:4180'};globalThis.history={replaceState(){}};
  globalThis.sessionStorage={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  saveDraft(sessionStorage,code,{name:'Synthetic preserved business',maps:review,step:3});
  globalThis.fetch=async(url,options={})=>{
   const action=options.body?JSON.parse(options.body).action:null;calls.push({url,action});
   if(url.includes('action=mode'))return response(200,{mode:'supabase',auth_wizard_test:true});
   if(url.includes('buyer-status'))return response(200,{code,activation_state:'inactive',claim_allowed:false});
   if(url==='/api/convert-review')return response(200,{review_url:review});
   if(url==='/api/buyer-google')return response(200,{enabled:true});
   if(action==='signout'){signedIn=false;return response(200,{success:true});}
   if(action==='refresh')return response(signedIn?200:401,{success:signedIn});
   if(url.includes('action=session')){if(holdNext){holdNext=false;return new Promise(r=>release=()=>r(response(200,{user})));}return fail?response(503,{}):response(signedIn?200:401,{user});}
   throw Error('Unexpected operation');
  };
  await import('../pembeli/wizard.mjs?logout-regression');await new Promise(r=>setTimeout(r,750));
  assert.equal(el('step-3').dataset.state,'done');assert.match(el('google-status').textContent,/Akun terhubung/);
  const draft=()=>{const {time,...value}=JSON.parse(sessionStorage.getItem('rr-review-draft:'+code));return value;};const saved=draft();
  await el('auth-wizard-logout').onclick();
  function signedOut(){assert.equal(el('step-3').dataset.state,'active');assert.equal(el('step-state-3').textContent,'Saat ini');assert.equal(el('step-3')['aria-current'],'step');assert.doesNotMatch(el('identity').textContent,/Terhubung sebagai/);assert.doesNotMatch(el('google-status').textContent,/Akun terhubung/);assert.equal(el('google').hidden,false);assert.equal(el('google').disabled,false);assert.equal(el('dashboard-link').hidden,true);assert.equal(el('claim-card').hidden,true);assert.equal(el('auth-wizard-logout').hidden,true);assert.deepEqual(draft(),saved);}
  signedOut();assert.match(el('google-status').textContent,/Belum terhubung/);
  signedIn=true;await el('auth-wizard-refresh').onclick();assert.equal(el('step-3').dataset.state,'done');assert.match(el('google-status').textContent,/Akun terhubung/);
  holdNext=true;const pending=el('auth-wizard-refresh').onclick();for(let i=0;i<20&&!release;i++)await new Promise(r=>setTimeout(r,1));assert.ok(release);
  await el('auth-wizard-logout').onclick();release();await pending;signedOut();
  signedIn=true;await el('auth-wizard-refresh').onclick();fail=true;await el('auth-wizard-refresh').onclick();signedOut();assert.match(el('google-status').textContent,/belum terkonfirmasi/);
  assert.equal(calls.filter(c=>['first-claim','claim','activate','update'].includes(c.action)).length,0);
  assert.equal(el('business').value,'Synthetic preserved business');assert.equal(el('maps').value,review);
 }finally{for(const k of keys)if(old[k]===undefined)delete globalThis[k];else globalThis[k]=old[k];}
});
