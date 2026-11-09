import { config, upstream, BuyerError } from '../lib/buyer-service.mjs';
import {restrictedStatus} from '../lib/restricted-app-adapter.mjs';
export default async function handler(req,res){
  if(process.env.BUYER_PILOT_ENABLED==='true'){
    const {createPilotHandlers}=await import('../lib/public-pilot.mjs');return createPilotHandlers().status(req,res);
  }
  if(process.env.BUYER_RESTRICTED_APP==='true')return restrictedStatus(req,res);
  res.setHeader('Cache-Control','no-store');if(req.method!=='GET')return res.status(405).json({error:'Metode tidak diizinkan.'});
  try{const code=req.query?.card;if(typeof code!=='string'||!/^[A-Za-z0-9_-]{1,30}$/.test(code))throw new BuyerError(400,'Identitas kartu tidak valid.');
    const cfg=config();
    if(process.env.BUYER_FIRST_CLAIM_ENABLED==='true'){
      const status=await upstream(cfg,'/rest/v1/rpc/buyer_public_card_status',{method:'POST',body:{p_card_code:code}});
      if(!status)return res.status(404).json({error:'Kartu tidak ditemukan.'});
      return res.status(200).json(status);
    }
    const rows=await upstream(cfg,'/rest/v1/card_public?card_code=eq.'+encodeURIComponent(code)+'&select=card_code,review_url&limit=1');
    if(!Array.isArray(rows)||!rows.length)return res.status(404).json({error:'Kartu tidak ditemukan.'});
    // Public view cannot prove activation/ownership. Do not infer authorization.
    return res.status(200).json({code,configured:Boolean(rows[0].review_url),activation_state:'unverified',claim_allowed:false});
  }catch(e){return res.status(e.status||500).json({error:e instanceof BuyerError?e.message:'Status kartu belum tersedia.'});}
}
