// GET-only configuration review. Never saves API secrets/full response bodies.
import fs from 'node:fs';import path from 'node:path';
const origin='https://rakyat-riview.vercel.app',ref='svuagnobufhfpgzmsyxx';
const folder=path.resolve('.backups/pilot-deployment-config-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(folder,{recursive:false});
const report={at:new Date().toISOString(),project_ref:ref,origin,changesMade:false,loginPerformed:false,vercel:{verified:false,reason:'No Vercel connector/CLI/project link or usable authenticated browser available'}};
try{
 if(process.argv.includes('--public-provider-only')){
  const source=fs.readFileSync('r/001/index.html','utf8'),key=source.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0];
  if(!source.includes(ref)||!key)throw Error('Project public key unavailable');
  const r=await fetch(`https://${ref}.supabase.co/auth/v1/settings`,{method:'GET',headers:{apikey:key},signal:AbortSignal.timeout(20000)});
  const d=r.ok?await r.json():{};report.publicAuthSettings={verified:r.ok,httpStatus:r.status,googleEnabled:d.external?.google===true,callbackAllowlistVerified:false};
 }else{
 const token=process.env.SUPABASE_AUDIT_ACCESS_TOKEN;if(!token)throw Error('Read-only Supabase management credential unavailable');
 const r=await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`,{method:'GET',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});
 if(!r.ok){report.auth={verified:false,httpStatus:r.status};}
 else{
  const c=await r.json();const entries=Array.isArray(c.uri_allow_list)?c.uri_allow_list:String(c.uri_allow_list||'').split(',').map(s=>s.trim()).filter(Boolean);
  report.auth={verified:true,googleEnabled:c.external_google_enabled===true,googleClientConfigured:!!c.external_google_client_id,googleSecretConfigured:!!c.external_google_secret,
   siteURLMatchesProduction:c.site_url===origin,siteURLOrigin:(()=>{try{return new URL(c.site_url).origin;}catch{return null;}})(),
   productionCallback:origin+'/pembeli/oauth.html',productionCallbackExactAllowed:entries.includes(origin+'/pembeli/oauth.html'),
   productionWildcardEntries:entries.filter(s=>s.startsWith(origin+'/')&&s.includes('*')),
   redirectEntryCount:entries.length,googleCloudRedirectURI:`https://${ref}.supabase.co/auth/v1/callback`,googleCloudConsoleVerified:false};
 }
 report.routes=[];
 for(const p of ['/r/iKRb7_7PyK6kg4Ye7EqvOhYu','/r/RRROUTECHECK0000000000000','/pembeli/mulai.html','/pembeli/oauth.html','/pembeli/dashboard.html','/dashboard.html','/kartu.html','/api/buyer-google','/api/buyer?action=mode']){
  const r=await fetch(origin+p,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(20000)});await r.arrayBuffer();report.routes.push({path:p,status:r.status,type:r.headers.get('content-type')});
 }
 }
 report.status='READONLY_CONFIG_REVIEW_COMPLETE';
}catch{report.status='READONLY_REVIEW_INCOMPLETE';report.reason='Network/read-only management access unavailable; no retry or changes made';process.exitCode=1;}
fs.writeFileSync(path.join(folder,'RESULT.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({folder,...report}));
