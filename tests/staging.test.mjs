import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stagingConfig} from '../scripts/staging-config.mjs';
import {createPreview} from '../scripts/preview-accounts.mjs';

const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',SUPABASE_STAGING_CONFIRMED_REF:'abcdefghijklmnopqrst',BUYER_APP_ORIGIN:'http://127.0.0.1:4179',BUYER_LOCAL_HTTP:'1'};
test('staging guard rejects unconfirmed, old, production, secret and nonlocal targets',()=>{
  assert.equal(stagingConfig(env).ref,'abcdefghijklmnopqrst');
  for(const patch of [{SUPABASE_STAGING_CONFIRMED_REF:''},{SUPABASE_URL:'https://svuagnobufhfpgzmsyxx.supabase.co'},{SUPABASE_URL:'https://svuagnobuhfpgzmsyxx.supabase.co'},{NODE_ENV:'production'},{VERCEL:'1'},{SUPABASE_PUBLISHABLE_KEY:'sb_secret_fixture'},{BUYER_APP_ORIGIN:'https://live.example'},{SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co/path'}])assert.throws(()=>stagingConfig({...env,...patch}));
});
test('staging HTTP routes use real handlers without exposing synthetic cards or legacy config (mock upstream)',async()=>{
  const oldEnv={...process.env},oldFetch=globalThis.fetch;let server;
  try{
    Object.assign(process.env,env,{BUYER_INTEGRATION_ENABLED:'true',BUYER_GOOGLE_ENABLED:'true'});
    server=createPreview({live:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const base='http://127.0.0.1:'+server.address().port;
    // No external fetch is needed by these handlers. Real OAuth stays untested.
    const get=p=>oldFetch(base+p);
    assert.deepEqual(await(await get('/api/buyer?action=mode')).json(),{mode:'supabase'});
    assert.equal((await get('/api/buyer?action=cards')).status,401);
    assert.equal((await get('/preview-new-card')).status,404);
    assert.deepEqual(await(await get('/api/buyer-google')).json(),{enabled:true});
    const html=await(await get('/r/abcdefghijklmnopqrstuvwx')).text();
    assert.ok(html.includes(env.SUPABASE_URL));assert.ok(!html.includes('svuagnob'));assert.ok(!html.includes('SYN-DEMO'));
    assert.equal((await oldFetch(base+'/api/buyer',{method:'POST',headers:{Origin:env.BUYER_APP_ORIGIN,'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify({action:'demo-signin'})})).status,401);
    assert.equal((await get('/.env.staging')).status,404);
  }finally{if(server)await new Promise(r=>server.close(r));globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in oldEnv))delete process.env[k];Object.assign(process.env,oldEnv);}
});
test('login has one primary Google entry and collapsed email alternative',async()=>{
  const source=await readFile(new URL('../pembeli/account.js',import.meta.url),'utf8');
  assert.equal(source.split("googleButton.textContent='Lanjutkan dengan Google'").length-1,1);
  assert.match(source,/<details class="email-access">/);assert.match(source,/googleButton.className='btn primary full'/);
});
