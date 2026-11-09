import { createPreview } from './preview-accounts.mjs';
const server=createPreview({scan:true});
server.on('error',e=>{console.error(e.message);process.exitCode=1;});
server.listen(4177,'127.0.0.1',()=>console.log('Scan publik sintetis: http://127.0.0.1:4177/r/SYN-SCAN\nSimulasi kemasan: http://127.0.0.1:4177/preview-package'));
