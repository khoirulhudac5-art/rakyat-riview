// Read-only log collection for the failed deployment. No env run or mutation command.
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
import {sanitizeAdminGuardLog} from './admin-postflight-diagnostics.mjs';
const cli=path.resolve('.local-tools/npm-cache/_npx/69f9afb961c37556/node_modules/vercel/dist/vc.js');
const options={deployment:'dpl_QFSdJ9Mg9cXw6rJFR111cgWujBGW',since:'2026-11-07T16:04:00Z',until:'2026-11-07T16:10:00Z'};
for(let i=2;i<process.argv.length;i+=2){const name=process.argv[i]?.slice(2);if(!['deployment','since','until'].includes(name)||!process.argv[i+1])throw Error('Only read-only deployment/time filters are supported');options[name]=process.argv[i+1];}
if(!/^dpl_[A-Za-z0-9]+$/.test(options.deployment)||![options.since,options.until].every(x=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(x)&&Number.isFinite(Date.parse(x)))||Date.parse(options.since)>=Date.parse(options.until))throw Error('Invalid log scope');
const deployment=options.deployment,project='prj_BdqElWlwjelD7zwY6pPZiABHYX9E';
const folder=path.resolve('.backups/admin-session-diagnosis-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(folder);
async function readLogs(source){
 const args=[cli,'logs',source,'--deployment',deployment,'--project',project,'--scope','rakprem','--since',options.since,'--until',options.until,'--limit','100','--json'];
 return new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(Error('Read-only log timeout'));},60000);child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',()=>{clearTimeout(timer);reject(Error('CLI read failed'));});child.on('close',code=>{clearTimeout(timer);
 const parsed=[];for(const line of stdout.split(/\r?\n/)){try{parsed.push(JSON.parse(line));}catch{}}
 if(!parsed.length){try{parsed.push(JSON.parse(stdout));}catch{}}
 const category=s=>['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','ERR_REQUIRE_ESM','FUNCTION_INVOCATION_FAILED','FUNCTION_INVOCATION_TIMEOUT','SyntaxError','TypeError','ReferenceError','Admin V2 production belum dikonfigurasi'].filter(tag=>s.includes(tag));
 function projectRecord(x){const message=typeof x.message==='string'?x.message:typeof x.text==='string'?x.text:'';const fields={};for(const key of ['type','timestamp','time','level','source','deploymentId','requestId','httpStatus','statusCode','requestMethod','requestHostname','route','requestPath','code','runtime'])if(['string','number','boolean'].includes(typeof x[key]))fields[key]=/path|route/i.test(key)?String(x[key]).split('?')[0]:x[key];fields.errorCategories=category(message);const guard=sanitizeAdminGuardLog(message);if(guard)fields.guardDiagnostic=guard;if(x.records)fields.records=x.records.map(projectRecord);if(x.logs)fields.logs=x.logs.map(projectRecord);if(x.data&&typeof x.data==='object')fields.data=Array.isArray(x.data)?x.data.map(projectRecord):projectRecord(x.data);return fields;}
 resolve({source,exitCode:code,records:parsed.map(projectRecord),accessDenied:/forbidden|403|not authorized|permission denied/i.test(stderr),rawLogsSaved:false});});});
}
const results=[];for(const source of ['requests','runtime'])results.push(await readLogs(source));const report={deployment,project,readOnly:true,results};fs.writeFileSync(path.join(folder,'LOG-EVIDENCE.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({folder,...report}));
