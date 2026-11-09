// Prepare a bridge to the existing verified exporter; no network or SQL here.
import fs from 'node:fs';import path from 'node:path';
const file=path.resolve('.backups/tooling/pilot-stage2-backup.mjs');
let source=fs.readFileSync('.backups/tooling/admin-readonly-live-backup.mjs','utf8');
const original="import {preflight,read,tool,packageCheck,dataSQL} from './admin-readonly-live.mjs';";
if(!source.includes(original))throw Error('Exporter source shape changed');
source=source.replace(original,`import {tool} from './admin-readonly-live.mjs';
import {snapshot,packageCheck,dataSQL,compareSnapshots} from '../../scripts/public-pilot-live.mjs';
import {inspect} from '../../scripts/readonly-psql.mjs';
async function read(queries,env){return inspect({executable:path.resolve('.backups/tooling/pgsql/bin/psql.exe'),env,queries});}
async function preflight(folder){
 const r=await snapshot(true);if(r.state.fingerprint!=='59f0d0d9a4fee9a96481e0630c7b74a7')throw Error('Stage2 baseline fingerprint drift');
 const installed=JSON.parse(fs.readFileSync('.backups/public-pilot-closed-2026-11-07T08-05-36-263Z/INSTALL-RESULT.json')).after;compareSnapshots(installed,r);
 fs.writeFileSync(path.join(folder,'preflight.json'),JSON.stringify(r,null,2));return r;
}`);
source=source.replace("startsWith('admin-readonly-live-')","startsWith('pilot-stage2-backup-')");
if(fs.existsSync(file))throw Error('Backup bridge already exists; inspect before replacing');fs.writeFileSync(file,source);
const folder=path.resolve('.backups/pilot-stage2-backup-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(folder);console.log(JSON.stringify({folder,exporter:file,networkAccess:false}));
