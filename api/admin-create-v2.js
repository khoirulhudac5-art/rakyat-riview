import {authorize,rpc} from '../lib/admin-buyer.mjs';
import {restrictedAdminUnsupported} from '../lib/restricted-app-adapter.mjs';
export default async function handler(req,res){
  if(process.env.BUYER_RESTRICTED_APP==='true')return restrictedAdminUnsupported(req,res);
  if(!authorize(req,res))return;
  if(process.env.ADMIN_V2_CREATION_ENABLED!=='true')return res.status(503).json({error:'Pembuatan kartu V2 belum diaktifkan.'});
  const quantity=req.body?.quantity;
  if(!Number.isInteger(quantity)||quantity<1||quantity>1000)return res.status(400).json({error:'Jumlah kartu harus 1 sampai 1000.'});
  try{const origin=new URL(process.env.CARD_PUBLIC_ORIGIN);if(origin.protocol!=='https:'||origin.origin!==process.env.CARD_PUBLIC_ORIGIN)throw Error('Domain permanen kartu belum dikonfigurasi.');
    const cards=await rpc('admin_create_v2_cards',{p_quantity:quantity});
    return res.status(200).json({cards:cards.map(c=>({card_code:c.card_code,card_url:origin.origin+'/r/'+encodeURIComponent(c.card_code)}))});
  }catch(e){return res.status(503).json({error:e.message==='Domain permanen kartu belum dikonfigurasi.'?e.message:'Pembuatan kartu V2 belum dapat diproses. Periksa konfigurasi dan migration.'});}
}
