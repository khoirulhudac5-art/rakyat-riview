(() => {
  'use strict';
  const accountMode = document.body.dataset.source !== 'legacy-demo';
  let client, statistics=null, accountUser=null, simulation=false, errorText='', needsLogin=false, resolvedReview=null, mapsWork, editingAllowed=true;
  const fixtures = [
    { id: 'demo-101', code: 'DEMO-101', name: 'Kopi Ruang Pagi', status: 'active', type: 'NFC + QR', url: 'https://search.google.com/local/writereview?placeid=ChISyntheticDemo101', visits: [32, 46, 39, 65, 52, 78, 64], redirects: 351 },
    { id: 'demo-102', code: 'DEMO-102', name: 'Studio Senja', status: 'active', type: 'QR', url: 'https://search.google.com/local/writereview?placeid=ChISyntheticDemo102', visits: [15, 21, 18, 29, 24, 37, 30], redirects: 158 },
    { id: 'demo-103', code: 'DEMO-103', name: 'Kartu usaha baru', status: 'pending', type: 'NFC + QR', url: '', visits: [0, 0, 0, 0, 0, 0, 0], redirects: 0 }
  ];
  const storageKey = 'rr-buyer-v2-synthetic-session';
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icons = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    card: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h4"/>',
    chart: '<path d="M4 3v17h17M8 15l4-5 4 2 5-7"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    wave: '<path d="M8 9a4 4 0 0 1 0 6m4-9a8 8 0 0 1 0 12m4-15a12 12 0 0 1 0 18"/>',
    store: '<path d="M4 10v10h16V10M3 10l2-6h14l2 6M9 20v-6h6v6M3 10c0 3 4 3 4 0 0 3 5 3 5 0 0 3 5 3 5 0 0 3 4 3 4 0"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>'
  };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.card}</svg>`;
  const fmt = n => n!==null&&n!==undefined&&Number.isFinite(Number(n)) ? new Intl.NumberFormat('id-ID').format(n) : '—';
  const sum = list => list.reduce((a, b) => a + b, 0);
  let cards = accountMode ? [] : structuredClone(fixtures);
  if(!accountMode)try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
    cards.forEach(card => {
      if (typeof saved[card.id]?.name === 'string' && typeof saved[card.id]?.url === 'string') {
        card.name = saved[card.id].name; card.url = saved[card.id].url;
      }
    });
  } catch { /* A blocked/unavailable session store does not prevent the demo. */ }
  const detail = document.body.dataset.page === 'detail';
  const params = new URLSearchParams(location.search);
  let state = accountMode ? 'loading' : ['ready', 'loading', 'empty', 'error'].includes(params.get('state')) ? params.get('state') : 'ready';
  let search = '', filter = 'all', timer;
  const selected = () => cards.find(c => c.id === (params.get('id') || params.get('card') || (accountMode ? '' : 'demo-101')));
  const badge = card => `<span class="badge ${card.status}">${card.status === 'active' ? 'Aktif' : 'Belum aktif'}</span>`;
  const shell = document.getElementById('shell');
  shell.innerHTML = `
    <aside class="sidebar" id="navigation"><a class="brand" href="dashboard.html"><span class="brand-mark"><img class="rr-logo" src="assets/rakyat-review-logo.png" alt="" width="72" height="48"></span><span>rakyat<span class="brand-light">review</span><small>BUYER WORKSPACE</small></span></a><div class="workspace"><span class="workspace-avatar">DP</span><span>Workspace pembeli<small>Demo workspace</small></span><span class="workspace-dot"></span></div>
      <p class="nav-label">WORKSPACE</p><nav aria-label="Navigasi pembeli">
        <a class="nav-link ${!detail ? 'active' : ''}" ${!detail ? 'aria-current="page"' : ''} href="dashboard.html">${icon('grid')} Ringkasan</a>
        <a class="nav-link ${detail ? 'active' : ''}" href="dashboard.html#cards">${icon('card')} Kartu saya</a>
        <a class="nav-link" href="dashboard.html#statistics">${icon('chart')} Statistik</a>
      </nav><div class="sidebar-foot"><div class="sidebar-note">${icon('card')}<strong>Interaksi kecil.<br>Reputasi lebih besar.</strong><p>Satu tempat untuk setiap kartu dan setiap kunjungan.</p></div><div class="sidebar-version"><span class="status-dot"></span> Rakyat Review <span>V2 DEMO</span></div></div>
    </aside>
    <div class="layout"><header class="topbar"><button class="mobile-menu" id="menu" aria-label="Buka navigasi" aria-controls="navigation" aria-expanded="false">${icon('menu')}</button><a class="mobile-brand" href="dashboard.html" aria-label="Rakyat Review — Dashboard pembeli"><span class="mobile-brand-mark"><img class="rr-logo" src="assets/rakyat-review-logo.png" alt="" width="72" height="48"></span><span class="mobile-brand-name">rakyat<span>review</span></span></a><span class="top-title">Workspace <span class="top-divider">/</span> <strong>${detail ? 'Detail kartu' : 'Ringkasan'}</strong></span><div class="account"><span class="demo-pill">DEMO</span><span class="account-divider"></span><span class="avatar" aria-hidden="true">DP</span><span class="account-name">Demo Pembeli<small>Personal workspace</small></span></div></header>
    <main class="content" id="main"><div id="view" aria-busy="false"></div>
    <div class="demo-tools"><label for="demo-state">Pratinjau kondisi</label><select class="field-control" id="demo-state"><option value="ready">Data tersedia</option><option value="loading">Loading</option><option value="empty">Kosong</option><option value="error">Gagal memuat</option></select><button class="btn text" id="reset-demo">Reset data demo</button><span>Hanya data sintetis · tanpa koneksi database</span></div>
    <footer class="footer"><span>© 2026 Rakyat Review</span><span>Dirancang untuk usaha yang terus tumbuh.</span></footer></main></div>`;
  const view = document.getElementById('view');
  const selector = document.getElementById('demo-state');
  selector.value = state;
  document.getElementById('menu').addEventListener('click', e => {
    const open = document.getElementById('navigation').classList.toggle('open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
    e.currentTarget.setAttribute('aria-label', open ? 'Tutup navigasi' : 'Buka navigasi');
  });
  document.querySelectorAll('.nav-link').forEach(a => a.addEventListener('click', () => {
    document.getElementById('navigation').classList.remove('open');
    document.getElementById('menu').setAttribute('aria-expanded', 'false');
  }));
  let demoNotice = `<div class="notice demo-notice"><span class="demo-label">DEMO WORKSPACE</span><span>Semua kartu dan statistik adalah contoh. Perubahan hanya berlaku di tab ini, bukan pada kartu NFC/QR asli.</span>${icon('lock')}</div>`;
  function chart(values, label) {
    const series=accountMode?(detail?statistics?.by_card?.[selected()?.code]?.series:statistics?.series)||[]:[];
    const cutoff=new Date(Date.now()-6*86400000).toISOString().slice(0,10),today=new Date().toISOString().slice(0,10);
    const pointsData=series.filter(p=>p.date>=cutoff&&p.date<=today);
    if(accountMode)values=pointsData.map(p=>p.visits);
    if(accountMode&&!values.length)return `<div class="chart-wrap"><div class="chart-summary"><div><span class="overline">KUNJUNGAN</span><strong>—<small>data belum tersedia</small></strong></div><span class="chart-legend"><i></i> Kunjungan kartu</span></div><svg class="chart" viewBox="0 0 740 214" role="img" aria-label="Statistik belum tersedia"><text x="370" y="110" text-anchor="middle">Belum ada data pengukuran</text></svg><p class="chart-note">Scan dan redirect bukan jumlah ulasan Google. Rincian NFC/QR belum tersedia.</p></div>`;
    const max = Math.max(10, ...values), ceiling = Math.ceil(max / 10) * 10;
    const points = values.map((v, i) => `${54 + i * (accountMode ? 648/Math.max(1,values.length-1) : 108)},${170 - v / ceiling * 140}`).join(' ');
    const labels = accountMode ? pointsData.map(p=>new Date(p.date+'T12:00:00Z').toLocaleDateString('id-ID',{day:'numeric',month:'short'})) : ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
    return `<div class="chart-wrap"><div class="chart-summary"><div><span class="overline">KUNJUNGAN${accountMode?(simulation?' · SIMULASI':''):' · DATA CONTOH'}</span><strong>${fmt(sum(values))}<small>selama 7 hari</small></strong></div><span class="chart-legend"><i></i> Kunjungan kartu</span></div><svg class="chart" viewBox="0 0 740 214" role="img" aria-label="${esc(accountMode?label.replace(' contoh',''):label)}">${[0, 1, 2, 3].map(i => `<line x1="54" y1="${30 + i * 140 / 3}" x2="702" y2="${30 + i * 140 / 3}" stroke="#e9edf3" stroke-dasharray="3 5"/><text x="4" y="${34 + i * 140 / 3}">${Math.round(ceiling * (3 - i) / 3)}</text>`).join('')}<polygon points="54,170 ${points} 702,170" fill="#f0f5ff"/><polyline points="${points}" fill="none" stroke="#3778ed" stroke-width="2.5" stroke-linejoin="round"/>${values.map((v, i) => `<circle cx="${54 + i * (accountMode ? 648/Math.max(1,values.length-1) : 108)}" cy="${170 - v / ceiling * 140}" r="3.5" fill="white" stroke="#3778ed" stroke-width="2"/><text text-anchor="middle" x="${54 + i * (accountMode ? 648/Math.max(1,values.length-1) : 108)}" y="200">${labels[i]}</text>`).join('')}</svg><p class="chart-note"><span>${values.map((v, i) => `${labels[i]} ${fmt(v)}`).join(' · ')}</span><span>Kunjungan dan redirect bukan jumlah ulasan Google.</span></p></div>`;
  }
  function heading() {
    return detail ? `<div class="breadcrumb"><a href="dashboard.html">Dashboard</a> ${icon('chevron')} Detail kartu</div><div class="page-heading"><div><p class="eyebrow">KARTU & IDENTITAS USAHA</p><h1>Detail kartu<span class="heading-dot">.</span></h1><p class="subtitle">Satu identitas usaha. Setiap interaksi terhubung.</p></div><a class="btn" href="dashboard.html">${icon('back')} Kembali</a></div>` : `<div class="page-heading"><div><p class="eyebrow">SELAMAT DATANG, ${accountMode?esc(accountUser?.name||'PEMBELI'):'DEMO PEMBELI'}</p><h1>Usaha Anda, makin dikenal<span class="heading-dot">.</span></h1><p class="subtitle">Dari satu sentuhan, jadi kesempatan. Kelola semua kartu dan interaksi usaha Anda di sini.</p></div><a class="btn primary" href="#cards">${icon('card')} Lihat kartu saya ${icon('arrow')}</a><div class="hero-art" aria-hidden="true"><span class="hero-orbit"></span><div class="hero-card hero-card-back"></div><div class="hero-card hero-card-front"><span><img class="rr-logo" src="assets/rakyat-review-logo.png" alt="" width="72" height="48"> rakyat<b>review</b></span><strong>Usaha kecil.<br>Kesan besar.</strong><small>NFC + QR <i>••••</i></small></div><span class="hero-star">✦</span></div></div>`;
  }
  function empty(title, description, retry = false) {
    return `<section class="panel empty" role="status"><div class="icon-box">${icon(retry ? 'info' : 'card')}</div><h2>${title}</h2><p>${description}</p>${retry ? '<button class="btn primary" id="retry">Coba lagi</button>' : accountMode?'<a class="btn" href="/pembeli/mulai.html">Tambah kartu</a>':'<button class="btn" id="show-demo">Tampilkan data contoh</button>'}</section>`;
  }
  function render() {
    clearTimeout(timer);
    view.setAttribute('aria-busy', String(state === 'loading'));
    view.innerHTML = heading() + demoNotice;
    if (state === 'loading') {
      view.innerHTML += '<section class="panel" role="status"><p class="subtitle" style="padding:24px">Memuat kartu dan statistik…</p><div class="loading-block"></div><div class="loading-block"></div></section>';
      return;
    }
    if (state === 'error') {
      view.innerHTML += empty('Data belum dapat dimuat', accountMode?esc(errorText):'Simulasi gangguan koneksi. Data demo Anda tetap tersimpan. Silakan coba lagi.', true);
      if(accountMode){document.getElementById('retry').onclick=loadAccount;if(needsLogin){document.getElementById('retry').textContent=simulation?'Masuk sebagai akun demo A':'Lanjutkan dengan Google';document.getElementById('retry').onclick=loginAccount;}return;}
      document.getElementById('retry').onclick = () => { state = 'loading'; render(); timer = setTimeout(() => changeState('ready'), 650); };
      return;
    }
    if (state === 'empty' || (detail && !selected())) {
      view.innerHTML += empty(detail ? 'Kartu tidak ditemukan' : 'Belum ada kartu', detail ? accountMode?'Kartu tidak tercantum pada akun Anda.':'Kartu tidak tersedia dalam koleksi demo ini.' : accountMode?'Kartu yang Anda klaim akan muncul di sini. Scan NFC/QR untuk memulai.':'Kartu yang sudah ditambahkan akan muncul di sini. Mulai dengan menjelajahi data contoh.');
      if(accountMode)return;
      document.getElementById('show-demo').onclick = () => {
        if (detail && !selected()) location.href = 'dashboard.html'; else changeState('ready');
      };
      return;
    }
    if (detail) renderDetail(); else renderDashboard();
  }
  function renderDashboard() {
    const visits = accountMode ? [] : cards[0].visits.map((_, i) => sum(cards.map(c => c.visits[i])));
    const stats = [['Kartu aktif', cards.filter(c => c.status === 'active').length, `Dari ${cards.length} kartu Anda`, 'card'], ['Total kunjungan', accountMode?statistics?.visits:sum(visits), accountMode?'Kunjungan URL kartu':'Periode contoh · 7 hari', 'chart'], ['Total redirect', accountMode?statistics?.redirects:sum(cards.map(c => c.redirects)), accountMode?'Pengalihan ke Google Review':'Periode contoh · 7 hari', 'arrow']];
    view.innerHTML += `<section class="stats" aria-label="Ringkasan kartu">${stats.map(([title, value, caption, symbol]) => `<article class="stat"><div class="stat-top"><span>${title}</span><span class="icon-box">${icon(symbol)}</span></div><div class="metric-body"><div class="stat-value">${fmt(value)}</div><span class="metric-index" aria-hidden="true">${icon(symbol)}</span></div><div class="stat-caption"><span class="metric-dot"></span>${caption}<span class="metric-demo">${accountMode?(simulation?'SIMULASI':''):'DEMO'}</span></div></article>`).join('')}</section>
      <div class="dashboard-overview"><section class="panel" id="statistics"><div class="panel-head"><div><h2>Aktivitas kartu</h2><p>Kunjungan seluruh kartu Anda</p></div><span class="demo-pill">${accountMode?(simulation?'7 HARI · SIMULASI':'7 HARI'):'7 HARI CONTOH'}</span></div>${chart(visits, 'Kunjungan seluruh kartu selama tujuh hari contoh')}</section><aside class="panel workspace-overview"><div class="panel-head"><div><h2>Di workspace Anda</h2><p>Setiap usaha, satu identitas.</p></div><span class="overview-count">${cards.length}</span></div><div class="workspace-list">${cards.map(c => `<a class="workspace-item" href="kartu.html?id=${encodeURIComponent(c.id)}"><span class="business-avatar business-${c.id}">${icon('store')}</span><span><strong>${esc(c.name)}</strong><small>${esc(c.code)} · ${c.status === 'active' ? 'Aktif' : 'Belum aktif'}</small></span>${icon('chevron')}</a>`).join('')}</div><div class="workspace-tip">${icon('info')}<p><strong>Siap untuk interaksi berikutnya?</strong>Kelola tujuan Google Review langsung dari detail kartu.</p></div><a class="overview-link" href="#cards">Jelajahi kartu Anda ${icon('arrow')}</a></aside></div>
      <section class="panel section-gap" id="cards"><div class="panel-head"><div><h2>Kartu saya <span class="code">(${cards.length})</span></h2><p>Kelola informasi dan link Google Review usaha Anda.</p></div>${icon('card')}</div><div class="toolbar"><label class="sr-only" for="search">Cari nama usaha atau kode</label><input class="field-control search" id="search" type="search" placeholder="Cari nama usaha atau kode kartu…" value="${esc(search)}"><label class="sr-only" for="filter">Filter status</label><select class="field-control" id="filter"><option value="all">Semua status</option><option value="active">Aktif</option><option value="pending">Belum aktif</option></select></div><p class="sr-only" id="search-result" role="status"></p><div class="card-grid" id="card-list"></div></section>`;
    document.getElementById('filter').value = filter;
    document.getElementById('search').oninput = e => { search = e.target.value; renderCards(); };
    document.getElementById('filter').onchange = e => { filter = e.target.value; renderCards(); };
    renderCards();
  }
  function renderCards() {
    const matches = cards.filter(c => (filter === 'all' || c.status === filter) && `${c.name} ${c.code}`.toLowerCase().includes(search.toLowerCase()));
    document.getElementById('search-result').textContent = `${matches.length} kartu ditemukan`;
    document.getElementById('card-list').innerHTML = matches.length ? matches.map((c) => `<article class="buyer-card ${c.status === 'pending' ? 'pending-card' : ''}"><div class="card-top"><span class="card-type">${icon(c.type === 'QR' ? 'grid' : 'wave')}${esc(c.type)}</span>${badge(c)}</div><div class="business-identity"><span class="business-avatar business-${c.id}">${icon('store')}</span><div><h3 class="card-name">${esc(c.name)}</h3><div class="code">${esc(c.code)}<span>·</span> Kartu digital</div></div></div><div class="card-metrics"><div><span>Kunjungan</span><strong>${fmt(accountMode?c.measuredVisits:sum(c.visits))}</strong></div><div><span>Redirect</span><strong>${fmt(c.redirects)}</strong></div><span class="card-period">${accountMode?(simulation?'SIMULASI':''):'7 hari<br>contoh'}</span></div><div class="card-actions"><a class="btn" href="kartu.html?id=${encodeURIComponent(c.id)}">Detail kartu ${icon('chevron')}</a><a class="btn ${c.status === 'pending' ? 'activate' : 'primary'}" href="${accountMode&&c.status==='pending'?'/pembeli/mulai.html?card='+encodeURIComponent(c.code):'kartu.html?id='+encodeURIComponent(c.id)+'#edit'}">${c.status === 'pending' ? 'Aktivasi' : 'Kelola'} ${icon('arrow')}</a></div>${c.status === 'pending' && !accountMode ? '<p class="pending-hint">Pratinjau aktivasi · tidak mengaktifkan kartu asli</p>' : ''}</article>`).join('') : '<p class="subtitle no-results">Tidak ada kartu yang sesuai. Coba kata kunci atau status lain.</p>';
  }
  function renderDetail() {
    const card = selected();
    view.innerHTML += `<div class="detail-grid"><section class="panel" id="edit"><div class="panel-head"><div><h2>${card.status === 'pending' ? (accountMode?'Aktivasi kartu':'Pratinjau aktivasi') : 'Informasi usaha'}</h2><p>Nama dan tujuan Google Review kartu.</p></div>${badge(card)}</div><div class="panel-body">${card.status === 'pending' ? '<div class="notice">'+(accountMode?'Kartu belum aktif. Scan NFC/QR untuk melanjutkan aktivasi.':'Kartu contoh ini belum aktif. Edit hanya menyimpan draft demo dan tidak mengaktifkan kartu.')+'</div>' : ''}<form id="edit-form"><div class="form-field"><label for="business-name">Nama usaha</label><input class="field-control" id="business-name" name="business_name" required maxlength="150" value="${esc(card.name)}" autocomplete="organization"></div><div class="form-field"><label for="review-url">URL Google Review</label><input class="field-control" id="review-url" name="review_url" type="url" required maxlength="2048" placeholder="https://search.google.com/local/writereview?placeid=…" value="${esc(card.url)}" aria-describedby="url-hint"><p class="hint" id="url-hint">Gunakan URL HTTPS Google Maps atau Google Review.</p></div><div class="form-field"><label for="card-code">Kode kartu</label><input class="field-control readonly" id="card-code" value="${esc(card.code)}" readonly><p class="hint">Kode dan URL permanen kartu tidak berubah saat informasi usaha diedit.</p></div><div class="form-bottom"><span class="hint">${accountMode?'Disimpan pada kartu milik akun Anda.':'Perubahan hanya untuk demo.'}</span><button class="btn primary" id="save" type="submit">Simpan perubahan</button></div><p id="save-message" class="message" role="status" aria-live="polite"></p><label class="hint"><input type="checkbox" id="simulate-failure"> Simulasikan gagal menyimpan</label></form></div></section>
    <aside class="panel card-overview"><div class="panel-head"><h2>Ringkasan kartu</h2>${icon('card')}</div><div class="panel-body"><div class="physical-card ${card.status === 'pending' ? 'physical-pending' : ''}"><div class="physical-top"><span>rakyat<span>review</span></span><img class="rr-logo" src="assets/rakyat-review-logo.png" alt="" width="72" height="48"></div><div class="physical-name">${esc(card.name)}</div><div class="physical-bottom"><span>${esc(card.code)}</span><span>NFC / QR${accountMode?(simulation?' · SIMULASI':''):' · DEMO'}</span></div></div><dl class="details-list"><dt>Nama usaha</dt><dd id="summary-name">${esc(card.name)}</dd><dt>Jenis kartu</dt><dd>${esc(card.type)}</dd><dt>Status</dt><dd>${badge(card)}</dd><dt>URL permanen${accountMode?'':' (contoh)'}</dt><dd><code>/r/${esc(card.code)}</code><p class="hint">${accountMode?'URL QR dan NFC tetap sama saat link review diedit.':'Kode sintetis ini tidak terhubung ke kartu asli.'}</p></dd><dt>Tujuan Google Review</dt><dd id="summary-url">${esc(card.url || 'Belum diatur')}</dd></dl><div class="detail-summary"><span>Kunjungan${accountMode?'':' · 7 hari contoh'}</span><strong>${fmt(accountMode?card.measuredVisits:sum(card.visits))}</strong><span>${fmt(card.redirects)} redirect diproses</span></div></div></aside></div>
    <section class="panel section-gap" id="statistics"><div class="panel-head"><div><h2>Statistik kunjungan</h2><p>Aktivitas kartu ${esc(card.code)}</p></div><span class="demo-pill">${accountMode?(simulation?'7 HARI · SIMULASI':'7 HARI'):'7 HARI CONTOH'}</span></div>${chart(card.visits, `Kunjungan kartu ${card.code} selama tujuh hari contoh`)}</section>`;
    if(accountMode)mountConversion();
    document.getElementById('edit-form').addEventListener('submit', async event => {
      event.preventDefault();
      const nameInput = document.getElementById('business-name');
      const urlInput = document.getElementById('review-url');
      const name = nameInput.value.trim(), url = urlInput.value.trim();
      const message = document.getElementById('save-message');
      const fail = !accountMode&&document.getElementById('simulate-failure').checked;
      const feedback = (text, error = false) => { message.className = `message ${error ? 'error' : 'success'}`; message.textContent = text; };
      if (!name || name.length > 150) { feedback('Isi nama usaha dengan 1–150 karakter.', true); nameInput.focus(); return; }
      if(accountMode){await saveAccount(card,name,message);return;}
      if (!validReviewUrl(url)) { feedback('Gunakan URL HTTPS Google Maps atau Google Review yang valid.', true); urlInput.focus(); return; }
      const save = document.getElementById('save');
      save.disabled = true; nameInput.disabled = true; urlInput.disabled = true;
      save.textContent = 'Menyimpan…'; message.textContent = '';
      await new Promise(resolve => setTimeout(resolve, 550));
      if (!document.contains(save)) return;
      if (fail) feedback('Simulasi gagal menyimpan. Perubahan belum disimpan. Silakan coba lagi.', true);
      else {
        card.name = name; card.url = url;
        let persisted = true;
        try { sessionStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(cards.map(c => [c.id, { name: c.name, url: c.url }])))); }
        catch { persisted = false; }
        document.getElementById('summary-name').textContent = name;
        document.getElementById('summary-url').textContent = url;
        feedback(persisted ? 'Perubahan demo berhasil disimpan di tab ini.' : 'Perubahan berhasil diterapkan di halaman ini. Penyimpanan sesi tidak tersedia.');
      }
      save.disabled = false; nameInput.disabled = false; urlInput.disabled = false; save.textContent = 'Simpan perubahan';
    });
  }

  async function loginAccount(){
    try{if(simulation){await client.requestBuyer('demo-signin',{account:'first'});await loadAccount();}else{const {googleLogin}=await import('../pembeli/drafts.mjs');await googleLogin(location.pathname+location.search);}}
    catch(error){errorText=error.message;state='error';render();}
  }
  async function readOwned(){
    const data=await client.ownedDashboard(simulation);statistics=data.statistics;
    cards=data.cards.map(c=>({id:c.card_code,code:c.card_code,name:c.business_name||'Usaha Anda',url:c.review_url,status:c.active?'active':'pending',type:'NFC + QR',visits:[],measuredVisits:data.statistics.by_card[c.card_code]?.visits??null,redirects:data.statistics.by_card[c.card_code]?.redirects??null}));
  }
  async function loadAccount(){
    state='loading';needsLogin=false;render();
    try{
      client=await import('./buyer-account.mjs');const mode=await client.requestBuyer('mode',undefined,false);simulation=mode.mode==='synthetic';editingAllowed=mode.capabilities?.update!==false;
      document.querySelector('.account .demo-pill').textContent=simulation||mode.fixture===true?'SIMULASI':'GOOGLE';
      demoNotice='<div class="notice demo-notice"><span class="demo-label">'+(simulation?'SIMULASI LOKAL':'AKUN PEMBELI')+'</span><span>'+(simulation?'Kartu dan statistik hanya berasal dari preview lokal, bukan Supabase atau Google Review.':mode.card_access==='closed'?'Google Login tersedia. Akses kartu V2 masih closed; tidak ada kartu atau angka demo sebagai pengganti data akun.':'Kartu dan perubahan dibaca dari akun Anda. Scan dan redirect bukan jumlah ulasan Google.')+'</span>'+icon('lock')+'</div>';
      if(mode.fixture===true)demoNotice='<div class="notice demo-notice"><span class="demo-label">FIXTURE LOKAL</span><span>Kartu dari PostgreSQL lokal dan akun OAuth sintetis. Bukan Supabase atau Google nyata. Statistik belum tersedia.</span></div>';
      const session=await client.requestBuyer('session');accountUser=session.user;
      if(!simulation&&accountUser.google!==true)throw Object.assign(Error('Gunakan akun Google Anda.'),{status:401});
      document.querySelector('.account-name').innerHTML=esc(accountUser.name||'Pembeli')+'<small>'+(simulation?'Simulasi lokal':'Akun Google')+'</small>';
      document.querySelector('.workspace-avatar').textContent=(accountUser.name||'P').slice(0,2).toUpperCase();document.getElementById('account-logout').hidden=false;document.getElementById('account-logout').disabled=false;
      document.getElementById('account-logout').textContent=(accountUser.name||'P').slice(0,2).toUpperCase();
      await readOwned();state=cards.length?'ready':'empty';render();
    }catch(error){cards=[];statistics=null;needsLogin=error.status===401;errorText=error.message;state='error';render();}
  }
  async function mountConversion(){
    if(!editingAllowed){document.getElementById('simulate-failure').closest('label').hidden=true;for(const id of ['save','business-name','review-url'])document.getElementById(id).disabled=true;document.getElementById('save-message').textContent='Pilot ini hanya membuka baca kartu milik Anda. Pengeditan belum diaktifkan.';return;}
    mapsWork?.dispose();resolvedReview=null;const input=document.getElementById('review-url'),save=document.getElementById('save');save.disabled=true;input.maxLength=8192;
    document.getElementById('simulate-failure').closest('label').hidden=true;
    const link=document.createElement('a');link.className='btn text';link.textContent='Coba Link Review';link.target='_blank';link.rel='noopener noreferrer';link.hidden=true;input.after(link);
    try{const {converter,resolveMaps}=await import('../pembeli/maps.mjs');if(!input.isConnected)return;mapsWork=converter({resolve:resolveMaps,update(result){if(!input.isConnected)return;resolvedReview=result.url;save.disabled=result.state!=='ready';document.getElementById('url-hint').textContent=result.message||'Tempel link Google Maps atau Google Review.';link.hidden=!result.url;if(result.url)link.href=result.url;}});input.addEventListener('input',()=>mapsWork.input(input.value));mapsWork.input(input.value);}
    catch{document.getElementById('url-hint').textContent='Konversi belum dapat dimuat. Muat ulang halaman.';}
  }
  async function saveAccount(card,name,message){
    if(!editingAllowed){message.textContent='Pengeditan belum diaktifkan pada pilot.';return;}
    if(!resolvedReview){message.className='message error';message.textContent='Tunggu hingga link Google Review siap.';return;}
    const save=document.getElementById('save');save.disabled=true;save.textContent='Menyimpan…';let saved=false;
    try{await client.requestBuyer('update',{card_code:card.code,business_name:name,review_url:resolvedReview});saved=true;await readOwned();state=cards.length?'ready':'empty';render();const note=document.getElementById('save-message');if(note){note.className='message success';note.textContent='Informasi kartu berhasil disimpan.';}}
    catch(error){if(saved){cards=[];statistics=null;errorText='Perubahan sudah disimpan, tetapi kartu belum dapat dibaca ulang. '+error.message;state='error';render();return;}if(!document.contains(message))return;message.className='message error';message.textContent=error.message;}
    finally{if(document.contains(save)){save.disabled=false;save.textContent='Simpan perubahan';}}
  }

  function validReviewUrl(value) {
    try {
      const url = new URL(value);
      return value.length <= 2048 && url.protocol === 'https:' && !url.username && !url.password && !url.port && ['maps.app.goo.gl', 'www.google.com', 'google.com', 'search.google.com'].includes(url.hostname);
    } catch { return false; }
  }
  function changeState(next) { state = next; selector.value = next; render(); }
  selector.onchange = e => {if(!accountMode)changeState(e.target.value);};
  document.getElementById('reset-demo').onclick = () => {
    if(accountMode)return;
    try { sessionStorage.removeItem(storageKey); } catch { /* Still reset in memory. */ }
    cards = structuredClone(fixtures); search = ''; filter = 'all'; changeState('ready');
  };
  if(accountMode){
    demoNotice='<div class="notice demo-notice"><span class="demo-label">AKUN PEMBELI</span><span>Memuat sesi dan kartu Anda…</span>'+icon('lock')+'</div>';document.querySelector('.account .demo-pill').textContent='AKUN';document.querySelector('.account-name').textContent='Pembeli';
    document.querySelector('.demo-tools').hidden=true;document.querySelector('.demo-tools').style.display='none';
    document.querySelector('.workspace small').textContent='Akun pembeli';
    document.querySelector('.sidebar-version span:last-child').textContent='V2';
    const logout=document.createElement('button');logout.className='avatar';logout.textContent='RR';logout.title='Keluar';logout.setAttribute('aria-label','Keluar dari akun');logout.hidden=true;logout.disabled=true;logout.id='account-logout';
    document.querySelector('.account .avatar').replaceWith(logout);logout.onclick=async()=>{try{await client.requestBuyer('signout',{});location.href='/pembeli/index.html';}catch(error){errorText=error.message;state='error';render();}};
    window.addEventListener('pageshow',event=>{if(event.persisted)loadAccount();});
    loadAccount();
  }else render();
})();
