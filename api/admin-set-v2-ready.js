import {createHash} from 'node:crypto';
import {authorize,rpc} from '../lib/admin-buyer.mjs';
import {restrictedAdminUnsupported} from '../lib/restricted-app-adapter.mjs';
export default async function handler(req,res){
 if(process.env.BUYER_RESTRICTED_APP==='true')return restrictedAdminUnsupported(req,res);
 if(!authorize(req,res))return;
 if(process.env.ADMIN_V2_INVENTORY_ENABLED!=='true')return res.status(503).json({error:'Pengelolaan kesiapan stok V2 belum diaktifkan.'});
 const {card_code,ready}=req.body||{};
 if(typeof card_code!=='string'||!/^[A-Za-z0-9_-]{24}$/.test(card_code)||typeof ready!=='boolean')return res.status(400).json({error:'ID kartu dan status kesiapan tidak valid.'});
 const actor='admin-session:'+createHash('sha256').update(req.headers.cookie||'').digest('hex').slice(0,24);
 try{const ok=await rpc('admin_set_v2_card_ready',{p_card_code:card_code,p_ready:ready,p_actor:actor});if(ok!==true)return res.status(409).json({error:'Status stok ditolak. Kartu mungkin sudah aktif, dimiliki, atau bukan kartu V2.'});return res.status(200).json({success:true});}
 catch{return res.status(503).json({error:'Status stok belum dapat dikonfirmasi.'});}
}
