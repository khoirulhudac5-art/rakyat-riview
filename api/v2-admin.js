// Local restricted façade for the new Admin UI. No original RPC fallback.
import login from './admin-login.js';
import logout from './admin-logout.js';
import {requireAdminSession} from '../lib/admin-session.mjs';
import {config} from '../lib/buyer-service.mjs';
import {restrictedAdminReset,restrictedAdminUnsupported} from '../lib/restricted-app-adapter.mjs';
import adminReadonly from '../lib/admin-readonly.mjs';
export default async function handler(req,res){
  if(process.env.ADMIN_V2_READONLY_LOCAL==='true')return adminReadonly(req,res);
  res.setHeader('Cache-Control','no-store');
  const metadata={mode:'restricted',capabilities:{list:false,create:false,reset:process.env.ADMIN_V2_RESET_ENABLED==='true'&&process.env.RR_TEST_APP_WRITES==='true',audit:false}};
  try{
    const cfg=config();
    if(process.env.BUYER_RESTRICTED_APP!=='true'||process.env.NODE_ENV==='production'||process.env.VERCEL||!cfg.local||cfg.url!=='https://svuagnobufhfpgzmsyxx.supabase.co'||req.headers.host!==new URL(cfg.origin).host)throw Error();
    if(req.method==='POST'&&(req.headers.origin!==cfg.origin||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')))throw Error();
  }catch{return res.status(503).json({...metadata,authenticated:false,error:'Adapter Admin restricted belum diaktifkan. Akses tetap tertutup.'});}
  const action=req.method==='GET'?req.query?.action:req.body?.action;
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Metode tidak diizinkan.'});
  // Preserve authentication metadata even on an expired session response.
  const response={setHeader:(...v)=>res.setHeader(...v),status(n){this.code=n;return this;},json(data){return res.status(this.code||200).json({...metadata,...data});}};
  if(req.method==='POST'&&action==='login')return login(req,response);
  if(req.method==='POST'&&action==='logout')return logout(req,response);
  if(!requireAdminSession(req,response))return;
  if(req.method==='GET'&&action==='session')return response.status(200).json({authenticated:true});
  if(req.method==='POST'&&action==='reset')return restrictedAdminReset(req,response);
  return restrictedAdminUnsupported(req,response);
}
