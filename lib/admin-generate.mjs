// Isolated PostgreSQL adapter only. No production POST transport or default RPC.
import {randomBytes,createHash} from 'node:crypto';
import {requireAdminSession,requireAdminRequest} from './admin-session.mjs';
import {createAdminReadonly} from './admin-readonly.mjs';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export function confirmedCardOrigin(env=process.env){
 if(env.ADMIN_GENERATE_DOMAIN_CONFIRMED!=='true')return null;
 try{const u=new URL(env.CARD_PUBLIC_ORIGIN);if(u.protocol!=='https:'||u.origin!==env.CARD_PUBLIC_ORIGIN||u.username||u.password||u.hostname==='localhost'||u.hostname==='example.com'||u.hostname.endsWith('.test')||u.hostname.endsWith('.invalid')||u.hostname.endsWith('.localhost')||/^\d+(?:\.\d+){3}$/.test(u.hostname))return null;return u.origin;}catch{return null;}
}
export function createAdminGenerate({invoke,readPage,reissueToken}={}){
 const reader=createAdminReadonly({readPage,fixture:true});
 return async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');
  let origin;try{origin=new URL(process.env.ADMIN_V2_READ_ORIGIN);}catch{}
  const local=process.env.ADMIN_GENERATE_LOCAL==='isolated_postgres'&&typeof invoke==='function'&&typeof readPage==='function'&&!process.env.VERCEL&&process.env.NODE_ENV!=='production'&&origin?.protocol==='http:'&&['127.0.0.1','localhost'].includes(origin?.hostname)&&req.headers.host===origin.host;
  if(!local)return res.status(503).json({error:'Generate hanya tersedia pada PostgreSQL lokal terisolasi.'});
  const publicOrigin=confirmedCardOrigin();
  const response={setHeader:(...a)=>res.setHeader(...a),status(n){this.code=n;return this;},json(data){return res.status(this.code||200).json({...data,
   ...(Array.isArray(data.cards)?{cards:data.cards.map(c=>({...c,card_url:publicOrigin?publicOrigin+'/r/'+c.card_code:null}))}:{}),
   mode:'synthetic',data_source:'isolated_postgres',read_only:false,production_urls_available:Boolean(publicOrigin),
   capabilities:{list:true,audit:true,create:process.env.ADMIN_GENERATE_ENABLED==='true',reset:false,idempotent_create:true}});}};
  const action=req.method==='GET'?req.query?.action:req.body?.action;
  if(req.method==='GET'||['login','logout'].includes(action))return reader(req,response);
  if(!requireAdminSession(req,response)||!requireAdminRequest(req,response))return;
  if(req.method!=='POST'||req.headers.origin!==origin.origin||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return response.status(403).json({error:'Origin/format request ditolak.'});
  if(action!=='create'&&action!=='reissue-token')return response.status(405).json({error:'Reset dan mutasi lain tetap tertutup.'});
  if(process.env.ADMIN_GENERATE_ENABLED!=='true')return response.status(503).json({error:'Generate masih ditutup.'});
  const actor=process.env.ADMIN_OPERATOR_ID;
  if(!actor||actor.length>150)return response.status(503).json({error:'Identitas operator backend belum dikonfigurasi.'});

  if(action==='reissue-token'){
   const {card_code}=req.body||{};
   if(!card_code||!/^[A-Za-z0-9_-]{24}$/.test(card_code))return response.status(400).json({error:'Kode kartu tidak valid.'});
   const secret=randomBytes(24).toString('base64url');
   const hash=createHash('sha256').update(secret).digest('hex');
   try{
    if(typeof reissueToken==='function')await reissueToken({p_card_code:card_code,p_new_token_hash:hash,p_actor:actor});
    const actUrl=(publicOrigin||'https://rakyat-riview.vercel.app')+'/pembeli/mulai.html?card='+encodeURIComponent(card_code)+'&token='+encodeURIComponent(secret);
    return response.status(200).json({success:true,card_code,activation_token:secret,activation_url:actUrl});
   }catch(e){return response.status(503).json({error:'Penerbitan ulang token aktivasi belum dapat diproses.'});}
  }

  const {quantity,request_id}=req.body||{};
  if(!Number.isInteger(quantity)||quantity<1||quantity>1000||!uuid(request_id))return response.status(400).json({error:'Jumlah atau UUID permintaan tidak valid.'});
  const preparedTokens=[];
  for(let i=0;i<quantity;i++){
   const secret=randomBytes(24).toString('base64url');
   const hash=createHash('sha256').update(secret).digest('hex');
   preparedTokens.push({secret,hash});
  }
  try{
   const result=await invoke({p_request_id:request_id,p_quantity:quantity,p_actor:actor,p_tokens:preparedTokens.map(t=>t.hash)});
   if(result?.success!==true||result.batch_id!==request_id||!Array.isArray(result.cards)||result.cards.length!==quantity||new Set(result.cards.map(c=>c.card_code)).size!==quantity||result.cards.some(c=>!/^[A-Za-z0-9_-]{24}$/.test(c.card_code)))throw Error('Invalid result');
   const cards=result.cards.map((c,i)=>{
    const url=publicOrigin?publicOrigin+'/r/'+c.card_code:null;
    const secret=preparedTokens[i]?.secret;
    const actUrl=secret?((publicOrigin||'https://rakyat-riview.vercel.app')+'/pembeli/mulai.html?card='+encodeURIComponent(c.card_code)+'&token='+encodeURIComponent(secret)):null;
    return {card_code:c.card_code,card_url:url,qr_url:url,nfc_url:url,activation_token:secret||null,activation_url:actUrl};
   });
   return response.status(200).json({success:true,batch_id:request_id,cards});
  }catch(e){return response.status(e?.code==='22023'?409:503).json({success:false,request_id,error:'Hasil belum terkonfirmasi. Gunakan UUID permintaan yang sama untuk rekonsiliasi; jangan membuat permintaan baru.'});}
 };
}
