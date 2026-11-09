import {converter,resolveMaps} from './maps.mjs';
import {googleLogin} from './drafts.mjs';
const mounted=new WeakSet();
let active;
function mount(){
  const form=document.getElementById('edit-form'),input=document.getElementById('review_url');
  if(form&&input&&!form._rrMapsManaged&&!mounted.has(input)){
    active?.dispose();mounted.add(input);let result=null;
    input.maxLength=8192;
    const feedback=document.createElement('p');feedback.className='maps-feedback';feedback.setAttribute('role','status');
    const link=document.createElement('a');link.className='btn maps-test';link.textContent='Coba Link Review ↗';link.target='_blank';link.rel='noopener noreferrer';link.hidden=true;
    input.after(feedback,link);const button=form.querySelector('button[type="submit"]');
    active=converter({resolve:resolveMaps,update(r){result=r.url;feedback.textContent=r.message||'';feedback.dataset.state=r.state;link.hidden=!r.url;link.removeAttribute('href');if(r.url)link.href=r.url;button.disabled=r.state!=='ready';}});
    input.addEventListener('input',()=>active.input(input.value));active.input(input.value);
    form.addEventListener('submit',event=>{if(!result){event.preventDefault();event.stopImmediatePropagation();feedback.textContent='Tunggu link review siap sebelum menyimpan.';}else input.value=result;},true);
  }
  const auth=document.getElementById('auth-form');
  if(auth&&!document.getElementById('google-signin')&&!document.getElementById('google-login')){
    const button=document.createElement('button');button.type='button';button.id='google-login';button.className='btn full';button.textContent='Lanjutkan dengan Google';
    const note=document.createElement('p');note.className='hint';note.textContent='Gunakan akun Google yang sama untuk mengakses kartu Anda kembali.';
    auth.after(button,note);button.onclick=async()=>{button.disabled=true;try{await googleLogin('/pembeli/dashboard.html');}catch(e){note.textContent=e.message;button.disabled=false;}};
  }
}
new MutationObserver(mount).observe(document.getElementById('content'),{subtree:true,childList:true});mount();
