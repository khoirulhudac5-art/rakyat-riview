// Offline release assembly. Exact live V1 commit + approved overlay; never deploys.
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
const commit='d057c6082710a1966ef27e4416f10d6d6caa49e9',project='prj_BdqElWlwjelD7zwY6pPZiABHYX9E',org='team_sbndPkxC8tcwQtlNLm0rN3Yg';
const overlayFolder=path.resolve('.backups/pilot-deployment-review-2026-11-07T08-17-58-302Z'),overlay=JSON.parse(fs.readFileSync(path.join(overlayFolder,'MANIFEST.json')));
const sha=b=>createHash('sha256').update(b).digest('hex');
if(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim()!=='v2-development')throw Error('Wrong working branch');
for(const f of overlay.files)if(sha(fs.readFileSync(f.file))!==f.sha256)throw Error('Overlay source drift: '+f.file);
const folder=path.resolve('.backups/pilot-release-'+new Date().toISOString().replace(/[:.]/g,'-')),root=path.join(folder,'release');fs.mkdirSync(root,{recursive:true});
const put=(file,bytes)=>{const dest=path.join(root,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes);};
const baseNames=execFileSync('git',['ls-tree','-r','--name-only',commit],{encoding:'utf8'}).trim().split('\n');
const baseline=baseNames.map(file=>{if(file.startsWith('.')||file.includes('..'))throw Error('Unexpected baseline path');const b=execFileSync('git',['show',commit+':'+file]);put(file,b);return {file,sha256:sha(b)};});
for(const f of overlay.files)put(f.file,fs.readFileSync(f.file));
const invariant=baseline.filter(f=>f.file!=='vercel.json');for(const f of invariant)if(sha(fs.readFileSync(path.join(root,f.file)))!==f.sha256)throw Error('V1 source modified by overlay: '+f.file);
const routes=JSON.parse(fs.readFileSync(path.join(root,'vercel.json'))),baseRoutes=JSON.parse(execFileSync('git',['show',commit+':vercel.json'],{encoding:'utf8'}));
if(!baseRoutes.rewrites.every(a=>routes.rewrites.some(b=>JSON.stringify(a)===JSON.stringify(b))))throw Error('V1 rewrite changed');
const publicFiles=[...new Set([...baseNames.filter(f=>f!=='vercel.json'&&f!=='README.md'&&!f.startsWith('api/')), ...overlay.files.filter(f=>f.surface==='public-static').map(f=>f.file)])];
put('release-public-files.json',JSON.stringify(publicFiles,null,2));
put('build-release.mjs',`import fs from 'node:fs';import path from 'node:path';
const list=JSON.parse(fs.readFileSync('release-public-files.json'));fs.mkdirSync('public',{recursive:true});
for(const file of list){if(file.includes('..')||file.startsWith('.')||file.startsWith('api/')||file.startsWith('lib/'))throw Error('Unsafe public input');const dest=path.join('public',file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(file,dest);}
function walk(dir,prefix=''){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name),prefix+e.name+'/'):[prefix+e.name]);}
if(walk('public').some(f=>!list.includes(f)))throw Error('Unexpected static file');console.log('Verified static allowlist: '+list.length+' files');
`);
put('package.json',JSON.stringify({private:true,type:'module',engines:{node:'24.x'},scripts:{build:'node build-release.mjs'}},null,2));
// Per-release output isolation. Does not update the remote project's settings.
const builders=[{src:'package.json',use:'@vercel/static-build@27.0.0',config:{distDir:'public'}},{src:'api/*.js',use:'@vercel/node@30.0.0'}];
const apiNames=fs.readdirSync(path.join(root,'api')).filter(f=>f.endsWith('.js')).map(f=>f.slice(0,-3)).sort();
const rewrites=[...apiNames.map(n=>({source:'/api/'+n,destination:'/api/'+n+'.js'})),...routes.rewrites.map(r=>r.destination.startsWith('/api/pilot-redirect?')?{...r,destination:r.destination.replace('/api/pilot-redirect?','/api/pilot-redirect.js?')}:r)];
// Exact official builder versions shipped with CLI 65.12.1. Explicit specs use
// its npm installer, avoiding the native vlt installer's Windows symlink requirement.
put('vercel.json',JSON.stringify({...routes,rewrites,builds:builders},null,2));
const settings={framework:null,nodeVersion:'24.x',buildCommand:'node build-release.mjs',outputDirectory:'public',installCommand:null,rootDirectory:null};
put('.vercel/project.json',JSON.stringify({projectId:project,orgId:org,projectName:'rakyat-riview',settings},null,2));
const publicSource=fs.readFileSync('r/001/index.html','utf8'),key=publicSource.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0];if(!publicSource.includes('svuagnobufhfpgzmsyxx')||!key)throw Error('Matching publishable key required');
const planned={BUYER_PILOT_ENABLED:'true',BUYER_INTEGRATION_ENABLED:'true',BUYER_GOOGLE_ENABLED:'true',BUYER_APP_ORIGIN:'https://rakyat-riview.vercel.app',SUPABASE_PUBLISHABLE_KEY:key,BUYER_RESTRICTED_APP:'false',BUYER_FIRST_CLAIM_ENABLED:'false',BUYER_LOCAL_HTTP:'0',PILOT_SYNTHETIC_LOCAL:'false'};
// LOCAL build file only; no real secrets or production env pull. Runtime changes await approval.
put('.vercel/.env.production.local',Object.entries(planned).map(([k,v])=>k+'='+v).join('\n')+'\n');
fs.writeFileSync(path.join(folder,'PLANNED-DEPLOYMENT-ENV.json'),JSON.stringify(planned,null,2));
const manifest={status:'ASSEMBLED_NOT_DEPLOYED',sourceCommit:commit,sourceBranch:'main',workingBranch:'v2-development',rollback:'dpl_HdXJh3cMvqMq9Q6bsibyjWyD8Xxb',projectId:project,orgId:org,production:'https://rakyat-riview.vercel.app',databaseState:'closed',databaseFingerprint:'59f0d0d9a4fee9a96481e0630c7b74a7',unchangedV1:invariant,overlayFiles:overlay.files,publicFiles,apiCount:baseNames.filter(f=>f.startsWith('api/')).length+4,plannedEnvironmentNames:Object.keys(planned),secretsCopied:false,existingProductionVariablesToPreserve:['ADMIN_PASSWORD','SUPABASE_SECRET_KEY','SUPABASE_URL'],perReleaseConfig:{builders,outputDirectory:'public',nodeVersion:settings.nodeVersion},remoteChangesMade:false};
fs.writeFileSync(path.join(folder,'MANIFEST.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({folder,root,status:manifest.status,v1FilesPreserved:invariant.length,publicFiles:publicFiles.length,functions:manifest.apiCount,manifestSHA256:sha(fs.readFileSync(path.join(folder,'MANIFEST.json')))}));
