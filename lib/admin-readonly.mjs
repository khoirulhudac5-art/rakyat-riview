// Local, server-authenticated read adapter. No generic RPC/table passthrough.
import login from '../api/admin-login.js';
import logout from '../api/admin-logout.js';
import {requireAdminSession,requireAdminRequest} from './admin-session.mjs';
const target='https://svuagnobufhfpgzmsyxx.supabase.co';
const rpcNames={cards:'admin_read_v2_inventory',audit:'admin_read_v2_audit'};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const code=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{24}$/.test(v);
const text=(v,max)=>v==null?null:typeof v==='string'&&v.length<=max?v:invalid();
const date=v=>v==null?null:typeof v==='string'&&Number.isFinite(Date.parse(v))?v:invalid();
const owner=v=>v===null?null:uuid(v)?v:invalid();
function invalid(){throw Object.assign(Error('Respons kontrak baca Admin tidak valid. Tidak ada data pengganti yang digunakan.'),{status:502});}
function unavailable(){return Object.assign(Error('Kontrak RPC/izin baca Admin belum disetujui atau belum tersedia. Akses tetap tertutup.'),{status:503});}
function local(req){
 if(process.env.ADMIN_V2_READONLY_LOCAL!=='true'||process.env.NODE_ENV==='production'||process.env.VERCEL)throw unavailable();
 let origin;try{origin=new URL(process.env.ADMIN_V2_READ_ORIGIN);}catch{throw unavailable();}
 if(origin.protocol!=='http:'||!['127.0.0.1','localhost'].includes(origin.hostname)||origin.origin!==process.env.ADMIN_V2_READ_ORIGIN||req.headers.host!==origin.host)throw unavailable();
 if((req.headers.origin&&req.headers.origin!==origin.origin)||req.headers['sec-fetch-site']==='cross-site'||req.headers['sec-fetch-site']==='same-site')throw Object.assign(Error('Permintaan Admin harus berasal dari origin yang sama.'),{status:403});
 if(req.method==='POST'&&(req.headers.origin!==origin.origin||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')))throw Object.assign(Error('Permintaan tidak diizinkan.'),{status:403});
}
export function getCardPublicOrigin(env=process.env){
 const candidate=env.CARD_PUBLIC_ORIGIN||env.ADMIN_V2_ORIGIN||((env.NODE_ENV==='production'||env.VERCEL)?'https://rakyat-riview.vercel.app':null);
 if(!candidate||typeof candidate!=='string')return null;
 try{const base=new URL(candidate);if(base.protocol==='https:'&&base.origin===candidate&&!base.username&&!base.password)return base.origin;}catch{}
 return null;
}
function card(row){
 if(!row||!code(row.card_code)||typeof row.active!=='boolean'||!Number.isSafeInteger(row.activation_revision)||row.activation_revision<0)invalid();
 const id=owner(row.owner_id);const origin=getCardPublicOrigin();
 const card_url=origin?origin+'/r/'+encodeURIComponent(row.card_code):null;
 return {card_code:row.card_code,business_name:text(row.business_name,150),review_url:text(row.review_url,2048),created_at:date(row.created_at),owner_id:id,owner_label:id,active:row.active,activation_revision:row.activation_revision,inventory_state:text(row.inventory_state,30),claim_mode:'google_first_claim',card_url};
}
function event(row){
 if(!row||!code(row.card_code)||!/^[-A-Za-z0-9_:]{1,100}$/.test(String(row.id))||typeof row.action!=='string'||!row.action||row.action.length>60||!row.at)invalid();
 return {id:String(row.id),at:date(row.at),action:row.action,card_code:row.card_code,actor:text(row.actor,150),reason:text(row.reason,1000),old_owner:owner(row.old_owner),new_owner:owner(row.new_owner)};
}
export async function supabaseAdminReadPage(kind,cursor){
 if(process.env.ADMIN_V2_READ_CONTRACT_READY!=='true'||!Object.hasOwn(rpcNames,kind))throw unavailable();
 let base;try{base=new URL(process.env.SUPABASE_URL);}catch{throw unavailable();}
 const key=process.env.SUPABASE_SECRET_KEY;
 if(base.href!==target+'/'||!key||key.startsWith('sb_publishable_'))throw unavailable();
 const headers={apikey:key};
 if(!key.startsWith('sb_secret_')){let role;try{role=JSON.parse(Buffer.from(key.split('.')[1]||'','base64url')).role;}catch{}if(role!=='service_role')throw unavailable();headers.Authorization='Bearer '+key;}
 const url=new URL(target+'/rest/v1/rpc/'+rpcNames[kind]);url.searchParams.set('p_limit','200');if(cursor!==null)url.searchParams.set('p_after',cursor);
 let response;try{response=await fetch(url,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(12000)});}catch{throw Object.assign(Error('Layanan baca Admin belum dapat dihubungi.'),{status:502});}
 if(!response.ok){if([401,403,404,405].includes(response.status))throw unavailable();throw Object.assign(Error('Layanan baca Admin gagal merespons.'),{status:502});}
 try{return await response.json();}catch{invalid();}
}
export function createAdminReadonly({readPage=supabaseAdminReadPage,fixture=false,validateRequest=local,loginHandler=login,logoutHandler=logout,requireSession=requireAdminSession,generateEnabled=false,createHandler=null,reissueHandler=null}={}){
 return async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');res.setHeader('Vary','Cookie');res.setHeader('X-Content-Type-Options','nosniff');
  const ready=process.env.ADMIN_V2_READ_CONTRACT_READY==='true';
  const gen=generateEnabled||process.env.ADMIN_V2_GENERATE_ENABLED==='true';
  const meta={mode:fixture?'synthetic':(gen?'admin_production':'admin_readonly'),read_only:!gen,data_source:fixture?'contract_fixture':'supabase',capabilities:{list:ready,audit:ready,create:gen,reset:false,reissue:gen,idempotent_create:gen}};
  const respond={setHeader:(...a)=>res.setHeader(...a),status(n){this.code=n;return this;},json(data){return res.status(this.code||200).json({...data,...meta});}};
  try{
   validateRequest(req);
   if(!fixture&&process.env.ADMIN_PASSWORD==='demo-admin')throw Object.assign(Error('Sandi demo tidak dapat dipakai pada adapter Supabase nyata.'),{status:503});
   const action=req.method==='GET'?req.query?.action:req.body?.action;
   if(req.method==='POST'&&['login','logout'].includes(action)){if(!requireAdminRequest(req,respond))return;return await (action==='login'?loginHandler:logoutHandler)(req,respond);}
   if(!requireSession(req,respond,meta))return;
   if(req.method==='POST'&&action==='create'&&gen&&createHandler){if(!requireAdminRequest(req,respond))return;return await createHandler(req,respond);}
   if(req.method==='POST'&&action==='reissue-token'&&gen&&reissueHandler){if(!requireAdminRequest(req,respond))return;return await reissueHandler(req,respond);}
   if(req.method!=='GET')return respond.status(405).json({error:'Mode read-only menolak generate, reset, dan seluruh mutasi kartu.'});
   if(action==='session')return respond.status(200).json({authenticated:true});
   if(!['cards','audit'].includes(action))return respond.status(400).json({error:'Operasi baca tidak tersedia.'});
   if(!ready)throw unavailable();
   const items=[],seenItems=new Set(),seenCursors=new Set();let cursor=null;
   for(let page=0;page<50;page++){
    const data=await readPage(action,cursor),rows=data?.[action==='cards'?'cards':'events'];
    if(!Array.isArray(rows)||rows.length>200||!Object.hasOwn(data,'next_cursor'))invalid();
    for(const row of rows){const value=action==='cards'?card(row):event(row),id=action==='cards'?value.card_code:value.id;if(seenItems.has(id))invalid();seenItems.add(id);items.push(value);}
    const next=data.next_cursor;if(next===null)return respond.status(200).json(action==='cards'?{cards:items,statistics:{available:false,synthetic:false,visits:null,redirects:null,series:[]}}:{events:items});
    if(!rows.length||typeof next!=='string'||(action==='cards'?!code(next):!/^[-A-Za-z0-9_]{1,512}$/.test(next))||seenCursors.has(next))invalid();seenCursors.add(next);cursor=next;
   }
   throw Object.assign(Error('Inventaris melebihi batas pembacaan lokal. Data parsial tidak ditampilkan.'),{status:502});
  }catch(error){return respond.status(error.status||503).json({error:error.status?error.message:'Adapter baca Admin belum dapat digunakan.'});}
 };
}
export default createAdminReadonly();
