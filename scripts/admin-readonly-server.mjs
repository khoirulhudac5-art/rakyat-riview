// Loopback HTTP surface for existing Admin UI + read-only facade only.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createAdminReadonly} from '../lib/admin-readonly.mjs';
const files=new Map([['/','admin-v2.html'],['/admin-v2.html','admin-v2.html'],['/assets/admin-v2.js','assets/admin-v2.js'],['/assets/admin-v2.css','assets/admin-v2.css'],['/assets/rakyat-review-logo.png','assets/rakyat-review-logo.png'],['/pembeli/dashboard-data.mjs','pembeli/dashboard-data.mjs']]);
export function createAdminReadonlyServer(options={}){
 const handler=options.handler||createAdminReadonly(options);
 return http.createServer(async(req,res)=>{
  const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'private, no-store'});res.end(JSON.stringify(data));};
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return json(403,{error:'Local only'});
  if(req.headers.host!==new URL(process.env.ADMIN_V2_READ_ORIGIN).host)return json(403,{error:'Origin tidak diizinkan.'});
  const url=new URL(req.url,process.env.ADMIN_V2_READ_ORIGIN);
  if(url.pathname==='/api/v2-admin'){
   let body={};try{if(req.method==='POST'){let raw='';for await(const part of req){raw+=part;if(Buffer.byteLength(raw)>8192)return json(413,{});}body=JSON.parse(raw);}}catch{return json(400,{error:'JSON tidak valid.'});}
   const respond={setHeader:(...a)=>res.setHeader(...a),status(n){this.code=n;return this;},json(d){return json(this.code||200,d);}};
   return handler({method:req.method,headers:req.headers,body,query:Object.fromEntries(url.searchParams)},respond);
  }
  if(!['GET','HEAD'].includes(req.method))return json(405,{error:'Read-only preview'});
  const file=files.get(url.pathname);if(!file)return json(404,{});
  try{const content=await readFile(new URL('../'+file,import.meta.url));res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.png')?'image/png':'text/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:content);}catch{return json(500,{error:'Preview asset unavailable'});}
 });
}
