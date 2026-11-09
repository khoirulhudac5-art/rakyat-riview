// Offline overlay on the sealed, reader-ready pilot artifact. Never deploys.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
const sha=b=>createHash('sha256').update(b).digest('hex');
if(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim()!=='v2-development')throw Error('Wrong branch');
const base=path.resolve('.backups/pilot-release-2026-11-07T12-02-44-312Z'),seal=fs.readFileSync(path.join(base,'ARTIFACT-MANIFEST.json'));
if(sha(seal)!=='5c891b2b7222cb09cabd3835e400fdd52e29db87862fc682ff6458aa7c300e34')throw Error('Pilot artifact seal drift');
const previous=JSON.parse(seal);for(const f of previous.files)if(sha(fs.readFileSync(path.join(base,'release/.vercel/output',f.file)))!==f.sha256)throw Error('Baseline artifact changed');
const folder=path.resolve('.backups/admin-production-release-'+new Date().toISOString().replace(/[:.]/g,'-')),root=path.join(folder,'release');fs.mkdirSync(root,{recursive:true});
const put=(file,b)=>{const dest=path.join(root,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,b);};
const copyTree=(source,prefix='')=>{for(const e of fs.readdirSync(source,{withFileTypes:true})){if(e.isSymbolicLink())throw Error('Unexpected symlink');const rel=prefix+e.name;if(rel==='public'||rel.startsWith('.vercel/'))continue;if(e.isDirectory())copyTree(path.join(source,e.name),rel+'/');else put(rel,fs.readFileSync(path.join(source,e.name)));}};
copyTree(path.join(base,'release'));put('.vercel/project.json',fs.readFileSync(path.join(base,'release/.vercel/project.json')));put('.vercel/.env.production.local',fs.readFileSync(path.join(base,'release/.vercel/.env.production.local')));
const added=['admin-v2.html','assets/admin-v2.js','assets/admin-v2.css'];for(const f of added)put(f,fs.readFileSync(f));
// Isolate transitive local auth modules so no new V1 API entrypoint is published.
const backend=['lib/admin-production.mjs','lib/admin-readonly.mjs','lib/admin-session.mjs','api/admin-login.js','api/admin-logout.js'];
for(const f of backend)put('internal-admin/'+f,fs.readFileSync(f));
put('api/admin-v2-readonly.js',"export {default} from '../internal-admin/lib/admin-production.mjs';\n");
const publicFiles=[...JSON.parse(fs.readFileSync(path.join(root,'release-public-files.json'))),...added];put('release-public-files.json',JSON.stringify(publicFiles,null,2));
const config=JSON.parse(fs.readFileSync(path.join(root,'vercel.json')));
config.rewrites.unshift({source:'/api/v2-admin',destination:'/api/admin-v2-readonly.js'});
config.headers=[...(config.headers||[]),{source:'/admin-v2.html',headers:[{key:'X-Robots-Tag',value:'noindex, nofollow'},{key:'X-Content-Type-Options',value:'nosniff'},{key:'Cache-Control',value:'no-store'},{key:'Content-Security-Policy',value:"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'"}]}];put('vercel.json',JSON.stringify(config,null,2));
const manifest={status:'ASSEMBLED_NOT_DEPLOYED',folder,projectId:previous.projectId,orgId:previous.orgId,baseline:base,baselineArtifactSeal:sha(seal),rollback:'dpl_6bSToPRzkLAtApYtqXTMn4jkXwiy',publicFiles,addedStatic:added,backendSources:backend.map(file=>({file,sha256:sha(fs.readFileSync(file))})),expectedFunctions:11,protectedOutput:previous.files.filter(f=>f.file!=='config.json'),databaseChanges:false,runtime:{preserveExisting:['ADMIN_PASSWORD','SUPABASE_URL','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','all existing buyer/pilot deployment-scoped variables'],additionalNames:['ADMIN_V2_READONLY_PRODUCTION','ADMIN_V2_ORIGIN','ADMIN_V2_READ_CONTRACT_READY','ADMIN_V2_SESSION_SECRET'],additionalPublicValues:{ADMIN_V2_READONLY_PRODUCTION:'true',ADMIN_V2_ORIGIN:'https://rakyat-riview.vercel.app',ADMIN_V2_READ_CONTRACT_READY:'true'},privateSessionSecretSource:'.env.admin-readonly:ADMIN_SESSION_SECRET (private runtime only; never copied into artifact)'}};
fs.writeFileSync(path.join(folder,'MANIFEST.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({status:manifest.status,folder,functions:11,publicFiles:publicFiles.length,productionChanged:false}));
