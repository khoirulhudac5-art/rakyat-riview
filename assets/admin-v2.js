// Product Admin V2. The local preview API owns fixtures and authorization;
// this UI never treats browser storage or an interface flag as authority.
import {normalizeDashboard} from '../pembeli/dashboard-data.mjs';
import {generateQrPngBlob} from './qrcode.mjs';
import {buildZip} from './zip.mjs';
const app = document.getElementById('admin-app');
const byId = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const number = value => value!==null&&value!==undefined&&value!==''&&Number.isSafeInteger(Number(value))&&Number(value)>=0?new Intl.NumberFormat('id-ID').format(Number(value)):'—';
const paths = {
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  card:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M7 15h4m4 0h2"/>',
  history:'<path d="M3 11a9 9 0 1 1 2.7 7M3 5v6h6m3-5v6l4 2"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  external:'<path d="M14 3h7v7m0-7L10 14m-2-9H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5m10.2-4A8 8 0 0 0 5.5 5.5L4 8m16 8-1.5 2.5A8 8 0 0 1 4.8 16"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout:'<path d="M9 5H5v14h4m5-12 5 5-5 5m-6-5h11"/>',
  users:'<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m2-15a3 3 0 0 1 0 6m4 9v-2a6 6 0 0 0-3-5"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  scan:'<path d="M8 3H4v4m12-4h4v4M4 17v4h4m12-4v4h-4M3 12h18m-14-4h10v8H7"/>',
  chart:'<path d="M4 4v16h17M8 15l4-5 4 2 4-7"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  reset:'<path d="M3 10a9 9 0 1 1 1 7M3 4v6h6m3-4v6l4 2"/>',
  nfc:'<path d="M9 6v12m6-12v12M9 6l6 12M5 7a7 7 0 0 0 0 10m14-10a7 7 0 0 1 0 10M2 4a12 12 0 0 0 0 16M22 4a12 12 0 0 1 0 16"/>',
  box:'<path d="m3 7 9-4 9 4-9 5-9-5Zm0 0v11l9 4 9-4V7m-9 5v10M7 5l9 5"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.card}</svg>`;
const logo = '<img src="/assets/rakyat-review-logo.png" alt="" width="38" height="38"><span><strong>Rakyat Review</strong><small>Admin workspace</small></span>';
const state = {mode:'unknown',cards:[],statistics:null,loaded:false,capabilities:{list:false,create:false,reset:false,audit:false},view:'cards',query:'',filter:'all',selected:null,resetCard:null,busy:false,knownActivationLinks:new Map(),lastGeneratedBatch:null,reissueTarget:null};
let noticeTimer;

function notify(message, error=false) {
  const notice=byId('admin-notice'); clearTimeout(noticeTimer);
  notice.textContent=message; notice.classList.toggle('error',error); notice.hidden=false;
  noticeTimer=setTimeout(()=>{notice.hidden=true;},6500);
}

function acceptMetadata(data) {
  if(data.mode)state.mode=data.mode;
  state.readOnly=data.read_only===true;
  state.urlsAvailable=data.production_urls_available!==false;
  const defaults=state.mode==='synthetic'?{list:true,create:true,reset:true,audit:true}:{list:false,create:false,reset:false,audit:false};
  state.capabilities={...defaults,...(data.capabilities||{})};
  if(state.readOnly){state.capabilities.create=false;state.capabilities.reset=false;}
}

async function request(action, body) {
  // A failed mutation is never automatically retried: reload authoritative state first.
  const response=await fetch('/api/v2-admin?action='+encodeURIComponent(action),{
    method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',
    headers:body===undefined?{}:{'Content-Type':'application/json','X-Admin-Request':'1'},
    ...(body===undefined?{}:{body:JSON.stringify({action,...body})}),
  });
  let data;try{data=await response.json();if(!data||typeof data!=='object'||Array.isArray(data))throw Error();}catch{throw Error('Respons server tidak dapat dibaca. Muat ulang status sebelum mengulangi tindakan.');}
  if(!response.ok){const error=new Error(data.error||data.message||'Permintaan belum berhasil. Coba muat ulang status.');error.status=response.status;error.data=data;throw error;}
  return data;
}

function environment() {
  if(state.readOnly)return '<div class="environment restricted"><span class="tag '+(state.mode==='synthetic'?'synthetic':'')+'">'+(state.mode==='synthetic'?'SIMULASI READ-ONLY':'SUPABASE READ-ONLY')+'</span><span>'+(state.mode==='synthetic'?'Data contoh kontrak baca lokal, bukan data Supabase.':'Data dibaca melalui backend Admin; RPC/izin yang belum tersedia tetap ditolak.')+' Generate dan Reset Aktivasi tidak diaktifkan.</span></div>';
  return state.mode==='synthetic'
    ? '<div class="environment"><span class="tag synthetic">SIMULASI LOKAL</span><span>Inventaris dan aktivitas di halaman ini merupakan fixture lokal. Semua perubahan hanya berlaku pada preview ini.</span></div>'
    : '<div class="environment restricted"><span class="tag">AKSES TERBATAS</span><span>Operasi mengikuti izin server dan registry pengujian. Fitur yang belum dibuka akan tetap ditolak; data simulasi tidak ditampilkan dalam mode ini.</span></div>';
}

function renderLogin(message='') {
  app.setAttribute('aria-busy','false');
  app.innerHTML=`<main id="main" class="login-wrap"><section class="login-card"><a class="brand" href="/pembeli/dashboard.html">${logo}</a><div class="eyebrow">RUANG KERJA ADMIN</div><h1>Kelola setiap kartu.<br>Dalam satu tempat.</h1><p>Masuk untuk menyiapkan kartu, melihat kepemilikan, dan mencatat Reset Aktivasi.</p><form id="admin-login-form"><div id="login-error" class="inline-error" role="alert" ${message?'':'hidden'}>${escapeHtml(message)}</div><label for="admin-password">Sandi Admin</label><input class="field" id="admin-password" name="password" type="password" autocomplete="current-password" required placeholder="Masukkan sandi Admin"><button class="btn primary" id="admin-login-submit" type="submit">Masuk ke Dashboard ${icon('arrow')}</button></form>${state.mode==='synthetic'?'<div class="environment"><span class="tag synthetic">SIMULASI LOKAL</span><p>Gunakan sandi <code>demo-admin</code>. Ini bukan akun Admin production.</p></div>':''}<a class="back-link" href="/pembeli/dashboard.html">${icon('arrow')} Kembali ke dashboard pembeli</a></section></main>`;
  byId('admin-login-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=byId('admin-login-submit');button.disabled=true;button.textContent='Memverifikasi…';byId('login-error').hidden=true;
    try{const data=await request('login',{password:byId('admin-password').value});acceptMetadata(data);renderShell();await loadCards();}
    catch(error){const target=byId('login-error');if(target){target.textContent=error.message;target.hidden=false;button.disabled=false;button.innerHTML='Masuk ke Dashboard '+icon('arrow');}}
  });
}

