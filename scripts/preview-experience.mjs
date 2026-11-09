import {createPreview} from './preview-accounts.mjs';
const server=createPreview({experience:true,firstClaim:true});
server.on('error',e=>{console.error(e.message);process.exitCode=1;});
server.listen(4178,'127.0.0.1',()=>console.log('Kartu baru first claim SINTETIS: http://127.0.0.1:4178/preview-new-card\nDraft legacy: http://127.0.0.1:4178/r/SYN-DRAFT\nDashboard: http://127.0.0.1:4178/pembeli/\nGoogle OAuth belum aktif. Kepemilikan preview hanya di memori, bukan Supabase.'));
