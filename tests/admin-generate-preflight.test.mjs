import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {verifyGenerateReview,validateGenerateBaseline,healthSQL,stateSQL,compatibilitySQL,dataSQL} from '../scripts/admin-generate-preflight.mjs';
import {assertInspection} from '../scripts/readonly-psql.mjs';
import {generateProtectedSQL,inventoryFunctionSQL,closedProfileSQL,validateClosedGenerateProfile} from '../scripts/admin-generate-review-controls.mjs';
const health={readonly:'on',database:'postgres',user:'postgres',version:170011,recovery:false,long_idle:0,long_active:0,waiting:0,strong_locks:0,connections:14,max_connections:60};
const state={stage:6,state:'closed',fingerprint:'1aa5a5788a1baed944130434797876ac',actual:'1aa5a5788a1baed944130434797876ac',rpc_count:15,allowlist_effective:true,active_runs:0,hashes:['frozen']};
test('preflight reuses unchanged tested generate artifacts and SELECT-only queries',()=>{
 const m=verifyGenerateReview();assert.equal(m.default_enabled,false);assert.equal(m.files.length,6);for(const q of [healthSQL,stateSQL,compatibilitySQL,dataSQL])assert.doesNotThrow(()=>assertInspection(q));
});
test('strict preflight accepts baseline but rejects drift, role access, write transactions and locks',()=>{
 assert.doesNotThrow(()=>validateGenerateBaseline(health,state,{guard:true,owner:true},['frozen']));
 for(const patch of [{readonly:'off'},{user:'service_role'},{waiting:1},{strong_locks:1},{long_idle:1},{connections:50}])assert.throws(()=>validateGenerateBaseline({...health,...patch},state,{guard:true},['frozen']),/guard failed/);
 for(const patch of [{state:'testing_restricted'},{actual:'wrong'},{fingerprint:'newbaseline'},{rpc_count:16},{allowlist_effective:false},{active_runs:1},{hashes:['modified']}])assert.throws(()=>validateGenerateBaseline(health,{...state,...patch},{guard:true},['frozen']),/drift/);
 assert.throws(()=>validateGenerateBaseline(health,state,{guard:false},['frozen']),/compatibility failed/);
});
test('inspection runner has no write/installer dispatch and never overwrites backup preflight.json',()=>{
 const source=fs.readFileSync('scripts/admin-generate-preflight.mjs','utf8');assert.doesNotMatch(source,/frozenFile\(|generateInstallSQL\(|generationAccessSQL\(/);assert.match(source,/flag:'wx'/);assert.doesNotMatch(source,/path\.join\(parent,'preflight\.json'\)/);
});
test('closed-only postflight excludes only intentional patches and rejects any generation access or rows',()=>{
 for(const q of [generateProtectedSQL,inventoryFunctionSQL,closedProfileSQL])assert.doesNotThrow(()=>assertInspection(q));
 const p={stage:6,state:'closed',match:true,package_id:'frozen',enabled:false,previous_fingerprint:state.fingerprint,old_definitions_saved:true,batch_count:0,card_count:0,context_count:0,total_rpcs:16,allowlist_effective:true};
 assert.doesNotThrow(()=>validateClosedGenerateProfile(p,'frozen'));
 for(const patch of [{enabled:true},{batch_count:1},{card_count:1},{context_count:1},{allowlist_effective:false},{match:false},{total_rpcs:15}])assert.throws(()=>validateClosedGenerateProfile({...p,...patch},'frozen'),/STOP/);
});