function renderShell() {
  app.setAttribute('aria-busy','false');
  app.innerHTML=`<aside class="sidebar" id="admin-sidebar" aria-label="Navigasi Admin"><a class="brand" href="/admin-v2.html">${logo}</a><button class="icon-btn mobile-close" id="menu-close" aria-label="Tutup navigasi">${icon('close')}</button><p class="side-label">WORKSPACE</p><nav><button class="nav-item active" data-view="cards">${icon('grid')} Ringkasan & kartu</button><button class="nav-item" data-view="audit">${icon('history')} Riwayat aktivitas</button></nav><p class="side-label">${state.mode==='synthetic'?'PREVIEW PRODUK':'APLIKASI'}</p><a class="nav-item" href="/pembeli/dashboard.html">${icon('users')} Dashboard pembeli ${icon('external')}</a>${state.mode==='synthetic'?`<a class="nav-item" href="/preview-new-card">${icon('scan')} Coba scan kartu ${icon('external')}</a>`:''}<div class="sidebar-bottom"><div class="side-note"><div class="color-bar" aria-hidden="true"><i></i><i></i><i></i><i></i></div><p style="margin-top:12px">Satu kartu. Satu URL permanen.<br>QR dan NFC tetap terhubung.</p></div><button class="nav-item" id="admin-logout">${icon('logout')} Keluar Admin</button></div></aside><button class="backdrop" id="menu-backdrop" aria-label="Tutup navigasi" hidden></button><div class="layout"><header class="topbar"><button class="icon-btn menu-toggle" id="menu-open" aria-label="Buka navigasi" aria-expanded="false" aria-controls="admin-sidebar">${icon('menu')}</button><a class="brand" href="/admin-v2.html">${logo}</a><div class="top-context">Workspace <span style="margin:0 12px;color:#c6cfdd">/</span><strong id="breadcrumb">Ringkasan & kartu</strong></div><span class="tag ${state.mode==='synthetic'?'synthetic':''}">${state.mode==='synthetic'?'SIMULASI':'TERBATAS'}</span><div class="admin-identity"><span class="avatar">AD</span><span>Administrator</span></div></header><main class="content" id="main"><div id="page-error" class="inline-error" role="alert" hidden></div><section class="section" id="inventory-section"><div class="heading"><div><div class="eyebrow">RAKYAT REVIEW · ADMIN V2</div><h1>Setiap kartu, tertata.</h1><p>Siapkan inventaris dan kelola aktivasi, dari kartu pertama hingga ribuan usaha.</p></div><div class="heading-actions"><button class="btn" id="reload-cards">${icon('refresh')} Muat ulang</button><button class="btn primary" id="open-create" ${state.capabilities.create?'':'disabled'}>${icon('plus')} Buat kartu</button></div></div>${environment()}<div class="metrics" id="admin-metrics">${metricsMarkup()}</div><div class="overview"><section class="panel"><div class="panel-heading"><div><h2>Aktivitas kartu</h2><p>Scan dan pengalihan menuju tujuan review.</p></div>${icon('chart')}</div><div class="chart-content" id="admin-chart"><div class="no-chart">Memuat aktivitas…</div></div></section><section class="panel production-panel"><div class="panel-heading"><div><h2>Siap untuk setiap usaha</h2><p>Produksi dengan alur yang konsisten.</p></div>${icon('box')}</div><div class="production-box"><div class="production-mark">${icon('nfc')}<div><strong>Satu identitas. QR + NFC.</strong><small>Gunakan URL permanen yang sama pada kedua media.</small></div></div><p>Kartu baru langsung siap diklaim. Pemilik pertama dapat mengelola nama usaha dan tujuan review melalui akunnya.</p><button class="btn" id="production-export">${icon('download')} Ekspor data produksi</button></div></section></div><section class="panel" aria-labelledby="inventory-title"><div class="panel-heading inventory-heading"><div><h2 id="inventory-title">Inventaris kartu</h2><span class="count" id="inventory-count">0</span></div>${icon('card')}</div><div class="tools"><label class="search-wrap"><span class="sr-only" style="position:absolute;clip:rect(0,0,0,0)">Cari nama usaha, ID, atau pemilik kartu</span>${icon('search')}<input id="card-search" class="field" type="search" placeholder="Cari usaha, ID kartu, atau pemilik…" autocomplete="off"></label><select class="field" id="card-filter" aria-label="Filter status kartu"><option value="all">Semua status</option><option value="active">Sudah aktif</option><option value="ready">Siap diklaim</option></select><button class="btn" id="export-cards">${icon('download')} Ekspor CSV</button><button class="btn" id="download-qr-zip">${icon('download')} Download ZIP QR</button></div><div id="inventory-body" aria-live="polite"><div class="loading-row">Memuat kartu…<span class="skeleton"></span><span class="skeleton"></span></div></div><div class="table-footer"><span id="inventory-result">Memuat inventaris…</span><span>Identitas kartu dan URL permanen tetap dipertahankan.</span></div></section><div id="restricted-reset-host"></div><p class="integration-note">${icon('info')}<span>Scan adalah kunjungan ke URL kartu, bukan jumlah review. Jumlah dan riwayat Google Review belum tersedia karena belum ada integrasi resmi Google Business Profile yang terotorisasi.</span></p></section><section class="section" id="audit-section" hidden><div class="heading"><div><div class="eyebrow">JEJAK OPERASIONAL</div><h1>Riwayat aktivitas.</h1><p>Perubahan inventaris dan Reset Aktivasi tercatat untuk ditinjau kembali.</p></div><button class="btn" id="reload-audit">${icon('refresh')} Muat ulang</button></div>${environment()}<section class="panel"><div class="panel-heading inventory-heading"><h2>Log aktivitas Admin</h2>${icon('shield')}</div><div id="audit-body" aria-live="polite"></div></section></section><footer class="page-foot"><span>Rakyat Review · Admin V2</span><span>${state.mode==='synthetic'?'Preview lokal · data sintetis':'Akses mengikuti izin server'}</span></footer></main></div>${dialogsMarkup()}`;
  app.addEventListener('click',handleClick);
  byId('card-search').addEventListener('input',event=>{state.query=event.target.value;renderInventory();});
  byId('card-filter').addEventListener('change',event=>{state.filter=event.target.value;renderInventory();});
  byId('admin-create-form').addEventListener('submit',createCards);
  byId('admin-reset-form').addEventListener('submit',resetCard);
  for(const id of ['reset-confirmation','reset-reason','reset-ack'])byId(id).addEventListener('input',validateReset);
  if(byId('reissue-ack'))byId('reissue-ack').addEventListener('input',()=>{if(byId('reissue-submit'))byId('reissue-submit').disabled=!byId('reissue-ack').checked||state.busy;});
  for(const id of ['create-dialog','detail-dialog','reset-dialog','batch-dialog','reissue-dialog'])if(byId(id))byId(id).addEventListener('cancel',event=>{if(state.busy)event.preventDefault();});
}

