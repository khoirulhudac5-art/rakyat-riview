import test from 'node:test';
import assert from 'node:assert/strict';
import {existingConfig} from '../scripts/existing-config.mjs';
import {createPreview} from '../scripts/preview-accounts.mjs';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const env={SUPABASE_URL:'https://svuagnobufhfpgzmsyxx.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',BUYER_EXISTING_CONFIRMED_REF:'svuagnobufhfpgzmsyxx',BUYER_APP_ORIGIN:'http://127.0.0.1:4180',BUYER_LOCAL_HTTP:'1',BUYER_INTEGRATION_ENABLED:'true',BUYER_EXISTING_PREVIEW_WRITES:'false'};
test('existing-project runner rejects wrong project, nonlocal context and secret keys',()=>{
  assert.equal(existingConfig(env).url,env.SUPABASE_URL);
  for(const patch of [{SUPABASE_URL:'https://anotherproject.supabase.co'},{BUYER_EXISTING_CONFIRMED_REF:''},{SUPABASE_PUBLISHABLE_KEY:'sb_secret_fixture'},{BUYER_APP_ORIGIN:'https://live.example'},{VERCEL:'1'},{NODE_ENV:'production'}])assert.throws(()=>existingConfig({...env,...patch}));
});
test('existing preparation blocks auth/claim/edit POSTs before any external request',async()=>{
  const old={...process.env},fetchBefore=globalThis.fetch;let server;
  try{
    Object.assign(process.env,env);server=createPreview({live:true,target:'existing'});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
    globalThis.fetch=()=>{throw Error('External requests forbidden in preparation test');};
    for(const [path,action]of [['/api/buyer','first-claim'],['/api/buyer','update'],['/api/buyer','signin'],['/api/buyer','demo-signin'],['/api/buyer-google','start']]){
      const r=await fetchBefore(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:env.BUYER_APP_ORIGIN,'X-Buyer-Request':'1'},body:JSON.stringify({action})});assert.equal(r.status,503);
    }
    assert.equal((await fetchBefore(base+'/preview-new-card')).status,404);assert.equal((await fetchBefore(base+'/.env.existing')).status,404);
    assert.equal((await(await fetchBefore(base+'/api/buyer?action=mode')).json()).mode,'supabase');
  }finally{globalThis.fetch=fetchBefore;if(server)await new Promise(r=>server.close(r));for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);}
});
test('scan recognizes hidden unclaimed V2 by targeted status, refuses mismatched/active/error results',async()=>{
  const html=await readFile(new URL('../r/001/index.html',import.meta.url),'utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1],code='abcdefghijklmnopqrstuvwx';
  for(const state of [{code,activation_state:'inactive',claim_allowed:true},{code:'other',activation_state:'inactive',claim_allowed:true},{code,activation_state:'active',claim_allowed:false},null]){
    let destination=null,calls=0;const note={textContent:''};
    const context=vm.createContext({URL,window:{location:{pathname:'/r/'+code,replace:v=>destination=v}},document:{getElementById:()=>note},fetch:async(url,options)=>{calls++;if(calls===1)return{ok:true,json:async()=>[]};assert.ok(url.endsWith('/rpc/buyer_public_card_status'));assert.equal(JSON.parse(options.body).p_card_code,code);return{ok:Boolean(state),json:async()=>state};}});
    vm.runInContext(script.replace('    bukaUlasan();','    globalThis.done = bukaUlasan();'),context);await context.done;
    assert.equal(destination,state?.code===code&&state.claim_allowed?'/pembeli/mulai.html?card='+code:null);assert.equal(calls,2);
  }
});
