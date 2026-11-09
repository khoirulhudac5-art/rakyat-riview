// Production admin facade with read and write capabilities.
import {createHmac,createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {createAdminReadonly,supabaseAdminReadPage} from './admin-readonly.mjs';
import {passwordsMatch} from './admin-session.mjs';
const origin='https://rakyat-riview.vercel.app',cookieName='__Host-rr_admin_v2',seconds=1800;
const target='https://svuagnobufhfpgzmsyxx.supabase.co';
const fail=(status,message)=>Object.assign(Error(message),{status});
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

export function normalizeAdminSupabaseUrl(value){
 if(typeof value!=='string')return null;
 try{const u=new URL(value);return u.protocol==='https:'&&u.origin===target&&u.pathname==='/'&&!u.username&&!u.password&&!u.search&&!u.hash&&(value===target||value===target+'/')?u.origin:null;}catch{return null;}
}

export function getAdminV2Password(env=process.env){
 if(typeof env.ADMIN_V2_PASSWORD==='string'&&!!env.ADMIN_V2_PASSWORD)return env.ADMIN_V2_PASSWORD;
 if(typeof env.ADMIN_PASSWORD==='string'&&!!env.ADMIN_PASSWORD)return env.ADMIN_PASSWORD;
 return '';
}

export function adminConfigurationChecks(env=process.env){
 const password=getAdminV2Password(env);
 return {
  production_enabled:env.ADMIN_V2_PRODUCTION_ENABLED==='true'||env.ADMIN_V2_READONLY_PRODUCTION==='true',
  origin_matches:env.ADMIN_V2_ORIGIN===origin,
  read_contract_enabled:env.ADMIN_V2_READ_CONTRACT_READY==='true',
  supabase_target_valid:normalizeAdminSupabaseUrl(env.SUPABASE_URL)!==null,
  server_key_present:typeof env.SUPABASE_SECRET_KEY==='string'&&!!env.SUPABASE_SECRET_KEY&&!env.SUPABASE_SECRET_KEY.startsWith('sb_publishable_'),
  admin_password_present:!!password,
  admin_password_policy:typeof password==='string'&&password.length>=16&&!/^(demo-admin|test-only-password|password|changeme)$/i.test(password),
  signing_secret_present:typeof env.ADMIN_V2_SESSION_SECRET==='string'&&!!env.ADMIN_V2_SESSION_SECRET,
  signing_secret_policy:typeof env.ADMIN_V2_SESSION_SECRET==='string'&&Buffer.byteLength(env.ADMIN_V2_SESSION_SECRET)>=32&&!/^(demo|test|example|changeme)/i.test(env.ADMIN_V2_SESSION_SECRET)
 };
}

let lastGuardFailure='';
function configuration(){
 const env=process.env,checks=adminConfigurationChecks(env);
 if(!Object.values(checks).every(Boolean)){
  const signature=JSON.stringify(checks);
  if(signature!==lastGuardFailure){console.error(JSON.stringify({event:'admin_v2_configuration_guard_failed',category:'ADMIN_CONFIG_UNAVAILABLE',checks}));lastGuardFailure=signature;}
  throw fail(503,'Admin V2 production belum dikonfigurasi. Akses tetap tertutup.');
 }
 lastGuardFailure='';
 return env;
}

function validateRequest(req){
 configuration();
 if(req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin)||(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site'])))throw fail(403,'Permintaan Admin harus berasal dari website yang sama.');
 if(!['GET','POST'].includes(req.method))throw fail(405,'Metode tidak diizinkan.');
 if(req.method==='POST'&&(req.headers.origin!==origin||req.headers['x-admin-request']!=='1'||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')))throw fail(403,'Permintaan tidak diizinkan.');
 if(req.method==='POST'&&Buffer.byteLength(JSON.stringify(req.body||{}))>4096)throw fail(413,'Permintaan terlalu besar.');
}

const sign=payload=>createHmac('sha256',configuration().ADMIN_V2_SESSION_SECRET).update(payload).digest('base64url');

function cookie(clear=false,now=Date.now()){
 let value='';if(!clear){const iat=Math.floor(now/1000),payload=Buffer.from(JSON.stringify({aud:'rr-admin-v2-readonly',iat,exp:iat+seconds,nonce:randomBytes(24).toString('base64url')})).toString('base64url');value=payload+'.'+sign(payload);}
 return `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${clear?0:seconds}`;
}

function requireSession(req,res,meta){
 try{
  const entries=(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(cookieName+'='));if(entries.length!==1)throw Error();
  const token=entries[0].slice(cookieName.length+1);if(token.length>1024)throw Error();const [payload,sig,...extra]=token.split('.');if(extra.length||!payload||!sig)throw Error();const expected=sign(payload);
  if(sig.length!==expected.length||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))throw Error();
  const session=JSON.parse(Buffer.from(payload,'base64url')),now=Math.floor(Date.now()/1000);
  if(session.aud!=='rr-admin-v2-readonly'||!Number.isInteger(session.iat)||!Number.isInteger(session.exp)||session.iat>now||session.exp<=now||session.exp-session.iat!==seconds||!/^[A-Za-z0-9_-]{32}$/.test(session.nonce))throw Error();return true;
 }catch{res.setHeader('Set-Cookie',cookie(true));res.status(401).json({error:'Silakan masuk sebagai Admin.',...(meta||{})});return false;}
}

export async function supabaseAdminRpc(fnName,args){
 const key=process.env.SUPABASE_SECRET_KEY;
 if(!key)throw Object.assign(Error('Layanan database belum dikonfigurasi.'),{status:503});
 const headers={apikey:key,'Content-Type':'application/json'};
 if(!key.startsWith('sb_secret_')){
  let role;try{role=JSON.parse(Buffer.from(key.split('.')[1]||'','base64url')).role;}catch{}
  if(role!=='service_role')throw Object.assign(Error('Kunci otorisasi database tidak valid.'),{status:503});
  headers.Authorization='Bearer '+key;
 }
 const url=new URL(`${target}/rest/v1/rpc/${fnName}`);
 let response;
 try{
  response=await fetch(url,{method:'POST',headers,body:JSON.stringify(args),redirect:'error',signal:AbortSignal.timeout(20000)});
 }catch{
  throw Object.assign(Error('Layanan database belum dapat dihubungi.'),{status:502});
 }
 if(!response.ok){
  let errBody=null;try{errBody=await response.json();}catch{}
  throw Object.assign(Error(errBody?.message||'Operasi database belum dapat diselesaikan.'),{status:response.status===400?409:503,details:errBody});
 }
 return await response.json();
}

export function createProductionAdmin({readPage=supabaseAdminReadPage,invokeRpc=supabaseAdminRpc,now=Date.now}={}){
 const attempts=new Map();
 async function login(req,res){
  const time=now();for(const [k,v] of attempts)if(v.until<=time)attempts.delete(k);
  const ip=req.headers['x-vercel-forwarded-for']||req.socket?.remoteAddress||'unknown';
  const key=createHmac('sha256',configuration().ADMIN_V2_SESSION_SECRET).update(String(ip)).digest('hex'),entry=attempts.get(key);
  if((entry?.count||0)>=5||attempts.size>=2048){res.setHeader('Retry-After','900');return res.status(429).json({error:'Terlalu banyak percobaan. Coba lagi setelah 15 menit.'});}
  const password=req.body?.password;
  if(typeof password!=='string'||password.length>256||!passwordsMatch(password,getAdminV2Password(configuration()))){
   attempts.set(key,{count:(entry?.count||0)+1,until:entry?.until||time+900000});return res.status(401).json({error:'Password salah.'});
  }
  attempts.delete(key);res.setHeader('Set-Cookie',cookie(false,time));return res.status(200).json({success:true});
 }
 function logout(req,res){res.setHeader('Set-Cookie',cookie(true));return res.status(200).json({success:true});}

 async function handleCreate(req,res){
  const {quantity,request_id}=req.body||{};
  if(!Number.isInteger(quantity)||![1,10,50,100].includes(quantity)||!uuid(request_id)){
   return res.status(400).json({error:'Jumlah kartu harus 1, 10, 50, atau 100 dengan UUID batch yang valid.'});
  }
  const cardsPayload=[];
  const generatedTokens=[];
  for(let i=0;i<quantity;i++){
   const card_code=randomBytes(18).toString('base64url');
   const secret=randomBytes(24).toString('base64url');
   const token_hash=createHash('sha256').update(secret).digest('hex');
   cardsPayload.push({card_code,token_hash});
   generatedTokens.push({card_code,secret});
  }
  const actor=process.env.ADMIN_OPERATOR_ID||'admin:production-operator';
  try{
   const result=await invokeRpc('admin_generate_v2_cards_with_tokens',{
    p_request_id:request_id,
    p_quantity:quantity,
    p_cards:cardsPayload,
    p_actor:actor
   });
   if(result?.success!==true||result.batch_id!==request_id||!Array.isArray(result.cards)||result.cards.length!==quantity){
    throw Error('Hasil pembuatan belum dapat dikonfirmasi.');
   }
   const publicOrigin=process.env.CARD_PUBLIC_ORIGIN||origin;
   const cards=cardsPayload.map((c,i)=>{
    const secret=generatedTokens[i].secret;
    const url=`${publicOrigin}/r/${c.card_code}`;
    const actUrl=`${publicOrigin}/pembeli/mulai.html?card=${encodeURIComponent(c.card_code)}&token=${encodeURIComponent(secret)}`;
    return {
     card_code:c.card_code,
     card_url:url,
     qr_url:url,
     nfc_url:url,
     activation_token:secret,
     activation_url:actUrl
    };
   });
   return res.status(200).json({success:true,batch_id:request_id,cards});
  }catch(e){
   return res.status(e?.status||503).json({
    success:false,
    request_id,
    error:e?.message||'Pembuatan kartu V2 belum dapat diproses.'
   });
  }
 }

 async function handleReissue(req,res){
  const {card_code}=req.body||{};
  if(!card_code||!/^[A-Za-z0-9_-]{24}$/.test(card_code)){
   return res.status(400).json({error:'Kode kartu tidak valid.'});
  }
  const secret=randomBytes(24).toString('base64url');
  const hash=createHash('sha256').update(secret).digest('hex');
  const actor=process.env.ADMIN_OPERATOR_ID||'admin:production-operator';
  try{
   const ok=await invokeRpc('admin_reissue_v2_activation_token',{
    p_card_code:card_code,
    p_new_token_hash:hash,
    p_actor:actor
   });
   if(ok!==true){
    return res.status(409).json({error:'Token aktivasi tidak dapat diterbitkan ulang. Pastikan kartu ada dan belum pernah diaktivasi.'});
   }
   const publicOrigin=process.env.CARD_PUBLIC_ORIGIN||origin;
   const actUrl=`${publicOrigin}/pembeli/mulai.html?card=${encodeURIComponent(card_code)}&token=${encodeURIComponent(secret)}`;
   return res.status(200).json({
    success:true,
    card_code,
    activation_token:secret,
    activation_url:actUrl
   });
  }catch(e){
   return res.status(e?.status||503).json({error:e?.message||'Penerbitan ulang token aktivasi gagal.'});
  }
 }

 const readonly=createAdminReadonly({
  readPage,
  validateRequest,
  loginHandler:login,
  logoutHandler:logout,
  requireSession,
  generateEnabled:process.env.ADMIN_V2_GENERATE_ENABLED==='true',
  createHandler:handleCreate,
  reissueHandler:handleReissue
 });

 return async(req,res)=>{
  res.setHeader('X-Robots-Tag','noindex, nofollow');
  res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
  return readonly(req,res);
 };
}

export default createProductionAdmin();
