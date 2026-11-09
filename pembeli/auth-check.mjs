import {googleLogin} from './drafts.mjs';
const el=id=>document.getElementById(id);
async function post(action){return fetch('/api/buyer',{method:'POST',headers:{'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify({action})});}
async function session(){
 try{let r=await fetch('/api/buyer?action=session',{cache:'no-store'});if(r.status===401){const renewed=await post('refresh');if(renewed.ok)r=await fetch('/api/buyer?action=session',{cache:'no-store'});}
 if(r.status===401){el('status').textContent='Belum login. Gunakan akun Google penguji.';el('logout').hidden=true;el('google-login').hidden=false;return;}
 const data=await r.json();if(!r.ok)throw Error(data.error||'Sesi belum dapat diperiksa.');if(data.user?.google!==true)throw Error('Sesi ada, tetapi identity Google belum terverifikasi.');
 el('status').textContent='Login Google nyata terverifikasi oleh Supabase Auth untuk sesi browser ini.';el('logout').hidden=false;el('google-login').hidden=true;
 }catch(e){el('status').textContent=e.message;}
}
el('google-login').onclick=async()=>{el('google-login').disabled=true;try{await googleLogin('/pembeli/auth-check.html');}catch(e){el('status').textContent=e.message;el('google-login').disabled=false;}};
el('check-session').onclick=session;
el('logout').onclick=async()=>{try{const r=await post('signout'),data=await r.json();if(!r.ok)throw Error(data.error||'Logout belum terkonfirmasi.');await session();}catch(e){el('status').textContent=e.message;}};
await session();
