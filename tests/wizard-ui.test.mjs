import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../pembeli/mulai.html',import.meta.url),'utf8');

test('wizard client: two inputs, conversion, summary, demo login, pending ownership and draft restore',async()=>{
  const keys=['document','location','history','sessionStorage','fetch'],previous=Object.fromEntries(keys.map(k=>[k,globalThis[k]]));
  const saved=new Map(),calls=[];let signedIn=false;
  const review='https://search.google.com/local/writereview?placeid=ChITestFixtureOnly'; // Mock only.
  function dom(){const nodes=new Map();for(const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g))nodes.set(match[1],{value:'',textContent:'',hidden:/\bhidden\b/.test(match[0]),disabled:false,dataset:{},handlers:{},addEventListener(n,f){this.handlers[n]=f;},removeAttribute(n){delete this[n];},setAttribute(n,v){this[n]=v;},focus(){}});return{getElementById:id=>{assert.ok(nodes.has(id),id);return nodes.get(id);}};}
  const get=id=>globalThis.document.getElementById(id);
  try{
    globalThis.document=dom();globalThis.location={search:'?card=SYN-DRAFT',pathname:'/pembeli/mulai.html',origin:'http://127.0.0.1:4178'};globalThis.history={replaceState(){}};
    globalThis.sessionStorage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)};
    globalThis.fetch=async(path,options={})=>{calls.push({path,options});let data;
      if(path.includes('action=mode'))data={mode:'synthetic'};
      else if(path.includes('buyer-status'))data={code:'SYN-DRAFT',activation_state:'inactive',claim_allowed:false};
      else if(path==='/api/convert-review')data={review_url:review};
      else if(path.includes('action=session'))return{ok:signedIn,status:signedIn?200:401,json:async()=>({user:{email:'fixture@example.test'}})};
      else if(path==='/api/buyer'&&JSON.parse(options.body).action==='demo-signin'){signedIn=true;data={success:true};}
      else throw Error('Unexpected operation '+path);
      return{ok:true,json:async()=>data};
    };
    await import('../pembeli/wizard.mjs?initial-ui-test');assert.equal(get('draft-form').hidden,false);assert.match(get('card-label').textContent,/SYN-DRAFT/);assert.equal(get('step-1').dataset.state,'done');assert.equal(get('step-2').dataset.state,'active');assert.equal(get('step-3').dataset.state,'upcoming');
    get('business').value='Synthetic store';get('business').handlers.input();get('maps').value='https://maps.app.goo.gl/test-fixture';get('maps').handlers.input();assert.equal(get('continue').disabled,true);
    await new Promise(r=>setTimeout(r,720));assert.equal(get('continue').disabled,false);assert.equal(get('try-link').href,review);
    await get('draft-form').onsubmit({preventDefault(){}});assert.equal(get('summary').hidden,false);assert.equal(get('sum-name').textContent,'Synthetic store');assert.equal(get('step-2').dataset.state,'done');assert.equal(get('step-3').dataset.state,'active');assert.equal(get('summary-try-link').href,review);assert.ok(!get('sum-link').textContent.includes('https:'));
    await get('demo').onclick();assert.match(get('identity').textContent,/fixture@example.test/);assert.equal(get('step-3').dataset.state,'done');assert.equal(get('dashboard-link').hidden,false);
    assert.ok(calls.every(c=>!c.options.body||!['activate','claim','verify'].includes(JSON.parse(c.options.body).action)));
    assert.match(html,/Menunggu konfirmasi klaim/);
    globalThis.document=dom();await import('../pembeli/wizard.mjs?restored-ui-test');assert.equal(get('business').value,'Synthetic store');assert.equal(get('maps').value,'https://maps.app.goo.gl/test-fixture');
    await new Promise(r=>setTimeout(r,720));assert.equal(get('continue').disabled,false);
    assert.ok([...saved.values()].every(v=>!v.includes('access_token')&&!v.includes('password')));
  }finally{for(const key of keys){if(previous[key]===undefined)delete globalThis[key];else globalThis[key]=previous[key];}}
});
