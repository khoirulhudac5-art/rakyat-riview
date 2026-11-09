import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {packageCheck,compareSnapshots,validateSnapshot,expected,bundle} from '../scripts/public-pilot-live.mjs';
test('frozen pilot SQL and all approved sources still match checksums',()=>{assert.equal(packageCheck().expected_fingerprint,expected);});
test('invariant comparison refuses data/grant/reader drift; accepts only exact scoped guard patch',()=>{
 const a={protectedFP:'schema',dataDigest:'data',generateDigest:'generate',viewDigest:'view',anonView:'anon',authenticatedView:'empty',adminReaders:{cards:{rows:1,digest:'a'}},state:{fingerprint:expected},guard:'BEGIN\n RETURN NEW;\nEND'};
 compareSnapshots(a,structuredClone(a));
 for(const k of ['protectedFP','dataDigest','generateDigest','anonView','adminReaders']){const b=structuredClone(a);b[k]='drift';assert.throws(()=>compareSnapshots(a,b));}
 const b=structuredClone(a);b.state.fingerprint='drift';assert.throws(()=>compareSnapshots(a,b));assert.throws(()=>compareSnapshots(a,a,{installed:true}));
 const artifact=fs.readFileSync(bundle+'/install-closed.sql','utf8'),replacement=artifact.match(/EXECUTE replace\(c\.previous_guard,'BEGIN','((?:''|[^'])*)'\);/)[1].replaceAll("''", "'");
 const correct=structuredClone(a);correct.guard=a.guard.replace('BEGIN',replacement);compareSnapshots(a,correct,{installed:true});
});
test('validator rejects readonly transaction loss and partial/mismatched checkpoints before writes',()=>{
 for(const h of [{readonly:'off'},{readonly:'on',database:'wrong'}])assert.throws(()=>validateSnapshot({health:h,state:{}}),/Read-only/);
 const h={readonly:'on',database:'postgres',user:'postgres',version:170011,connections:1,max_connections:50};
 assert.throws(()=>validateSnapshot({health:h,state:{stage:5}}),/Checkpoint/);
});
test('installer has no enable/claim/create/reset or destructive recovery execution path',()=>{
 const s=fs.readFileSync('scripts/install-public-pilot-closed.mjs','utf8');assert.doesNotMatch(s,/pilotAccessSQL|open_run\(|close_run\(|generate_v2_batch\(|first_claim\(|--clean/);assert.match(s,/INSTALL-ATTEMPT/);assert.match(s,/ON_ERROR_STOP=1/);assert.match(s,/verify-full/);assert.match(s,/install-closed.sql/);assert.match(s,/No retry, rollback, enable/);
});
