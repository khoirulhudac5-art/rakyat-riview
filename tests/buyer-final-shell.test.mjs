import test from 'node:test';
import assert from 'node:assert/strict';
import {requestBuyer,ownedDashboard} from '../assets/buyer-account.mjs';
test('final legacy shell client renews an expired session once and reads the authenticated API',async()=>{
 const previous=globalThis.fetch,calls=[];
 try{
  globalThis.fetch=async(path,options)=>{calls.push({path,options});return calls.length===1?{status:401,ok:false,json:async()=>({})}:{status:200,ok:true,json:async()=>path.includes('cards')?{cards:[]}:{success:true}};};
  assert.deepEqual(await ownedDashboard(),{cards:[],statistics:{available:false,synthetic:false,visits:null,redirects:null,nfc:null,qr:null,series:[],by_card:{}}});
  assert.deepEqual(calls.map(c=>c.path),['/api/buyer?action=cards','/api/buyer','/api/buyer?action=cards']);assert.equal(JSON.parse(calls[1].options.body).action,'refresh');assert.ok(calls.every(c=>c.options.credentials==='same-origin'));
 }finally{globalThis.fetch=previous;}
});
test('final legacy shell client keeps closed access closed and never returns fixture cards',async()=>{
 const previous=globalThis.fetch;let calls=0;
 try{globalThis.fetch=async()=>{calls++;return {status:403,ok:false,json:async()=>({code:'V2_ACCESS_CLOSED',error:'closed'})};};await assert.rejects(ownedDashboard(),e=>e.code==='V2_ACCESS_CLOSED'&&e.status===403);assert.equal(calls,1);}
 finally{globalThis.fetch=previous;}
});
test('final legacy shell edit uses server update and no synthetic statistics enter the real view',async()=>{
 const previous=globalThis.fetch,calls=[];
 try{globalThis.fetch=async(path,options)=>{calls.push({path,options});return {status:200,ok:true,json:async()=>path.includes('cards')?{cards:[{card_code:'OWNED',active:true}],statistics:{available:true,synthetic:true,visits:999}}:{success:true}};};
  await requestBuyer('update',{card_code:'OWNED',business_name:'Updated',review_url:'https://search.google.com/local/writereview?placeid=ChITestOnly'});assert.equal(JSON.parse(calls[0].options.body).action,'update');assert.equal(calls[0].options.headers['X-Buyer-Request'],'1');
  const data=await ownedDashboard(false);assert.equal(data.cards.length,1);assert.equal(data.statistics.available,false);assert.equal(data.statistics.visits,null);
 }finally{globalThis.fetch=previous;}
});
