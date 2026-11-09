// Production read-only facade. No fixture, SQL, generic RPC, generate or reset path.
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {createAdminReadonly,supabaseAdminReadPage} from './admin-readonly.mjs';
import {passwordsMatch} from './admin-session.mjs';
const origin='https://rakyat-riview.vercel.app',cookieName='__Host-rr_admin_v2',seconds=1800;
const fail=(status,message)=>Object.assign(Error(message),{status});
export function normalizeAdminSupabaseUrl(value){
 const target='https://svuagnobufhfpgzmsyxx.supabase.co';
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
  production_enabled:env.ADMIN_V2_READONLY_PRODUCTION==='true',
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
  // Server-only, fixed keys/categories and booleans. Never values, lengths or hashes.
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
function requireSession(req,res){
 try{
  const entries=(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(cookieName+'='));if(entries.length!==1)throw Error();
  const token=entries[0].slice(cookieName.length+1);if(token.length>1024)throw Error();const [payload,sig,...extra]=token.split('.');if(extra.length||!payload||!sig)throw Error();const expected=sign(payload);
  if(sig.length!==expected.length||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))throw Error();
  const session=JSON.parse(Buffer.from(payload,'base64url')),now=Math.floor(Date.now()/1000);
  if(session.aud!=='rr-admin-v2-readonly'||!Number.isInteger(session.iat)||!Number.isInteger(session.exp)||session.iat>now||session.exp<=now||session.exp-session.iat!==seconds||!/^[A-Za-z0-9_-]{32}$/.test(session.nonce))throw Error();return true;
 }catch{res.setHeader('Set-Cookie',cookie(true));res.status(401).json({error:'Silakan masuk sebagai Admin.'});return false;}
}
export function createProductionAdmin({readPage=supabaseAdminReadPage,now=Date.now}={}){
 // Defense in depth per warm instance; not a distributed rate-limit guarantee.
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
 const readonly=createAdminReadonly({readPage,validateRequest,loginHandler:login,logoutHandler:logout,requireSession});
 return async(req,res)=>{res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");return readonly(req,res);};
}
export default createProductionAdmin();
