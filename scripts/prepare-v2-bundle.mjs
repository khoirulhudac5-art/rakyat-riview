// Generates review artifacts ONLY. Never opens a DB connection or reads env files.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {files,migrationStep,resumeSQL,controlledPauseSQL} from './v2-migration-control.mjs';
const dir=path.resolve('.backups','prepared-v2-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(dir,{recursive:true});
const artifacts=[];
for(let stage=1;stage<=6;stage++)artifacts.push(['step-'+stage+'.sql',migrationStep(stage)]);
artifacts.push(['pause.sql',controlledPauseSQL()],['resume-after-six.sql',resumeSQL()]);
for(const [name,body] of artifacts)fs.writeFileSync(path.join(dir,name),body);
fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({status:'PREPARED_NOT_EXECUTED',targetRef:'svuagnobufhfpgzmsyxx',productionConnected:false,migrations:files,artifacts:artifacts.map(([name,body])=>({name,sha256:createHash('sha256').update(body).digest('hex')}))},null,2));
console.log(JSON.stringify({status:'PREPARED_NOT_EXECUTED',folder:dir,files:artifacts.length}));
