import {requireAdminSession} from '../lib/admin-session.mjs';
import {rpc} from '../lib/admin-buyer.mjs';
import {restrictedAdminUnsupported} from '../lib/restricted-app-adapter.mjs';
export default async function handler(req,res){
 if(process.env.BUYER_RESTRICTED_APP==='true')return restrictedAdminUnsupported(req,res);
 res.setHeader('Cache-Control','no-store');if(req.method!=='GET')return res.status(405).json({error:'Metode tidak diizinkan.'});if(!requireAdminSession(req,res))return;
 try{return res.status(200).json({cards:await rpc('admin_list_v2_activation_cards',{}),reset_enabled:process.env.ADMIN_V2_RESET_ENABLED==='true',creation_enabled:process.env.ADMIN_V2_CREATION_ENABLED==='true'});}catch{return res.status(503).json({error:'Daftar aktivasi V2 belum tersedia. Periksa kesiapan migration.'});}
}