function metricsMarkup() {
  const loaded=state.capabilities.list&&state.loaded;
  const values=[loaded?number(state.cards.length):'—',loaded?number(state.cards.filter(c=>c.active).length):'—',loaded?number(state.cards.filter(c=>!c.active&&(!state.readOnly||c.inventory_state==='ready')).length):'—',state.statistics?.available?number(state.statistics.visits):'—'];
  return [['Tổng kartu','card','Identitas NFC + QR'],['Sudah aktif','check','Memiliki pemilik akun'],['Siap diklaim','box','Langsung siap untuk pembeli'],['Total scan','scan','Kunjungan, bukan Google Review']].map((item,index)=>`<article class="metric"><div class="metric-top"><span>${index===0?'Total kartu':item[0]}</span>${icon(item[1])}</div><div class="metric-value">${values[index]}</div><small>${item[2]}</small></article>`).join('');
}

function safeUrl(value) {
  try{const url=new URL(value,location.origin);return !url.username&&!url.password&&(url.protocol==='https:'||(url.protocol==='http:'&&url.origin===location.origin&&['127.0.0.1','localhost'].includes(url.hostname)))?url.href:'';}catch{return '';}
}
function permanentUrl(card){
  if(state.urlsAvailable===false||!card?.card_code)return '';
  const canonical='https://rakyat-riview.vercel.app';
  const fallback=location.origin===canonical?canonical+'/r/'+encodeURIComponent(card.card_code):'';
  const candidate=card.card_url||fallback;
  if(!candidate&&state.readOnly)return '';
  const value=safeUrl(candidate||card.card_url||'/r/'+encodeURIComponent(card.card_code));
  if(!value)return '';
  const url=new URL(value);
  return url.pathname==='/r/'+encodeURIComponent(card.card_code)&&!url.search&&!url.hash?url.href:'';
}

