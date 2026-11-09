// Shared URL contract and debounced conversion; no fabricated Place IDs.
const hosts=new Set(['maps.app.goo.gl','goo.gl','google.com','www.google.com','maps.google.com','search.google.com','google.co.id','www.google.co.id']);
export function mapsInput(value){
  try{const u=new URL(value);return typeof value==='string'&&value.length<=8192&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&hosts.has(u.hostname)&&
    (u.hostname!=='maps.app.goo.gl'||/^\/[A-Za-z0-9_-]+\/?$/.test(u.pathname))&&
    (u.hostname!=='goo.gl'||/^\/maps\/[A-Za-z0-9_-]+\/?$/.test(u.pathname))&&
    (!['google.com','www.google.com','google.co.id','www.google.co.id'].includes(u.hostname)||u.pathname.startsWith('/maps')||u.pathname==='/local/writereview');}catch{return false;}
}
export function directReview(value){
  try{const u=new URL(value);const ids=u.searchParams.getAll('placeid');
    if(u.protocol!=='https:'||u.hostname!=='search.google.com'||u.port||u.username||u.password||u.pathname!=='/local/writereview'||ids.length!==1||!/^ChI[A-Za-z0-9_-]{5,250}$/.test(ids[0]))return null;
    return 'https://search.google.com/local/writereview?placeid='+encodeURIComponent(ids[0]);
  }catch{return null;}
}
export function converter({resolve,update,delay=650,schedule=setTimeout,cancel=clearTimeout}){
  let version=0,timer,controller;
  return {
    input(raw){const current=++version;cancel(timer);controller?.abort();const value=raw.trim();update({state:'idle',url:null});if(!value)return;
      if(!mapsInput(value)){update({state:'error',url:null,message:'Gunakan link Bagikan dari Google Maps atau link Google Review HTTPS.'});return;}
      const direct=directReview(value);
      if(direct){update({state:'ready',url:direct,verification:'user_provided',message:'Link Google Review langsung siap. Tidak memerlukan layanan konversi; coba link untuk memeriksa lokasi usaha.'});return;}
      update({state:'loading',url:null,message:'Menyiapkan link review…'});
      timer=schedule(async()=>{controller=new AbortController();try{const result=await resolve(value,controller.signal);if(current!==version)return;const url=directReview(result.review_url);if(!url)throw Error('Hasil konversi belum valid.');update({state:'ready',url,message:result.verification==='not_verified'?'Link review siap. Lokasi belum diverifikasi otomatis; coba link dan pastikan usaha yang terbuka benar.':'Link review siap. Coba link dan pastikan lokasi usaha benar.'});}catch(e){if(current===version)update({state:'error',url:null,code:e.code||null,message:e.message||'Link belum dapat diproses. Coba link Bagikan Google Maps yang lain.'});}},delay);
    },dispose(){version++;cancel(timer);controller?.abort();}
  };
}
export async function resolveMaps(value,signal){
  let r;try{r=await fetch('/api/convert-review',{method:'POST',headers:{'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify({maps_url:value}),signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(20000)])});}
  catch(e){if(e.name==='TimeoutError')throw Error('Konversi terlalu lama. Coba lagi sebentar.');if(e.name==='AbortError')throw e;throw Error('Tidak dapat menghubungi server preview. Periksa apakah server masih berjalan.');}
  const data=await r.json().catch(()=>({}));if(!r.ok){const error=Error(data.error||'Konversi gagal. Salin ulang link dari tombol Bagikan di Google Maps.');error.code=data.code;throw error;}return data;
}
