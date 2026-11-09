import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createPreview } from '../scripts/preview-accounts.mjs';
import {converter} from '../pembeli/maps.mjs';
import * as dashboardData from '../pembeli/dashboard-data.mjs';

const source=await readFile(new URL('../pembeli/account.js',import.meta.url),'utf8');
// Adapter exercises client event/payload flow, not browser layout/native validation.
async function screen(page,search,client,storage){
  const nodes=new Map();
  const decode=s=>s.replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
  class Element{
    constructor(){this.value='';this.hidden=false;this.handlers={};this.elements={};this.textContent='';this.disabled=false;this.isConnected=true;}
    set innerHTML(html){this.html=html;parse(html);}
    get innerHTML(){return this.html||'';}
    addEventListener(event,fn){this.handlers[event]=fn;}
    querySelector(selector){return selector.includes('button')?this.button:this.note;}
    before(){}
    reset(){for(const e of Object.values(this.elements))e.value=e.initial;}
  }
  function parse(html){
    for(const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)){
      const element=new Element();element.value=decode(match[0].match(/\bvalue="([^"]*)"/)?.[1]||'');element.initial=element.value;nodes.set(match[1],element);
    }
    for(const match of html.matchAll(/<form id="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)){
      const form=nodes.get(match[1]);form.button=new Element();form.button.textContent='Submit';form.note=new Element();
      for(const input of match[2].matchAll(/<input\b[^>]*>/g)){
        const name=input[0].match(/\bname="([^"]+)"/)?.[1],id=input[0].match(/\bid="([^"]+)"/)?.[1];
        if(name){const element=id?nodes.get(id):new Element();element.value=decode(input[0].match(/\bvalue="([^"]*)"/)?.[1]||'');element.initial=element.value;form.elements[name]=element;}
      }
    }
  }
  nodes.set('app',new Element());
  const document={body:{dataset:{page}},getElementById:id=>{assert.ok(nodes.has(id),`Missing ${id}`);return nodes.get(id);},createElement:()=>new Element(),querySelector:selector=>selector==='.email-access'?new Element():nodes.get('edit-form').note};
  class FormData{constructor(form){this.form=form;}*[Symbol.iterator](){for(const[k,v]of Object.entries(this.form.elements))yield[k,v.value];}}
  const location={hash:'',pathname:'/pembeli/'+(page==='auth'?'index.html':page==='activate'?'aktivasi.html':'dashboard.html'),search,href:''};
  const context=vm.createContext({document,location,history:{replaceState(){}},FormData,URLSearchParams,fetch:client,dashboardData,editMaps:{converter,resolveMaps:async value=>{const r=await client('/api/convert-review',{method:'POST',headers:{'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify({maps_url:value})});if(!r.ok)throw Error('Conversion failed');return r.json();}},sessionStorage:storage||{getItem(){return null;}}});
  vm.runInContext(source.replace("import('./maps.mjs')","Promise.resolve(editMaps)").replace("import('./dashboard-data.mjs')","Promise.resolve(dashboardData)").replace('  boot();','  globalThis.finished = boot();'),context);
  await context.finished;
  return {get:id=>nodes.get(id),location};
}

test('client flow: register -> activation -> owned dashboard -> edit -> legacy claim',async()=>{
  const server=createPreview();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;let cookie='';
  const client=async(path,options={})=>{
    const r=await fetch(origin+path,{...options,headers:{...options.headers,Origin:origin,Cookie:cookie}});
    if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return r;
  };
  const submit=async(screen,id,values)=>{
    const form=screen.get(id);assert.ok(form);for(const[k,v]of Object.entries(values))form.elements[k].value=v;
    await form.handlers.submit({preventDefault(){},currentTarget:form});return form.note;
  };
  try{
    const auth=await screen('auth','',client);
    assert.match(auth.get('mode-note').innerHTML,/sintetis/);
    auth.get('signup-tab').onclick();
    await submit(auth,'auth-form',{email:'ui@example.test',password:'synthetic-password'});
    assert.equal(auth.location.href,'dashboard.html');
    const activation=await screen('activate','',client);
    assert.ok(activation.get('activate-form'));assert.ok(activation.get('claim-form'));
    assert.match(activation.get('content').innerHTML,/aria-label="Kelompok isian aktivasi"/);
    for(const stage of ['stage-card','stage-business','stage-security']){
      assert.match(activation.get('content').innerHTML,new RegExp(`href="#${stage}"`));
      assert.ok(activation.get(stage));
    }
    assert.match(activation.get('content').innerHTML,/rakyat-review-logo\.png/);
    assert.match(activation.get('content').innerHTML,/href="dashboard.html"/);
    const note=await submit(activation,'activate-form',{card_code:'SYN-NEW',activation_code:'SYNTHETIC-ONLY',business_name:'UI Synthetic',review_url:'https://www.google.com/maps',pin:'synthetic-pin'});
    assert.match(note.textContent,/Kartu aktif/);
    const dashboard=await screen('dashboard','?card=SYN-NEW',client);
    assert.match(dashboard.get('owned-list').innerHTML,/UI Synthetic/);
    assert.match(dashboard.get('content').innerHTML,/Pelacakan belum tersedia/);
    await submit(dashboard,'edit-form',{business_name:'UI Updated',review_url:'https://google.com/maps'});
    assert.match(dashboard.get('owned-list').innerHTML,/UI Updated/);
    assert.match(dashboard.get('edit-form').note.textContent,/berhasil disimpan/);
    const claim=await screen('activate','',client);
    const claimNote=await submit(claim,'claim-form',{'old-card':'SYN-OLD','old-pin':'synthetic-pin'});
    assert.match(claimNote.textContent,/berhasil terhubung/);
    const after=await screen('dashboard','',client);
    assert.match(after.get('owned-list').innerHTML,/Usaha Sintetis Lama/);
    await after.get('logout').onclick();assert.equal(after.location.href,'index.html');
    const signedOut=await screen('dashboard','',client);assert.equal(signedOut.location.href,'index.html?next=dashboard.html');
  }finally{await new Promise(r=>server.close(r));}
});

test('local demo entry preserves activation destination and supports dashboard/detail navigation',async()=>{
  const server=createPreview();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;let cookie='';
  const client=async(path,options={})=>{const r=await fetch(origin+path,{...options,headers:{...options.headers,Origin:origin,Cookie:cookie}});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return r;};
  try{
    const missing=await screen('activate','',client);assert.equal(missing.location.href,'index.html?next=aktivasi.html');
    const login=await screen('auth','?next=aktivasi.html',client);
    await login.get('demo-signin').onclick();assert.equal(login.location.href,'aktivasi.html');
    const activation=await screen('activate','',client);assert.ok(activation.get('activate-form'));assert.equal(activation.location.href,'');
    const dashboard=await screen('dashboard','?card=SYN-DEMO',client);assert.match(dashboard.get('owned-list').innerHTML,/Mathews Theatres/);assert.ok(dashboard.get('edit-form'));
    const unsafe=await screen('auth','?next=https://evil.example',client);await unsafe.get('demo-signin').onclick();assert.equal(unsafe.location.href,'dashboard.html');
    const live=await screen('auth','',async()=>({ok:true,json:async()=>({mode:'supabase'})}));assert.doesNotMatch(live.get('content').innerHTML,/id="demo-signin"/);
    assert.equal((await fetch(origin+'/api/buyer',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example','X-Buyer-Request':'1'},body:JSON.stringify({action:'demo-signin'})})).status,403);
  }finally{await new Promise(r=>server.close(r));}
});

test('synthetic preview refuses production environments',()=>{
  const old=process.env.NODE_ENV;try{process.env.NODE_ENV='production';assert.throws(()=>createPreview(),/hanya diizinkan/);}finally{if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old;}
});

test('dashboard shows previous local drafts separately, filters them, and never grants ownership',async()=>{
  const data=new Map([
    ['rr-review-draft:SYN-DRAFT',JSON.stringify({code:'SYN-DRAFT',name:'Usaha <lokal>',maps:'https://maps.app.goo.gl/local',step:3,time:Date.now()})],
    ['rr-review-draft:SYN-DEMO',JSON.stringify({code:'SYN-DEMO',name:'Duplicate',maps:'https://maps.app.goo.gl/local',step:3,time:Date.now()})],
    ['rr-review-draft:BAD','broken JSON'],
    ['rr-review-draft:EXPIRED',JSON.stringify({code:'EXPIRED',name:'Expired',maps:'https://maps.app.goo.gl/local',time:1})]
  ]);
  const storage={getItem:k=>data.get(k),length:data.size,key:i=>[...data.keys()][i]};
  const client=async(path)=>({ok:true,json:async()=>path.includes('mode')?{mode:'synthetic'}:path.includes('session')?{user:{email:'fixture@example.test'}}:{cards:[{card_code:'SYN-DEMO',business_name:'Owned',active:true,review_url:'https://search.google.com/local/writereview?placeid=ChIUnitTestOnly'}]}});
  const ui=await screen('dashboard','?card=SYN-DRAFT',client,storage);
  assert.match(ui.get('owned-list').innerHTML,/SYN-DEMO/);assert.doesNotMatch(ui.get('owned-list').innerHTML,/SYN-DRAFT/);
  assert.match(ui.get('local-list').innerHTML,/SYN-DRAFT/);assert.match(ui.get('local-list').innerHTML,/Belum diajukan/);assert.match(ui.get('local-list').innerHTML,/Tersimpan di perangkat ini/);
  assert.match(ui.get('local-list').innerHTML,/Usaha &lt;lokal&gt;/);assert.doesNotMatch(ui.get('local-list').innerHTML,/SYN-DEMO|Expired|Kartu Aktif/);
  assert.equal(ui.get('edit-form'),undefined);
  ui.get('search-cards').value='not-found';ui.get('search-cards').oninput();assert.doesNotMatch(ui.get('local-list').innerHTML,/SYN-DRAFT/);
  ui.get('search-cards').value='lokal';ui.get('search-cards').oninput();assert.match(ui.get('local-list').innerHTML,/SYN-DRAFT/);
});
