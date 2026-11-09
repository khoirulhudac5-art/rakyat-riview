import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreview } from '../scripts/preview-accounts.mjs';

test('scan prototype: public URL cannot claim; proof is single-use, account-bound, and activation atomic',async()=>{
  assert.throws(()=>createPreview({live:true,scan:true}),/tidak boleh/);
  const server=createPreview({scan:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const post=async(path,body,cookie='')=>fetch(origin+path,{method:'POST',headers:{Origin:origin,'X-Buyer-Request':'1','Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
  const jar=r=>r.headers.get('set-cookie')?.split(';')[0];
  try{
    const first=await fetch(origin+'/r/SYN-SCAN',{redirect:'manual'});assert.equal(first.status,302);assert.equal(first.headers.get('location'),'/pembeli/scan.html');
    const status=await(await fetch(origin+'/api/scan')).json();assert.deepEqual(status,{code:'SYN-SCAN',active:false});
    const a=jar(await post('/api/buyer',{action:'demo-signin'}));
    const b=jar(await post('/api/buyer',{action:'signup',email:'b@example.test',password:'synthetic-password'}));
    const fields={action:'activate',business_name:'Synthetic shop',review_url:'https://www.google.com/maps'};
    assert.equal((await post('/api/scan',fields,a)).status,403);
    assert.equal((await post('/api/scan',{action:'verify',proof:'guessed'},a)).status,403);
    const packageHtml=await(await fetch(origin+'/preview-package')).text();const proof=packageHtml.match(/#proof=([A-Za-z0-9_-]+)/)[1];
    assert.equal((await post('/api/scan',{action:'verify',proof})).status,401);
    const verified=await post('/api/scan',{action:'verify',proof},a);assert.equal(verified.status,200);const ticket=jar(verified);
    assert.match(verified.headers.get('set-cookie'),/HttpOnly/);
    assert.equal((await post('/api/scan',{action:'verify',proof},b)).status,403);
    assert.equal((await post('/api/scan',fields,b+'; '+ticket)).status,403);
    assert.equal((await post('/api/scan',{...fields,card_code:'SYN-OLD'},a+'; '+ticket)).status,403);
    assert.equal((await post('/api/scan',{...fields,review_url:'https://evil.example'},a+'; '+ticket)).status,400);
    assert.equal((await(await fetch(origin+'/api/scan')).json()).active,false);
    const results=await Promise.all([post('/api/scan',fields,a+'; '+ticket),post('/api/scan',fields,a+'; '+ticket)]);assert.equal(results.filter(r=>r.status===200).length,1);
    const scan=await fetch(origin+'/r/SYN-SCAN',{redirect:'manual'});assert.equal(scan.headers.get('location'),fields.review_url);
    const owned=await(await fetch(origin+'/api/buyer?action=cards',{headers:{Cookie:a}})).json();assert.ok(owned.cards.some(c=>c.card_code==='SYN-SCAN'));
    assert.equal((await post('/api/buyer',{action:'update',card_code:'SYN-SCAN',business_name:'Hijack',review_url:fields.review_url},b)).status,400);
    assert.equal((await post('/api/buyer',{action:'update',card_code:'SYN-SCAN',business_name:'Updated',review_url:'https://google.com/maps'},a)).status,200);
    assert.equal((await fetch(origin+'/r/SYN-SCAN',{redirect:'manual'})).headers.get('location'),'https://google.com/maps');
  }finally{await new Promise(r=>server.close(r));}
});
