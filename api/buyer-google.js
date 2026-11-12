import { randomBytes,createHash,timingSafeEqual } from 'node:crypto';
import { config,guard,upstream,cookies,BuyerError,isAllowedOrigin } from '../lib/buyer-service.mjs';
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  try{const cfg=config();if(req.method==='GET')return res.status(200).json({enabled:process.env.BUYER_GOOGLE_ENABLED==='true'});
    if(req.method!=='POST')return res.status(405).json({error:'Metode tidak diizinkan.'});guard(req,cfg);
    if(process.env.BUYER_GOOGLE_ENABLED!=='true')throw new BuyerError(503,'Login Google belum dikonfigurasi. Draft Anda tetap tersimpan.');
    const origin = req.headers.origin || req.headers.referer;
    const effectiveOrigin = (origin && isAllowedOrigin(origin, cfg)) ? (new URL(origin).origin) : cfg.origin;
    const prefix=cfg.local?'rr_oauth_':'__Host-rr_oauth_';
    const make=(k,v,age=600)=>`${prefix}${k}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${cfg.local?'':'; Secure'}`;
    if(req.body?.action==='start'){
      const verifier=randomBytes(32).toString('base64url'),state=randomBytes(32).toString('base64url');
      const url=new URL(cfg.url+'/auth/v1/authorize');url.searchParams.set('provider','google');url.searchParams.set('redirect_to',effectiveOrigin+'/pembeli/oauth.html');url.searchParams.set('code_challenge',createHash('sha256').update(verifier).digest('base64url'));url.searchParams.set('code_challenge_method','s256');
      // Bind this browser tab to the HttpOnly state cookie without a dynamic
      // callback URL. The PKCE verifier remains server-only.
      res.setHeader('Set-Cookie',[make('verifier',verifier),make('state',state)]);return res.status(200).json({url:url.href,state});
    }
    if(req.body?.action!=='callback')throw new BuyerError(400,'Aksi tidak dikenal.');
    const read=k=>{const matches=(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(prefix+k+'='));return matches.length===1?matches[0].slice((prefix+k+'=').length):'';};
    const state=read('state'),given=req.body.state,verifier=read('verifier');
    if(!/^[A-Za-z0-9_-]{43}$/.test(state)||typeof given!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(given)||!timingSafeEqual(Buffer.from(state),Buffer.from(given))||!/^[A-Za-z0-9_-]{43}$/.test(verifier)||typeof req.body.code!=='string'||!req.body.code||req.body.code.length>2048)throw new BuyerError(400,'Login tidak valid atau kedaluwarsa. Mulai login lagi.');
    let data;
    try{data=await upstream(cfg,'/auth/v1/token?grant_type=pkce',{method:'POST',body:{auth_code:req.body.code,code_verifier:verifier}});}
    catch(error){if(error instanceof BuyerError&&[400,401].includes(error.status))throw new BuyerError(400,'Sesi login Google kedaluwarsa atau tidak valid. Mulai login lagi; informasi kartu tetap tersimpan.');throw error;}
    res.setHeader('Set-Cookie',[...cookies(data,cfg),make('state','',0),make('verifier','',0)]);return res.status(200).json({success:true});
  }catch(e){return res.status(e instanceof BuyerError?e.status:500).json({error:e instanceof BuyerError?e.message:'Login belum dapat diproses.'});}
}
