import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createPilotHandlers,PILOT_CARD} from '../lib/public-pilot.mjs';
import {pilotInstallSQL,pilotAccessSQL,pilotRollbackSQL} from '../scripts/public-pilot-package.mjs';
function res(){return {code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(d){this.data=d;return this;},end(){this.ended=true;return this;}};}
test('public status projection discards accidental upstream private properties',async()=>{
 const h=createPilotHandlers({rpc:async()=>({code:PILOT_CARD,activation_state:'inactive',claim_allowed:true,user_id:'private',business_name:'private',review_url:'private'})}),r=res();await h.status({method:'GET',query:{card:PILOT_CARD}},r);
 assert.deepEqual(r.data,{code:PILOT_CARD,activation_state:'inactive',claim_allowed:true});assert.match(r.headers['Cache-Control'],/no-store/);
});
test('unknown code does not query inventory',async()=>{const h=createPilotHandlers({rpc:()=>{throw Error('must not call');}}),r=res();await h.status({method:'GET',query:{card:'other'}},r);assert.equal(r.data.activation_state,'unavailable');});
test('ready scan redirects only to fixed wizard',async()=>{const h=createPilotHandlers({rpc:async()=>({code:PILOT_CARD,activation_state:'inactive',claim_allowed:true})}),r=res();await h.redirect({method:'GET',query:{code:PILOT_CARD,next:'https://evil.test'}},r);assert.equal(r.code,303);assert.equal(r.headers.Location,'/pembeli/mulai.html?card='+PILOT_CARD);});
test('active scan sends 302 to canonical Google Review only',async()=>{const url='https://search.google.com/local/writereview?placeid=ChISyntheticPilot2345',h=createPilotHandlers({rpc:async()=>({code:PILOT_CARD,activation_state:'active'}),redirectRPC:async()=>({review_url:url})}),r=res();await h.redirect({method:'GET',query:{code:PILOT_CARD}},r);assert.equal(r.code,302);assert.equal(r.headers.Location,url);assert.equal(r.data,undefined);});
test('invalid/inconsistent/server failure redirect stays closed',async()=>{
 for(const target of [null,{review_url:'https://evil.test/'},{review_url:'https://search.google.com/local/writereview?placeid=ChISyntheticPilot2345&extra=1'}]){const r=res();await createPilotHandlers({rpc:async()=>({activation_state:'active'}),redirectRPC:async()=>target}).redirect({method:'GET',query:{code:PILOT_CARD}},r);assert.equal(r.code,503);assert.equal(r.headers.Location,undefined);}
 const r=res();await createPilotHandlers({rpc:()=>{throw Error('private database exception');}}).status({method:'GET',query:{card:PILOT_CARD}},r);assert.equal(r.code,503);assert.doesNotMatch(JSON.stringify(r.data),/private database/);
});
test('package default closed, scope literal, claim pause preserves reads, rollback non-destructive',()=>{
 const s=pilotInstallSQL('a'.repeat(32));assert.match(s,/card_code IS DISTINCT FROM/);assert.match(s,/DEFAULT false/);assert.doesNotMatch(s,/GRANT EXECUTE/);assert.throws(()=>pilotInstallSQL('wrong'));
 assert.match(pilotAccessSQL('close-claim'),/claim_on=false/);assert.doesNotMatch(pilotAccessSQL('close-claim'),/owner_on=false/);assert.match(pilotRollbackSQL(),/Committed attempts/);assert.doesNotMatch(pilotRollbackSQL(),/DELETE FROM public/);
});
test('exact pilot rewrites precede untouched V1 generic route',()=>{const r=JSON.parse(fs.readFileSync('vercel.json')).rewrites;assert.equal(r[0].source,'/r/'+PILOT_CARD);assert.equal(r[2].source,'/r/:code');assert.equal(r[2].destination,'/r/001/index.html');});
