// New built-artifact checks only. No remote requests, database connections or deployment.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
import {secretMatches} from './prepare-pilot-deployment-review.mjs';
const folder=path.resolve(process.argv[2]||''),root=path.join(folder,'release'),out=path.join(root,'.vercel/output');
if(path.dirname(folder)!==path.resolve('.backups')||!path.basename(folder).startsWith('pilot-release-'))throw Error('Expected isolated release');
const m=JSON.parse(fs.readFileSync(path.join(folder,'MANIFEST.json'))),checks=[];
const sha=b=>createHash('sha256').update(b).digest('hex'),check=(name,pass)=>{checks.push({name,pass:!!pass});if(!pass)throw Error(name);};
function walk(dir,prefix=''){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const f=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Unexpected output symlink');return e.isDirectory()?walk(f,prefix+e.name+'/'):[prefix+e.name];});}
try{
 for(const f of m.unchangedV1)check('V1 source unchanged '+f.file,sha(fs.readFileSync(path.join(root,f.file)))===f.sha256);
 const staticFiles=walk(path.join(out,'static'));check('exact static allowlist',JSON.stringify([...staticFiles].sort())===JSON.stringify([...m.publicFiles].sort()));
 for(const f of m.publicFiles)check('static matches source '+f,sha(fs.readFileSync(path.join(out,'static',f)))===sha(fs.readFileSync(path.join(root,f))));
 check('no backend secrets in static output',secretMatches(staticFiles.map(f=>path.join(out,'static',f))).length===0);
 const functions=fs.readdirSync(path.join(out,'functions/api')).filter(f=>f.endsWith('.func')).sort();check('exactly ten expected API functions',functions.length===10&&functions.every(f=>fs.existsSync(path.join(root,'api',f.replace(/\.func$/,'')))));
 for(const f of functions){const c=JSON.parse(fs.readFileSync(path.join(out,'functions/api',f,'.vc-config.json')));check('Node 24 runtime '+f,c.runtime==='nodejs24.x');}
 const config=JSON.parse(fs.readFileSync(path.join(out,'config.json'))),exists=p=>staticFiles.includes(p.slice(1))||functions.includes(p.slice('/api/'.length)+'.func');
 function route(url){for(const r of config.routes){if(r.handle==='filesystem'){if(exists(url))return url;continue;}if(!r.src)continue;const hit=url.match(new RegExp(r.src));if(hit){const dest=(r.dest||'').replace(/\$(\d+)/g,(_,i)=>hit[Number(i)]||'');if(!r.check||exists(dest.split('?')[0]))return dest;}}return null;}
 for(const f of functions){const name=f.replace(/\.js\.func$/,'');check('extensionless API resolves '+name,route('/api/'+name)==='/api/'+name+'.js');}
 for(const suffix of ['','/'])check('exact pilot route '+suffix,route('/r/iKRb7_7PyK6kg4Ye7EqvOhYu'+suffix)==='/api/pilot-redirect.js?code=iKRb7_7PyK6kg4Ye7EqvOhYu');
 for(const code of ['LEGACY-UNCHANGED','OTHER-V2-CARD'])check('nonpilot keeps V1 route '+code,route('/r/'+code)?.startsWith('/r/001/index.html?'));
 const envBefore={...process.env},originalFetch=globalThis.fetch;let networkCalls=0;
 Object.assign(process.env,{NODE_ENV:'production',VERCEL:'1',BUYER_PILOT_ENABLED:'true',BUYER_INTEGRATION_ENABLED:'true',BUYER_GOOGLE_ENABLED:'true',BUYER_APP_ORIGIN:'https://rakyat-riview.vercel.app',SUPABASE_URL:'https://svuagnobufhfpgzmsyxx.supabase.co',SUPABASE_PUBLISHABLE_KEY:'fixture-not-a-real-key',BUYER_RESTRICTED_APP:'false',BUYER_LOCAL_HTTP:'0',PILOT_SYNTHETIC_LOCAL:'false'});
 const response=()=>({headers:{},code:200,setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;return this;},end(){return this;}});
 try{
  globalThis.fetch=async()=>{networkCalls++;return new Response(JSON.stringify({code:'42501'}),{status:403});};
  const load=async name=>{const c=JSON.parse(fs.readFileSync(path.join(out,'functions/api',name+'.js.func/.vc-config.json')));const mod=await import(pathToFileURL(path.join(out,'functions/api',name+'.js.func',c.handler)));return typeof mod.default==='function'?mod.default:mod.default?.default;};
  const buyer=await load('buyer'),r=response();await buyer({method:'GET',query:{action:'mode'},headers:{}},r);check('built buyer profile boots without demo or owner edit',r.code===200&&r.body.mode==='pilot'&&!r.body.fixture&&r.body.capabilities.update===false&&networkCalls===0);
  const resolver=await load('pilot-redirect'),denied=response();await resolver({method:'GET',query:{code:'iKRb7_7PyK6kg4Ye7EqvOhYu'},headers:{}},denied);check('built resolver denies closed RPC without redirect',[401,503].includes(denied.code)&&!denied.headers.Location&&networkCalls===1);
 }finally{globalThis.fetch=originalFetch;for(const k of Object.keys(process.env))if(!(k in envBefore))delete process.env[k];Object.assign(process.env,envBefore);}
 const files=walk(out).map(file=>{const b=fs.readFileSync(path.join(out,file));return {file,bytes:b.length,sha256:sha(b)};});
 fs.writeFileSync(path.join(folder,'ARTIFACT-MANIFEST.json'),JSON.stringify({sourceCommit:m.sourceCommit,rollback:m.rollback,projectId:m.projectId,orgId:m.orgId,files},null,2));
 const report={status:'LOCAL_RELEASE_BUILD_VERIFIED_NOT_DEPLOYED',checks,hostNode:process.version,configuredFunctionRuntime:'nodejs24.x',liveGoogleTested:false,productionAccessed:false,closedRPCResponse:'local stub, not live DB',sourceManifestSHA256:sha(fs.readFileSync(path.join(folder,'MANIFEST.json'))),artifactManifestSHA256:sha(fs.readFileSync(path.join(folder,'ARTIFACT-MANIFEST.json'))),staticFiles:27,functions:10};
 fs.writeFileSync(path.join(folder,'VERIFICATION.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:checks.length,artifactManifestSHA256:report.artifactManifestSHA256,folder}));
}catch(e){fs.writeFileSync(path.join(folder,'VERIFICATION-FAILED.json'),JSON.stringify({status:'ARTIFACT_VERIFICATION_FAILED',reason:e.message,checks},null,2));console.log(JSON.stringify({status:'ARTIFACT_VERIFICATION_FAILED',reason:e.message,folder}));process.exitCode=1;}
