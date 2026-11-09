import {createHash} from 'node:crypto';
import {authorize,rpc} from '../lib/admin-buyer.mjs';
import {restrictedAdminReset} from '../lib/restricted-app-adapter.mjs';
export default async function handler(req,res){
 if(process.env.BUYER_RESTRICTED_APP==='true')return restrictedAdminReset(req,res);
 if(!authorize(req,res))return;
 if(process.env.ADMIN_V2_RESET_ENABLED!=='true')return res.status(503).json({error:'Reset aktivasi V2 belum diaktifkan.'});
 const {card_code,confirmation,expected_revision,reason,acknowledged}=req.body||{};
 if(typeof card_code!=='string'||!/^[A-Za-z0-9_-]{24}$/.test(card_code)||confirmation!==card_code||acknowledged!==true||!Number.isSafeInteger(expected_revision)||expected_revision<0||typeof reason!=='string'||reason.trim().length<20||reason.trim().length>1000)return res.status(400).json({error:'Konfirmasikan ID kartu, dampak reset, dan alasan minimal 20 karakter.'});
 const actor='admin-session:'+createHash('sha256').update(req.headers.cookie||'').digest('hex').slice(0,24);
 try{const ok=await rpc('admin_reset_v2_activation',{p_card_code:card_code,p_confirmation:confirmation,p_expected_revision:expected_revision,p_actor:actor,p_reason:reason.trim()});if(ok!==true)return res.status(409).json({error:'Reset ditolak: kartu tidak aktif, data berubah, atau bukan kartu V2. Muat ulang daftar.'});return res.status(200).json({success:true});}catch{return res.status(503).json({error:'Reset belum terkonfirmasi. Muat ulang status sebelum mencoba lagi.'});}
}
