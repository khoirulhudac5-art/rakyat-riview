// Explicitly synthetic in-memory model for local HTTP/concurrency tests.
import {directReview} from '../pembeli/maps.mjs';
export function firstClaimModel(cards,account,body,limits,now=Date.now()){
  const error=(status,message)=>({status,data:{error:message}});
  if(!account?.google)return error(403,'Gunakan akun Google untuk mengklaim kartu baru.');
  if(typeof body.card_code!=='string'||!/^[A-Za-z0-9_-]{24}$/.test(body.card_code)||typeof body.business_name!=='string'||!body.business_name.trim()||body.business_name.trim().length>150||!directReview(body.review_url)||directReview(body.review_url)!==body.review_url)return error(400,'Identitas atau link review tidak valid.');
  const limit=limits.get(account.id)||{start:now,count:0};if(limit.start<=now-900000){limit.start=now;limit.count=0;}limit.count++;limits.set(account.id,limit);
  if(limit.count>20)return error(429,'Terlalu banyak percobaan. Tunggu 15 menit.');
  const card=cards.find(c=>c.card_code===body.card_code);
  if(!card||card.claim_mode!=='google_first_claim')return error(409,'Kartu tidak dapat diklaim dengan metode ini.');
  if(card.owner)return card.owner===account.id&&card.active?{status:200,data:{success:true,card_code:card.card_code}}:error(409,'Kartu sudah dimiliki akun lain.');
  if(card.inventory_state!=='ready')return error(409,'Kartu belum siap diaktifkan oleh inventaris.');
  if(card.active||card.pin||card.review_url)return error(409,'Kartu sudah aktif.');
  // No await between checks and commit: this models, but does not prove, SQL locks.
  Object.assign(card,{owner:account.id,active:true,inventory_state:'claimed',business_name:body.business_name.trim(),review_url:body.review_url});
  return {status:200,data:{success:true,card_code:card.card_code}};
}
