// Only imported after a loopback-only preview capability flag. No mock Auth.
import {googleLogin} from './drafts.mjs';
async function digest(value){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');}
export async function installAuthWizardTest({el,code,persist,identity,getAccount}){
 let refreshed=false;
 const values=()=>({code,name:el('business').value,maps:el('maps').value});
 async function beforeLogin(){persist();sessionStorage.setItem('rr-auth-wizard-proof',JSON.stringify({code,digest:await digest(values()),time:Date.now()}));}
 async function render(){
  el('auth-wizard-controls').hidden=el('summary').hidden;
  el('claim-card').hidden=true;el('demo').hidden=true;
  el('claim-title').textContent='Kartu sintetis untuk pengujian OAuth';el('claim-explanation').textContent='Akun Google dan sesi menggunakan Supabase Auth nyata. Kartu ini tidak ada di production dan tidak akan diklaim.';
  el('auth-wizard-logout').hidden=!getAccount()?.google;
  let proof,callback;try{proof=JSON.parse(sessionStorage.getItem('rr-auth-wizard-proof'));callback=JSON.parse(sessionStorage.getItem('rr-oauth-callback-check'));}catch{}
  const returned=callback?.path===location.pathname+location.search&&Date.now()-callback.time<3600000;
  const restored=proof?.code===code&&Date.now()-proof.time<3600000&&proof.digest===await digest(values());
  el('auth-wizard-evidence').textContent=getAccount()?.google?(returned&&restored?'LULUS: sesi Google nyata terverifikasi; konteks kartu dan data formulir cocok setelah callback.'+(refreshed?' Refresh sesi Supabase juga berhasil.':''):'Sesi Google nyata terverifikasi. Klik uji login untuk memeriksa perjalanan kembali ke wizard.'):'Belum login. Data formulir tetap tersimpan di tab ini.';
 }
 el('auth-wizard-login').onclick=async()=>{try{await beforeLogin();await googleLogin(location.pathname+location.search);}catch(e){el('auth-wizard-evidence').textContent=e.message;}};
 async function authAction(action){const r=await fetch('/api/buyer',{method:'POST',headers:{'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify({action})}),data=await r.json();if(!r.ok)throw Error(data.error||'Sesi belum dapat diperbarui.');}
 el('auth-wizard-refresh').onclick=async()=>{try{await authAction('refresh');refreshed=true;await identity();await render();}catch(e){el('auth-wizard-evidence').textContent=e.message;}};
 el('auth-wizard-logout').onclick=async()=>{try{persist();await authAction('signout');refreshed=false;await identity();await render();el('auth-wizard-evidence').textContent='Logout aplikasi berhasil. Data formulir tetap tersimpan; Anda dapat login kembali.';}catch(e){el('auth-wizard-evidence').textContent=e.message;}};
 return{beforeLogin,render};
}
