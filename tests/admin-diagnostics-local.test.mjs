import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {adminConfigurationChecks,normalizeAdminSupabaseUrl,createProductionAdmin} from '../lib/admin-production.mjs';
import {supabaseAdminReadPage} from '../lib/admin-readonly.mjs';
import {sanitizeAdminPostflight,recordAdminSessionPostflight,runAdminSessionPostflight,sanitizeAdminGuardLog} from '../scripts/admin-postflight-diagnostics.mjs';
import {verifyAdminArtifact} from '../scripts/deploy-admin-production.mjs';
const target='https://svuagnobufhfpgzmsyxx.supabase.co',secret=()=>randomBytes(40).toString('hex');
test('Supabase normalization accepts only exact target with optional root slash',()=>{
 for(const value of [target,target+'/'])assert.equal(normalizeAdminSupabaseUrl(value),target);
 for(const value of [undefined,'',target+'//',target+'/a',target+'/a/..',target+'?x=1',target+'#x',target+'?',target+'#',target.replace('https:','http:'),target.replace('svuagnobufhfpgzmsyxx','another'),target+'.evil.test',target.replace('https://','https://user:pass@'),' '+target,target+' ',target+'\\',target+':444'])assert.equal(normalizeAdminSupabaseUrl(value),null);
});
test('guard emits only safe server-side booleans; response stays generic; valid anonymous stays 401',async()=>{
 const saved={...process.env},originalError=console.error,originalFetch=globalThis.fetch,logs=[];let calls=0;
 const cfg={ADMIN_V2_READONLY_PRODUCTION:'true',ADMIN_V2_ORIGIN:'https://rakyat-riview.vercel.app',ADMIN_V2_READ_CONTRACT_READY:'true',SUPABASE_URL:target+'/',SUPABASE_SECRET_KEY:'sb_secret_'+secret(),ADMIN_PASSWORD:secret(),ADMIN_V2_SESSION_SECRET:secret()};
 try{
  Object.assign(process.env,cfg);console.error=line=>logs.push(JSON.parse(line));globalThis.fetch=async()=>{calls++;throw Error('No network');};
  const invoke=async()=>{const r={code:200,setHeader(){},status(n){this.code=n;return this;},json(data){this.data=data;}};await createProductionAdmin()({method:'GET',headers:{host:'rakyat-riview.vercel.app'},query:{action:'session'}},r);return r;};
  assert.equal((await invoke()).code,401);assert.equal(logs.length,0);
  for(const [key,value,failed] of [['ADMIN_V2_READONLY_PRODUCTION','false','production_enabled'],['ADMIN_V2_SESSION_SECRET','','signing_secret_present'],['ADMIN_PASSWORD','synthetic-short','admin_password_policy'],['SUPABASE_URL',target+'/invalid','supabase_target_valid']]){
   process.env[key]=value;const r=await invoke();assert.equal(r.code,503);assert.equal(r.data.error,'Admin V2 production belum dikonfigurasi. Akses tetap tertutup.');assert.equal(r.data.checks,undefined);assert.equal(r.data.category,undefined);
   const entry=logs.at(-1);assert.equal(entry.event,'admin_v2_configuration_guard_failed');assert.equal(entry.category,'ADMIN_CONFIG_UNAVAILABLE');assert.equal(entry.checks[failed],false);assert.ok(Object.values(entry.checks).every(v=>typeof v==='boolean'));process.env[key]=cfg[key];
  }
  for(const value of [cfg.ADMIN_PASSWORD,cfg.ADMIN_V2_SESSION_SECRET,cfg.SUPABASE_SECRET_KEY,'synthetic-short',target])assert.equal(JSON.stringify(logs).includes(value),false);
  assert.equal(calls,0);assert.equal((await invoke()).code,401);
  assert.equal(adminConfigurationChecks({...cfg,ADMIN_PASSWORD:'synthetic-short'}).admin_password_policy,false);
 }finally{console.error=originalError;globalThis.fetch=originalFetch;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
});
const response=(status,body,headers={})=>({status,body,headers:new Headers({'content-type':'application/json','x-vercel-id':'sin1::iad1::request-123',...headers})});
test('known sanitized body, status and category persist BEFORE failure and survive rollback status changes',()=>{
 const attempt={},saved=[];const save=()=>saved.push(structuredClone(attempt));
 assert.throws(()=>recordAdminSessionPostflight(attempt,response(503,JSON.stringify({error:'Admin V2 production belum dikonfigurasi. Akses tetap tertutup.',password:secret(),token:secret()})),save),/ADMIN_CONFIG_UNAVAILABLE/);
 assert.equal(saved.length,1);assert.equal(saved[0].adminSessionPostflight.status,503);assert.equal(saved[0].adminSessionPostflight.category,'ADMIN_CONFIG_UNAVAILABLE');assert.deepEqual(saved[0].adminSessionPostflight.body,{error:'Admin V2 production belum dikonfigurasi. Akses tetap tertutup.'});assert.equal(saved[0].adminSessionPostflight.requestId,'sin1::iad1::request-123');
 attempt.status='READER_READY_ROLLBACK_VERIFIED';save();assert.deepEqual(saved[1].adminSessionPostflight,saved[0].adminSessionPostflight);
});
test('unrecognized JSON/text, HTML, oversized bodies, cookies and locations cannot leak credentials',()=>{
 const sensitive=secret();for(const body of [JSON.stringify({error:sensitive,secret:sensitive,owner_id:sensitive,review_url:sensitive}),'<html>'+sensitive+'</html>',sensitive.repeat(1000),JSON.stringify({mode:sensitive,data_source:sensitive,capabilities:{create:sensitive}})]){
  const d=sanitizeAdminPostflight(response(503,body,{'set-cookie':sensitive,'location':'https://vercel.com/sso-api?token='+sensitive}));assert.equal(JSON.stringify(d).includes(sensitive),false);assert.equal(d.cookie,undefined);assert.equal(d.location,undefined);
 }
 const d=sanitizeAdminPostflight(response(302,'',{'location':'https://vercel.com/sso-api?token='+sensitive}));assert.equal(d.category,'DEPLOYMENT_PROTECTION_REDIRECT');assert.equal(JSON.stringify(d).includes(sensitive),false);
});
test('configuration-valid 401 is still the only successful anonymous status',()=>{
 const attempt={};let saves=0;recordAdminSessionPostflight(attempt,response(401,JSON.stringify({error:'Silakan masuk sebagai Admin.',mode:'admin_readonly',data_source:'supabase',read_only:true,capabilities:{create:false,reset:false}})),()=>saves++);assert.equal(saves,1);assert.equal(attempt.adminSessionPostflight.category,'ADMIN_SESSION_REQUIRED');
 for(const status of [200,403,404,500,503])assert.throws(()=>recordAdminSessionPostflight({},response(status,'{}'),()=>{}));
});
test('transport and body-read failures persist a safe category without raw exception content',async()=>{
 const attempt={},sensitive=secret();let saved;
 await assert.rejects(runAdminSessionPostflight(attempt,async()=>{throw Error(sensitive);},()=>saved=structuredClone(attempt)),/HTTP_TRANSPORT_ERROR/);
 assert.equal(saved.adminSessionPostflight.status,null);assert.equal(saved.adminSessionPostflight.category,'HTTP_TRANSPORT_ERROR');assert.equal(JSON.stringify(saved).includes(sensitive),false);
});
test('old sealed artifact cannot be deployed after backend source has changed',()=>{
 assert.throws(()=>verifyAdminArtifact({releaseFolder:'.backups/admin-production-release-2026-11-07T15-01-06-201Z',artifactSeal:'24211d568e56461c5329d83d5dddc275c7f5d1830407899b0279f2108c609873'}),/Backend source changed; rebuild and review a new artifact/);
});
test('runtime guard parser retains the named booleans but no extra values or secret text',()=>{
 const sensitive=secret(),checks=adminConfigurationChecks({});const input={event:'admin_v2_configuration_guard_failed',category:'ADMIN_CONFIG_UNAVAILABLE',checks:{...checks,password:sensitive},token:sensitive};
 const result=sanitizeAdminGuardLog(JSON.stringify(input));assert.deepEqual(result,{event:input.event,category:input.category,checks});assert.equal(JSON.stringify(result).includes(sensitive),false);
 for(const message of [sensitive,'{}',JSON.stringify({...input,event:'other'}),JSON.stringify({...input,checks:{...checks,signing_secret_policy:sensitive}}),sensitive.repeat(1000)])assert.equal(sanitizeAdminGuardLog(message),null);
});
test('newly sealed diagnostic artifact passes offline deployment gates',()=>assert.equal(verifyAdminArtifact(),true));
test('trailing slash also succeeds through the unchanged read transport (mocked upstream)',async()=>{
 const saved={...process.env},native=globalThis.fetch;let count=0;
 try{Object.assign(process.env,{SUPABASE_URL:target+'/',SUPABASE_SECRET_KEY:'sb_secret_'+secret(),ADMIN_V2_READ_CONTRACT_READY:'true'});globalThis.fetch=async(url,options)=>{count++;assert.equal(new URL(url).pathname,'/rest/v1/rpc/admin_read_v2_inventory');assert.equal(options.method,'GET');return new Response(JSON.stringify({cards:[],next_cursor:null}));};assert.deepEqual(await supabaseAdminReadPage('cards',null),{cards:[],next_cursor:null});assert.equal(count,1);
 }finally{globalThis.fetch=native;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
});
test('deployed V1 password behavior remains distinct; V2 minimum is not relaxed',async()=>{
 const saved={...process.env};try{
  process.env.ADMIN_PASSWORD='synthetic-short';const legacy=await import(pathToFileURL(process.cwd()+'/.backups/pilot-release-2026-11-07T12-02-44-312Z/release/api/admin-login.js'));
  const r={code:200,setHeader(){},status(v){this.code=v;return this;},json(v){this.body=v;}};await legacy.default({method:'POST',body:{password:'synthetic-short'}},r);assert.equal(r.code,200);assert.equal(adminConfigurationChecks({ADMIN_PASSWORD:'synthetic-short'}).admin_password_policy,false);
 }finally{for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
});
