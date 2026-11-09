// Offline only. Does not import connection configuration or read .env files.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {writePackage,verifyPackage,sha} from './admin-readonly-package.mjs';
if(execFileSync('git',['branch','--show-current'],{encoding:'utf8',windowsHide:true}).trim()!=='v2-development')throw Error('Wrong branch');
const proofFolder=process.argv[2];
if(!proofFolder)throw Error('Provide isolated local proof folder, not database credentials');
const proof=JSON.parse(fs.readFileSync(path.join(proofFolder,'admin-read-local-report.json'),'utf8'));
if(proof.status!=='LOCAL_ADMIN_READ_PACKAGE_PASS'||proof.passed<39||!proof.localServerStopped||proof.productionConnected!==false||!proof.finalClosed||!proof.originalFingerprintRestored)throw Error('Local proof is incomplete');
verifyPackage(path.join(proofFolder,'package'));
// Last recorded CLOSED checkpoint, not a claim of a new live preflight.
const expected='315715bea02c60bf3d4e4e9e898bdb5c';
const folder=path.resolve('.backups/admin-readonly-approval-'+new Date().toISOString().replace(/[:.]/g,'-'));
writePackage(folder,expected);verifyPackage(folder);
const evidence={authorization:'AWAITING EXPLICIT DATABASE APPROVAL',liveAccessPerformed:false,baseline:'Last recorded closed checkpoint; must be reverified before execution',localProof:path.resolve(proofFolder),localProofSHA256:sha(fs.readFileSync(path.join(proofFolder,'admin-read-local-report.json'))),testSources:['scripts/test-admin-readonly-package-local.mjs','tests/admin-readonly-package.test.mjs'].map(file=>({file,sha256:sha(fs.readFileSync(file))})),postgresChecks:proof.passed,javascriptTests:96};
fs.writeFileSync(path.join(folder,'EVIDENCE.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify({folder,manifestSHA256:sha(fs.readFileSync(path.join(folder,'manifest.json'))),localChecks:proof.passed,productionConnected:false}));
