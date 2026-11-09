// Isolated, visibly synthetic dashboard preview. No .env files, Supabase,
// restricted-run runner, Google tokens or existing preview state are used.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createProductPreview} from './preview-product.mjs';
import {demoAccounts} from './product-model.mjs';
if(process.env.NODE_ENV==='production'||process.env.VERCEL)throw Error('Dashboard preview is local development only.');
const file=path.resolve('.local-tools/buyer-dashboard-preview/state.json');
if(!fs.existsSync(file)){
 const state={version:1,synthetic:true,cards:[{
  card_code:randomBytes(18).toString('base64url'),business_name:'Usaha Contoh · SIMULASI',
  // Public example Place ID from Google's Maps place-details documentation.
  review_url:'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4',
  active:true,owner:demoAccounts.first.id,pin:null,claim_mode:'google_first_claim',
  inventory_state:'claimed',activation_revision:1,created_at:new Date().toISOString()
 }],events:[],audit:[]};
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(state,null,2),{flag:'wx',mode:0o600});
}
const server=createProductPreview({file});
server.on('error',e=>{console.error('Local dashboard preview:',e.code||'local error');process.exitCode=1;});
server.listen(4187,'127.0.0.1',()=>console.log('SIMULASI LOKAL — bukan data Supabase/Google.\nhttp://127.0.0.1:4187/pembeli/dashboard.html\nMasuk sebagai akun demo A untuk membuka satu kartu contoh; tidak perlu mengulang klaim.\nStatistik hanya berasal dari kunjungan preview lokal; NFC/QR tidak dipisahkan.'));
