// No env files or production connection. --fixtures explicitly injects fake
// contract responses; default has the upstream contract gate forced CLOSED.
import {randomBytes} from 'node:crypto';
import {createAdminReadonlyServer} from './admin-readonly-server.mjs';
if(process.env.NODE_ENV==='production'||process.env.VERCEL)throw Error('Local preview only');
const fixture=process.argv.includes('--fixtures'),port=4191;
process.env.ADMIN_V2_READONLY_LOCAL='true';process.env.ADMIN_V2_READ_ORIGIN='http://127.0.0.1:'+port;
process.env.ADMIN_V2_READ_CONTRACT_READY=fixture?'true':'false';
let options={};
if(fixture){
 process.env.ADMIN_PASSWORD='demo-admin';process.env.ADMIN_SESSION_SECRET=randomBytes(48).toString('hex');process.env.CARD_PUBLIC_ORIGIN='https://cards.example.test';
 const uid='11111111-2222-4333-8444-555555555555',card_code='R'.repeat(24);
 options={fixture:true,readPage:async kind=>kind==='cards'?{cards:[{card_code,business_name:'Contoh Kontrak Read-Only',review_url:null,created_at:null,owner_id:uid,active:true,activation_revision:1,inventory_state:'claimed'}],next_cursor:null}:{events:[{id:'reset:1',at:'2026-11-07T00:00:00Z',action:'reset',card_code,actor:'Admin fixture',reason:'Contoh audit lokal, bukan event Supabase.',old_owner:uid,new_owner:null}],next_cursor:null}};
}
const server=createAdminReadonlyServer(options);server.on('error',e=>{console.error(e.code||'Local error');process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log('http://127.0.0.1:'+port+'/admin-v2.html\n'+(fixture?'SIMULASI KONTRAK READ-ONLY. Sandi demo: demo-admin. Tidak memakai Supabase.':'Kontrak Supabase CLOSED. Tidak memuat kredensial atau menjalankan query live.')));
