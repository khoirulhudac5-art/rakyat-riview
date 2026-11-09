(() => {
  const el=id=>document.getElementById(id);
  let proof=new URLSearchParams(location.hash.slice(1)).get('proof');
  history.replaceState(null,'',location.pathname); // No proof in history/referrer/logged query.
  async function call(action,body={}){
    const r=await fetch('/api/scan',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify({action,...body})});
    const data=await r.json();if(!r.ok){const e=new Error(data.error||'Permintaan gagal.');e.status=r.status;throw e;}return data;
  }
  async function boot(){
    el('demo').hidden=true;el('proof-help').hidden=true;
    try{
      const r=await fetch('/api/scan',{cache:'no-store'});if(!r.ok)throw Error('Prototipe scan hanya tersedia di preview lokal khusus.');const info=await r.json();
      if(info.active){el('state').textContent='Kartu sudah aktif. Scan kartu untuk membuka link review.';el('complete').hidden=false;return;}
      const user=await fetch('/api/buyer?action=session',{cache:'no-store'});
      if(!user.ok){el('state').textContent='Masuk ke akun pembeli untuk menyimpan kartu Anda.';el('demo').hidden=false;return;}
      if(proof){await call('verify',{proof});proof=null;}
      await call('ready');el('state').textContent='Kepemilikan terverifikasi. Lengkapi dua isian berikut.';el('scan-form').hidden=false;
    }catch(error){el('state').textContent=error.message;el('proof-help').hidden=false;}
  }
  el('demo').onclick=async()=>{
    el('demo').disabled=true;
    try{const r=await fetch('/api/buyer',{method:'POST',headers:{'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify({action:'demo-signin'})});if(!r.ok)throw Error('Sesi demo tidak tersedia.');await boot();}catch(e){el('state').textContent=e.message;}finally{el('demo').disabled=false;}
  };
  el('scan-form').onsubmit=async event=>{
    event.preventDefault();el('submit').disabled=true;
    try{await call('activate',{business_name:el('business').value,review_url:el('review').value});el('scan-form').hidden=true;el('complete').hidden=false;el('state').textContent='Aktivasi berhasil.';el('message').textContent='';}catch(e){el('message').className='message error';el('message').textContent=e.message;}finally{el('submit').disabled=false;}
  };
  boot();
})();
