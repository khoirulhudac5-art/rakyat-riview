// Pilot profile only. Buyer JWTs reach the claim RPC; service credentials are redirect-only.
import buyer from '../api/buyer.js';
import {BuyerError,config,guard,upstream,user,cardInput} from './buyer-service.mjs';
import {directReview} from '../pembeli/maps.mjs';
export const PILOT_CARD='iKRb7_7PyK6kg4Ye7EqvOhYu';
const unavailable={activation_state:'unavailable',claim_allowed:false};
function pilotConfig(){const cfg=config();if(cfg.url!=='https://svuagnobufhfpgzmsyxx.supabase.co'&&!(cfg.local&&process.env.PILOT_SYNTHETIC_LOCAL==='true'&&cfg.url==='https://pilot-fixture.supabase.co'))throw new BuyerError(503,'Target pilot tidak sesuai konfigurasi.');return cfg;}
function headers(res){res.setHeader('Cache-Control','private, no-store');res.setHeader('Vary','Cookie');res.setHeader('X-Content-Type-Options','nosniff');}
export function createPilotHandlers({rpc=async(name,args,access)=>upstream(pilotConfig(),'/rest/v1/rpc/'+name,{method:'POST',body:args,access}),redirectRPC}={}){
 const fail=(res,e)=>res.status(e instanceof BuyerError?e.status:503).json({error:e instanceof BuyerError?e.message:'Pilot belum tersedia. Tidak ada perubahan yang dilakukan.'});
 async function status(req,res){headers(res);try{
  if(req.method!=='GET')throw new BuyerError(405,'Metode tidak diizinkan.');
  if(req.query?.card!==PILOT_CARD)return res.status(200).json(unavailable);
  const s=await rpc('buyer_pilot_public_status',{p_card_code:PILOT_CARD});
  if(!s||s.code!==PILOT_CARD)return res.status(200).json(unavailable);
  return res.status(200).json({code:PILOT_CARD,activation_state:['active','inactive'].includes(s.activation_state)?s.activation_state:'unavailable',claim_allowed:s.claim_allowed===true});
 }catch(e){return fail(res,e);}}
 async function api(req,res){headers(res);try{
  const action=req.method==='GET'?req.query?.action:req.body?.action;
  if(['session','refresh','signout'].includes(action))return buyer(req,res);
  const cfg=pilotConfig();guard(req,cfg);
  if(req.method==='GET'&&action==='mode')return res.status(200).json({mode:'pilot',activation_flow:'first_claim',capabilities:{update:false,statistics:false},...(process.env.PILOT_SYNTHETIC_LOCAL==='true'&&cfg.local?{fixture:true}:{})});
  const session=await user(req,cfg);
  if(req.method==='GET'&&action==='cards'){
   const cards=await rpc('buyer_pilot_list_cards',{},session.access);
   if(!Array.isArray(cards)||cards.some(c=>c.card_code!==PILOT_CARD))throw new BuyerError(502,'Respons kartu pilot tidak valid.');
   return res.status(200).json({cards,statistics:{available:false,visits:null,redirects:null,message:'Belum ada sumber statistik nyata untuk pilot. Scan bukan jumlah review Google.'}});
  }
  if(req.method==='POST'&&action==='first-claim'){
   if(!session.user.google)throw new BuyerError(403,'Gunakan akun Google.');
   const args=cardInput(req.body);
   if(args.p_card_code!==PILOT_CARD||directReview(args.p_review_url)!==args.p_review_url||Object.keys(req.body).some(k=>!['action','card_code','business_name','review_url'].includes(k)))throw new BuyerError(400,'Isian pilot tidak valid.');
   const r=await rpc('buyer_pilot_first_claim',args,session.access);
   if(r?.code==='rate_limited')throw new BuyerError(429,'Tunggu sebelum mencoba klaim lagi.');
   if(r?.success!==true)throw new BuyerError(409,'Kartu tidak dapat diklaim. Draft tetap tersimpan.');
   return res.status(200).json({success:true,card_code:PILOT_CARD});
  }
  throw new BuyerError(403,'Operasi ini belum dibuka pada pilot.');
 }catch(e){return fail(res,e);}}
 async function redirect(req,res){headers(res);try{
  if(req.method!=='GET'&&req.method!=='HEAD')throw new BuyerError(405,'Metode tidak diizinkan.');
  if(req.query?.code!==PILOT_CARD)throw new BuyerError(404,'Kartu tidak tersedia.');
  const s=await rpc('buyer_pilot_public_status',{p_card_code:PILOT_CARD});
  if(s?.code===PILOT_CARD&&s.activation_state==='inactive'&&s.claim_allowed===true){res.setHeader('Location','/pembeli/mulai.html?card='+PILOT_CARD);return res.status(303).end();}
  if(s?.activation_state!=='active'||!redirectRPC)throw new BuyerError(503,'Kartu belum tersedia.');
  const target=await redirectRPC(PILOT_CARD);
  if(typeof target?.review_url!=='string'||directReview(target.review_url)!==target.review_url)throw new BuyerError(503,'Tujuan kartu belum tersedia.');
  res.setHeader('Location',target.review_url);return res.status(302).end();
 }catch(e){return fail(res,e);}}
 return {api,status,redirect};
}
// Server-only credential, never included in buyer responses or browser assets.
export async function serverRedirect(code){
 const cfg=pilotConfig(),key=process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
 if(code!==PILOT_CARD||!key)throw new BuyerError(503,'Resolver pilot belum dikonfigurasi.');
 return upstream({...cfg,key},'/rest/v1/rpc/buyer_pilot_redirect_target',{method:'POST',body:{p_card_code:code},access:key});
}
