import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createProductModel} from '../scripts/product-model.mjs';
const code='X'.repeat(24),review='https://search.google.com/local/writereview?placeid=ChITestOnly';
function fixture(mode='google_first_claim'){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'rr-admin-local-')),file=path.join(folder,'state.json');
 const card={card_code:mode==='legacy'?'001':code,owner:'fixture-owner',active:true,claim_mode:mode,inventory_state:'claimed',business_name:'Synthetic Owner',review_url:review,pin:mode==='legacy'?'SYNTHETIC-LEGACY-PIN':null,activation_revision:2};
 fs.writeFileSync(file,JSON.stringify({version:1,synthetic:true,cards:[card],events:[],audit:[]}));return {file,card,model:createProductModel({file})};
}
test('Admin local creates 1/100/1000 unique ready cards with stable permanent URLs',()=>{
 const model=createProductModel();const seen=new Set(model.rows().map(c=>c.card_code));
 for(const count of [1,100,1000]){const result=model.create(count);assert.equal(result.status,200);assert.equal(result.data.cards.length,count);for(const c of result.data.cards){assert.match(c.card_code,/^[A-Za-z0-9_-]{24}$/);assert.equal(seen.has(c.card_code),false);seen.add(c.card_code);assert.equal(c.inventory_state,'ready');assert.equal(c.owner,null);}}
 for(const c of model.rows(null,'http://127.0.0.1:4187'))assert.equal(c.card_url,'http://127.0.0.1:4187/r/'+c.card_code);
 for(const count of [0,-1,1001,1.2,'1'])assert.equal(model.create(count).status,400);
});
test('Admin local reset requires confirmation/revision/reason, persists audit, removes former owner and preserves code/URL',()=>{
 const {model,file}=fixture(),body={card_code:code,confirmation:code,expected_revision:2,reason:'Synthetic documented admin reset',acknowledged:true};
 for(const patch of [{confirmation:'wrong'},{expected_revision:1},{reason:'short'},{acknowledged:false}])assert.equal(model.reset({...body,...patch}).status,400);
 assert.equal(model.reset(body).status,200);const restored=createProductModel({file}),row=restored.rows(null,'http://127.0.0.1:4187')[0];assert.equal(row.card_code,code);assert.equal(row.card_url,'http://127.0.0.1:4187/r/'+code);assert.equal(row.active,false);assert.equal(row.owner_label,null);assert.equal(row.activation_revision,3);assert.equal(restored.audit().filter(e=>e.action==='reset').length,1);assert.equal(restored.update({id:'fixture-owner'},{card_code:code,business_name:'Old owner',review_url:review}).status,403);assert.equal(restored.reset(body).status,409);
});
test('Admin V2 local reset refuses legacy V1 without changing its identity, target or PIN fixture',()=>{
 const {model,file,card}=fixture('legacy'),before=fs.readFileSync(file,'utf8');
 assert.equal(model.reset({card_code:'001',confirmation:'001',expected_revision:2,reason:'Synthetic legacy refusal verification',acknowledged:true}).status,409);assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(model.scan('001',false).location,card.review_url);
});