function renderChart() {
  const stats=state.statistics;
  if(!stats?.available){byId('admin-chart').innerHTML='<div class="no-chart">Statistik belum tersedia pada backend ini.<br>Tidak ada data simulasi yang ditampilkan sebagai data nyata.</div>';return;}
  const series=Array.isArray(stats.series)?stats.series.slice(-14):[];
  const maximum=Math.max(3,Math.ceil(Math.max(0,...series.flatMap(point=>[Number(point.visits)||0,Number(point.redirects)||0]))/3)*3);
  const x=index=>48+index*(530/Math.max(series.length-1,1));
  const y=value=>160-((Number(value)||0)/maximum)*130;
  const line=key=>series.map((point,index)=>`${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`).join(' ');
  let graph='';
  for(let index=0;index<4;index++){const value=maximum*index/3,top=y(value);graph+=`<line x1="48" y1="${top}" x2="582" y2="${top}" stroke="#edf1f7"/><text x="33" y="${top+4}" text-anchor="end">${number(Math.round(value))}</text>`;}
  if(series.length){graph+=`<polyline points="${line('visits')}" fill="none" stroke="#4285f4" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/><polyline points="${line('redirects')}" fill="none" stroke="#34a853" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;for(const index of [...new Set([0,Math.floor((series.length-1)/2),series.length-1])]){const date=new Date(series[index].date);const label=Number.isNaN(date.getTime())?'':date.toLocaleDateString('id-ID',{day:'numeric',month:'short'});graph+=`<text x="${x(index)}" y="187" text-anchor="${index===0?'start':index===series.length-1?'end':'middle'}">${escapeHtml(label)}</text>`;}}
  byId('admin-chart').innerHTML=`<div class="chart-totals"><div class="chart-total"><i></i>Scan kartu<strong>${number(stats.visits)}</strong></div><div class="chart-total green"><i></i>Redirect ke Google<strong>${number(stats.redirects)}</strong></div></div><svg class="chart" role="img" aria-label="Grafik ${number(stats.visits)} scan dan ${number(stats.redirects)} redirect. ${stats.synthetic?'Aktivitas lokal sintetis.':''}" viewBox="0 0 612 200">${graph}</svg><div class="chart-foot"><span>${stats.synthetic?'Aktivitas aktual pada URL kartu preview lokal.':'Aktivitas URL kartu yang dicatat sistem.'}</span><span>Scan ≠ review Google</span></div>`;
}

async function loadCards() {
  byId('page-error').hidden=true;
  const reload=byId('reload-cards');reload.disabled=true;
  if(!state.capabilities.list){renderInventory();renderChart();renderRestrictedReset();reload.disabled=false;return false;}
  try{const data=await request('cards');acceptMetadata(data);const normalized=normalizeDashboard(data,{simulation:state.mode==='synthetic'});state.cards=normalized.cards;state.statistics=normalized.statistics;state.loaded=true;byId('admin-metrics').innerHTML=metricsMarkup();renderInventory();renderChart();renderRestrictedReset();return true;}
  catch(error){state.cards=[];state.statistics=null;state.loaded=false;if(error.status===401){renderLogin('Sesi Admin berakhir. Silakan masuk kembali.');return false;}byId('admin-metrics').innerHTML=metricsMarkup();renderInventory();renderChart();byId('page-error').textContent=error.message;byId('page-error').hidden=false;byId('inventory-body').innerHTML=`<div class="empty">${icon('info')}<strong>Inventaris belum dapat dimuat</strong><p>${escapeHtml(error.message)}</p><button class="btn" id="retry-cards">Coba lagi</button></div>`;return false;}
  finally{if(byId('reload-cards'))byId('reload-cards').disabled=false;}
}

function filteredCards() {
  const query=state.query.trim().toLocaleLowerCase('id-ID');
  return state.cards.filter(card=>(state.filter==='all'||(state.filter==='active'?card.active:!card.active))&&(!query||[card.card_code,card.business_name,card.owner_label].some(value=>String(value||'').toLocaleLowerCase('id-ID').includes(query))));
}

function renderInventory() {
  byId('inventory-count').textContent=number(state.cards.length);
  for(const id of ['export-cards','production-export','download-qr-zip'])if(byId(id))byId(id).disabled=state.urlsAvailable===false||!state.capabilities.list||state.cards.length===0;
  if(!state.capabilities.list){byId('inventory-body').innerHTML=`<div class="empty">${icon('shield')}<strong>Daftar inventaris belum tersedia</strong><p>Kontrak restricted saat ini tidak menyediakan daftar atau pembuatan kartu Admin.<br>Tidak ada RPC asli yang dibuka sebagai pengganti.</p></div>`;byId('inventory-result').textContent='Akses baca inventaris tidak tersedia.';return;}
  const cards=filteredCards();
  byId('inventory-result').textContent=`Menampilkan ${number(cards.length)} dari ${number(state.cards.length)} kartu`;
  if(!cards.length){byId('inventory-body').innerHTML=`<div class="empty">${icon('card')}<strong>${state.cards.length?'Kartu tidak ditemukan':'Inventaris Anda siap dimulai'}</strong><p>${state.cards.length?'Coba nama usaha, ID kartu, atau status yang lain.':'Buat kartu pertama. Setiap kartu akan langsung siap diklaim pembeli.'}</p>${state.cards.length||!state.capabilities.create?'':'<button class="btn primary" id="empty-create">'+icon('plus')+' Buat kartu pertama</button>'}</div>`;return;}
  byId('inventory-body').innerHTML=`<table class="table"><thead><tr><th scope="col">Kartu & usaha</th><th scope="col">Status</th><th scope="col">Pemilik</th><th scope="col">Scan</th><th scope="col">Aksi</th></tr></thead><tbody>${cards.map(card=>`<tr><td><div class="card-identity"><span class="card-initial">${icon(card.active?'card':'nfc')}</span><div><strong>${escapeHtml(card.business_name||'Kartu siap diklaim')}</strong><small class="mono">${escapeHtml(card.card_code)}</small></div></div></td><td><span class="status ${card.active?'active':'ready'}">${activationStatus(card)}</span></td><td class="owner">${escapeHtml(card.owner_label||'Belum ada pemilik')}<small>${card.owner_label?'Terhubung ke akun pembeli':'Klaim pertama menjadi pemilik'}</small></td><td class="scan-count">${state.statistics?.available?number(card.visits):'—'}</td><td><div class="row-action"><button class="btn" data-detail="${escapeHtml(card.card_code)}" aria-label="Detail kartu ${escapeHtml(card.card_code)}">Detail ${icon('arrow')}</button></div></td></tr>`).join('')}</tbody></table>`;
}

function activationStatus(card){return card.active?'Sudah aktif':!state.readOnly||card.inventory_state==='ready'?'Siap diklaim':card.inventory_state==='draft'?'Belum siap':'Belum aktif';}

function renderRestrictedReset() {
  if(state.capabilities.list||!state.capabilities.reset){byId('restricted-reset-host').innerHTML='';return;}
  byId('restricted-reset-host').innerHTML=`<section class="panel manual-reset"><div class="panel-heading"><div><h2>Reset kartu pengujian terdaftar</h2><p>Hanya identitas dummy dan revision yang sudah diverifikasi operator.</p></div>${icon('shield')}</div><form id="manual-reset-form" class="dialog-body"><label for="manual-card">ID kartu dummy</label><input class="field" id="manual-card" required maxlength="100" autocomplete="off"><label for="manual-revision">Revision aktivasi saat ini</label><input class="field" id="manual-revision" type="number" min="0" step="1" required><p>Server tetap memeriksa sesi Admin, registry, masa berlaku, revision, dan status akses. Mode closed akan menolak operasi.</p><button class="btn" type="submit">Lanjut ke konfirmasi</button></form></section>`;
  byId('manual-reset-form').addEventListener('submit',event=>{event.preventDefault();const revision=Number(byId('manual-revision').value);if(!Number.isSafeInteger(revision)||revision<0)return;openReset({card_code:byId('manual-card').value.trim(),activation_revision:revision,active:true});});
}

function dialogsMarkup() {
  return `<dialog id="create-dialog" aria-labelledby="create-title"><form id="admin-create-form"><div class="dialog-head"><div><h2 id="create-title">Siapkan kartu baru</h2><p>Identitas unik otomatis, langsung siap diklaim.</p></div><button class="icon-btn" type="button" data-close="create-dialog" aria-label="Tutup">${icon('close')}</button></div><div class="dialog-body"><div id="create-error" class="inline-error" role="alert" hidden></div><div class="form-group"><label for="create-quantity">Jumlah kartu</label><input class="field" id="create-quantity" type="number" min="1" max="1000" step="1" value="1" required><div class="quantity-presets"><button class="btn" type="button" data-quantity="1">1 kartu</button><button class="btn" type="button" data-quantity="10">10 kartu</button><button class="btn" type="button" data-quantity="50">50 kartu</button><button class="btn" type="button" data-quantity="100">100 kartu</button></div><p class="help">Maksimal 1.000 kartu dalam satu pembuatan.</p></div><div class="production-mark">${icon('nfc')}<div><strong>QR dan NFC menggunakan URL yang sama</strong><small>Ekspor CSV sesudah kartu dibuat untuk menyiapkan produksi.</small></div></div></div><div class="dialog-foot"><button class="btn" type="button" data-close="create-dialog">Batal</button><button class="btn primary" id="create-submit" type="submit">${icon('plus')} Buat kartu</button></div></form></dialog><dialog id="batch-dialog" aria-labelledby="batch-title"><div class="dialog-head"><div><h2 id="batch-title">Kartu Baru Berhasil Disimpan</h2><p id="batch-subtitle"></p></div><button class="icon-btn" type="button" data-close="batch-dialog" aria-label="Tutup">${icon('close')}</button></div><div class="dialog-body"><div class="warning-box" style="background:#fef7e0;border-color:#f9ab00;color:#202124"><strong>PENTING: Unduh file aktivasi sekarang.</strong><br>Database hanya menyimpan hash token demi keamanan. Link aktivasi ini tidak dapat dibaca kembali dari database setelah sesi browser ini selesai.</div><div style="display:flex;flex-direction:column;gap:10px;margin-top:16px"><button class="btn primary" id="download-private-batch-csv">${icon('download')} Unduh CSV Link Aktivasi (Arsip Privat Admin)</button><button class="btn" id="download-batch-qr-zip">${icon('download')} Unduh ZIP QR Code (${icon('card')} PNG per kartu)</button><button class="btn" id="download-physical-batch-csv">${icon('download')} Unduh CSV Produksi Fisik (Untuk Percetakan & NFC)</button></div><p class="help" style="margin-top:12px">CSV Produksi Fisik bebas token rahasia, aman dikirim ke pihak luar.</p></div><div class="dialog-foot"><button class="btn" type="button" data-close="batch-dialog">Selesai</button></div></dialog><dialog id="reissue-dialog" aria-labelledby="reissue-title"><div class="dialog-head"><div><h2 id="reissue-title">Terbitkan Ulang Link Aktivasi</h2><p id="reissue-card-label" class="mono"></p></div><button class="icon-btn" type="button" data-close="reissue-dialog" aria-label="Tutup">${icon('close')}</button></div><div class="dialog-body"><div class="warning-box"><strong>Link aktivasi lama akan dibatalkan secara permanen.</strong><br>Token baru akan diterbitkan. Siapa pun yang memegang link lama tidak akan dapat menggunakannya lagi.</div><label class="check-label" style="margin-top:16px"><input id="reissue-ack" type="checkbox" required><span>Saya mengonfirmasi bahwa link lama hilang/batal dan perlu diganti dengan link baru.</span></label></div><div class="dialog-foot"><button class="btn" type="button" data-close="reissue-dialog">Batal</button><button class="btn danger" id="reissue-submit" type="button" disabled>Konfirmasi Terbitkan Ulang</button></div></dialog><dialog id="detail-dialog" aria-labelledby="detail-title"><div class="dialog-head"><div><h2 id="detail-title">Detail kartu</h2><p>Identitas, kepemilikan, dan URL permanen.</p></div><button class="icon-btn" data-close="detail-dialog" aria-label="Tutup">${icon('close')}</button></div><div class="dialog-body" id="detail-body"></div><div class="dialog-foot"><button class="btn" data-close="detail-dialog">Tutup</button></div></dialog><dialog id="reset-dialog" aria-labelledby="reset-title"><form id="admin-reset-form"><div class="dialog-head"><div><h2 id="reset-title">Reset Aktivasi</h2><p id="reset-card-label" class="mono"></p></div><button class="icon-btn" type="button" data-close="reset-dialog" aria-label="Tutup">${icon('close')}</button></div><div class="dialog-body"><div class="warning-box"><strong>Pemilik lama akan kehilangan akses.</strong>Nama usaha, tujuan review, dan kepemilikan dilepas agar kartu dapat diklaim ulang. ID dan URL QR/NFC tetap sama. Tindakan ini dicatat pada audit.</div><div id="reset-error" class="inline-error" role="alert" hidden></div><div class="form-group"><label for="reset-confirmation">Ketik ulang ID kartu</label><input class="field mono" id="reset-confirmation" required autocomplete="off" spellcheck="false"></div><div class="form-group"><label for="reset-reason">Alasan reset</label><textarea class="field" id="reset-reason" required minlength="20" maxlength="1000" placeholder="Jelaskan permintaan dan alasan reset…"></textarea><p class="help">Minimal 20 karakter. Alasan disimpan dalam log aktivitas.</p></div><label class="check-label"><input id="reset-ack" type="checkbox" required><span>Saya memahami bahwa pemilik lama kehilangan akses dan kartu dapat diklaim ulang.</span></label></div><div class="dialog-foot"><button class="btn" type="button" data-close="reset-dialog">Batal</button><button class="btn danger" id="reset-submit" type="submit" disabled>Konfirmasi Reset Aktivasi</button></div></form></dialog>`;
}

function showDetail(code) {
  const card=state.cards.find(item=>item.card_code===code);if(!card)return;
  state.selected=code;
  const cardUrl=permanentUrl(card),reviewUrl=safeUrl(card.review_url);
  const knownActivation=state.knownActivationLinks?.get(code);
  const created=card.created_at?new Date(card.created_at):new Date(NaN);const createdLabel=Number.isNaN(created.getTime())?'—':created.toLocaleDateString('id-ID',{day:'numeric',month:'long',year:'numeric'});
  let activationSection='';
  if(!card.active){
    if(knownActivation){
      activationSection=`<div class="detail-url" style="border-left:4px solid #1a73e8;background:#f8fafd"><strong style="color:#1a73e8">LINK AKTIVASI RAHASIA (Tersedia Sesi Ini)</strong><span class="mono" style="word-break:break-all;font-size:12px;display:block;margin-top:4px">${escapeHtml(knownActivation)}</span><div style="margin-top:8px;display:flex;gap:8px"><button class="btn primary" id="copy-activation-link">${icon('copy')} Salin Link Aktivasi</button><button class="btn" id="open-reissue-dialog">${icon('refresh')} Terbitkan Ulang Link</button></div></div>`;
    }else{
      activationSection=`<div class="detail-url" style="background:#f9fbfd"><strong>LINK AKTIVASI RAHASIA</strong><small style="color:#5f6368;display:block;margin-top:4px">Link asli tersimpan pada CSV Privat saat batch dibuat. Jika link hilang sebelum kartu diserahkan ke pembeli, gunakan tombol di bawah.</small><div style="margin-top:8px"><button class="btn" id="open-reissue-dialog">${icon('refresh')} Terbitkan Ulang Link Aktivasi</button></div></div>`;
    }
  }
  byId('detail-body').innerHTML=`<div class="detail-card"><div class="brand">${logo}</div>${icon('nfc')}<h3>${escapeHtml(card.business_name||'Siap untuk usaha berikutnya')}</h3><p class="mono">${escapeHtml(code)}</p><div class="color-bar" aria-hidden="true"><i></i><i></i><i></i><i></i></div></div><dl class="detail-grid"><div><dt>Status aktivasi</dt><dd><span class="status ${card.active?'active':'ready'}">${activationStatus(card)}</span></dd></div><div><dt>Pemilik akun</dt><dd>${escapeHtml(card.owner_label||'Belum ada pemilik')}</dd></div><div><dt>Dibuat</dt><dd>${escapeHtml(createdLabel)}</dd></div><div><dt>Revision aktivasi</dt><dd>${number(card.activation_revision)}</dd></div><div><dt>Scan kartu</dt><dd>${state.statistics?.available?number(card.visits):'Belum tersedia'}</dd></div><div><dt>Redirect ke Google</dt><dd>${state.statistics?.available?number(card.redirects):'Belum tersedia'}</dd></div></dl><div class="detail-url"><strong>URL PERMANEN · QR + NFC</strong>${cardUrl?`<a href="${escapeHtml(cardUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(cardUrl)}</a>`:'URL belum tersedia'}</div>${activationSection}<div class="detail-actions"><button class="btn" id="copy-card-url">${icon('copy')} Salin URL</button><button class="btn" id="download-card-qr">${icon('download')} Download QR (PNG)</button><button class="btn" id="export-one-card">${icon('download')} Ekspor CSV Percetakan</button>${cardUrl?`<a class="btn" href="${escapeHtml(cardUrl)}" target="_blank" rel="noopener noreferrer">${icon('external')} Coba scan</a>`:''}</div><p class="detail-review"><strong>TUJUAN GOOGLE REVIEW</strong>${reviewUrl?`<a href="${escapeHtml(reviewUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(reviewUrl)}</a>`:'Belum ditetapkan. Pembeli mengisi saat aktivasi.'}</p>${card.active&&state.capabilities.reset&&(!card.claim_mode||card.claim_mode==='google_first_claim')?'<div class="manual-reset"><button class="btn" id="open-reset">'+icon('reset')+' Reset Aktivasi</button><p class="help">Hanya lakukan setelah memeriksa permintaan yang sah.</p></div>':''}`;
  if(state.readOnly||state.urlsAvailable===false){byId('copy-card-url').disabled=!cardUrl;if(byId('download-card-qr'))byId('download-card-qr').disabled=!cardUrl;byId('export-one-card').disabled=!cardUrl;}
  byId('detail-dialog').showModal();
}

function openReset(card) {
  if(!state.capabilities.reset||!card?.active||state.busy||(card.claim_mode&&card.claim_mode!=='google_first_claim'))return;
  state.resetCard={...card};byId('admin-reset-form').reset();byId('reset-error').hidden=true;
  byId('reset-card-label').textContent=card.card_code+' · revision '+number(card.activation_revision);
  if(byId('detail-dialog').open)byId('detail-dialog').close();validateReset();byId('reset-dialog').showModal();
}

function validateReset() {
  byId('reset-submit').disabled=state.busy||!state.resetCard||!Number.isSafeInteger(state.resetCard.activation_revision)||state.resetCard.activation_revision<0||byId('reset-confirmation').value!==state.resetCard.card_code||byId('reset-reason').value.trim().length<20||byId('reset-reason').value.trim().length>1000||!byId('reset-ack').checked;
}

function lockDialog(id,locked) {
  state.busy=locked;for(const button of byId(id).querySelectorAll('button'))button.disabled=locked;
  if(id==='reset-dialog')validateReset();
}

async function createCards(event) {
  event.preventDefault();if(state.busy||!state.capabilities.create)return;
  const quantity=Number(byId('create-quantity').value);if(!Number.isSafeInteger(quantity)||quantity<1||quantity>1000)return;
  let pending=null;
  if(state.capabilities.idempotent_create){
    try{pending=JSON.parse(sessionStorage.getItem('rr-admin-generate-pending-v1')||'null');if(pending&&pending.quantity!==quantity)throw Error('Selesaikan permintaan sebelumnya dengan jumlah '+pending.quantity+' kartu terlebih dahulu.');if(!pending)pending={quantity,request_id:crypto.randomUUID()};sessionStorage.setItem('rr-admin-generate-pending-v1',JSON.stringify(pending));}
    catch(error){byId('create-error').textContent=error.message||'ID permintaan tidak dapat disimpan. Tidak ada kartu dibuat.';byId('create-error').hidden=false;return;}
  }
  lockDialog('create-dialog',true);byId('create-submit').textContent='Menyiapkan kartu…';byId('create-error').hidden=true;
  try{const data=await request('create',{quantity,...(pending?{request_id:pending.request_id}:{})});if(data.success!==true||!Array.isArray(data.cards)||data.cards.length!==quantity)throw Error('Hasil pembuatan belum dapat dikonfirmasi.');if(pending)sessionStorage.removeItem('rr-admin-generate-pending-v1');byId('create-dialog').close();if(!state.knownActivationLinks)state.knownActivationLinks=new Map();if(Array.isArray(data.cards)){for(const c of data.cards)if(c.activation_url)state.knownActivationLinks.set(c.card_code,c.activation_url);state.lastGeneratedBatch=data.cards;if(typeof openBatchResult==='function')openBatchResult(data.cards);}const loaded=await loadCards();notify(loaded?`${number(data.cards.length)} kartu berhasil dibuat dan siap diklaim.`+(state.urlsAvailable===false?' Domain permanen belum dikonfirmasi; ekspor URL belum tersedia.':' URL QR dan NFC identik.'):'Kartu sudah dibuat, tetapi inventaris belum dapat dibaca ulang. Muat ulang inventaris; jangan ulangi pembuatan.',!loaded);}
  catch(error){byId('create-error').textContent=error.message+' Muat ulang inventaris sebelum mengulangi pembuatan.';byId('create-error').hidden=false;}
  finally{if(byId('create-dialog')){lockDialog('create-dialog',false);byId('create-submit').innerHTML=icon('plus')+' Buat kartu';}}
}

async function resetCard(event) {
  event.preventDefault();validateReset();if(byId('reset-submit').disabled)return;
  const card=state.resetCard;lockDialog('reset-dialog',true);byId('reset-submit').textContent='Memproses reset…';byId('reset-error').hidden=true;
  try{const data=await request('reset',{card_code:card.card_code,confirmation:byId('reset-confirmation').value,expected_revision:Number(card.activation_revision),reason:byId('reset-reason').value.trim(),acknowledged:byId('reset-ack').checked});if(data.success!==true)throw Error('Hasil reset belum dapat dikonfirmasi.');byId('reset-dialog').close();const loaded=await loadCards();notify(loaded?'Reset Aktivasi berhasil. Pemilik lama dilepas; ID dan URL kartu tetap sama.':'Reset sudah berhasil, tetapi inventaris belum dapat dibaca ulang. Muat ulang status; jangan ulangi reset.',!loaded);}
  catch(error){byId('reset-error').textContent=error.message+' Reset tidak diulang otomatis. Muat ulang status sebelum mencoba lagi.';byId('reset-error').hidden=false;}
  finally{if(byId('reset-dialog')){lockDialog('reset-dialog',false);byId('reset-submit').textContent='Konfirmasi Reset Aktivasi';}}
}

function csvValue(value) {
  let text=String(value??'');if(/^[=+\-@\t\r]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}

function exportCards(cards) {
  if(!state.capabilities.list||!cards.length){notify('Belum ada kartu untuk diekspor.',true);return;}
  if(cards.some(card=>!permanentUrl(card))){notify('URL permanen belum valid. Muat ulang inventaris sebelum ekspor.',true);return;}
  const rows=[['card_code','business_name','status','owner','qr_url','nfc_url','activation_revision'],...cards.map(card=>{const url=permanentUrl(card);return [card.card_code,card.business_name||'',card.active?'active':'ready',card.owner_label||'',url,url,card.activation_revision];})];
  const blob=new Blob(['\uFEFF'+rows.map(row=>row.map(csvValue).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='rakyat-review-'+(state.mode==='synthetic'?'SIMULASI-':'')+new Date().toISOString().slice(0,10)+'.csv';document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);notify(number(cards.length)+' kartu diekspor. Kolom QR dan NFC menggunakan URL yang sama.');
}

async function copyCardUrl() {
  const card=state.cards.find(item=>item.card_code===state.selected);if(!card)return;
  const url=permanentUrl(card);if(!url)return;
  try{await navigator.clipboard.writeText(url);notify('URL permanen kartu berhasil disalin.');}
  catch{const selection=getSelection(),node=byId('detail-body').querySelector('.detail-url a');if(node&&selection){const range=document.createRange();range.selectNodeContents(node);selection.removeAllRanges();selection.addRange(range);}notify('Browser tidak mengizinkan clipboard. URL telah dipilih; gunakan Salin pada browser.',true);}
}

async function downloadCardQr(card) {
  const url=permanentUrl(card);if(!url){notify('URL permanen kartu belum tersedia.',true);return;}
  try{
    const blob=await generateQrPngBlob(url,{size:512,margin:4});
    const blobUrl=URL.createObjectURL(blob),anchor=document.createElement('a');
    anchor.href=blobUrl;anchor.download=`${card.card_code}.png`;
    document.body.append(anchor);anchor.click();anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(blobUrl),1000);
    notify(`QR Code ${card.card_code}.png berhasil diunduh.`);
  }catch(e){notify('Gagal membuat QR Code: '+(e.message||e),true);}
}

async function downloadQrZip(cards) {
  if(!cards.length){notify('Belum ada kartu untuk diunduh.',true);return;}
  notify(`Menyiapkan ${number(cards.length)} file QR Code PNG…`);
  try{
    const files=[];
    for(const card of cards){
      const url=permanentUrl(card);if(!url)continue;
      const blob=await generateQrPngBlob(url,{size:512,margin:4});
      const buffer=new Uint8Array(await blob.arrayBuffer());
      files.push({name:`${card.card_code}.png`,data:buffer});
    }
    if(!files.length)throw Error('Tidak ada URL permanen valid.');
    const zipBytes=buildZip(files);
    const zipBlob=new Blob([zipBytes],{type:'application/zip'});
    const zipUrl=URL.createObjectURL(zipBlob),anchor=document.createElement('a');
    anchor.href=zipUrl;anchor.download=`rakyat-review-qr-${new Date().toISOString().slice(0,10)}.zip`;
    document.body.append(anchor);anchor.click();anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(zipUrl),1000);
    notify(`ZIP berisi ${number(files.length)} QR Code berhasil diunduh.`);
  }catch(e){notify('Gagal membuat file ZIP: '+(e.message||e),true);}
}

async function copyActivationLink() {
  const code=state.selected;
  const link=state.knownActivationLinks?.get(code);
  if(!link){notify('Link aktivasi tidak tersimpan di sesi browser. Gunakan Terbitkan Ulang jika link hilang.',true);return;}
  try{
    await navigator.clipboard.writeText(link);
    notify('Link aktivasi rahasia berhasil disalin.');
  }catch(e){notify('Browser tidak mengizinkan clipboard.',true);}
}

function openReissueDialog(card) {
  if(!card||card.active||state.busy)return;
  state.reissueTarget=card.card_code;
  byId('reissue-card-label').textContent=card.card_code;
  byId('reissue-ack').checked=false;
  byId('reissue-submit').disabled=true;
  byId('reissue-dialog').showModal();
}

async function confirmReissue() {
  if(byId('reissue-submit').disabled||state.busy)return;
  const code=state.reissueTarget||state.selected;
  lockDialog('reissue-dialog',true);
  byId('reissue-submit').textContent='Menerbitkan…';
  try{
    const data=await request('reissue-token',{card_code:code});
    if(!data.activation_url)throw Error('Gagal mendapatkan link aktivasi baru.');
    if(!state.knownActivationLinks)state.knownActivationLinks=new Map();
    state.knownActivationLinks.set(code,data.activation_url);
    await navigator.clipboard.writeText(data.activation_url);
    byId('reissue-dialog').close();
    showDetail(code);
    notify('Link aktivasi baru berhasil diterbitkan dan disalin ke clipboard. Link lama dibatalkan.');
  }catch(e){notify('Penerbitan ulang gagal: '+(e.message||e),true);}
  finally{
    if(byId('reissue-dialog')){
      lockDialog('reissue-dialog',false);
      byId('reissue-submit').textContent='Konfirmasi Terbitkan Ulang';
    }
  }
}

function openBatchResult(cards) {
  if(byId('batch-subtitle'))byId('batch-subtitle').textContent=`${number(cards.length)} kartu baru siap diproduksi dan diklaim pembeli.`;
  if(byId('batch-dialog'))byId('batch-dialog').showModal();
}

function exportPrivateActivationCsv(cards) {
  if(!cards||!cards.length){notify('Belum ada kartu untuk diekspor.',true);return;}
  const rows=[['card_code','permanent_url','secret_activation_link','secret_activation_token','created_at'],...cards.map(c=>[c.card_code,c.card_url||permanentUrl(c),c.activation_url||state.knownActivationLinks?.get(c.card_code)||'',c.activation_token||'',new Date().toISOString()])];
  const blob=new Blob(['\uFEFF'+rows.map(row=>row.map(csvValue).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='rakyat-review-ARSIP-PRIVAT-AKTIVASI-'+new Date().toISOString().slice(0,10)+'.csv';document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  notify('CSV Link Aktivasi Privat berhasil diunduh. Simpan untuk diberikan ke pembeli.');
}

function exportPhysicalProductionCsv(cards) {
  if(!cards||!cards.length){notify('Belum ada kartu untuk diekspor.',true);return;}
  const rows=[['card_code','permanent_url','qr_url','nfc_url'],...cards.map(c=>{const url=c.card_url||permanentUrl(c);return [c.card_code,url,url,url];})];
  const blob=new Blob(['\uFEFF'+rows.map(row=>row.map(csvValue).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='rakyat-review-PRODUKSI-PERCETAKAN-'+new Date().toISOString().slice(0,10)+'.csv';document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  notify('CSV Produksi Percetakan berhasil diunduh (bebas token/link rahasia).');
}

async function loadAudit() {
  const target=byId('audit-body');
  if(!state.capabilities.audit){target.innerHTML=`<div class="empty">${icon('shield')}<strong>Audit belum tersedia pada adapter ini</strong><p>Log lokal tidak menggantikan audit database. Tidak ada akses tambahan yang dibuka.</p></div>`;return;}
  byId('reload-audit').disabled=true;target.innerHTML='<div class="loading-row">Memuat aktivitas…<span class="skeleton"></span></div>';
  try{const data=await request('audit'),events=Array.isArray(data.events)?data.events:[];target.innerHTML=events.length?'<div class="audit-list">'+events.slice().reverse().map(entry=>{const date=new Date(entry.at),label=Number.isNaN(date.getTime())?'':date.toLocaleString('id-ID',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}),action=String(entry.action||'');return `<article class="audit-item"><span class="audit-symbol">${icon(action.includes('reset')?'reset':action.includes('creat')?'plus':'history')}</span><div><div class="audit-title"><strong>${escapeHtml(action.includes('reset')?'Reset Aktivasi':action.includes('creat')?'Kartu baru disiapkan':action.includes('claim')?'Kartu diklaim':action.includes('update')?'Informasi kartu diperbarui':action||'Aktivitas kartu')}</strong><time>${escapeHtml(label)}</time></div><p class="mono">${escapeHtml(entry.card_code||'—')}</p><p>${escapeHtml(entry.actor||'Admin')}${entry.reason?' · '+escapeHtml(entry.reason):''}</p></div></article>`;}).join('')+'</div>':`<div class="empty">${icon('history')}<strong>Belum ada aktivitas</strong><p>Pembuatan kartu dan Reset Aktivasi akan muncul di sini.</p></div>`;}
  catch(error){target.innerHTML=`<div class="empty">${icon('info')}<strong>Riwayat belum dapat dimuat</strong><p>${escapeHtml(error.message)}</p></div>`;}
  finally{if(byId('reload-audit'))byId('reload-audit').disabled=false;}
}

function toggleMenu(open) {byId('admin-sidebar').classList.toggle('open',open);byId('menu-open').setAttribute('aria-expanded',String(open));byId('menu-backdrop').hidden=!open;}

async function handleClick(event) {
  const button=event.target.closest('button');if(!button||!app.contains(button))return;
  const id=button.id;
  if(button.dataset.close){if(!state.busy)byId(button.dataset.close).close();return;}
  if(button.dataset.quantity){byId('create-quantity').value=button.dataset.quantity;return;}
  if(button.dataset.detail){showDetail(button.dataset.detail);return;}
  if(button.dataset.view){state.view=button.dataset.view;for(const item of app.querySelectorAll('[data-view]'))item.classList.toggle('active',item.dataset.view===state.view);byId('inventory-section').hidden=state.view!=='cards';byId('audit-section').hidden=state.view!=='audit';byId('breadcrumb').textContent=state.view==='cards'?'Ringkasan & kartu':'Riwayat aktivitas';toggleMenu(false);if(state.view==='audit')await loadAudit();return;}
  if(id==='menu-open'){toggleMenu(!byId('admin-sidebar').classList.contains('open'));return;}
  if(id==='menu-close'||id==='menu-backdrop'){toggleMenu(false);return;}
  if(id==='reload-cards'||id==='retry-cards'){await loadCards();return;}
  if(id==='reload-audit'){await loadAudit();return;}
  if(id==='open-create'||id==='empty-create'){if(!state.capabilities.create)return;byId('create-error').hidden=true;byId('admin-create-form').reset();if(state.capabilities.idempotent_create){try{const pending=JSON.parse(sessionStorage.getItem('rr-admin-generate-pending-v1')||'null');if(pending)byId('create-quantity').value=pending.quantity;}catch{}}byId('create-dialog').showModal();return;}
  if(id==='export-cards'){exportCards(filteredCards());return;}
  if(id==='production-export'){exportCards(state.cards);return;}
  if(id==='export-one-card'){exportCards(state.cards.filter(card=>card.card_code===state.selected));return;}
  if(id==='copy-card-url'){await copyCardUrl();return;}
  if(id==='download-card-qr'){const card=state.cards.find(c=>c.card_code===state.selected);if(card)await downloadCardQr(card);return;}
  if(id==='copy-activation-link'){await copyActivationLink();return;}
  if(id==='open-reissue-dialog'){const card=state.cards.find(c=>c.card_code===state.selected);if(card)openReissueDialog(card);return;}
  if(id==='reissue-submit'){await confirmReissue();return;}
  if(id==='download-private-batch-csv'){exportPrivateActivationCsv(state.lastGeneratedBatch||[]);return;}
  if(id==='download-batch-qr-zip'){await downloadQrZip(state.lastGeneratedBatch||[]);return;}
  if(id==='download-physical-batch-csv'){exportPhysicalProductionCsv(state.lastGeneratedBatch||[]);return;}
  if(id==='download-qr-zip'){await downloadQrZip(filteredCards());return;}
  if(id==='open-reset'){openReset(state.cards.find(card=>card.card_code===state.selected));return;}
  if(id==='admin-logout'){button.disabled=true;try{await request('logout',{});state.cards=[];state.statistics=null;app.removeEventListener('click',handleClick);renderLogin();}catch(error){button.disabled=false;notify(error.message,true);}}
}

document.addEventListener('keydown',event=>{if(event.key==='Escape'&&byId('admin-sidebar'))toggleMenu(false);});
try{const session=await request('session');acceptMetadata(session);if(session.authenticated===false)renderLogin();else{renderShell();await loadCards();}}
catch(error){if(error.data)acceptMetadata(error.data);renderLogin(error.status===401?'':error.message);}
