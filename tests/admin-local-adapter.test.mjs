import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {adminLocalAdapter} from '../scripts/admin-local-adapter.mjs';
test('local Admin adapter rejects production, unauthenticated and nonlocal requests',async()=>{
 const original=process.env.NODE_ENV;process.env.NODE_ENV='production';assert.throws(()=>adminLocalAdapter());if(original===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=original;
 const adapter=adminLocalAdapter();const server=http.createServer(async(req,res)=>{if(!await adapter(req,res)){res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(base+'/unknown')).status,404);
  // Missing configured secret is fail-closed (503); valid config missing session 401.
  assert.ok([401,503].includes((await fetch(base+'/api/admin-v2-cards')).status));
  const status=await new Promise((resolve,reject)=>{const req=http.get(base+'/api/admin-v2-cards',{headers:{Host:'external.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(status,403);
  assert.equal((await fetch(base+'/api/admin-reset-v2',{method:'POST',body:'{'})).status,400);
  assert.equal((await fetch(base+'/api/admin-reset-v2',{method:'POST',body:'x'.repeat(17000)})).status,413);
  assert.equal((await fetch(base+'/api/admin-session',{method:'POST'})).status,405);
 }finally{await new Promise(r=>server.close(r));}
});
