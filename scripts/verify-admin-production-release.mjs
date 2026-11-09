// Seal a prebuilt overlay. Never contacts or modifies production.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
import {secretMatches} from './prepare-pilot-deployment-review.mjs';
import {recordAdminSessionPostflight} from './admin-postflight-diagnostics.mjs';
const folder=path.resolve(process.argv[2]||'');if(path.dirname(folder)!==path.resolve('.backups')||!path.basename(folder).startsWith('admin-production-release-'))throw Error('Invalid release folder');
const m=JSON.parse(fs.readFileSync(path.join(folder,'MANIFEST.json'))),root=path.join(folder,'release'),output=path.join(root,'.vercel/output'),baseline=path.join(m.baseline,'release/.vercel/output'),build=path.join(root,'.vercel/build-output');
const sha=b=>createHash('sha256').update(b).digest('hex'),checks=[],check=(name,pass)=>{checks.push({name,pass:!!pass});assert.ok(pass,name);};
function walk(dir,prefix=''){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{if(e.isSymbolicLink())throw Error('Artifact symlink');return e.isDirectory()?walk(path.join(dir,e.name),prefix+e.name+'/'):[prefix+e.name];});}
try{
 for(const s of m.backendSources)check('backend source frozen '+s.file,sha(fs.readFileSync(s.file))===s.sha256);
 if(!fs.existsSync(build)){
  check('new function built',fs.existsSync(path.join(output,'functions/api/admin-v2-readonly.js.func/.vc-config.json')));
  fs.renameSync(output,build);fs.cpSync(baseline,output,{recursive:true});fs.cpSync(path.join(build,'functions/api/admin-v2-readonly.js.func'),path.join(output,'functions/api/admin-v2-readonly.js.func'),{recursive:true});
  for(const f of m.addedStatic)fs.copyFileSync(path.join(root,f),path.join(output,'static',f));
  const config=JSON.parse(fs.readFileSync(path.join(output,'config.json'))),headers=JSON.parse(fs.readFileSync(path.join(root,'vercel.json'))).headers.find(r=>r.source==='/admin-v2.html').headers;
  config.routes.unshift({src:'^/admin-v2\\.html$',headers:Object.fromEntries(headers.map(h=>[h.key,h.value])),continue:true});
  config.routes.splice(config.routes.findIndex(r=>r.handle==='filesystem')+1,0,{src:'^/api/v2-admin$',dest:'/api/admin-v2-readonly.js',check:true});
  fs.writeFileSync(path.join(output,'config.json'),JSON.stringify(config,null,2));
 }
 for(const f of m.protectedOutput)check('existing output identical '+f.file,sha(fs.readFileSync(path.join(output,f.file)))===f.sha256);
 const staticFiles=walk(path.join(output,'static'));check('exact public allowlist',JSON.stringify(staticFiles.sort())===JSON.stringify([...m.publicFiles].sort()));check('public output has no secrets',secretMatches(staticFiles.map(f=>path.join(output,'static',f))).length===0);
 for(const f of m.addedStatic)check('Admin UI unchanged '+f,sha(fs.readFileSync(path.join(output,'static',f)))===sha(fs.readFileSync(f)));
 const oldConfig=JSON.parse(fs.readFileSync(path.join(baseline,'config.json'))),config=JSON.parse(fs.readFileSync(path.join(output,'config.json')));
 check('all existing routes identical and ordered',JSON.stringify(config.routes.filter(r=>r.src!=='^/admin-v2\\.html$'&&r.src!=='^/api/v2-admin$'))===JSON.stringify(oldConfig.routes));
 check('only new Admin routes',config.routes.length===oldConfig.routes.length+2);check('new extensionless endpoint',config.routes.some(r=>r.src==='^/api/v2-admin$'&&r.dest==='/api/admin-v2-readonly.js'));
 check('exactly eleven functions',fs.readdirSync(path.join(output,'functions/api')).filter(f=>f.endsWith('.func')).length===11);
 const fn=path.join(output,'functions/api/admin-v2-readonly.js.func'),cfg=JSON.parse(fs.readFileSync(path.join(fn,'.vc-config.json')));check('new function Node 24 runtime',cfg.runtime==='nodejs24.x');check('no embedded private runtime values',Object.keys(cfg.environment||{}).length===0);
 const saved={...process.env},originalFetch=globalThis.fetch,originalError=console.error,guardLogs=[];let requests=0;
 Object.assign(process.env,{NODE_ENV:'production',VERCEL:'1',ADMIN_V2_READONLY_PRODUCTION:'true',ADMIN_V2_ORIGIN:'https://rakyat-riview.vercel.app',ADMIN_V2_READ_CONTRACT_READY:'true',ADMIN_V2_SESSION_SECRET:'fixture-release-signing-secret-not-real-at-least-32-chars',ADMIN_PASSWORD:'fixture-release-password-not-real',SUPABASE_URL:'https://svuagnobufhfpgzmsyxx.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_fixture_not_real'});
 const res=()=>({headers:{},code:200,setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(data){this.body=data;return this;}});
 try{
  console.error=line=>guardLogs.push(JSON.parse(line));
  globalThis.fetch=async(url,opts)=>{requests++;check('built transport GET fixed read-only RPC',opts.method==='GET'&&/^https:\/\/svuagnobufhfpgzmsyxx\.supabase\.co\/rest\/v1\/rpc\/admin_read_v2_(inventory|audit)/.test(String(url)));return new Response(JSON.stringify(String(url).includes('_audit')?{events:[],next_cursor:null}:{cards:[],next_cursor:null}));};
  const module=await import(pathToFileURL(path.join(fn,cfg.handler))),handler=typeof module.default==='function'?module.default:module.default.default;
  const headers={host:'rakyat-riview.vercel.app',origin:'https://rakyat-riview.vercel.app','x-admin-request':'1','content-type':'application/json'};
  const anon=res();await handler({method:'GET',headers,query:{action:'cards'}},anon);check('built anonymous denied before upstream',anon.code===401&&requests===0);
  const valid={...process.env};
  for(const [name,change,status] of [
   ['valid session configuration',{},401],['trailing slash accepted',{SUPABASE_URL:valid.SUPABASE_URL+'/'},401],
   ['foreign project rejected',{SUPABASE_URL:'https://another.supabase.co'},503],['non-root URL rejected',{SUPABASE_URL:valid.SUPABASE_URL+'/extra'},503],
   ['production flag required',{ADMIN_V2_READONLY_PRODUCTION:'false'},503],['read contract required',{ADMIN_V2_READ_CONTRACT_READY:'false'},503],
   ['origin configuration checked',{ADMIN_V2_ORIGIN:'https://outside.example'},503],['password minimum retained',{ADMIN_PASSWORD:'synthetic-short'},503],
   ['server key required',{SUPABASE_SECRET_KEY:''},503],['signing secret required',{ADMIN_V2_SESSION_SECRET:''},503]
  ]){
   Object.assign(process.env,valid,change);const r=res();await handler({method:'GET',headers,query:{action:'session'}},r);
   check('built session '+name,r.code===status&&requests===0&&r.body.checks===undefined);
   if(status===503){const attempt={};let stored;try{recordAdminSessionPostflight(attempt,{status:r.code,body:JSON.stringify(r.body),headers:new Headers({'content-type':'application/json'})},()=>stored=structuredClone(attempt));}catch{}check('built failure safely captured '+name,stored?.adminSessionPostflight.status===503&&stored.adminSessionPostflight.category==='ADMIN_CONFIG_UNAVAILABLE');}
  }
  Object.assign(process.env,valid);
  check('built diagnostics contain only fixed categories and booleans',guardLogs.length>0&&guardLogs.every(r=>r.event==='admin_v2_configuration_guard_failed'&&r.category==='ADMIN_CONFIG_UNAVAILABLE'&&Object.values(r.checks).every(v=>typeof v==='boolean')));
  check('built diagnostics never contain synthetic private values',![valid.ADMIN_PASSWORD,valid.SUPABASE_SECRET_KEY,valid.ADMIN_V2_SESSION_SECRET].some(s=>JSON.stringify(guardLogs).includes(s)));
  const login=res();await handler({method:'POST',headers,body:{action:'login',password:process.env.ADMIN_PASSWORD}},login);check('built Admin login',login.code===200&&login.headers['Set-Cookie'].startsWith('__Host-rr_admin_v2='));check('built cookie security flags',['HttpOnly','Secure','SameSite=Strict','Path=/','Max-Age=1800'].every(v=>login.headers['Set-Cookie'].includes(v)));
  headers.cookie=login.headers['Set-Cookie'].split(';')[0];
  for(const action of ['cards','audit']){const r=res();await handler({method:'GET',headers,query:{action}},r);check('built authorized '+action,r.code===200&&r.body.data_source==='supabase'&&r.body.read_only&&r.body.capabilities.create===false&&r.body.capabilities.reset===false);}
  const before=requests;for(const action of ['create','reset']){const r=res();await handler({method:'POST',headers,body:{action}},r);check('built '+action+' disabled',r.code===405);}check('no write RPC called',requests===before);
 }finally{console.error=originalError;globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
 const files=walk(output).map(file=>{const bytes=fs.readFileSync(path.join(output,file));return {file,bytes:bytes.length,sha256:sha(bytes)};});
 fs.writeFileSync(path.join(folder,'ARTIFACT-MANIFEST.json'),JSON.stringify({projectId:m.projectId,orgId:m.orgId,rollback:m.rollback,files},null,2));
 const report={status:'ADMIN_PRODUCTION_RELEASE_READY_NOT_DEPLOYED',checks:checks.length,allPass:true,staticFiles:staticFiles.length,functions:11,artifactManifestSHA256:sha(fs.readFileSync(path.join(folder,'ARTIFACT-MANIFEST.json'))),runtime:'nodejs24.x',hostNode:process.version,productionDatabaseAccess:false,productionLoginTested:false,transport:'explicit local stub',rollback:m.rollback};fs.writeFileSync(path.join(folder,'VERIFICATION.json'),JSON.stringify({...report,details:checks},null,2));console.log(JSON.stringify({folder,...report}));
}catch(e){fs.writeFileSync(path.join(folder,'VERIFICATION-FAILED.json'),JSON.stringify({reason:e.message,checks},null,2));console.log(JSON.stringify({status:'FAILED',reason:e.message}));process.exitCode=1;}
