// Synthetic loopback server. No env files, live Auth, external requests or production data.
import http from 'node:http';import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
import {createPilotHandlers,PILOT_CARD} from '../lib/public-pilot.mjs';
import google from '../api/buyer-google.js';
const A='f1111111-1111-4111-8111-111111111111',B='f2222222-2222-4222-8222-222222222222';
export async function startPilotFixture({rpc,port=4196}){
 const origin='http://127.0.0.1:'+port,issuer='https://pilot-fixture.supabase.co',key=crypto.randomBytes(32),codes=new Map(),refreshes=new Map(),revoked=new Set();
 Object.assign(process.env,{BUYER_INTEGRATION_ENABLED:'true',BUYER_GOOGLE_ENABLED:'true',BUYER_RESTRICTED_APP:'false',BUYER_PILOT_ENABLED:'true',BUYER_LOCAL_HTTP:'1',BUYER_APP_ORIGIN:origin,SUPABASE_URL:issuer,SUPABASE_PUBLISHABLE_KEY:'fixture-publishable-not-real',PILOT_SYNTHETIC_LOCAL:'true'});
 const sign=(uid,exp=Date.now()/1000+3600)=>{const p=Buffer.from(JSON.stringify({sub:uid,exp,iss:issuer})).toString('base64url'),h=Buffer.from('{"alg":"HS256"}').toString('base64url'),s=h+'.'+p;return s+'.'+crypto.createHmac('sha256',key).update(s).digest('base64url');};
 const verify=t=>{try{if(revoked.has(t))return null;const [h,p,s]=t.split('.');if(crypto.createHmac('sha256',key).update(h+'.'+p).digest('base64url')!==s)return null;const d=JSON.parse(Buffer.from(p,'base64url'));return d.iss===issuer&&d.exp>Date.now()/1000?[A,B].includes(d.sub)&&d.sub:null;}catch{return null;}};
 const session=uid=>{const r=crypto.randomBytes(32).toString('base64url');refreshes.set(r,uid);return {access_token:sign(uid),refresh_token:r,expires_in:3600};};
 const realFetch=globalThis.fetch;
 globalThis.fetch=async(input,opts={})=>{
  const u=new URL(input instanceof Request?input.url:input);
  if(u.origin!==issuer){if(u.origin===origin)return realFetch(input,opts);throw Error('External network disabled in pilot fixture');}
  const body=opts.body?JSON.parse(opts.body):{},token=opts.headers?.Authorization?.replace('Bearer ',''),uid=verify(token||'');
  const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  if(u.pathname==='/auth/v1/user')return uid?response({id:uid,email:(uid===A?'fixture-a':'fixture-b')+'@example.invalid',identities:[{provider:'google'}],user_metadata:{full_name:'Synthetic account '+(uid===A?'A':'B')}}):response({},401);
  if(u.pathname==='/auth/v1/logout'){if(!uid)return response({},401);revoked.add(token);for(const [r,id] of refreshes)if(id===uid)refreshes.delete(r);return response({});}
  if(u.pathname==='/auth/v1/token'&&u.searchParams.get('grant_type')==='pkce'){
   const c=codes.get(body.auth_code);codes.delete(body.auth_code);
   return c&&crypto.createHash('sha256').update(body.code_verifier||'').digest('base64url')===c.challenge?response(session(c.uid)):response({},400);
  }
  if(u.pathname==='/auth/v1/token'&&u.searchParams.get('grant_type')==='refresh_token'){
   const id=refreshes.get(body.refresh_token);refreshes.delete(body.refresh_token);return id?response(session(id)):response({},401);
  }
  return response({},404);
 };
 const handlers=createPilotHandlers({rpc:async(name,args,access)=>{const uid=access?verify(access):null;if(access&&!uid)throw Error('Invalid synthetic JWT');return rpc(name,args,uid);},redirectRPC:code=>rpc('buyer_pilot_redirect_target',{p_card_code:code},null)});
 const server=http.createServer(async(req,res)=>{
  const json=(n,d)=>{res.writeHead(n,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(d));};
  if(req.headers.host!==new URL(origin).host||!['127.0.0.1','::ffff:127.0.0.1','::1'].includes(req.socket.remoteAddress))return json(403,{});
  const u=new URL(req.url,origin);let body={};
  try{if(req.method==='POST'){let raw='';for await(const p of req){raw+=p;if(raw.length>16384)return json(413,{});}body=JSON.parse(raw);}}catch{return json(400,{});}
  const req2={method:req.method,headers:req.headers,query:Object.fromEntries(u.searchParams),body};
  const res2={setHeader:(...a)=>res.setHeader(...a),status(n){res.statusCode=n;return this;},json(d){
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(d));},end(){res.end();}};
  try{
   if(['/fixture-account/A','/fixture-account/B'].includes(u.pathname)){
    const s=session(u.pathname.at(-1)==='A'?A:B);res.writeHead(303,{'Set-Cookie':[`rr_buyer_a=${s.access_token}; Path=/; HttpOnly; SameSite=Strict`,`rr_buyer_r=${s.refresh_token}; Path=/; HttpOnly; SameSite=Strict`],Location:'/pembeli/mulai.html?card='+PILOT_CARD});return res.end();
   }
   if(u.pathname==='/fixture-google'){
    const challenge=u.searchParams.get('challenge');if(!/^[A-Za-z0-9_-]{43}$/.test(challenge||''))return json(400,{});
    const code=crypto.randomBytes(24).toString('base64url');codes.set(code,{challenge,uid:u.searchParams.get('account')==='B'?B:A});res.writeHead(302,{Location:origin+'/pembeli/oauth.html?code='+code,'Cache-Control':'no-store'});return res.end();
   }
   if(u.pathname==='/api/buyer-google')return await google(req2,res2);
   if(u.pathname==='/api/buyer')return await handlers.api(req2,res2);
   if(u.pathname==='/api/buyer-status')return await handlers.status(req2,res2);
   if([`/r/${PILOT_CARD}`,`/r/${PILOT_CARD}/`].includes(u.pathname))return await handlers.redirect({...req2,query:{code:PILOT_CARD}},res2);
   if(u.pathname==='/api/convert-review')return json(503,{error:'Fixture offline: gunakan URL review sintetis langsung yang ditandai jelas. Tidak ada hasil konversi Google yang dibuat.'});
   if(!['GET','HEAD'].includes(req.method))return json(405,{});
   const file=u.pathname==='/'?'dashboard.html':u.pathname.startsWith('/r/')?'r/001/index.html':u.pathname.slice(1);
   if(!/^(dashboard\.html|kartu\.html|r\/001\/index\.html|(?:assets|pembeli)\/[A-Za-z0-9_-]+\.(?:html|css|js|mjs|png|svg))$/.test(file))return json(404,{});
   const b=await fs.readFile(path.resolve(file));res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(b);
  }catch{return json(503,{error:'Fixture lokal belum tersedia.'});}
 });
 await new Promise((resolve,reject)=>server.listen(port,'127.0.0.1',resolve).on('error',reject));
 return {server,origin,issuer,sign,session,verify,stop:async()=>{await new Promise(r=>server.close(r));globalThis.fetch=realFetch;}};
}
