import {createHash} from 'node:crypto';
import {authorize,rpc} from '../lib/admin-buyer.mjs';
import {restrictedAdminUnsupported} from '../lib/restricted-app-adapter.mjs';
export default async function handler(req,res){
  if(process.env.BUYER_RESTRICTED_APP==='true')return restrictedAdminUnsupported(req,res);
  if(!authorize(req,res))return;
  if(process.env.ADMIN_BUYER_RECOVERY_ENABLED!=='true')return res.status(503).json({error:'Pemulihan kepemilikan belum diaktifkan oleh pengelola.'});
  const {card_code,new_owner,reason,confirmation}=req.body||{};
  if(typeof card_code!=='string'||!/^[A-Za-z0-9_-]{24}$/.test(card_code)||confirmation!==card_code||typeof new_owner!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(new_owner)||typeof reason!=='string'||reason.trim().length<20||reason.trim().length>1000)return res.status(400).json({error:'Isi ID kartu, akun tujuan, alasan pemulihan, dan konfirmasi ID kartu dengan benar.'});
  const actor='admin-session:'+createHash('sha256').update(req.headers.cookie||'').digest('hex').slice(0,24);
  try{const ok=await rpc('admin_recover_v2_owner',{p_card_code:card_code,p_new_owner:new_owner,p_actor:actor,p_reason:reason.trim()});if(ok!==true)return res.status(409).json({error:'Pemulihan ditolak. Pastikan kartu V2 aktif dan akun tujuan mempunyai identitas Google.'});return res.status(200).json({success:true});}
  catch{return res.status(503).json({error:'Pemulihan belum tersedia. Tidak ada perubahan yang dikonfirmasi.'});}
}
