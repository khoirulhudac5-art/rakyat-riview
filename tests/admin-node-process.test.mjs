import test from 'node:test';import assert from 'node:assert/strict';import {matchesAdminNodeProcess} from '../scripts/admin-node-process.mjs';
const executable='C:\\Program Files\\nodejs\\node.exe',workspace='C:\\Users\\user\\rakyat-riview';
const info={name:'node.exe',executablePath:executable};
test('matcher accepts quoted Node executable and exact relative or absolute script',()=>{
 for(const commandLine of ['"'+executable+'" scripts/start-admin-generate-live.mjs','"'+executable+'" "'+workspace+'\\scripts\\start-admin-generate-live.mjs"'])assert.equal(matchesAdminNodeProcess({...info,commandLine},{executable,workspace}),true);
});
test('matcher also accepts an unquoted executable without spaces',()=>{
 const executable='C:\\node\\node.exe';assert.equal(matchesAdminNodeProcess({name:'node.exe',executablePath:executable,commandLine:executable+' scripts/start-admin-generate-live.mjs'},{executable,workspace}),true);
});
test('other executable, workspace, script, or arguments are refused',()=>{
 for(const commandLine of ['"'+executable+'" scripts/start-admin-readonly.mjs','"'+executable+'" scripts/start-admin-generate-live.mjs --extra','"C:\\other\\node.exe" scripts/start-admin-generate-live.mjs','"'+executable+'" C:\\other\\scripts\\start-admin-generate-live.mjs'])assert.equal(matchesAdminNodeProcess({...info,commandLine},{executable,workspace}),false);
});
