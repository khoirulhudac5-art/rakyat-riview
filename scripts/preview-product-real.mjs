// Reuse the existing, previously tested callback origin. No Auth configuration
// or card database changes; 4186 explicitly redirects before any form is filled.
import http from 'node:http';
import fs from 'node:fs';
import {existingConfig} from './existing-config.mjs';
export async function startRealProduct(createProductPreview){
  process.loadEnvFile('.env.existing');
  existingConfig();
  if(process.env.BUYER_GOOGLE_ENABLED!=='true')throw Error('Google OAuth is not enabled in the existing local configuration.');
  process.env.BUYER_RESTRICTED_APP='true';
  const restrictedRun=process.argv.includes('--restricted-run');
  if(!restrictedRun)process.env.RR_TEST_APP_WRITES='false';
  else{
    const plan=JSON.parse(fs.readFileSync('.local-tools/first-claim-live/plan.json','utf8'));
    if(plan.project_ref!=='svuagnobufhfpgzmsyxx'||plan.status!=='ACTIVE_RESTRICTED_TEST'||plan.fixtures?.length!==2||!plan.expires_at)throw Error('No approved active restricted run has been recorded locally.');
    process.env.RR_TEST_APP_WRITES='true';process.env.RR_TEST_RUN_ID=plan.run_id;
    process.env.RR_TEST_CARD_CODES=plan.fixtures.map(c=>c.card_code).join(',');process.env.RR_TEST_RUN_EXPIRES_AT=plan.expires_at;
  }
  const server=createProductPreview({integration:true,restrictedRun});
  const frontdoor=http.createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||![`127.0.0.1:4186`,`localhost:4186`].includes(req.headers.host))return res.writeHead(403).end();
    if(!['GET','HEAD'].includes(req.method))return res.writeHead(403,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Mode Google nyata memakai origin callback http://127.0.0.1:4180. Muat ulang halaman; draft lama 4186 tidak dihapus.'}));
    const url=new URL(req.url,'http://127.0.0.1:4186');
    const allowed=url.pathname==='/preview-new-card'||url.pathname==='/pembeli/'||/^\/pembeli\/[A-Za-z0-9_.-]+$/.test(url.pathname);
    const path=allowed?url.pathname+url.search:'/preview-new-card';
    res.writeHead(302,{Location:'http://127.0.0.1:4180'+path});res.end();
  });
  const listen=(s,p)=>new Promise((ok,no)=>{s.once('error',no);s.listen(p,'127.0.0.1',ok);});
  try{await listen(server,4180);await listen(frontdoor,4186);}catch(error){server.close();frontdoor.close();throw Error('Real preview could not bind its local ports: '+(error.code||'local error'));}
  console.log('GOOGLE ASLI — Supabase Rakyat Review existing\nBuka: http://127.0.0.1:4186/preview-new-card\nOrigin OAuth teruji: http://127.0.0.1:4180\n'+(restrictedRun?'Adapter wrapper restricted dipilih; registry dan grants database tetap menentukan izin.':'Kartu konteks lokal saja; seluruh akses kartu V2 tetap closed.')+' Tidak ada akun demo atau perubahan konfigurasi database.');
  return {server,frontdoor};
}
