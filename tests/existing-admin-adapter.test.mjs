import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreview} from '../scripts/preview-accounts.mjs';
test('existing Admin requires explicit local consent and remains blocked in Auth-only mode',async()=>{
 const saved={...process.env};
 Object.assign(process.env,{SUPABASE_URL:'https://svuagnobufhfpgzmsyxx.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',BUYER_EXISTING_CONFIRMED_REF:'svuagnobufhfpgzmsyxx',BUYER_APP_ORIGIN:'http://127.0.0.1:4180',BUYER_LOCAL_HTTP:'1',ADMIN_SESSION_SECRET:'local-fixture-only-32-character-minimum',ADMIN_PASSWORD:'local-only-fixture-password'});
 try{for(const [admin,writes,auth,status] of [['false','false','false',503],['true','false','false',503],['true','true','true',503],['true','true','false',401]]){
  Object.assign(process.env,{BUYER_EXISTING_ADMIN_PREVIEW:admin,BUYER_EXISTING_PREVIEW_WRITES:writes,BUYER_EXISTING_AUTH_ONLY:auth});
  const server=createPreview({live:true,target:'existing'});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  try{assert.equal((await fetch(base+'/api/admin-v2-cards')).status,status);assert.equal((await fetch(base+'/admin.html')).status,status===401?200:503);
   if(status===401){
    const login=await fetch(base+'/api/admin-login',{method:'POST',headers:{'X-Admin-Request':'1','Content-Type':'application/json'},body:JSON.stringify({password:'local-only-fixture-password'})});assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie');assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);
    assert.equal((await fetch(base+'/api/admin-session',{headers:{Cookie:cookie.split(';')[0]}})).status,200);
    const logout=await fetch(base+'/api/admin-logout',{method:'POST',headers:{'X-Admin-Request':'1',Cookie:cookie.split(';')[0]}});assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
   }
  }finally{await new Promise(r=>server.close(r));}
 }}finally{for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
});
