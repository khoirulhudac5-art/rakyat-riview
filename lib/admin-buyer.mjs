import {requireAdminRequest,requireAdminSession} from './admin-session.mjs';
export function authorize(req,res){res.setHeader('Cache-Control','no-store');if(process.env.ADMIN_V2_READONLY_LOCAL==='true'){res.status(405).json({error:'Mutasi Admin V2 tidak tersedia pada mode read-only.'});return false;}if(req.method!=='POST'){res.status(405).json({error:'Metode tidak diizinkan.'});return false;}return requireAdminRequest(req,res)&&requireAdminSession(req,res);}
export async function rpc(name,args){
  const raw=process.env.SUPABASE_URL,key=process.env.SUPABASE_SECRET_KEY;
  if(!raw||!key)throw Error('Server belum dikonfigurasi.');
  const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password)throw Error('Konfigurasi server tidak valid.');
  const r=await fetch(url.origin+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw Error('Operasi admin ditolak. Periksa kesiapan migration dan izin.');return r.json();
}
