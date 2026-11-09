import {converter,resolveMaps} from './maps.mjs';
import {loadDraft,saveDraft,removeDraft,googleLogin} from './drafts.mjs';
import {mountReviewFallback} from './review-fallback.mjs';
const el=id=>document.getElementById(id),searchParams=new URLSearchParams(location.search),code=searchParams.get('card')||searchParams.get('kartu')||searchParams.get('code'),initialToken=searchParams.get('token')||searchParams.get('activation_token')||'';
let canonical=null,synthetic=false,restoreSummary=false,claimEligible=false,account=null,googleEnabled=false,authTestUI=null,inventoryNotReady=false;
let restricted=false;
let realAuth=false,cardAccessClosed=false;
let localFallback={update(){}};
async function checkRestrictedStatus(){
  if(!restricted||!account)return;
  const r=await fetch('/api/buyer-status?card='+encodeURIComponent(code),{cache:'no-store'}),status=await r.json();
  claimEligible=r.ok&&status.claim_allowed===true;
  if(!r.ok)throw Error(status.error||'Kartu pengujian belum dapat diperiksa.');
  if(cardAccessClosed||status.local_context===true){el('card-state').textContent='Sesi akun diperiksa melalui Supabase Auth. Konteks kartu ini tetap lokal; klaim dan edit live belum dibuka.';return;}
  el('card-state').textContent=status.activation_state==='active'?'Kartu sudah aktif. Buka Dashboard Saya untuk mengelolanya.':'Kartu pengujian siap diperiksa untuk klaim.';
}
const feedback=e=>{el('message').className='message error';el('message').textContent=e.message;};
function step(current,complete=false){for(let n=1;n<=3;n++){const state=n<current||complete?'done':n===current?'active':'upcoming';el('step-'+n).dataset.state=state;el('step-state-'+n).textContent=state==='done'?'Selesai':state==='active'?'Saat ini':'Belum dimulai';if(state==='active')el('step-'+n).setAttribute('aria-current','step');else el('step-'+n).removeAttribute('aria-current');}}
function persist(){saveDraft(sessionStorage,code,{name:el('business').value,maps:el('maps').value,token:el('token')?.value||initialToken,step:el('summary').hidden?2:3});}
const work=converter({resolve:resolveMaps,update(result){canonical=result.url;el('conversion').textContent=result.message||'';el('conversion').dataset.state=result.state;el('continue').disabled=result.state!=='ready'||!el('business').value.trim();el('try-link').hidden=!result.url;el('try-link').removeAttribute('href');if(result.url)el('try-link').href=result.url;localFallback.update(result);if(result.state==='ready'&&restoreSummary){restoreSummary=false;showSummary().catch(feedback);}}});
el('maps').addEventListener('input',()=>{restoreSummary=false;canonical=null;work.input(el('maps').value);try{persist();}catch{feedback(Error('Informasi belum dapat disimpan. Izinkan penyimpanan browser sebelum melanjutkan.'));}});
el('business').addEventListener('input',()=>{el('continue').disabled=!canonical||!el('business').value.trim();try{persist();}catch{feedback(Error('Informasi belum dapat disimpan di browser ini.'));}});
let identityVersion=0;
function renderSession(state){
  const connected=state==='connected'&&Boolean(account);
  el('identity').textContent=connected?'Terhubung sebagai '+(account.name||account.email)+' ('+account.email+')':state==='checking'?'Memeriksa sesi akun Anda...':state==='error'?'Sesi belum dapat diperiksa. Coba lagi sebentar.':'Hubungkan akun Anda. Informasi tetap tersimpan di tab ini.';
  el('google').hidden=connected?(!claimEligible||Boolean(account.google)):false;
  el('google').disabled=state==='checking'||!googleEnabled;
  el('demo').hidden=connected||!synthetic;
  el('dashboard-link').hidden=!connected;
  if(el('wizard-logout'))el('wizard-logout').hidden=!connected||Boolean(authTestUI);
  el('google-status').textContent=connected?(claimEligible?'Akun terhubung. Konfirmasikan klaim kartu di bawah.':'Akun terhubung. Status kartu belum mengizinkan klaim. Buka dashboard untuk mengelola kartu yang sudah Anda miliki.'):state==='checking'?'Memeriksa sesi Supabase...':state==='error'?'Status akun belum terkonfirmasi. Data formulir tetap tersimpan.':googleEnabled?'Belum terhubung. Masuk dengan Google untuk melanjutkan.':'Belum terhubung. Login Google belum tersedia pada lingkungan ini.';
  step(3,connected);renderClaim();
}
async function identity(){
  const version=++identityVersion;account=null;renderSession('checking');
  try{
    let r=await fetch('/api/buyer?action=session',{cache:'no-store'});
    if(r.status===401){const refreshed=await fetch('/api/buyer',{method:'POST',headers:{'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify({action:'refresh'})});if(refreshed.ok)r=await fetch('/api/buyer?action=session',{cache:'no-store'});}
    if(version!==identityVersion)return;
    if(r.ok){const data=await r.json();if(version!==identityVersion)return;if(!data.user)throw Error('Invalid session');account=data.user;if(realAuth&&!account.google){account=null;renderSession('signed-out');feedback(Error('Gunakan akun Google untuk menghubungkan kartu.'));return;}try{await checkRestrictedStatus();}catch(error){claimEligible=false;feedback(error);}if(version!==identityVersion)return;renderSession('connected');}
    else if(r.status===401){account=null;renderSession('signed-out');}
    else throw Error('Session unavailable');
  }catch{if(version!==identityVersion)return;account=null;renderSession('error');}
  if(authTestUI&&version===identityVersion)await authTestUI.render();
  return account;
}
function renderClaim(){
  if(cardAccessClosed){el('claim-card').hidden=true;el('claim-title').textContent='Login Google nyata; akses kartu V2 masih closed';el('claim-explanation').textContent='Anda dapat menguji login, callback, draft, sesi, dan logout. Klaim dan edit kartu live memerlukan pembukaan restricted run khusus penguji dengan persetujuan baru. Tidak ada kartu yang diklaim otomatis.';return;}
  if(authTestUI){el('claim-card').hidden=true;return;}
  el('claim-card').hidden=!(claimEligible&&account?.google&&canonical);
  if(inventoryNotReady){el('claim-title').textContent='Kartu belum siap diaktifkan';el('claim-explanation').textContent='Status kesiapan kartu dikelola sistem inventaris. Coba kembali setelah kartu ditandai siap; informasi Anda tetap tersimpan.';return;}
  if(claimEligible){el('claim-title').textContent='Konfirmasikan akun dan aktifkan kartu';el('claim-explanation').textContent='Pastikan kartu ini milik Anda. Klaim pertama yang berhasil akan menghubungkan kartu ke akun Google tersebut. Setelah itu akun lain tidak dapat mengklaimnya.';}
}
el('claim-card').onclick=async()=>{
  const button=el('claim-card');button.disabled=true;el('back').disabled=true;
  try{
    if(!claimEligible||!account?.google||!canonical)throw Error('Masuk dengan Google dan periksa informasi kartu terlebih dahulu.');
    persist();
    const tokenVal=el('token')?.value?.trim()||initialToken;
    const options={method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify({action:'first-claim',card_code:code,activation_token:tokenVal,business_name:el('business').value.trim(),review_url:canonical})};
    let response=await fetch('/api/buyer',options);
    if(response.status===401){const refreshed=await fetch('/api/buyer',{method:'POST',headers:{'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify({action:'refresh'})});if(refreshed.ok)response=await fetch('/api/buyer',options);}
    const data=await response.json();if(!response.ok||data.success!==true)throw Error(data.error||'Klaim belum berhasil. Informasi Anda tetap tersimpan.');
    try{removeDraft(sessionStorage,code);sessionStorage.setItem('rr-buyer-activation-flash',code);}catch{ /* DB success must not be misreported as a failed claim. */ }
    location.href='/pembeli/dashboard.html';
  }catch(e){feedback(e);}finally{button.disabled=false;el('back').disabled=false;}
};
async function showSummary(){
  if(!canonical||!el('business').value.trim())return;
  el('sum-code').textContent=code;el('sum-name').textContent=el('business').value.trim();el('sum-link').textContent='Link review siap dicoba. Pastikan usaha yang terbuka benar.';
  el('summary-url').textContent=canonical;el('summary-try-link').href=canonical;
  el('draft-form').hidden=true;el('summary').hidden=false;persist();step(3);await identity();
}
el('draft-form').onsubmit=async e=>{e.preventDefault();if(!canonical)return;if(!el('business').value.trim()){feedback(Error('Isi nama usaha Anda terlebih dahulu.'));el('business').focus();return;}try{await showSummary();}catch(e){feedback(e);}};
el('back').onclick=()=>{el('summary').hidden=true;el('draft-form').hidden=false;el('message').textContent='';persist();step(2);};
el('copy-link').onclick=async()=>{try{await navigator.clipboard.writeText(canonical);el('message').className='message success';el('message').textContent='Link berhasil disalin.';}catch{feedback(Error('Link belum dapat disalin otomatis. Anda dapat menyalin link yang ditampilkan di atas.'));}};
el('google').onclick=async()=>{el('google').disabled=true;try{persist();if(authTestUI)await authTestUI.beforeLogin();await googleLogin(location.pathname+location.search);}catch(e){feedback(e);el('google').disabled=false;}};
el('demo').onclick=async()=>{el('demo').disabled=true;try{const r=await fetch('/api/buyer',{method:'POST',headers:{'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify({action:'demo-signin'})});if(!r.ok)throw Error('Akun contoh belum dapat dibuka.');await identity();}catch(e){feedback(e);}finally{el('demo').disabled=false;}};
if(el('wizard-logout'))el('wizard-logout').onclick=async()=>{
  el('wizard-logout').disabled=true;
  try{persist();const r=await fetch('/api/buyer',{method:'POST',headers:{'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify({action:'signout'})});if(!r.ok)throw Error('Logout belum terkonfirmasi. Coba lagi.');identityVersion++;account=null;renderSession('signed-out');el('message').className='message success';el('message').textContent='Anda sudah keluar. Draft tetap tersimpan; kartu belum diklaim.';}
  catch(error){feedback(error);}finally{el('wizard-logout').disabled=false;}
};
try{
  const mode=await fetch('/api/buyer?action=mode').then(r=>r.json()).catch(()=>({}));synthetic=mode.mode==='synthetic'&&['127.0.0.1','localhost'].includes(new URL(location.origin).hostname);
  restricted=mode.mode==='restricted';
  realAuth=mode.real_auth===true;cardAccessClosed=mode.card_access==='closed';
  if(mode.fixture===true){el('mode').hidden=false;el('mode').textContent='FIXTURE LOKAL · OAuth dan kartu sintetis; tidak terhubung ke Google atau Supabase production.';}
  localFallback=mountReviewFallback({input:el('maps'),before:el('continue'),enabled:synthetic&&mode.product_preview===true});
  if(!/^[A-Za-z0-9_-]{1,30}$/.test(code||'')){
    if(synthetic&&mode.product_preview===true){location.href='/preview-new-card';}else if(el('scan-help'))el('scan-help').hidden=false;
    throw Error('Scan QR atau tap NFC pada kartu Anda. Tidak perlu mengetik kode kartu.');
  }
  if(synthetic){el('mode').hidden=false;el('mode').textContent='PREVIEW LOKAL ? Kartu dan akun contoh. Tidak ada aktivasi kartu asli.';el('demo').hidden=false;}
  if(realAuth){el('mode').hidden=false;el('mode').textContent='GOOGLE ASLI · Supabase Rakyat Review. Akses kartu V2 tetap closed; tidak ada akun demo atau klaim otomatis.';el('demo').hidden=true;}
  if(mode.auth_wizard_test===true&&['127.0.0.1','localhost'].includes(new URL(location.origin).hostname)){el('mode').hidden=false;el('mode').textContent='UJI LOKAL: kartu sintetis, akun Google nyata. Tidak ada klaim atau perubahan kartu production.';const {installAuthWizardTest}=await import('./auth-wizard-test.mjs');authTestUI=await installAuthWizardTest({el,code,persist,identity,getAccount:()=>account});}
  const r=await fetch('/api/buyer-status?card='+encodeURIComponent(code),{cache:'no-store'});let status=await r.json();if(!r.ok){if(restricted&&(r.status===401||status.code==='V2_ACCESS_CLOSED'))status={code,activation_state:'unverified',claim_allowed:false};else throw Error(status.error||'Kartu belum dapat diperiksa.');}
  claimEligible=status.claim_allowed===true;inventoryNotReady=status.activation_reason==='inventory_not_ready';renderClaim();
  el('card-label').textContent='KARTU '+status.code;el('card-state').textContent=status.activation_state==='active'?'Kartu sudah aktif. Buka Dashboard Saya untuk mengelolanya.':status.activation_state==='inactive'?'Yuk, siapkan kartu Google Review untuk usaha Anda.':'Yuk, siapkan informasi usaha Anda. Status kartu akan diperiksa sebelum aktivasi.';
  if(status.local_context===true)el('card-state').textContent='Konteks kartu lokal untuk menguji OAuth asli. Identitas ini tidak dibuat di Supabase; data formulir tetap menjadi draft sampai klaim diizinkan.';
  step(2);
  el('draft-form').hidden=false;
  try{const r=await fetch('/api/buyer-google');const data=await r.json();googleEnabled=r.ok&&data.enabled===true;if(!googleEnabled){el('google').disabled=true;el('google-status').textContent='Login Google belum tersedia pada lingkungan ini. Informasi Anda tetap tersimpan.';}}catch{el('google').disabled=true;el('google-status').textContent='Login Google belum dapat dihubungi. Informasi Anda tetap tersimpan.';}
  const draft=loadDraft(sessionStorage,code);if(draft){el('business').value=draft.name;el('maps').value=draft.maps;if(draft.token&&el('token'))el('token').value=draft.token;restoreSummary=draft.step===3;work.input(draft.maps);}
  if(initialToken&&el('token')&&!el('token').value){el('token').value=initialToken;if(el('token-hint'))el('token-hint').textContent='Token terpasang dari link aktivasi khusus kartu.';}
}catch(e){el('card-state').textContent=e.message;}
