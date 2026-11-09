// No fixture options; current approval only activates the DB grant, not a card.
import {readAdminEnv,applyAdminReadConfig} from './admin-readonly-config.mjs';
import {createAdminReadonlyServer} from './admin-readonly-server.mjs';
import {createLiveAdminGenerate} from '../lib/admin-generate-live.mjs';
import {createOneCardAdmin} from '../lib/admin-one-card-gate.mjs';
import path from 'node:path';
try{
 if(process.argv.length>2)throw Error('Mode backend ini belum menerima scope pembuatan kartu.');
 const e={...process.env,...readAdminEnv('.env.admin-readonly'),ADMIN_V2_READ_ORIGIN:'http://127.0.0.1:4194'};
 applyAdminReadConfig(e);process.env.ADMIN_GENERATE_LIVE_LOCAL='true';process.env.ADMIN_GENERATE_DOMAIN_CONFIRMED='false';
 const server=createAdminReadonlyServer({handler:createOneCardAdmin({permitFile:path.resolve('.local-tools/admin-generate-one-card/permit.json')})});
 server.on('error',()=>{console.error('Backend Generate lokal tidak dapat dijalankan.');process.exitCode=1;});
 server.listen(4194,'127.0.0.1',()=>console.log('http://127.0.0.1:4194/admin-v2.html\nSUPABASE NYATA · sesi Admin wajib · create ditahan sampai izin uji satu kartu · reset/ekspor tetap tertutup.'));
}catch{console.error('Konfigurasi backend Generate tidak siap; tidak ada kartu dibuat atau credential ditampilkan.');process.exitCode=1;}
