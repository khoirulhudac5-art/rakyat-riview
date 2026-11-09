// Actual Supabase HTTP mode. No fixtures or .env.backup access.
import {readAdminEnv,adminConfigStatus,applyAdminReadConfig} from './admin-readonly-config.mjs';
import {createAdminReadonlyServer} from './admin-readonly-server.mjs';
try{
 const config={...process.env,...readAdminEnv('.env.admin-readonly')};
 if(process.argv.includes('--check')){const status=adminConfigStatus(config);console.log(JSON.stringify({mode:'configuration_only',...status,networkAccessed:false}));if(!status.ready)process.exitCode=1;}
 else{
  if(process.argv.length>2)throw Error('Mode live read-only tidak menerima opsi fixture.');
  const port=applyAdminReadConfig(config),server=createAdminReadonlyServer();
  server.on('error',()=>{console.error('Server Admin lokal tidak dapat dijalankan.');process.exitCode=1;});
  server.listen(port,new URL(config.ADMIN_V2_READ_ORIGIN).hostname,()=>console.log(config.ADMIN_V2_READ_ORIGIN+'/admin-v2.html\nSUPABASE READ-ONLY; tanpa fallback simulasi; generate/reset nonaktif.'));
 }
}catch(e){console.error(e.message);process.exitCode=1;}
