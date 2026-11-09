import {googleLogin} from './drafts.mjs';
const el=id=>document.getElementById(id);
const requestedAccount=new URLSearchParams(location.search).get('account');
const expectedAccount=['A','B'].includes(requestedAccount)?requestedAccount:null;
const returnPath='/pembeli/claim-test.html'+(expectedAccount?'?account='+expectedAccount:'');
let label=null,instance=null,allowed=true,inflight=false,checkingStatus=false,lastCheck=0;
const post=(path,body)=>fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify(body)});
async function register(){
 if(inflight||!allowed)return;inflight=true;el('register').disabled=true;lastCheck=Date.now();
 try{
  const body={action:'register',...(expectedAccount?{expectedAccount}:{})};
  let r=await post('/api/claim-test',body),data=await r.json();
  if(r.status===401&&data.canRefresh){const refreshed=await post('/api/buyer',{action:'refresh'});if(refreshed.ok){r=await post('/api/claim-test',body);data=await r.json();}else if(![400,401].includes(refreshed.status)){throw Error('Pembaruan sesi belum dapat menghubungi Supabase. Coba Periksa sesi lagi; tidak perlu login ulang.');}}
  if(!r.ok){label=null;el('message').textContent=data.error||'Sesi belum dapat diperiksa.';el('identity').textContent=data.code==='ACCOUNT_MISMATCH'?'Sesi aplikasi '+data.label+' (UID …'+data.uidSuffix+') terverifikasi di '+data.browser+'; halaman ini menunggu '+expectedAccount+'.':data.code==='PREPARATION_CLOSED'?'Persiapan sesi pada runner lama sudah ditutup.':data.code==='ACCOUNT_NOT_ALLOWED'?'Sesi Google terdeteksi, tetapi akunnya bukan A/B.':data.code==='SESSION_RENEWAL_REQUIRED'?'Sesi terdeteksi; pembaruan token belum selesai.':'Sesi penguji belum terverifikasi pada browser ini.';el('login').hidden=!data.loginRequired;el('switch-account').hidden=!data.switchAccount;return;}
  label=data.label;instance=data.instanceId;el('identity').textContent='Sesi Google nyata penguji '+label+' terdaftar di '+data.browser+'. UID …'+data.uidSuffix+' diverifikasi oleh Supabase Auth, bukan ditentukan oleh nama browser.';el('login').hidden=true;el('switch-account').hidden=true;el('message').textContent='';
 }catch(error){el('message').textContent=error.message==='Failed to fetch'?'Server persiapan belum dapat dihubungi. Klik Periksa sesi lagi setelah server tersedia.':error.message;el('login').hidden=true;}
 finally{inflight=false;el('register').disabled=!allowed;}
}
async function status(){
 if(checkingStatus)return;checkingStatus=true;
 try{
  const r=await fetch('/api/claim-test',{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();
  const restarted=instance!==null&&instance!==s.instanceId;instance=s.instanceId;allowed=s.registrationAllowed===true;
  el('scope').textContent=s.preparationOnly?'MODE PERSIAPAN SAJA · Akses kartu live tetap closed. Tidak ada open_run, dummy, atau hitungan 30 menit yang berjalan.':'Pengujian terbatas mengikuti kontrol operator. Persiapan sesi terpisah dari batas waktu run database.';
  el('phase').textContent=s.phase+' · A '+(s.ready.A?'siap':'menunggu')+' · B '+(s.ready.B?'siap':'menunggu');
  el('ready-a').textContent=s.ready.A?'Siap · '+s.browsers.A:'Menunggu sesi aplikasi A';el('ready-b').textContent=s.ready.B?'Siap · '+s.browsers.B:'Menunggu sesi aplikasi B';
  el('results').replaceChildren(...s.results.map(v=>{const li=document.createElement('li');li.textContent=(v.pass?'PASS: ':'FAIL: ')+v.name;return li;}));
  el('register').disabled=!allowed||inflight;el('relogin').hidden=!(label==='A'&&s.needsRelogin);
  if(!allowed){el('message').textContent=s.failure||'Runner sudah selesai. Sesi Google tidak perlu diulang hanya karena status ini. Halaman tetap memantau server persiapan.';el('identity').textContent='Pendaftaran sesi sedang ditutup; status login belum diperiksa.';el('login').hidden=true;el('switch-account').hidden=true;}
  else if(s.needsRelogin&&label==='A')el('message').textContent='Gunakan tombol keluar/login kembali sebagai A untuk memeriksa persistensi ownership.';
  const retryDue=lastCheck===0||Date.now()-lastCheck>60000;
  if(allowed&&(restarted||retryDue))await register();
 }catch{el('message').textContent='Server sedang tidak tersedia; halaman akan memeriksa kembali tanpa meminta login ulang.';}
 finally{checkingStatus=false;}
}
el('register').onclick=async()=>{await register();await status();};
el('login').onclick=()=>googleLogin(returnPath,{selectAccount:true}).catch(e=>el('message').textContent=e.message);
el('switch-account').textContent='Pilih akun Google '+(expectedAccount||'penguji');
el('switch-account').onclick=()=>googleLogin(returnPath,{selectAccount:true}).catch(e=>el('message').textContent=e.message);
el('relogin').onclick=async()=>{try{const r=await post('/api/buyer',{action:'signout'});if(!r.ok)throw Error('Logout belum terkonfirmasi.');await googleLogin(returnPath,{selectAccount:true});}catch(e){el('message').textContent=e.message;}};
async function checkOnReturn(){if(document.visibilityState==='visible'&&Date.now()-lastCheck>1500){await register();await status();}}
window.addEventListener('focus',checkOnReturn);document.addEventListener('visibilitychange',checkOnReturn);
await status();setInterval(status,5000);
