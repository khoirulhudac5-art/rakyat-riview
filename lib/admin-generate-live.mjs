// Loopback Admin backend. Real POST transport is scoped to a separately approved
// single-card request; a grant activation never authorizes creating a card.
import {createAdminReadonly} from './admin-readonly.mjs';
import {requireAdminSession,requireAdminRequest} from './admin-session.mjs';
import {adminConfigStatus} from '../scripts/admin-readonly-config.mjs';
import {confirmedCardOrigin} from './admin-generate.mjs';
const target='https://svuagnobufhfpgzmsyxx.supabase.co';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export function createLiveGenerateTransport({approvedRequestId=null,operator='admin:configured-owner',fetchImpl=(...a)=>fetch(...a)}={}){
 return async args=>{
  if(!uuid(approvedRequestId)||args.p_request_id!==approvedRequestId||args.p_quantity!==1||args.p_actor!==operator||!adminConfigStatus(process.env).ready)throw Error('Single-card test not authorized');
  const key=process.env.SUPABASE_SECRET_KEY,headers={apikey:key,'Content-Type':'application/json'};
  if(!key.startsWith('sb_secret_'))headers.Authorization='Bearer '+key;
  const r=await fetchImpl(target+'/rest/v1/rpc/admin_generate_v2_batch',{method:'POST',headers,redirect:'error',signal:AbortSignal.timeout(20000),body:JSON.stringify(args)});
  if(!r.ok){const e=Error('Generate result not confirmed');e.status=r.status===400?409:503;throw e;}return r.json();
 };
}
export function createLiveAdminGenerate({approvedRequestId=null,operator='admin:configured-owner',invoke=createLiveGenerateTransport({approvedRequestId,operator}),readPage}={}){
 const reader=createAdminReadonly({readPage});const testAllowed=uuid(approvedRequestId);
 return async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');res.setHeader('Vary','Cookie');
  let origin;try{origin=new URL(process.env.ADMIN_V2_READ_ORIGIN);}catch{}
  if(!adminConfigStatus(process.env).ready||process.env.ADMIN_GENERATE_LIVE_LOCAL!=='true'||origin?.protocol!=='http:'||!['127.0.0.1','localhost'].includes(origin?.hostname)||req.headers.host!==origin.host)return res.status(503).json({error:'Backend Generate nyata belum siap; akses tetap ditutup.'});
  if(req.headers.origin&&req.headers.origin!==origin.origin)return res.status(403).json({error:'Origin tidak diizinkan.'});
  const domain=confirmedCardOrigin();
  const response={setHeader:(...a)=>res.setHeader(...a),status(n){this.code=n;return this;},json(data){return res.status(this.code||200).json({...data,
   ...(Array.isArray(data.cards)?{cards:data.cards.map(c=>({...c,card_url:domain?domain+'/r/'+c.card_code:null}))}:{}),
   mode:'admin_generate_live',data_source:'supabase',read_only:false,production_urls_available:Boolean(domain),create_test_authorized:testAllowed,
   capabilities:{list:true,audit:true,create:testAllowed,reset:false,idempotent_create:true}});}};
  const action=req.method==='GET'?req.query?.action:req.body?.action;
  if(req.method==='GET'||['login','logout'].includes(action))return reader(req,response);
  if(!requireAdminSession(req,response)||!requireAdminRequest(req,response))return;
  if(req.method!=='POST'||req.headers.origin!==origin.origin||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return response.status(403).json({error:'Request ditolak.'});
  if(action!=='create')return response.status(405).json({error:'Reset dan mutasi lain tetap tertutup.'});
  if(!testAllowed)return response.status(423).json({error:'RPC siap untuk backend; pembuatan kartu menunggu persetujuan uji satu kartu.'});
  if(req.body.request_id!==approvedRequestId||req.body.quantity!==1)return response.status(403).json({error:'Permintaan tidak sesuai scope uji satu kartu.'});
  try{
   const r=await invoke({p_request_id:approvedRequestId,p_quantity:1,p_actor:operator});
   if(r?.success!==true||r.batch_id!==approvedRequestId||!Array.isArray(r.cards)||r.cards.length!==1||!/^[A-Za-z0-9_-]{24}$/.test(r.cards[0].card_code))throw Error('Unconfirmed result');
   const code=r.cards[0].card_code,url=domain?domain+'/r/'+code:null;return response.status(200).json({success:true,batch_id:r.batch_id,cards:[{card_code:code,card_url:url,qr_url:url,nfc_url:url}]});
  }catch{return response.status(503).json({success:false,request_id:approvedRequestId,error:'Hasil belum terkonfirmasi. Rekonsiliasi UUID yang sama; jangan membuat request baru.'});}
 };
}
