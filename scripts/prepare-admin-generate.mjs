// Freeze local review artifacts only. Never reads environment credentials or connects.
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {generatePackageID,writeGeneratePackage} from './admin-generate-package.mjs';import {sha} from './admin-readonly-package.mjs';
if(execFileSync('git',['branch','--show-current'],{encoding:'utf8',windowsHide:true}).trim()!=='v2-development')throw Error('Wrong branch');
const proofFile=path.join(process.argv[2]||'','RESULT.json');const proof=JSON.parse(fs.readFileSync(proofFile,'utf8'));
if(proof.status!=='LOCAL_ADMIN_GENERATE_PASS'||proof.passed<36||proof.productionConnected!==false||proof.realCredentialsUsed!==false||proof.package.package_id!==generatePackageID)throw Error('Current local proof required');
for(const s of proof.package.sources)if(sha(fs.readFileSync(s.file))!==s.sha256)throw Error('Source differs from local proof');
const folder=path.resolve('.backups/admin-generate-review-'+new Date().toISOString().replace(/[:.]/g,'-'));
const m=writeGeneratePackage(folder,'1aa5a5788a1baed944130434797876ac');
for(const f of m.files)if(sha(fs.readFileSync(path.join(folder,f.file)))!==f.sha256)throw Error('Artifact readback mismatch');
fs.writeFileSync(path.join(folder,'LOCAL-EVIDENCE.json'),JSON.stringify({proof:path.resolve(proofFile),proofSHA256:sha(fs.readFileSync(proofFile)),checks:proof.passed,generatedSyntheticCards:proof.generatedCards,productionAccessed:false,authorization:'NO PRODUCTION APPROVAL; fresh backup/preflight and explicit permission required'},null,2));
console.log(JSON.stringify({folder,package_id:m.package_id,manifestSHA256:sha(fs.readFileSync(path.join(folder,'manifest.json'))),productionAccessed:false}));
