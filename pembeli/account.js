(() => {
  'use strict';
  const page = document.body.dataset.page;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // Confirmation email may return an implicit-flow fragment. Never retain/log its tokens.
  if (location.hash.includes('access_token=') || location.hash.includes('error=')) history.replaceState(null, '', location.pathname + location.search);
  let signup = false, cards = [], selectedCode = null, mock = false, statistics = null, productPreview = false, firstClaimFlow = false, realAuth = false, cardAccess = 'closed';
  const count = value => (typeof value==='number'||(typeof value==='string'&&/^\d+$/.test(value)))&&Number.isSafeInteger(Number(value))&&Number(value)>=0 ? Number(value).toLocaleString('id-ID') : '—';
  const svg = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${({card:'<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h3"/>',scan:'<path d="M8 3H4a1 1 0 0 0-1 1v4m13-5h4a1 1 0 0 1 1 1v4M3 16v4a1 1 0 0 0 1 1h4m8 0h4a1 1 0 0 0 1-1v-4M7 12h10M9 9v6m6-6v6"/>',arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',plus:'<path d="M12 5v14M5 12h14"/>',chart:'<path d="M4 4v16h16M8 15l4-5 4 2 4-6"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',external:'<path d="M14 3h7v7m0-7L10 14M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',edit:'<path d="m15 5 4 4M4 20l5-1L20 8a3 3 0 0 0-4-4L5 15z"/>'})[name] || ''}</svg>`;
  function statsFor(code) { return code ? statistics?.by_card?.[code] : statistics; }
  function channelCaption(source) { return `NFC: ${count(source?.nfc)} · QR: ${count(source?.qr)}.${source?.nfc==null||source?.qr==null?' Rincian sumber belum tersedia. NFC dan QR memakai URL permanen yang sama; sumber tidak dapat disimpulkan dari URL saja.':''}`; }
  function chartMarkup(source, days = 30) {
    const today=new Date().toISOString().slice(0,10),since=new Date(Date.parse(today+'T00:00:00Z')-(days-1)*86400000).toISOString().slice(0,10);
    const series = Array.isArray(source?.series) ? source.series.filter(p => p.date>=since&&p.date<=today).slice(-days) : [];
    if (!statistics?.available || !series.length) return `<div class="chart-empty">${svg('chart')}<strong>Belum ada data kunjungan</strong><p>${statistics?.available ? 'Scan pertama akan muncul di sini setelah kunjungan tercatat.' : 'Pelacakan belum tersedia pada koneksi ini. Grafik akan muncul saat data kunjungan tersedia.'}</p></div>`;
    const max = Math.max(2, Math.ceil(Math.max(0,...series.map(p=>Math.max(Number(p.visits),Number(p.redirects))))/2)*2);
    const x = i => 42 + (series.length===1 ? 326 : i*652/(series.length-1)), y = n => 179-(Number(n)/max)*140;
    const path = field => series.map((p,i)=>`${i?'L':'M'}${x(i).toFixed(1)},${y(p[field]).toFixed(1)}`).join(' ');
    const total = field => count(series.reduce((sum,p)=>sum+Number(p[field]),0));
    const date = value => new Date(value+'T12:00:00Z').toLocaleDateString('id-ID',{day:'numeric',month:'short'});
    return `<div class="chart-summary"><span><i class="legend-dot blue"></i>${total('visits')} scan</span><span><i class="legend-dot green"></i>${total('redirects')} redirect</span></div><svg class="scan-chart" viewBox="0 0 720 220" role="img" aria-label="Grafik ${series.length} hari: ${total('visits')} scan dan ${total('redirects')} redirect. Scan bukan jumlah ulasan Google."><title>Perkembangan scan dan redirect kartu</title>${[0,.5,1].map(f=>`<line x1="42" x2="694" y1="${y(max*f)}" y2="${y(max*f)}" class="chart-grid"/><text x="30" y="${y(max*f)+4}" text-anchor="end">${Math.round(max*f)}</text>`).join('')}<path d="${path('visits')}" class="chart-visits"/><path d="${path('redirects')}" class="chart-redirects"/>${series.map((p,i)=>`<circle cx="${x(i)}" cy="${y(p.visits)}" r="3" fill="#4285f4"><title>${esc(date(p.date))}: ${count(p.visits)} scan, ${count(p.redirects)} redirect</title></circle>`).join('')}<text x="42" y="211">${esc(date(series[0].date))}</text><text x="694" y="211" text-anchor="end">${esc(date(series[series.length-1].date))}</text></svg>`;
  }
  const icon = '<img class="rr-logo" src="../assets/rakyat-review-logo.png" alt="" width="72" height="48">';
  document.getElementById('app').innerHTML = `<header class="account-header"><a class="account-brand" href="dashboard.html"><span class="account-mark">${icon}</span><span>rakyat<span>review</span></span></a><nav class="account-nav" aria-label="Navigasi pembeli"><a href="dashboard.html">Kartu Saya</a><a href="mulai.html">Tambah Kartu</a><span class="account-label" id="mode-label">AKUN PEMBELI</span><span class="account-email" id="account-identity" hidden></span><button class="btn" id="logout" hidden>Keluar</button></nav></header><main class="account-main" id="main"><div id="mode-note"></div><div id="content" aria-live="polite"><p class="account-loading">Memuat akun…</p></div></main>`;
  const content = document.getElementById('content');
  async function request(action, body, retry = true) {
    let response;
    try { response = await fetch('/api/buyer' + (body ? '' : '?action=' + action), { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? {'Content-Type':'application/json','X-Buyer-Request':'1'} : {}, ...(body ? {body:JSON.stringify({ ...body, action })} : {}) }); }
    catch { throw new Error('Koneksi terputus. Silakan coba lagi.'); }
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && retry && (!body || ['activate','update','claim','first-claim'].includes(action))) {
      try { await request('refresh', {}, false); }
      catch (error) { if ([400,401].includes(error.status)) error.status=401; throw error; }
      return request(action, body, false);
    }
    if (!response.ok) { const error = new Error(data.error || 'Permintaan belum dapat diproses.'); error.status = response.status;error.code=data.code; throw error; }
    return data;
  }
  function message(element, text, error = false) { element.className = 'message ' + (error ? 'error' : 'success'); element.textContent = text; }
  function field(id, label, { type='text', hint='', required=true, max, min, value='', autocomplete='off' } = {}) {
    return `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" ${required?'required':''} ${max?`maxlength="${max}"`:''} ${min?`minlength="${min}"`:''} value="${esc(value)}" autocomplete="${autocomplete}" ${hint?`aria-describedby="${id}-hint"`:''}><p class="hint" id="${id}-hint">${hint}</p></div>`;
  }
  function bindForm(id, action, success, prepare) {
    document.getElementById(id).addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget, button = form.querySelector('button[type="submit"]'), note = form.querySelector('[role="status"]');
      const data = Object.fromEntries(new FormData(form));
      const label = button.textContent; button.disabled = true; button.textContent = 'Memproses…'; note.textContent = '';
      try { if(prepare) await prepare(data); const result = await request(action, data); await success(result, form, note); }
      catch (error) { message(note, error.message, true); }
      finally { button.disabled = false; button.textContent = label; }
    });
  }
  function auth() {
    content.innerHTML = `<div class="auth-layout"><section class="auth-intro"><p class="eyebrow">RUANG PEMBELI RAKYAT REVIEW</p><h1>Setiap kartu.<br>Satu akun Anda.</h1><p>Aktifkan kartu, kelola identitas usaha, dan perbarui tujuan Google Review dalam satu tempat.</p><p class="account-privacy">Kartu NFC/QR Anda tetap dapat dibuka pengunjung tanpa login.</p></section><section class="auth-box"><details class="email-access"><summary>Akun email yang sudah ada</summary><div class="auth-tabs"><button class="btn ${!signup?'selected':''}" id="signin-tab">Masuk</button><button class="btn ${signup?'selected':''}" id="signup-tab">Daftar akun</button></div><h2>${signup?'Mulai dengan akun Anda':'Selamat datang kembali'}</h2><p class="status-note">${signup?'Verifikasi alamat email untuk menyelesaikan pendaftaran.':'Masuk menggunakan email dan password akun pembeli.'}</p><form id="auth-form">${field('email','Email',{type:'email',required:true,max:254,autocomplete:'email'})}${field('password','Password',{type:'password',min:signup?8:undefined,max:256,autocomplete:signup?'new-password':'current-password',hint:signup?'Minimal 8 karakter. Gunakan password yang unik.':''})}<button class="btn primary full" type="submit">${signup?'Buat akun':'Masuk ke dashboard'}</button><p class="message" role="status"></p></form></details>${mock ? '<div class="demo-access"><button class="btn full" id="demo-signin" type="button">Masuk sebagai akun demo</button><p class="hint">Preview lokal tanpa Supabase. Akun dan kartu contoh dibuat otomatis.</p><p class="message" id="demo-message" role="status"></p></div>' : ''}<p class="account-privacy">Akun pembeli terpisah dari akun admin. Jangan masukkan PIN kartu sebagai password akun.</p><div class="color-stripe"></div></section></div>`;
    document.getElementById('signin-tab').onclick = () => {signup=false;auth();};
    const googleButton=document.createElement('button');googleButton.type='button';googleButton.id='google-signin';googleButton.className='btn primary full';googleButton.textContent='Lanjutkan dengan Google';
    const googleNote=document.createElement('p');googleNote.role='status';googleNote.className='message';
    const emailSection=document.querySelector('.email-access');if(emailSection&&typeof emailSection.before==='function')emailSection.before(googleButton,googleNote);
    googleButton.onclick=async()=>{googleButton.disabled=true;try{const {googleLogin}=await import('./drafts.mjs');const next=new URLSearchParams(location.search).get('next');await googleLogin(next==='aktivasi.html'?'/pembeli/aktivasi.html':'/pembeli/dashboard.html');}catch(error){message(googleNote,error.message,true);googleButton.disabled=false;}};
    if(mock && productPreview){googleButton.disabled=true;googleNote.textContent='Login Google nyata tetap tersedia pada aplikasi terintegrasi. Gunakan akun simulasi A atau B untuk mencoba produk lokal ini.';googleNote.className='status-note';if(emailSection)emailSection.hidden=true;}
    if(realAuth){if(emailSection)emailSection.hidden=true;googleNote.textContent='Masuk dengan Google asli melalui Supabase. Akses kartu V2 masih closed.';googleNote.className='status-note';}
    document.getElementById('signup-tab').onclick = () => {signup=true;auth();};
    if (mock) document.getElementById('demo-signin').onclick = async () => {
      const button=document.getElementById('demo-signin'),note=document.getElementById('demo-message');
      button.disabled=true;
      try {
        await request('demo-signin',{account:'first'});
        const target=new URLSearchParams(location.search).get('next');
        location.href=['aktivasi.html','dashboard.html'].includes(target)?target:'dashboard.html';
      } catch(error) { message(note,error.message,true); }
      finally { button.disabled=false; }
    };
    if (mock && productPreview) {
      const secondButton=document.createElement('button');secondButton.type='button';secondButton.className='btn full';secondButton.id='demo-signin-second';secondButton.textContent='Masuk sebagai akun demo B';
      const demoButton=document.getElementById('demo-signin');demoButton.textContent='Masuk sebagai akun demo A';
      demoButton.after(secondButton);
      secondButton.onclick=async()=>{secondButton.disabled=true;try{await request('demo-signin',{account:'second'});location.href='dashboard.html';}catch(error){message(document.getElementById('demo-message'),error.message,true);}finally{secondButton.disabled=false;}};
    }
    bindForm('auth-form',signup?'signup':'signin',async (data, form, note) => {
      form.elements.password.value = '';
      if (data.signed_in) location.href = 'dashboard.html'; else message(note,data.message);
    });
  }
  async function loadCards() {
    content.innerHTML = '<p class="account-loading" role="status">Memuat kartu milik Anda…</p>';
    try{
      const data=await request('cards'),{normalizeDashboard}=await import('./dashboard-data.mjs');
      const normalized=normalizeDashboard(data,{simulation:mock&&!realAuth});cards=normalized.cards;statistics=normalized.statistics;
    }catch(error){
      cards=[];statistics=null;selectedCode=null;
      if(error.status===401){location.href=mock?'index.html?next=dashboard.html':'index.html';return false;}
      if(error.code==='V2_ACCESS_CLOSED'){content.innerHTML=`<section class="auth-box"><p class="eyebrow">AKUN GOOGLE TERHUBUNG</p><h1>Akun Anda sudah masuk.</h1><p class="message" role="status">${esc(error.message)}</p><p class="status-note">Daftar kartu belum dibaca. Tidak ada kartu simulasi yang digunakan sebagai pengganti data akun Anda.</p><a class="btn primary" href="/preview-new-card">Kembali ke aktivasi</a></section>`;return false;}
      content.innerHTML=`<section class="auth-box"><h1>Kartu belum dapat dimuat</h1><p class="message error" role="status">${esc(error.message)}</p><button class="btn primary" id="retry-cards" type="button">Coba lagi</button></section>`;
      document.getElementById('retry-cards').onclick=loadCards;return false;
    }
    const chosen = new URLSearchParams(location.search).get('card');
    selectedCode = chosen && cards.some(c => c.card_code === chosen) ? chosen : null;
    dashboard();
    try{
      const activated=sessionStorage.getItem('rr-buyer-activation-flash');
      if(cards.some(c=>c.card_code===activated&&c.active)&&typeof content.prepend==='function'){
        const note=document.createElement('p');note.className='message success';note.setAttribute('role','status');note.textContent='Kartu berhasil diaktifkan dan tersimpan di akun Anda.';content.prepend(note);
        sessionStorage.removeItem('rr-buyer-activation-flash');
      }
    }catch{ /* Storage availability does not affect server-backed ownership. */ }
    return true;
  }
  function localDrafts() {
    try {
      let index;try{index=JSON.parse(sessionStorage.getItem('rr-review-draft-index')||'[]');}catch{index=[];}
      if(!Array.isArray(index))index=[];
      // Discover older records too; previous versions did not maintain an index.
      if(typeof sessionStorage.key==='function')for(let i=0;i<Math.min(sessionStorage.length,1000);i++){const key=sessionStorage.key(i);if(key?.startsWith('rr-review-draft:'))index.push(key.slice('rr-review-draft:'.length));}
      return [...new Set(index)].filter(code=>typeof code==='string'&&/^[A-Za-z0-9_-]{1,30}$/.test(code)&&!cards.some(c=>c.card_code===code)).slice(0,100).map(code=>{
        try{const d=JSON.parse(sessionStorage.getItem('rr-review-draft:'+code)||'null');
        return d&&d.code===code&&typeof d.name==='string'&&d.name.length<=150&&typeof d.maps==='string'&&d.maps.length<=8192&&Number.isFinite(d.time)&&Date.now()-d.time<86400000&&d.time<=Date.now()?d:null;}catch{return null;}
      }).filter(Boolean);
    } catch { return []; }
  }
  function dashboard() {
    const tracked=statistics?.available===true, simulated=tracked&&statistics.synthetic===true;
    const tag=simulated?'<span class="simulation-tag">SIMULASI</span>':'';
    const metrics=[['Kartu aktif',count(cards.filter(c=>c.active).length),`${count(cards.length)} kartu milik akun`,'card'],['Total scan',tracked?count(statistics.visits):'—',tracked?'Kunjungan melalui URL kartu':'Pelacakan belum tersedia','scan'],['Redirect ke Google',tracked?count(statistics.redirects):'—',tracked?'Pengalihan ke link Google Review':'Data redirect belum tersedia','arrow'],['Draft di perangkat',count(localDrafts().length),'Belum diajukan · tab ini','edit']];
    content.innerHTML = `<div class="page-heading buyer-heading"><div><p class="eyebrow">WORKSPACE PEMBELI</p><h1>Dashboard Saya<span class="heading-dot">.</span></h1><p class="subtitle">Satu tempat untuk kartu dan reputasi usaha Anda.</p></div><a class="btn primary" href="mulai.html">${svg('plus')}Tambah Kartu</a></div><section class="stats buyer-metrics" aria-label="Ringkasan">${metrics.map((m,i)=>`<article class="stat buyer-metric metric-${i}"><div class="stat-top">${m[0]}<span class="metric-symbol">${svg(m[3])}</span></div><div class="stat-value">${m[1]}</div><div class="stat-caption">${m[2]}${i===1||i===2?tag:''}</div></article>`).join('')}</section><section class="scan-panel" aria-labelledby="scan-title"><div class="panel-heading"><div><p class="eyebrow">AKTIVITAS KARTU</p><h2 id="scan-title">Perkembangan kunjungan ${tag}</h2></div><label class="chart-range-label" for="chart-range"><span class="sr-only">Periode grafik</span><select id="chart-range"><option value="30">30 hari terakhir</option><option value="7">7 hari terakhir</option></select></label></div><div id="scan-chart">${chartMarkup(statistics)}</div><p class="chart-note">Scan menunjukkan kunjungan ke URL kartu, bukan jumlah ulasan. Redirect berarti pengalihan ke Google Review.${simulated?' Seluruh angka di atas adalah data simulasi lokal.':''} ${channelCaption(statistics)}</p></section><div class="collection-toolbar"><div><h2 class="collection-title">Kartu Saya <span class="collection-count">${count(cards.length)}</span></h2><p class="status-note">Hanya kartu yang terhubung dengan akun Anda.</p></div><div class="search-row">${svg('search')}<label class="sr-only" for="search-cards">Cari kartu</label><input id="search-cards" type="search" placeholder="Cari nama usaha atau kode kartu"></div></div><div id="owned-list" class="owned-grid"></div><section class="local-preparations" id="local-preparations" hidden><h2 class="collection-title">Lanjutkan aktivasi <span class="hint">Draft di perangkat ini</span></h2><p class="status-note">Informasi tersimpan sementara di tab browser ini. Belum diajukan dan belum tercatat sebagai kartu milik akun Anda.</p><div id="local-list" class="owned-grid"></div></section><section class="google-review-note">${svg('chart')}<div><strong>Ulasan Google yang terverifikasi</strong><p>Jumlah dan riwayat ulasan belum tersedia. Informasi ini hanya akan ditampilkan setelah integrasi resmi Google yang diotorisasi pemilik usaha.</p></div></section><div id="edit-slot"></div>`;
    document.getElementById('chart-range').onchange=event=>{document.getElementById('scan-chart').innerHTML=chartMarkup(statistics,Number(event.target.value));};
    const list = () => {
      const search = document.getElementById('search-cards').value.toLowerCase();
      const matches = cards.filter(c=>`${c.business_name} ${c.card_code}`.toLowerCase().includes(search));
      document.getElementById('owned-list').innerHTML = matches.length ? matches.map(c=>{
        const s=statsFor(c.card_code), code=encodeURIComponent(c.card_code);
        return `<article class="owned-card buyer-card"><div class="card-top"><div class="card-symbol">${svg('card')}</div><span class="badge ${c.active?'active':'pending'}">${c.active?'Kartu Aktif':'Belum Aktif'}</span></div><h2>${esc(c.business_name || 'Usaha Anda')}</h2><p class="card-code-line">KODE KARTU <span class="code">${esc(c.card_code)}</span></p><div class="mini-metrics"><div><span>Scan ${tag}</span><strong>${tracked&&s?count(s.visits):'—'}</strong></div><div><span>Redirect ${tag}</span><strong>${tracked&&s?count(s.redirects):'—'}</strong></div><div><span>Jenis kartu</span><strong class="card-type">NFC + QR</strong></div></div><details class="owned-link-details"><summary>Link Google Review</summary><p class="owned-review-url">${esc(c.review_url || 'Link belum tersedia')}</p></details><div class="account-actions"><a class="btn primary" href="${c.active?`dashboard.html?card=${code}#edit-slot`:`mulai.html?card=${code}`}">${svg(c.active?'edit':'plus')}${c.active?'Kelola Kartu':'Aktivasi Kartu'}</a>${c.active?`<a class="btn" href="/r/${code}" target="_blank" rel="noopener noreferrer">${svg('external')}Buka kartu</a>`:''}</div></article>`;
      }).join('') : `<section class="owned-card buyer-empty">${svg(cards.length?'search':'card')}<h2>${cards.length?'Kartu tidak ditemukan':'Kartu pertama Anda dimulai di sini'}</h2><p class="status-note">${cards.length?'Coba nama usaha atau kode kartu lainnya.':'Scan NFC atau QR pada kartu Anda, lalu lengkapi informasi usaha dan klaim dengan akun Google.'}</p><a class="btn primary" href="${productPreview?'/preview-new-card':'mulai.html'}">${svg('plus')}${productPreview?'Coba aktivasi kartu simulasi':'Tambah Kartu'}</a></section>`;
      const prepared=localDrafts(),found=prepared.filter(d=>(d.name+' '+d.code).toLowerCase().includes(search));
      document.getElementById('local-preparations').hidden=!prepared.length;
      document.getElementById('local-list').innerHTML=found.length?found.map(d=>`<article class="owned-card local-card"><span class="badge pending">Belum diajukan</span><h2>${esc(d.name || 'Informasi usaha belum lengkap')}</h2><span class="code">${esc(d.code)}</span><p class="local-storage-label">Tersimpan di perangkat ini</p><p class="status-note">${d.step===3?'Informasi siap. Lanjutkan untuk menghubungkan kartu ke akun Anda.':'Lanjutkan mengisi informasi usaha Anda.'}</p><a class="btn" href="mulai.html?card=${encodeURIComponent(d.code)}">Lanjutkan Penyiapan ${svg('arrow')}</a></article>`).join(''):'<p class="status-note">Tidak ada informasi tersimpan yang sesuai pencarian.</p>';
    };
    document.getElementById('search-cards').oninput=list; list();
    if (selectedCode) edit(cards.find(c=>c.card_code===selectedCode));
  }
  function edit(card) {
    const cardStats=statsFor(card.card_code),tracked=statistics?.available===true,simulated=tracked&&statistics.synthetic===true;
    document.getElementById('edit-slot').innerHTML = `<section class="account-edit"><div class="panel-heading"><div><p class="eyebrow">DETAIL KARTU</p><h2>Kelola Kartu</h2></div><span class="badge ${card.active?'active':'pending'}">${card.active?'Kartu Aktif':'Menunggu Aktivasi'}</span></div><div class="detail-layout"><aside class="detail-identity"><div class="detail-card-preview"><img src="../assets/rakyat-review-logo.png" width="90" height="60" alt="Rakyat Review"><strong>${esc(card.business_name || 'Usaha Anda')}</strong><span>NFC + QR</span><code>${esc(card.card_code)}</code></div><h3>URL kartu tetap sama</h3><p>Perubahan nama atau link tidak mengubah URL NFC dan QR yang sudah dicetak.</p><a class="permanent-url" href="/r/${encodeURIComponent(card.card_code)}" target="_blank" rel="noopener noreferrer">/r/${esc(card.card_code)} ${svg('external')}</a><div class="detail-stats"><div><span>Scan ${simulated?'<small>SIMULASI</small>':''}</span><strong>${tracked&&cardStats?count(cardStats.visits):'—'}</strong></div><div><span>Redirect ${simulated?'<small>SIMULASI</small>':''}</span><strong>${tracked&&cardStats?count(cardStats.redirects):'—'}</strong></div></div></aside><form id="edit-form"><input type="hidden" name="card_code" value="${esc(card.card_code)}"><h3>Informasi usaha</h3><p class="status-note">Kelola nama dan tujuan kartu Anda. Pengunjung tetap dapat membuka kartu tanpa login.</p>${field('business_name','Nama usaha',{max:150,value:card.business_name,autocomplete:'organization'})}${field('review_url','Link Google Maps / Google Review',{type:'url',max:8192,value:card.review_url,hint:'Tempel link Bagikan Google Maps atau link Google Review HTTPS. Konversi berjalan otomatis.'})}<a class="btn maps-test" id="edit-test-link" target="_blank" rel="noopener noreferrer" hidden>${svg('external')}Coba Link Review</a><div class="edit-form-actions"><button class="btn primary" type="submit">Simpan perubahan</button><a class="btn text" href="dashboard.html">Selesai</a></div><p class="message" role="status"></p></form></div></section>`;
    const form=document.getElementById('edit-form'),input=form.elements.review_url,button=form.querySelector('button[type="submit"]'),note=form.querySelector('[role="status"]');
    form._rrMapsManaged=true;
    const testLink=document.getElementById('edit-test-link');
    let resolved=null;button.disabled=true;let localFallback={update(){}};
    if(productPreview)import('./review-fallback.mjs').then(({mountReviewFallback})=>{if(form.isConnected)localFallback=mountReviewFallback({input,before:form.querySelector('.edit-form-actions'),enabled:true});}).catch(()=>{});
    import('./maps.mjs').then(({converter,resolveMaps})=>{
      if(!form.isConnected)return;
      const work=converter({resolve:resolveMaps,update(result){if(!form.isConnected)return;resolved=result.url;button.disabled=result.state!=='ready';testLink.hidden=!result.url;testLink.href=result.url||'';note.textContent=result.message||'';note.className='message '+(result.state==='error'?'error':'');localFallback.update(result);}});
      input.addEventListener('input',()=>work.input(input.value));
      if(input.value===card.review_url){resolved=card.review_url;button.disabled=false;testLink.href=card.review_url;testLink.hidden=!card.review_url;}else work.input(input.value);
    }).catch(()=>{button.disabled=true;message(note,'Konversi link belum dapat dimuat. Muat ulang halaman.',true);});
    bindForm('edit-form','update',async () => {if(await loadCards()){const savedNote=document.querySelector('#edit-form [role="status"]');if(savedNote)message(savedNote,'Informasi kartu berhasil disimpan.');}},async data=>{if(!resolved)throw Error('Tunggu hingga link Google Review siap.');data.review_url=resolved;});
  }
  function activation() {
    content.innerHTML = `
      <div class="activation-heading"><p class="eyebrow">AKTIVASI KARTU ? WORKSPACE PEMBELI</p><h1>Dari satu sentuhan,<br><span>jadi kepercayaan.</span></h1><p>Siapkan kartu NFC/QR untuk usaha Anda. Satu formulir, tiga kelompok isian.</p></div>
      <div class="activation-layout">
        <aside class="activation-context" aria-label="Tentang kartu Anda">
          <div class="nfc-illustration" aria-hidden="true"><div class="nfc-card"><div class="nfc-brand"><img src="../assets/rakyat-review-logo.png" width="84" height="56" alt=""><span>rakyat<b>review</b></span><svg class="icon" viewBox="0 0 24 24"><path d="M8 9a4 4 0 0 1 0 6m4-9a8 8 0 0 1 0 12m4-15a12 12 0 0 1 0 18"/></svg></div><strong>Usaha Anda,<br>makin dikenal.</strong><div class="nfc-bottom"><span>NFC + QR</span><span class="nfc-colors"><i></i><i></i><i></i><i></i></span></div></div><p>IDENTITAS USAHA, DALAM SATU KARTU</p></div>
          <div class="activation-benefit"><span>01</span><div><h2>Terhubung ke akun Anda</h2><p>Aktivasi dan pencatatan pemilik diproses bersama.</p></div></div>
          <div class="activation-benefit"><span>02</span><div><h2>URL kartu tetap sama</h2><p>Kartu NFC/QR tetap dapat dibuka pengunjung tanpa login.</p></div></div>
          <div class="activation-benefit"><span>03</span><div><h2>Simpan PIN dengan aman</h2><p>PIN kartu berbeda dari password akun pembeli.</p></div></div>
          <a class="activation-back" href="dashboard.html">? Kembali ke kartu saya</a>
        </aside>
        <div class="activation-forms">
          <section class="activation-primary" aria-labelledby="activation-title"><div class="activation-color-line" aria-hidden="true"></div><div class="activation-form-heading"><span class="activation-tag">KARTU BARU</span><h2 id="activation-title">Aktifkan kartu usaha Anda</h2><p>Semua kolom wajib diisi. Periksa kembali sebelum mengaktifkan.</p></div>
            <ol class="activation-stages" aria-label="Kelompok isian aktivasi"><li><a href="#stage-card"><span>1</span>Identitas Kartu</a></li><li><a href="#stage-business"><span>2</span>Informasi Usaha</a></li><li><a href="#stage-security"><span>3</span>Keamanan</a></li></ol>
            <form id="activate-form">
              <fieldset id="stage-card"><legend><span>01</span> Identitas Kartu</legend><p class="group-description">Gunakan kode yang disertakan bersama kartu Anda.</p>
                ${field('card_code','Kode kartu',{max:30,hint:'Pertahankan angka nol di depan, misalnya 002.'})}
                ${field('activation_code','Kode aktivasi',{type:'password',min:8,max:128,hint:'Kode aktivasi dari pembelian kartu, bukan PIN kartu.'})}
              </fieldset>
              <fieldset id="stage-business"><legend><span>02</span> Informasi Usaha</legend><p class="group-description">Tentukan nama dan tujuan Google Review usaha Anda.</p>
                ${field('business_name','Nama usaha',{max:150,autocomplete:'organization'})}
                ${field('review_url','URL Google Review',{type:'url',max:2048,hint:'Masukkan link Google Review atau Google Maps HTTPS.'})}
              </fieldset>
              <fieldset id="stage-security"><legend><span>03</span> Keamanan</legend><p class="group-description">Buat PIN yang hanya diketahui oleh pengelola kartu.</p>
                ${field('pin','Buat PIN kartu',{type:'password',min:6,max:72,autocomplete:'new-password',hint:'Minimal 6 karakter. Simpan PIN; jangan gunakan password akun Anda.'})}
              </fieldset>
              <div class="activation-submit"><button class="btn primary full" type="submit">Aktifkan & hubungkan kartu <span aria-hidden="true">?</span></button><p>Nama dan link dapat dikelola kembali dari dashboard.</p></div><p class="message" role="status"></p>
            </form>
          </section>
          <section class="activation-claim" aria-labelledby="claim-title"><span class="activation-tag">KARTU YANG SUDAH AKTIF</span><h2 id="claim-title">Hubungkan kartu lama</h2><p class="hint">Gunakan PIN yang sudah berlaku. URL dan hash PIN lama tetap dipertahankan.</p><form id="claim-form">
            ${field('old-card','Kode kartu',{max:30})}${field('old-pin','PIN kartu lama',{type:'password',max:1024})}
            <button class="btn full" type="submit">Hubungkan kartu lama</button><p class="message" role="status"></p></form><p class="account-privacy">Kartu milik akun lain tidak dapat diklaim. Setelah lima percobaan PIN salah, tunggu 15 menit. Jika lupa PIN, hubungi pengelola; belum tersedia reset PIN otomatis.</p>
          </section>
        </div>
      </div>`;
    bindForm('activate-form','activate',async (data, form, note)=>{form.reset();message(note,'Kartu aktif dan terhubung. Buka Kartu saya untuk mengelolanya.');});
    document.getElementById('claim-form').addEventListener('submit',async event=>{
      event.preventDefault();const form=event.currentTarget,button=form.querySelector('button'),note=form.querySelector('[role="status"]');button.disabled=true;
      try{await request('claim',{card_code:form.elements['old-card'].value.trim(),pin:form.elements['old-pin'].value});form.reset();message(note,'Kartu lama berhasil terhubung. Buka Kartu saya.');}catch(error){message(note,error.message,true);}finally{button.disabled=false;}
    });
  }
  async function boot() {
    try {
      const mode=await request('mode',undefined,false);mock=mode.mode==='synthetic';productPreview=mock&&mode.product_preview===true;firstClaimFlow=mode.activation_flow==='first_claim'||mode.mode==='restricted';realAuth=mode.real_auth===true||mode.mode==='restricted';cardAccess=mode.card_access||'closed';
      if(realAuth){document.getElementById('mode-label').textContent='GOOGLE ASLI';document.getElementById('mode-note').innerHTML='<div class="notice">Google OAuth dan sesi menggunakan Supabase nyata. '+(cardAccess==='restricted'?'Akses kartu mengikuti akun, registry, kepemilikan, dan masa berlaku pengujian terbatas.':'Akses kartu V2 masih closed; tidak ada kartu atau akun demo pada mode ini.')+'</div>';}
      if(mock){document.getElementById('mode-label').textContent='SIMULASI LOKAL';document.getElementById('mode-note').innerHTML=`<div class="notice buyer-preview-note"><span class="simulation-tag">SIMULASI</span><span>Preview lokal dengan akun dan kartu sintetis. Tidak ada koneksi Supabase atau aktivasi kartu asli.${productPreview?' Scan dan redirect tercatat hanya di preview ini.':''}</span>${productPreview?'<a href="/preview-new-card">Coba scan kartu</a>':''}</div>`;}
      if(page==='auth'){auth();return;}
      const session=await request('session');
      document.getElementById('logout').hidden=false;
      document.getElementById('logout').onclick=async()=>{try{await request('signout',{});location.href='index.html';}catch(error){content.innerHTML=`<p class="message error">${esc(error.message)}</p><a href="index.html">Kembali ke login</a>`;}};
      if(realAuth&&session.user.google!==true){content.innerHTML='<section class="auth-box"><h1>Gunakan akun Google Anda</h1><p class="status-note">Sesi ini belum mempunyai identitas Google yang terverifikasi. Keluar atau lanjutkan login Google untuk menghubungkan kartu.</p><a class="btn primary" href="index.html">Lanjutkan dengan Google</a></section>';return;}
      const identity=document.getElementById('account-identity');identity.textContent=(session.user.name?session.user.name+' · ':'')+(session.user.email || 'Akun pembeli')+(mock?' · SIMULASI':session.user.google?' (Google)':'');identity.hidden=false;
      if(page==='dashboard')await loadCards();else if(productPreview){location.href='/preview-new-card';return;}else if(firstClaimFlow){const code=new URLSearchParams(location.search).get('card');if(code&&/^[A-Za-z0-9_-]{24}$/.test(code)){location.href='mulai.html?card='+encodeURIComponent(code);return;}content.innerHTML='<section class="auth-box"><h1>Mulai dari kartu Anda</h1><p class="status-note">Scan QR atau tap NFC pada kartu. Identitas kartu terisi otomatis; Anda cukup mengisi informasi usaha lalu masuk dengan Google.</p><a class="btn" href="dashboard.html">Kembali ke dashboard</a></section>';}else activation();
    } catch(error) {
      if(error.status===401){location.href=mock?'index.html?next='+encodeURIComponent(page==='activate'?'aktivasi.html':'dashboard.html'):'index.html';return;}
      content.innerHTML=`<section class="auth-box"><h1>Belum dapat terhubung</h1><p class="message error">${esc(error.message)}</p><button class="btn" id="retry">Coba lagi</button></section>`;
      document.getElementById('retry').onclick=boot;
    }
  }
  if(typeof window!=='undefined')window.addEventListener('pageshow',event=>{
    if(event.persisted&&page==='dashboard')loadCards().catch(error=>{
      content.innerHTML=`<section class="auth-box"><p class="message error">${esc(error.message)}</p><a href="dashboard.html">Muat ulang Dashboard Saya</a></section>`;
    });
  });
  boot();
})();
