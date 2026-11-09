import { mapsInput, directReview } from '../pembeli/maps.mjs';

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  const fail=(status,code,error,upstream_status)=>{
    // No input URL, customer name, credentials or response body in server logs.
    console.warn('[review-convert]',JSON.stringify({code,...(upstream_status?{upstream_status}:{})}));
    return res.status(status).json({error,code});
  };
  if(req.method!=='POST')return res.status(405).json({error:'Metode tidak diizinkan.',code:'METHOD_NOT_ALLOWED'});
  const input=req.body?.maps_url;
  if(typeof input!=='string'||!mapsInput(input.trim()))return fail(400,'INVALID_MAPS_URL','Gunakan link Bagikan dari lokasi usaha di Google Maps, bukan alamat beranda Maps.');
  const existing=directReview(input.trim());
  if(existing)return res.status(200).json({review_url:existing,verification:'user_provided'});
  let response;
  try{
    response=await fetch('https://productmate.com/api/v1/google-review-link',{
      method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({maps_url:input.trim()}),signal:AbortSignal.timeout(15000)
    });
  }catch(error){
    const cause=error.cause?.code;
    if(['EACCES','EPERM'].includes(cause))return fail(503,'RESOLVER_NETWORK_BLOCKED','Server lokal belum diizinkan mengakses layanan konversi. Ini bukan kesalahan link Anda.');
    if(['TimeoutError','AbortError'].includes(error.name)||['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(cause))return fail(504,'RESOLVER_TIMEOUT','Layanan konversi terlalu lama merespons. Coba lagi sebentar.');
    return fail(502,'RESOLVER_NETWORK_ERROR','Server belum dapat terhubung ke layanan konversi. Coba lagi sebentar.');
  }
  if(response.status===429){res.setHeader('Retry-After','60');return fail(429,'RESOLVER_RATE_LIMIT','Batas konversi tercapai. Tunggu satu menit lalu coba lagi.',429);}
  if([401,403].includes(response.status))return fail(503,'RESOLVER_ACCESS_DENIED','Akses server ke layanan konversi ditolak. Konfigurasi layanan perlu diperiksa.',response.status);
  if([400,422].includes(response.status))return fail(422,'RESOLVER_INPUT_REJECTED','Resolver tidak dapat mengenali lokasi ini. Buka halaman usaha yang tepat di Google Maps, pilih Bagikan, lalu salin ulang link.',response.status);
  if(!response.ok)return fail(502,'RESOLVER_UPSTREAM_ERROR','Layanan konversi sedang tidak tersedia. Coba lagi nanti, atau tempel link formulir Google Review langsung jika sudah tersedia.',response.status);
  let data;try{data=await response.json();}catch{return fail(502,'RESOLVER_BAD_RESPONSE','Layanan konversi mengirim respons yang tidak dapat dibaca. Coba lagi sebentar.',response.status);}
  const canonical=directReview(data?.review_url);
  if(!canonical||(data.place_id!==undefined&&data.place_id!==new URL(canonical).searchParams.get('placeid')))return fail(502,'RESOLVER_INVALID_RESULT','Hasil konversi belum valid. Link tidak akan disimpan; coba link Bagikan Maps lain.',response.status);
  return res.status(200).json({place_id:new URL(canonical).searchParams.get('placeid'),review_url:canonical,verification:'not_verified'});
}
