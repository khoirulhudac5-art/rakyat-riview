(() => {
  'use strict';

  const demoUser = {
    name: 'Budi Santoso',
    email: 'budi.santoso@gmail.com'
  };

  const demoCards = [
    {
      card_code: 'RR-001',
      business_name: 'Kopi Nusantara',
      review_url: 'https://search.google.com/local/writereview?placeid=ChIJw73p24BC1i0R2jo9I4cr2qs',
      created_at: '2026-11-01T08:30:00Z',
      active: true,
      scan_count: 128
    },
    {
      card_code: 'RR-002',
      business_name: 'Warung Makan Berkah',
      review_url: 'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE',
      created_at: '2026-11-03T11:15:00Z',
      active: true,
      scan_count: 76
    },
    {
      card_code: 'RR-003',
      business_name: 'Laundry Bersih',
      review_url: 'https://search.google.com/local/writereview?placeid=ChIJuYi_Ighd1i0RswAXCrm2rdo',
      created_at: '2026-11-05T14:45:00Z',
      active: true,
      scan_count: 44
    }
  ];

  const demoDataSets = {
    7: [
      { date: '2026-11-04', day_name: 'Sen', day_label: '04/11', count: 22 },
      { date: '2026-11-05', day_name: 'Sel', day_label: '05/11', count: 35 },
      { date: '2026-11-06', day_name: 'Rab', day_label: '06/11', count: 28 },
      { date: '2026-11-07', day_name: 'Kam', day_label: '07/11', count: 49 },
      { date: '2026-11-08', day_name: 'Jum', day_label: '08/11', count: 31 },
      { date: '2026-11-09', day_name: 'Sab', day_label: '09/11', count: 52 },
      { date: '2026-11-10', day_name: 'Min', day_label: '10/11', count: 12 }
    ],
    30: Array.from({ length: 30 }, (_, i) => {
      const d = new Date(2026, 10, 10 - (29 - i));
      const dayNum = String(d.getDate()).padStart(2, '0');
      const monthNum = String(d.getMonth() + 1).padStart(2, '0');
      const dayNames = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
      // Deterministic realistic demo curve; today (i === 29) is exactly 12
      const pseudoVal = i === 29 ? 12 : Math.round(15 + Math.sin(i * 0.45) * 12 + (i % 7 === 5 ? 18 : (i % 7 === 6 ? 14 : 0)));
      return {
        date: `2026-${monthNum}-${dayNum}`,
        day_name: dayNames[d.getDay()],
        day_label: `${dayNum}/${monthNum}`,
        count: Math.max(pseudoVal, 5)
      };
    }),
    90: Array.from({ length: 90 }, (_, i) => {
      const d = new Date(2026, 10, 10 - (89 - i));
      const dayNum = String(d.getDate()).padStart(2, '0');
      const monthNum = String(d.getMonth() + 1).padStart(2, '0');
      // Today (i === 89) is exactly 12
      const pseudoVal = i === 89 ? 12 : Math.round(14 + Math.sin(i * 0.2) * 10 + (i % 7 === 5 ? 15 : 0));
      return {
        date: `2026-${monthNum}-${dayNum}`,
        day_name: '',
        day_label: `${dayNum}/${monthNum}`,
        count: Math.max(pseudoVal, 3)
      };
    })
  };

  let cards = [...demoCards];
  let currentPeriod = 7;
  let currentCard = 'all';
  let search = '';
  let filter = 'all';

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const icons = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    card: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h4"/>',
    chart: '<path d="M4 3v17h17M8 15l4-5 4 2 5-7"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    wave: '<path d="M8 9a4 4 0 0 1 0 6m4-9a8 8 0 0 1 0 12m4-15a12 12 0 0 1 0 18"/>',
    store: '<path d="M4 10v10h16V10M3 10l2-6h14l2 6M9 20v-6h6v6M3 10c0 3 4 3 4 0 0 3 5 3 5 0 0 3 5 3 5 0 0 3 4 3 4 0"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.card}</svg>`;
  const fmt = n => (n !== null && n !== undefined && Number.isFinite(Number(n))) ? new Intl.NumberFormat('id-ID').format(n) : '0';

  const shell = document.getElementById('shell');

  function renderShell() {
    const existingNav = document.getElementById('navigation');
    if (existingNav) return;

    shell.innerHTML = `
      <aside class="sidebar" id="navigation" aria-label="Navigasi Utama">
        <a class="brand" href="preview.html">
          <span class="brand-mark"><img class="rr-logo" src="assets/rakyat-review-logo.png" alt="Rakyat Review" width="72" height="48"></span>
          <span>rakyat<span class="brand-light">review</span><small>DASHBOARD PREVIEW</small></span>
        </a>

        <div class="workspace-user-card">
          <span class="avatar-circle" aria-hidden="true">BS</span>
          <div class="user-meta">
            <strong>${esc(demoUser.name)} <span class="badge pending" style="font-size:9px;padding:2px 5px;">DEMO</span></strong>
            <small>${esc(demoUser.email)}</small>
          </div>
        </div>

        <p class="nav-label">MENU UTAMA</p>
        <nav aria-label="Menu pembeli">
          <a class="nav-link active" href="preview.html" aria-current="page">${icon('grid')} Ringkasan & Kartu</a>
          <a class="nav-link" href="#card-section">${icon('card')} Daftar Kartu</a>
          <a class="nav-link" href="#analytics-section">${icon('chart')} Statistik Scan</a>
        </nav>

        <div class="sidebar-foot">
          <div class="sidebar-note">
            <div class="color-stripe" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
            <strong>Mode Preview Interaktif</strong>
            <p>Halaman ini menampilkan susunan fitur dan analitik lengkap dengan data simulasi (DEMO).</p>
          </div>
        </div>
      </aside>

      <div class="layout">
        <header class="topbar">
          <button class="mobile-menu" id="menu-toggle" aria-label="Buka menu navigasi" aria-expanded="false" aria-controls="navigation">
            ${icon('menu')}
          </button>
          <a class="mobile-brand" href="preview.html" aria-label="Rakyat Review">
            <img class="rr-logo" src="assets/rakyat-review-logo.png" alt="" width="54" height="36">
            <span class="mobile-brand-name">rakyat<span>review</span></span>
          </a>

          <div class="top-title">
            Dashboard Pembeli <span class="top-divider">/</span> <strong>Preview Mode (DEMO)</strong>
          </div>

          <div class="account-actions">
            <div class="account-badge">
              <span class="avatar-circle small" aria-hidden="true">BS</span>
              <span class="account-name-text">${esc(demoUser.name)}</span>
            </div>
            <span class="badge active" style="font-weight:600;">SIMULASI DEMO</span>
          </div>
        </header>

        <main class="content" id="main" tabindex="-1">
          <div id="view" aria-live="polite"></div>
          <footer class="footer">
            <span>© 2026 Rakyat Review · Solusi Ulasan Digital Usaha Indonesia (Preview Mode)</span>
            <span>QR Code & NFC Terintegrasi Google Review</span>
          </footer>
        </main>
      </div>

      <div id="modal-container"></div>
      <div id="toast" class="toast" role="status" aria-live="polite"></div>
    `;

    const toggleBtn = document.getElementById('menu-toggle');
    const nav = document.getElementById('navigation');
    if (toggleBtn && nav) {
      toggleBtn.onclick = () => {
        const isOpen = nav.classList.toggle('open');
        toggleBtn.setAttribute('aria-expanded', String(isOpen));
        toggleBtn.setAttribute('aria-label', isOpen ? 'Tutup navigasi' : 'Buka navigasi');
      };
    }

    if (nav) {
      const navLinks = nav.querySelectorAll('.nav-link');
      navLinks.forEach(link => {
        link.onclick = e => {
          const href = link.getAttribute('href');
          if (href.startsWith('#') || href === 'preview.html') {
            e.preventDefault();
            navLinks.forEach(l => {
              l.classList.remove('active');
              l.removeAttribute('aria-current');
            });
            link.classList.add('active');
            link.setAttribute('aria-current', 'page');
            if (nav.classList.contains('open')) {
              nav.classList.remove('open');
              toggleBtn?.setAttribute('aria-expanded', 'false');
            }
            if (href === '#card-section') {
              document.getElementById('card-section')?.scrollIntoView({ behavior: 'smooth' });
            } else if (href === '#analytics-section') {
              document.getElementById('analytics-section')?.scrollIntoView({ behavior: 'smooth' });
            } else {
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }
          }
        };
      });
    }
  }

  function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('visible'), 3200);
  }

  function renderBarChart(chartData, period) {
    const maxCount = Math.max(...chartData.map(d => d.count), 5);
    const step = maxCount <= 10 ? 2 : (maxCount <= 30 ? 5 : (maxCount <= 60 ? 10 : 25));
    const yMax = Math.ceil(maxCount / step) * step;

    const svgW = 720;
    const svgH = 220;
    const padL = 36;
    const padR = 20;
    const padT = 28;
    const padB = 36;
    const plotW = svgW - padL - padR;
    const plotH = svgH - padT - padB;

    const yGrid = [0, Math.round(yMax / 2), yMax];
    const gridLines = yGrid.map(val => {
      const y = padT + plotH - (val / yMax) * plotH;
      return `
        <line x1="${padL}" y1="${y}" x2="${svgW - padR}" y2="${y}" stroke="#e6e9ef" stroke-dasharray="3,3" stroke-width="1"/>
        <text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#697487" font-family="inherit">${val}</text>
      `;
    }).join('');

    const n = chartData.length;
    const colW = plotW / n;
    const barW = Math.max(Math.min(colW * 0.58, period === 7 ? 42 : (period === 30 ? 14 : 6)), 3);

    const todayWIB = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());

    const bars = chartData.map((d, i) => {
      const cx = padL + i * colW + colW / 2;
      const x = cx - barW / 2;
      const barH = d.count > 0 ? Math.max((d.count / yMax) * plotH, 4) : 0;
      const y = padT + plotH - barH;

      const isToday = d.date === todayWIB || (i === n - 1);
      const barColor = isToday ? '#ea4335' : '#3877db';

      let countLabel = '';
      if (period === 7 || (period === 30 && d.count > 0) || (period === 90 && isToday && d.count > 0)) {
        countLabel = `<text x="${cx}" y="${y - 6}" text-anchor="middle" font-size="11" font-weight="600" fill="${isToday ? '#b62d32' : '#253248'}" font-family="inherit">${d.count}</text>`;
      }

      let xLabel = '';
      if (period === 7) {
        xLabel = `<text x="${cx}" y="${svgH - 12}" text-anchor="middle" font-size="11" font-weight="${isToday ? '600' : '500'}" fill="${isToday ? '#b62d32' : '#697487'}" font-family="inherit">${esc(d.day_name || d.day_label)}</text>`;
      } else if (period === 30) {
        if (i === n - 1 || (i % 5 === 0 && (n - 1 - i >= 3))) {
          xLabel = `<text x="${cx}" y="${svgH - 12}" text-anchor="middle" font-size="10" font-weight="${isToday ? '600' : '400'}" fill="${isToday ? '#b62d32' : '#697487'}" font-family="inherit">${esc(d.day_label)}</text>`;
        }
      } else {
        if (i === n - 1 || (i % 15 === 0 && (n - 1 - i >= 8))) {
          xLabel = `<text x="${cx}" y="${svgH - 12}" text-anchor="middle" font-size="10" font-weight="${isToday ? '600' : '400'}" fill="${isToday ? '#b62d32' : '#697487'}" font-family="inherit">${esc(d.day_label)}</text>`;
        }
      }

      return `
        <g class="bar-group" data-date="${esc(d.date)}" data-count="${d.count}">
          <title>${esc(d.day_name || '')} (${esc(d.day_label || d.date)}): ${d.count} scan${isToday ? ' (Hari ini)' : ''}</title>
          ${barH > 0 ? `
            <rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="${Math.min(barW / 2, 5)}" fill="${barColor}" class="chart-bar ${isToday ? 'bar-today' : ''}"/>
          ` : `
            <circle cx="${cx}" cy="${padT + plotH}" r="${isToday ? 3 : 2}" fill="${isToday ? '#ea4335' : '#d2d8e4'}"/>
          `}
          ${countLabel}
          ${xLabel}
        </g>
      `;
    }).join('');

    return `
      <div class="chart-container">
        <svg class="chart-svg" viewBox="0 0 ${svgW} ${svgH}" preserveAspectRatio="xMidYMid meet" aria-label="Grafik batang pemindaian ${period} hari terakhir">
          ${gridLines}
          ${bars}
        </svg>
      </div>
    `;
  }

  function getPreviewChartData(days, card) {
    const base = demoDataSets[days] || demoDataSets[7];
    const mult = card === 'all' ? 1 : (card === 'RR-001' ? 0.52 : (card === 'RR-002' ? 0.31 : 0.17));
    const todayTarget = card === 'all' ? 12 : Math.max(1, Math.round(12 * mult));

    return base.map((d, idx) => {
      if (idx === base.length - 1) {
        return {
          ...d,
          count: todayTarget
        };
      }
      return {
        ...d,
        count: card === 'all' ? d.count : Math.max(1, Math.round(d.count * mult))
      };
    });
  }

  function updateAnalytics(days = currentPeriod, card = currentCard) {
    currentPeriod = days;
    currentCard = card;

    document.querySelectorAll('.filter-pills .pill-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.getAttribute('data-period'), 10) === days);
    });

    const cardSelect = document.getElementById('analytics-card-filter');
    if (cardSelect && cardSelect.value !== card) {
      cardSelect.value = card;
    }

    const c = demoCards.find(item => item.card_code === card);
    const totalScans = card === 'all' ? 248 : (c ? c.scan_count : 44);
    const mult = card === 'all' ? 1 : (card === 'RR-001' ? 0.52 : (card === 'RR-002' ? 0.31 : 0.17));
    const todayScans = card === 'all' ? 12 : Math.max(1, Math.round(12 * mult));

    const totalScanEl = document.querySelector('.stat-blue .stat-value');
    if (totalScanEl) totalScanEl.textContent = fmt(totalScans);

    const todayScanEl = document.querySelector('.stat-red .stat-value');
    if (todayScanEl) todayScanEl.textContent = fmt(todayScans);

    const totalCardsEl = document.querySelector('.stat-yellow .stat-value');
    if (totalCardsEl) totalCardsEl.textContent = fmt(card === 'all' ? cards.length : 1);

    const totalCardsCap = document.querySelector('.stat-yellow .stat-caption');
    if (totalCardsCap) totalCardsCap.textContent = card === 'all' ? 'Kartu yang terdaftar · DEMO' : `Kartu ${card} dipilih · DEMO`;

    const box = document.getElementById('chart-container');
    if (box) {
      box.innerHTML = renderBarChart(getPreviewChartData(days, card), days);
    }
  }

  function setPeriod(days) {
    updateAnalytics(days, currentCard);
    showToast(`Menampilkan grafik pemindaian ${days} hari terakhir (DEMO)`);
  }

  function render() {
    renderShell();
    const view = document.getElementById('view');
    if (!view) return;

    view.innerHTML = `
      <div class="page-heading">
        <div>
          <p class="eyebrow">PREVIEW WORKSPACE · DEMO</p>
          <h1>Halo, Budi Santoso 👋<span class="heading-dot">.</span></h1>
          <p class="subtitle">Kelola kartu review dan pantau performanya di sini. Halaman ini menggunakan data simulasi untuk preview antarmuka.</p>
        </div>
      </div>

      <!-- Demo Notification Banner -->
      <div class="google-alert-banner" role="note" style="border-left: 4px solid var(--google-blue);">
        <div class="alert-icon">${icon('info')}</div>
        <div class="alert-text">
          <strong>Mode Simulasi Tampilan (Preview):</strong>
          <span>Seluruh data scan, metrik, grafik, dan kartu di halaman ini merupakan <strong>data contoh (DEMO)</strong>. Autentikasi dan data asli akun Anda tetap terlindungi secara aman di sistem utama.</span>
        </div>
      </div>

      <!-- Metric Summaries -->
      <section class="stats" aria-label="Ringkasan kartu Anda">
        <!-- 1. Biru: Total Scan -->
        <article class="stat stat-blue">
          <div class="stat-top">
            <span>Total Scan</span>
            <span class="icon-box">${icon('wave')}</span>
          </div>
          <div class="metric-body">
            <div class="stat-value">248</div>
            <span class="stat-unit">Scan</span>
          </div>
          <div class="stat-caption">Total semua pemindaian kartu · DEMO</div>
        </article>

        <!-- 2. Merah: Scan Hari Ini -->
        <article class="stat stat-red">
          <div class="stat-top">
            <span>Scan Hari Ini</span>
            <span class="icon-box">${icon('calendar')}</span>
          </div>
          <div class="metric-body">
            <div class="stat-value">12</div>
            <span class="stat-unit">Scan</span>
          </div>
          <div class="stat-caption">Pemindaian hari ini (WIB) · DEMO</div>
        </article>

        <!-- 3. Kuning: Total Kartu Dimiliki -->
        <article class="stat stat-yellow">
          <div class="stat-top">
            <span>Total Kartu Dimiliki</span>
            <span class="icon-box">${icon('card')}</span>
          </div>
          <div class="metric-body">
            <div class="stat-value">3</div>
            <span class="stat-unit">Kartu</span>
          </div>
          <div class="stat-caption">Kartu yang terdaftar · DEMO</div>
        </article>
      </section>

      <!-- Scan Analytics Section -->
      <section class="panel section-gap" id="analytics-section" aria-labelledby="analytics-title">
        <div class="panel-head">
          <div>
            <h2 id="analytics-title">${icon('chart')} Statistik Scan <span class="badge count-badge" style="background:#e8f0fe;color:#1a73e8;">DEMO</span></h2>
            <p>Pantau performa pemindaian QR Code dan NFC kartu ulasan Anda.</p>
          </div>
          <div class="analytics-filter-bar" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
            <div class="analytics-card-selector" style="display:flex;align-items:center;gap:6px;">
              <label for="analytics-card-filter" style="font-size:12px;color:var(--muted);font-weight:550;">Kartu:</label>
              <select id="analytics-card-filter" class="field-control" style="min-height:36px;padding:6px 12px;font-size:12px;border-radius:20px;background:#fff;border:1px solid #dbe2ee;color:#334155;cursor:pointer;" aria-label="Pilih kartu untuk melihat statistik">
                <option value="all" ${currentCard === 'all' ? 'selected' : ''}>Semua Kartu (${cards.length})</option>
                ${cards.map(c => `
                  <option value="${esc(c.card_code)}" ${currentCard === c.card_code ? 'selected' : ''}>
                    ${esc(c.card_code)}${c.business_name ? ` · ${esc(c.business_name)}` : ''}
                  </option>
                `).join('')}
              </select>
            </div>
            <div class="filter-pills" role="radiogroup" aria-label="Filter Periode Statistik">
              <button class="pill-btn ${currentPeriod === 7 ? 'active' : ''}" data-period="7" type="button">7 Hari</button>
              <button class="pill-btn ${currentPeriod === 30 ? 'active' : ''}" data-period="30" type="button">30 Hari</button>
              <button class="pill-btn ${currentPeriod === 90 ? 'active' : ''}" data-period="90" type="button">90 Hari</button>
            </div>
          </div>
        </div>

        <div class="chart-wrapper" id="chart-container">
          ${renderBarChart(getPreviewChartData(currentPeriod, currentCard), currentPeriod)}
        </div>
      </section>

      <!-- Cards Grid Section -->
      <section class="panel section-gap" id="card-section" aria-labelledby="cards-title">
        <div class="panel-head">
          <div>
            <h2 id="cards-title">Daftar Kartu Saya <span class="badge count-badge">${cards.length}</span></h2>
            <p>Kelola nama usaha, salin URL permanen kartu, atau coba alur review.</p>
          </div>
          <div class="head-actions">
            <button class="btn primary small" id="btn-tambah-kartu" type="button">${icon('store')} + Tambah Kartu</button>
          </div>
        </div>

        <div class="toolbar">
          <div class="search-box">
            <span class="search-icon">${icon('search')}</span>
            <input class="field-control search" id="card-search" type="search" placeholder="Cari nama usaha atau kode kartu..." value="${esc(search)}">
          </div>
          <select class="field-control filter-select" id="card-filter" aria-label="Filter status kartu">
            <option value="all">Semua Status (${cards.length})</option>
            <option value="active">Sudah Aktif (${cards.filter(c => c.active).length})</option>
          </select>
        </div>

        <div class="cards-container" id="cards-list"></div>
      </section>
    `;

    // Filter pills listeners
    view.querySelectorAll('.filter-pills .pill-btn').forEach(btn => {
      btn.onclick = () => {
        const p = parseInt(btn.getAttribute('data-period'), 10);
        setPeriod(p);
      };
    });

    const cardSelect = document.getElementById('analytics-card-filter');
    if (cardSelect) {
      cardSelect.onchange = e => {
        const c = e.target.value;
        updateAnalytics(currentPeriod, c);
        showToast(c === 'all' ? 'Menampilkan statistik semua kartu (DEMO)' : `Menampilkan statistik kartu ${c} (DEMO)`);
      };
    }

    const btnTambah = document.getElementById('btn-tambah-kartu');
    if (btnTambah) {
      btnTambah.onclick = () => showToast('Fitur aktivasi kartu tersedia saat Anda masuk ke akun asli.');
    }

    const searchInput = document.getElementById('card-search');
    if (searchInput) {
      searchInput.oninput = e => {
        search = e.target.value;
        renderCardsList();
      };
    }

    const filterSelect = document.getElementById('card-filter');
    if (filterSelect) {
      filterSelect.value = filter;
      filterSelect.onchange = e => {
        filter = e.target.value;
        renderCardsList();
      };
    }

    renderCardsList();
  }

  function renderCardsList() {
    const list = document.getElementById('cards-list');
    if (!list) return;

    const filtered = cards.filter(c => {
      const matchStatus = filter === 'all' || (filter === 'active' && c.active);
      const query = search.trim().toLowerCase();
      const matchSearch = !query || c.card_code.toLowerCase().includes(query) || (c.business_name || '').toLowerCase().includes(query);
      return matchStatus && matchSearch;
    });

    if (filtered.length === 0) {
      list.innerHTML = `
        <div class="no-results-box">
          <p>Tidak ada kartu yang cocok dengan pencarian "<strong>${esc(search)}</strong>".</p>
        </div>
      `;
      return;
    }

    list.innerHTML = `
      <div class="cards-grid">
        ${filtered.map(card => {
          const permUrl = `${location.origin}/r/${card.card_code}`;
          const reviewTarget = card.review_url || '';
          return `
            <article class="card-item" id="card-${esc(card.card_code)}">
              <div class="card-item-top">
                <div class="card-code-pill">
                  ${icon('wave')}
                  <span class="mono">${esc(card.card_code)}</span>
                </div>
                <div class="card-top-badges">
                  <span class="card-scan-badge" title="Total pemindaian">${icon('chart')} <strong>${fmt(card.scan_count || 0)}</strong> scan</span>
                  <span class="badge active">Aktif</span>
                </div>
              </div>

              <div class="card-item-body">
                <div class="business-row">
                  <span class="business-icon">${icon('store')}</span>
                  <div class="business-info">
                    <h3 class="business-title">${esc(card.business_name)}</h3>
                    <small class="card-meta">Didaftarkan: ${new Date(card.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</small>
                  </div>
                </div>

                <div class="info-block">
                  <div class="info-label">URL PERMANEN (QR CODE & NFC)</div>
                  <div class="url-copy-row">
                    <span class="url-text mono" title="${esc(permUrl)}">${esc(permUrl)}</span>
                    <button class="btn-copy" data-copy="${esc(permUrl)}" type="button" aria-label="Salin URL Permanen">
                      ${icon('copy')} Salin
                    </button>
                  </div>
                </div>

                <div class="info-block">
                  <div class="info-label">TUJUAN GOOGLE REVIEW</div>
                  <div class="review-target-box">
                    <a class="review-link" href="${esc(reviewTarget)}" target="_blank" rel="noopener noreferrer" title="${esc(reviewTarget)}">
                      ${icon('external')} <span>${esc(reviewTarget)}</span>
                    </a>
                  </div>
                </div>
              </div>

              <div class="card-item-actions">
                <button class="btn primary btn-edit-demo" data-code="${esc(card.card_code)}" type="button">
                  ${icon('edit')} Edit Nama & Review
                </button>
                <a class="btn" href="${esc(reviewTarget)}" target="_blank" rel="noopener noreferrer">
                  ${icon('external')} Coba Review
                </a>
              </div>
            </article>
          `;
        }).join('')}
      </div>
    `;

    list.querySelectorAll('.btn-copy').forEach(btn => {
      btn.onclick = async () => {
        const text = btn.getAttribute('data-copy');
        try {
          await navigator.clipboard.writeText(text);
          const orig = btn.innerHTML;
          btn.innerHTML = `${icon('check')} Tersalin!`;
          btn.classList.add('copied');
          setTimeout(() => {
            btn.innerHTML = orig;
            btn.classList.remove('copied');
          }, 2000);
          showToast('URL permanen simulasi disalin ke clipboard');
        } catch {
          showToast('URL: ' + text);
        }
      };
    });

    list.querySelectorAll('.btn-edit-demo').forEach(btn => {
      btn.onclick = () => {
        const code = btn.getAttribute('data-code');
        const c = cards.find(item => item.card_code === code);
        if (c) openEditModal(c);
      };
    });
  }

  function openEditModal(card) {
    const container = document.getElementById('modal-container');
    if (!container) return;

    container.innerHTML = `
      <div class="modal-backdrop" id="modal-bg">
        <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div class="modal-head">
            <div>
              <h2 id="modal-title">Edit Kartu ${esc(card.card_code)} <span class="badge pending" style="font-size:10px;">DEMO</span></h2>
              <p>Simulasi pengubahan nama usaha dan link Google Review.</p>
            </div>
            <button class="modal-close" id="modal-close-btn" type="button" aria-label="Tutup">${icon('close')}</button>
          </div>
          <form id="modal-edit-form">
            <div class="modal-body">
              <div class="form-group">
                <label for="edit-business-name">Nama Usaha</label>
                <input class="field-control" id="edit-business-name" type="text" required maxlength="150" value="${esc(card.business_name)}">
              </div>
              <div class="form-group">
                <label for="edit-review-url">Link Google Review</label>
                <input class="field-control" id="edit-review-url" type="url" required value="${esc(card.review_url)}">
                <small class="field-hint">Mendukung link langsung Google Review atau Google Maps.</small>
              </div>
            </div>
            <div class="modal-foot">
              <button class="btn" id="modal-cancel-btn" type="button">Batal</button>
              <button class="btn primary" id="modal-submit-btn" type="submit">${icon('check')} Simpan Simulasi</button>
            </div>
          </form>
        </div>
      </div>
    `;

    const close = () => { container.innerHTML = ''; };
    document.getElementById('modal-bg').onclick = e => { if (e.target.id === 'modal-bg') close(); };
    document.getElementById('modal-close-btn').onclick = close;
    document.getElementById('modal-cancel-btn').onclick = close;

    document.getElementById('modal-edit-form').onsubmit = e => {
      e.preventDefault();
      const newName = document.getElementById('edit-business-name').value.trim();
      const newUrl = document.getElementById('edit-review-url').value.trim();
      if (!newName || !newUrl) return;
      card.business_name = newName;
      card.review_url = newUrl;
      showToast(`Kartu ${card.card_code} berhasil diperbarui (Simulasi DEMO)`);
      close();
      renderCardsList();
    };
  }

  render();
})();
