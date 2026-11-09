// Strict response projection: unknown text/fields are discarded, not regex-redacted.
const messages=new Map([
 ['Admin V2 production belum dikonfigurasi. Akses tetap tertutup.','ADMIN_CONFIG_UNAVAILABLE'],
 ['Silakan masuk sebagai Admin.','ADMIN_SESSION_REQUIRED'],
 ['Permintaan Admin harus berasal dari website yang sama.','ADMIN_ORIGIN_REJECTED'],
 ['Permintaan tidak diizinkan.','ADMIN_REQUEST_REJECTED'],
 ['Metode tidak diizinkan.','METHOD_REJECTED'],
 ['Adapter baca Admin belum dapat digunakan.','ADMIN_ADAPTER_UNAVAILABLE'],
 ['Mode read-only menolak generate, reset, dan seluruh mutasi kartu.','ADMIN_READONLY_WRITE_DENIED']
]);
const safeId=value=>typeof value==='string'&&value.length<=180&&/^[A-Za-z0-9;:_-]+$/.test(value)?value:null;
const guardKeys=['production_enabled','origin_matches','read_contract_enabled','supabase_target_valid','server_key_present','admin_password_present','admin_password_policy','signing_secret_present','signing_secret_policy'];
export function sanitizeAdminGuardLog(message){
 if(typeof message!=='string'||Buffer.byteLength(message)>4096)return null;
 try{const data=JSON.parse(message);if(data?.event!=='admin_v2_configuration_guard_failed'||data.category!=='ADMIN_CONFIG_UNAVAILABLE'||!data.checks||!guardKeys.every(k=>typeof data.checks[k]==='boolean'))return null;
  return {event:'admin_v2_configuration_guard_failed',category:'ADMIN_CONFIG_UNAVAILABLE',checks:Object.fromEntries(guardKeys.map(k=>[k,data.checks[k]]))};
 }catch{return null;}
}
export function sanitizeAdminPostflight(response){
 const status=Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:null;
 const header=name=>response.headers?.get?.(name)||null;
 const type=(header('content-type')||'').split(';')[0].trim().toLowerCase();
 const contentType=['application/json','text/html','text/plain'].includes(type)?type:'other';
 let body={redacted:true,reason:'UNRECOGNIZED_OR_NON_JSON_BODY'},category=status===401?'HTTP_UNAUTHORIZED':'UNCLASSIFIED_HTTP_RESPONSE';
 const raw=typeof response.body==='string'?response.body:'';
 if(Buffer.byteLength(raw)<=16384){try{
  const data=JSON.parse(raw);if(data&&typeof data==='object'&&!Array.isArray(data)){
   body={};if(typeof data.error==='string'){const known=messages.get(data.error);body.error=known?data.error:'[REDACTED_UNRECOGNIZED_ERROR]';if(known)category=known;}
   for(const [key,values] of [['mode',['admin_readonly','synthetic','restricted']],['data_source',['supabase','contract_fixture']]])if(values.includes(data[key]))body[key]=data[key];
   for(const key of ['read_only','authenticated'])if(typeof data[key]==='boolean')body[key]=data[key];
   if(data.capabilities&&typeof data.capabilities==='object'){body.capabilities={};for(const key of ['list','audit','create','reset'])if(typeof data.capabilities[key]==='boolean')body.capabilities[key]=data.capabilities[key];}
   if(Object.keys(body).length===0)body={redacted:true,reason:'NO_ALLOWLISTED_FIELDS'};
  }
 }catch{}}
 else body={redacted:true,reason:'BODY_TOO_LARGE'};
 if(status>=300&&status<400){try{const location=new URL(header('location'));if(location.hostname==='vercel.com'&&location.pathname.startsWith('/sso-api'))category='DEPLOYMENT_PROTECTION_REDIRECT';}catch{}}
 return {status,category,contentType,requestId:safeId(header('x-vercel-id')),body};
}
export function recordAdminSessionPostflight(attempt,response,save){
 attempt.adminSessionPostflight=sanitizeAdminPostflight(response);
 save(); // Persist BEFORE assertions and before rollback can replace the overall status.
 if(response.status!==401)throw Error('Admin session postflight failed: '+attempt.adminSessionPostflight.category);
 return attempt.adminSessionPostflight;
}
export async function runAdminSessionPostflight(attempt,getResponse,save){
 let response;
 try{response=await getResponse();}catch{
  attempt.adminSessionPostflight={status:null,category:'HTTP_TRANSPORT_ERROR',contentType:'other',requestId:null,body:{redacted:true,reason:'NO_RESPONSE_OR_BODY_READ_FAILED'}};
  save();throw Error('Admin session postflight failed: HTTP_TRANSPORT_ERROR');
 }
 recordAdminSessionPostflight(attempt,response,save);return response;
}
