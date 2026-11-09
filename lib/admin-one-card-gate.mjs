// Private disk permit, one Admin session, one UUID, one dispatch. No HTTP open API.
import fs from 'node:fs';import {createHash} from 'node:crypto';
import {createLiveAdminGenerate} from './admin-generate-live.mjs';
import {requireAdminSession,requireAdminRequest} from './admin-session.mjs';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export function adminCookieHash(raw=''){
 const parts=raw.split(';').map(p=>p.trim()).filter(p=>p.startsWith('__Host-rr_admin='));
 return parts.length===1?createHash('sha256').update(parts[0]).digest('hex'):null;
}
export function readOneCardPermit(file,rawCookie,now=Date.now()){
 try{const p=JSON.parse(fs.readFileSync(file,'utf8'));
  if(p.state!=='armed'||!uuid(p.request_id)||p.quantity!==1||p.project_ref!=='svuagnobufhfpgzmsyxx'||p.expected_fingerprint!=='5aefd8e4df29f1c365b8942629b911cd'||!p.session_hash||p.session_hash!==adminCookieHash(rawCookie)||!Number.isFinite(p.expires_at)||p.expires_at<=now||p.expires_at>now+10*60000)return null;
  return p;
 }catch{return null;}
}
export function closeOneCardPermit(file,reason='closed'){
 let p={};try{p=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
 fs.writeFileSync(file,JSON.stringify({...p,state:'closed',closed_at:new Date().toISOString(),reason},null,2));
}
export function createOneCardAdmin({permitFile,invoke,readPage}={}){
 const closed=createLiveAdminGenerate({readPage});
 return async(req,res)=>{
  const p=readOneCardPermit(permitFile,req.headers.cookie||'');
  if(!p)return closed(req,res);
  const action=req.method==='GET'?req.query?.action:req.body?.action;
  if(req.method==='POST'&&action==='create'){
   if(!requireAdminSession(req,res)||!requireAdminRequest(req,res))return;
   if(req.headers.origin!==process.env.ADMIN_V2_READ_ORIGIN||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')||req.body.request_id!==p.request_id||req.body.quantity!==1)return res.status(403).json({error:'Permintaan tidak sesuai scope satu kartu.'});
   let locked=false;
   try{
    const fd=fs.openSync(permitFile+'.'+p.request_id+'.lock','wx');fs.closeSync(fd);locked=true;
    closeOneCardPermit(permitFile,'consumed before RPC dispatch');
   }catch{return res.status(423).json({error:'Scope tidak dapat dikonsumsi secara aman; tidak memanggil generate.'});}
   if(locked){
    try{return await createLiveAdminGenerate({approvedRequestId:p.request_id,invoke,readPage})(req,res);}
    finally{closeOneCardPermit(permitFile,'dispatch finished or failed');}
   }
  }
  return createLiveAdminGenerate({approvedRequestId:p.request_id,invoke,readPage})(req,res);
 };
}
