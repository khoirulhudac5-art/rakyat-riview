// Local test harness. Real tokens enter only from existing HttpOnly cookies,
// are verified by Supabase Auth, stay in RAM and are never returned or logged.
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {config,user,guard,token} from '../lib/buyer-service.mjs';
export function createLiveClaimSession(plan,{preparationOnly=false,now=()=>Date.now()}={}){
 const sessions=new Map(),signedOut=new Set(),proofs=new Map(),results=[];
 const instanceId=randomUUID(),startedAt=new Date(now()).toISOString();
 let phase='WAITING_FOR_SESSIONS',failure=null;
 const digest=s=>createHash('sha256').update(s).digest('hex');
 const alias=id=>Object.keys(plan.accounts).find(k=>plan.accounts[k].uid===id);
 const sessionKey=access=>{try{return JSON.parse(Buffer.from(access.split('.')[1],'base64url')).session_id||digest(access);}catch{return digest(access);}};
 const ready=label=>sessions.get(label)?.expires>now()+120000;
 const browser=req=>/Edg\//.test(req.headers['user-agent']||'')?'Edge':/Chrome\//.test(req.headers['user-agent']||'')?'Chrome':/Firefox\//.test(req.headers['user-agent']||'')?'Firefox':'Browser';
 const allowed=()=>!['FINISHED','STOPPED'].includes(phase);
 return {
  sessions,results,proofs,get phase(){return phase;},set phase(v){phase=v;},set failure(v){failure=v;},
  get ready(){return ready('A')&&ready('B');},
  noteSignout(req){const access=token(req,'a',config());for(const [label,s]of sessions)if(s.access===access){signedOut.add(label);sessions.delete(label);}},
  clear(){sessions.clear();signedOut.clear();},
  async handle(req,res,url){
   if(url.pathname==='/pembeli/claim-test.html'){
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return true;}
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.method==='HEAD'?undefined:await readFile(new URL('../pembeli/claim-test.html',import.meta.url)));return true;
   }
   if(url.pathname!=='/api/claim-test')return false;
   const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));return true;};
   if(req.method==='GET')return send(200,{instanceId,preparationOnly,preparationStartedAt:startedAt,runClockStarted:!preparationOnly&&['RUNNING','WAITING_FOR_A_RELOGIN'].includes(phase),registrationAllowed:allowed(),phase:preparationOnly&&allowed()?(ready('A')&&ready('B')?'SESSIONS_READY':'WAITING_FOR_SESSIONS'):phase,ready:{A:ready('A'),B:ready('B')},browsers:{A:ready('A')?sessions.get('A').browser:null,B:ready('B')?sessions.get('B').browser:null},results,failure,needsRelogin:!preparationOnly&&phase==='WAITING_FOR_A_RELOGIN'&&!proofs.get('A')?.fresh});
   if(req.method!=='POST')return send(405,{});
   try{
    const cfg=config();guard(req,cfg);let raw='';for await(const part of req){raw+=part;if(raw.length>1024)return send(413,{});}const body=JSON.parse(raw);
    if(body.action!=='register')return send(400,{});
    if(!allowed())return send(409,{code:'PREPARATION_CLOSED',loginRequired:false,error:'Runner sudah selesai. Sesi Google mungkin masih aktif; server persiapan perlu diaktifkan kembali, bukan login berulang.'});
    const verified=await user(req,cfg),label=alias(verified.user.id);
    if(!verified.user.google)return send(403,{code:'GOOGLE_REQUIRED',loginRequired:true,error:'Sesi aplikasi ini belum menggunakan akun Google.'});
    if(!label)return send(403,{code:'ACCOUNT_NOT_ALLOWED',loginRequired:true,error:'Sesi Google saat ini (UID …'+String(verified.user.id).slice(-4)+') bukan penguji A (…'+plan.accounts.A.uid.slice(-4)+') atau B (…'+plan.accounts.B.uid.slice(-4)+'). Gunakan browser/profil penguji yang benar.'});
    const identity={label,browser:browser(req),uidSuffix:verified.user.id.slice(-4),identitySource:'Supabase Auth /auth/v1/user'};
    if(body.expectedAccount!==undefined&&!['A','B'].includes(body.expectedAccount))return send(400,{code:'INVALID_EXPECTED_ACCOUNT',loginRequired:false,error:'Pilih penguji A atau B.'});
    if(body.expectedAccount&&body.expectedAccount!==label)return send(409,{...identity,code:'ACCOUNT_MISMATCH',loginRequired:false,switchAccount:true,error:identity.browser+' mengirim sesi aplikasi '+label+' (UID …'+identity.uidSuffix+'), terverifikasi langsung oleh Supabase Auth. Halaman ini disiapkan untuk '+body.expectedAccount+'. Memilih browser atau akun Google di tab lain tidak mengganti sesi aplikasi ini. Gunakan Pilih akun Google '+body.expectedAccount+' satu kali.'});
    const key=sessionKey(verified.access);let exp;try{exp=JSON.parse(Buffer.from(verified.access.split('.')[1],'base64url')).exp;}catch{}
    if(!Number.isFinite(exp)||exp*1000<now()+120000)return send(401,{code:'SESSION_RENEWAL_REQUIRED',loginRequired:false,canRefresh:true,error:'Sesi Google terverifikasi, tetapi token perlu diperbarui sebelum dipakai untuk pengujian.'});
    const prior=proofs.get(label);proofs.set(label,{key,fresh:Boolean(prior?.fresh||(signedOut.has(label)&&prior?.key!==key))});
    sessions.set(label,{access:verified.access,key,expires:exp*1000,browser:browser(req)});return send(200,{...identity,registered:true,instanceId,remainingSeconds:Math.floor(exp-now()/1000),freshSession:proofs.get(label).fresh});
   }catch(error){return send(error.status||400,{code:error.status===401?'SESSION_UNAVAILABLE':'SESSION_CHECK_FAILED',loginRequired:error.status===401,canRefresh:error.status===401,error:error.status===401?'Sesi aplikasi pada browser ini belum tersedia. Periksa atau perbarui sesi yang sudah ada terlebih dahulu.':'Sesi penguji belum dapat diverifikasi. Coba Periksa sesi lagi.'});}
  },
  async call(label,action,body){
   if(preparationOnly)throw Error('Preparation-only server cannot invoke card operations');
   const session=sessions.get(label);if(!session)throw Error('Verified Google session '+label+' is unavailable');
   const cfg=config(),r=await fetch(cfg.origin+'/api/buyer'+(body?'':'?action='+action),{method:body?'POST':'GET',headers:{Cookie:'rr_buyer_a='+session.access,...(body?{Origin:cfg.origin,'Content-Type':'application/json','X-Buyer-Request':'1'}:{})},...(body?{body:JSON.stringify({...body,action})}:{}),signal:AbortSignal.timeout(20000)});
   return {status:r.status,data:await r.json()};
  }
 };
}
