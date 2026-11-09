// Prepare a current-baseline backup runner offline; do not execute it here.
// The metadata/roles/parameter-ACL and pg_dump exporter body is preserved.
import fs from 'node:fs';import path from 'node:path';import {sha} from './admin-readonly-package.mjs';
export function prepareGenerateBackup(){
 const sourceFile='.backups/tooling/admin-readonly-live-backup.mjs',source=fs.readFileSync(sourceFile,'utf8');
 const old="import {preflight,read,tool,packageCheck,dataSQL} from './admin-readonly-live.mjs';";
 if(source.split(old).length!==2)throw Error('Known verified backup driver shape changed');
 const bridge=`import {tool} from './admin-readonly-live.mjs';
import {generatePreflight,verifyGenerateReview as packageCheck,dataSQL} from '../../scripts/admin-generate-preflight.mjs';
import {inspect} from '../../scripts/readonly-psql.mjs';
async function read(queries,env){return inspect({executable:path.resolve('.backups/tooling/pgsql/bin/psql.exe'),env,queries});}
async function preflight(folder){
 const r=await generatePreflight(folder);if(r.status!=='GENERATE_LIVE_PREFLIGHT_PASS')throw Error('Generate backup preflight failed; no migration');
 const snapshot=path.join(folder,'preflight.json');if(!fs.existsSync(snapshot))fs.copyFileSync(r.output,snapshot,fs.constants.COPYFILE_EXCL);
 return r;
}`;
 const result=source.replace(old,bridge).replace("startsWith('admin-readonly-live-')","startsWith('admin-generate-backup-')");
 if(result===source||result.includes("import {preflight,read,tool,packageCheck,dataSQL}"))throw Error('Backup bridge not prepared');
 const file=path.resolve('.backups/tooling/admin-generate-live-backup.mjs');
 fs.writeFileSync(file,result);return {file,sha256:sha(result),exporterSource:sourceFile,exporterSourceSHA256:sha(source),executed:false};
}
const result=prepareGenerateBackup();console.log(JSON.stringify(result));
