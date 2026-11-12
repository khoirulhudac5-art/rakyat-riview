(() => {
  'use strict';

  let client = null;
  let accountUser = null;
  let cards = [];
  let analytics = { total_cards: 0, total_scans: 0, scans_today: 0, chart_data: [] };
  let analyticsPeriod = 7;
  let analyticsCardFilter = 'all';
  let state = 'loading'; // 'loading' | 'ready' | 'empty' | 'error'
  let errorText = '';
  let needsLogin = false;
  let search = '';
  let filter = 'all';
  let editingCard = null;
  let mapsWork = null;
  let resolvedReview = null;

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
    chevron: '<path d="m9 5 7 7-7 7"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'
  };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.card}</svg>`;
  const fmt = n => (n !== null && n !== undefined && Number.isFinite(Number(n))) ? new Intl.NumberFormat('id-ID').format(n) : '0';

  const shell = document.getElementById('shell');

  function renderShell() {
    const initials = (accountUser?.name || accountUser?.email || 'P').slice(0, 2).toUpperCase();
    const displayName = accountUser?.name || 'Pemilik Usaha';
    const displayEmail = accountUser?.email || '';

    const existingNav = document.getElementById('navigation');
    if (existingNav) {
      const avatarEl = existingNav.querySelector('.avatar-circle');
      if (avatarEl) avatarEl.textContent = initials;
      const userMetaEl = existingNav.querySelector('.user-meta strong');
      if (userMetaEl) userMetaEl.textContent = displayName;
      const emailEl = existingNav.querySelector('.user-meta small');
      if (emailEl) emailEl.textContent = displayEmail || 'Akun Google Terhubung';

      const topAvatar = document.querySelector('.topbar .avatar-circle');
      if (topAvatar) topAvatar.textContent = initials;
      const topName = document.querySelector('.topbar .account-name-text');
      if (topName) topName.textContent = displayName;
      return;
    }

    shell.innerHTML = `
      <aside class="sidebar" id="navigation" aria-label="Navigasi Utama">
        <a class="brand" href="dashboard.html">
          <span class="brand-mark"><img class="rr-logo" src="assets/rakyat-review-logo.png" alt="Rakyat Review" width="72" height="48"></span>
          <span>rakyat<span class="brand-light">review</span><small>DASHBOARD PEMBELI</small></span>
        </a>

        <div class="workspace-user-card">
          <span class="avatar-circle" aria-hidden="true">${esc(initials)}</span>
          <div class="user-meta">
            <strong>${esc(displayName)}</strong>
            <small>${esc(displayEmail || 'Akun Google Terhubung')}</small>
          </div>
        </div>

        <p class="nav-label">MENU UTAMA</p>
        <nav aria-label="Menu pembeli">
          <a class="nav-link active" href="dashboard.html" aria-current="page">${icon('grid')} Ringkasan & Kartu</a>
          <a class="nav-link" href="#card-section">${icon('card')} Daftar Kartu</a>
          <a class="nav-link" href="#analytics-section">${icon('chart')} Statistik Scan</a>
          <a class="nav-link" href="/pembeli/mulai.html">${icon('store')} Tambah / Aktivasi Kartu</a>
        </nav>

        <div class="sidebar-foot">
          <div class="sidebar-note">
            <div class="color-stripe" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
            <strong>Satu Kartu. Satu URL.</strong>
            <p>QR Code dan chip NFC selalu mengarah ke link permanen yang sama.</p>
          </div>
          <button class="btn secondary full" id="sidebar-password" type="button" style="margin-bottom:8px;">
            ${icon('lock')} Password Akun
          </button>
          <button class="btn btn-logout full" id="sidebar-logout" type="button">
            ${icon('logout')} Keluar Akun
          </button>
        </div>
      </aside>

      <div class="layout">
        <header class="topbar">
          <button class="mobile-menu" id="menu-toggle" aria-label="Buka menu navigasi" aria-expanded="false" aria-controls="navigation">
            ${icon('menu')}
          </button>
          <a class="mobile-brand" href="dashboard.html" aria-label="Rakyat Review">
            <img class="rr-logo" src="assets/rakyat-review-logo.png" alt="" width="54" height="36">
            <span class="mobile-brand-name">rakyat<span>review</span></span>
          </a>

          <div class="top-title">
            Dashboard Pembeli <span class="top-divider">/</span> <strong>Kelola Kartu Usaha</strong>
          </div>

          <div class="account-actions">
            ${accountUser ? `
              <div class="account-badge">
                <span class="avatar-circle small" aria-hidden="true">${esc(initials)}</span>
                <span class="account-name-text">${esc(displayName)}</span>
              </div>
              <button class="btn text btn-pw-top" id="topbar-password" type="button" title="Atur Password Akun">
                ${icon('lock')} <span class="logout-label">Password</span>
              </button>
              <button class="btn text btn-logout-top" id="topbar-logout" type="button" title="Keluar dari akun">
                ${icon('logout')} <span class="logout-label">Keluar</span>
              </button>
            ` : ''}
          </div>
        </header>

        <main class="content" id="main" tabindex="-1">
          <div id="view" aria-live="polite"></div>
          <footer class="footer">
            <span>© 2026 Rakyat Review · Solusi Ulasan Digital Usaha Indonesia</span>
            <span>QR Code & NFC Terintegrasi Google Review</span>
          </footer>
        </main>
      </div>

      <div id="modal-container"></div>
      <div id="toast" class="toast" role="status" aria-live="polite"></div>
    `;

    // Bind event listeners
    const toggleBtn = document.getElementById('menu-toggle');
    const nav = document.getElementById('navigation');
    if (toggleBtn && nav) {
      toggleBtn.onclick = () => {
        const isOpen = nav.classList.toggle('open');
        toggleBtn.setAttribute('aria-expanded', String(isOpen));
        toggleBtn.setAttribute('aria-label', isOpen ? 'Tutup navigasi' : 'Buka navigasi');
      };
    }

    // Smooth section navigation without jarring page refresh
    if (nav) {
      const navLinks = nav.querySelectorAll('.nav-link');
      navLinks.forEach(link => {
        link.onclick = e => {
          const href = link.getAttribute('href');
          if (href.startsWith('#') || href === 'dashboard.html') {
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

    const sLogout = document.getElementById('sidebar-logout');
    if (sLogout) sLogout.onclick = handleLogout;
    const tLogout = document.getElementById('topbar-logout');
    if (tLogout) tLogout.onclick = handleLogout;
    const sPw = document.getElementById('sidebar-password');
    if (sPw) sPw.onclick = openPasswordModal;
    const tPw = document.getElementById('topbar-password');
    if (tPw) tPw.onclick = openPasswordModal;
  }

  function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('visible'), 3200);
  }

  async function handleLogout() {
    try {
      if (client) await client.requestBuyer('signout', {});
    } catch {}
    location.href = '/pembeli/index.html';
  }

  function renderBarChart(chartData, period) {
    if (!Array.isArray(chartData) || chartData.length === 0) {
      return `
        <div class="chart-empty-state">
          <p>Belum ada data scan untuk periode ini.</p>
        </div>
      `;
    }

    const hasAnyScan = chartData.some(d => d.count > 0);
    if (!hasAnyScan) {
      return `
        <div class="chart-empty-state">
          <div class="icon-circle small">${icon('chart')}</div>
          <strong>Belum Ada Pemindaian Pada Periode Ini</strong>
          <p class="subtitle">Grafik akan terisi otomatis saat pelanggan men-tap kartu NFC atau men-scan QR Code Anda.</p>
        </div>
      `;
    }

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

  async function fetchAnalytics(days = analyticsPeriod, card = analyticsCardFilter) {
    analyticsPeriod = days;
    analyticsCardFilter = card;
    const chartBox = document.getElementById('chart-container');
    if (chartBox) {
      chartBox.innerHTML = '<div class="chart-empty-state"><p class="subtitle">Memuat data statistik...</p></div>';
    }
    document.querySelectorAll('.filter-pills .pill-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.getAttribute('data-period'), 10) === days);
    });
    try {
      if (client) {
        const stats = await client.requestBuyer('analytics', { days, card });
        if (stats && !stats.error) {
          analytics = stats;
        }
      }
    } catch (e) {
      console.warn('Gagal memuat analitik:', e);
    }
    const totalScanEl = document.querySelector('.stat-blue .stat-value');
    if (totalScanEl) totalScanEl.textContent = fmt(analytics.total_scans ?? 0);
    const todayScanEl = document.querySelector('.stat-red .stat-value');
    if (todayScanEl) todayScanEl.textContent = fmt(analytics.scans_today ?? 0);
    const totalCardsEl = document.querySelector('.stat-yellow .stat-value');
    if (totalCardsEl) totalCardsEl.textContent = fmt(analyticsCardFilter === 'all' ? (analytics.total_cards ?? cards.length) : 1);
    const totalCardsCap = document.querySelector('.stat-yellow .stat-caption');
    if (totalCardsCap) totalCardsCap.textContent = analyticsCardFilter === 'all' ? 'Kartu yang terdaftar' : `Kartu ${analyticsCardFilter} dipilih`;

    if (chartBox) {
      chartBox.innerHTML = renderBarChart(analytics.chart_data, analyticsPeriod);
    }
  }

  function changeAnalyticsPeriod(days) {
    return fetchAnalytics(days, analyticsCardFilter);
  }

  function render() {
    renderShell();
    const view = document.getElementById('view');
    if (!view) return;

    if (state === 'loading') {
      view.innerHTML = `
        <div class="page-heading">
          <div>
            <p class="eyebrow">DASHBOARD PEMBELI</p>
            <h1>Memuat workspace usaha Anda...</h1>
            <p class="subtitle">Menghubungkan sesi Google dan mengambil daftar kartu terdaftar.</p>
          </div>
        </div>
        <div class="loading-grid">
          <div class="skeleton-card"></div>
          <div class="skeleton-card"></div>
          <div class="skeleton-card"></div>
        </div>
      `;
      return;
    }

    if (state === 'error') {
      view.innerHTML = `
        <div class="panel empty-state error-state">
          <div class="icon-circle error">${icon(needsLogin ? 'lock' : 'refresh')}</div>
          <h2>${needsLogin ? 'Akses Dashboard Memerlukan Login' : 'Koneksi Terkendala'}</h2>
          <p>${esc(errorText || (needsLogin ? 'Sesi akun Anda telah berakhir atau belum aktif. Silakan masuk kembali untuk mengelola kartu Anda.' : 'Tidak dapat terhubung ke server. Silakan periksa koneksi internet Anda lalu coba lagi.'))}</p>
          <div class="action-row">
            ${needsLogin ? `
              <button class="btn primary" id="btn-login-google" type="button">
                ${icon('google')} Lanjutkan dengan Google
              </button>
              <a class="btn secondary" href="/pembeli/index.html" style="text-decoration:none;display:inline-flex;align-items:center;">
                Masuk dengan Email
              </a>
            ` : `
              <button class="btn primary" id="btn-retry" type="button">
                ${icon('refresh')} Coba Lagi
              </button>
            `}
          </div>
        </div>
      `;
      const btnLogin = document.getElementById('btn-login-google');
      if (btnLogin) {
        btnLogin.onclick = async () => {
          try {
            const { googleLogin } = await import('../pembeli/drafts.mjs');
            await googleLogin(location.pathname + location.search);
          } catch (e) {
            alert('Gagal memulai login Google: ' + e.message);
          }
        };
      }
      const btnRetry = document.getElementById('btn-retry');
      if (btnRetry) btnRetry.onclick = loadDashboard;
      return;
    }

    if (state === 'empty' || cards.length === 0) {
      view.innerHTML = `
        <div class="page-heading">
          <div>
            <p class="eyebrow">SELAMAT DATANG DI RAKYAT REVIEW</p>
            <h1>Halo, ${esc(accountUser?.name || 'Pemilik Usaha')}<span class="heading-dot">.</span></h1>
            <p class="subtitle">Akun Google Anda telah terhubung. Saat ini belum ada kartu yang ditautkan ke akun ini.</p>
          </div>
        </div>
        <div class="panel empty-state">
          <div class="icon-circle">${icon('card')}</div>
          <h2>Belum Ada Kartu Terdaftar</h2>
          <p>Miliki kartu Rakyat Review? Cukup scan QR Code atau tap NFC pada kartu fisik Anda untuk mulai mengaktifkan dan mengaturnya di sini.</p>
          <div class="action-row">
            <a class="btn primary" href="/pembeli/mulai.html">${icon('store')} Aktivasi Kartu Baru</a>
          </div>
        </div>
      `;
      return;
    }

    // STATE: READY WITH CARDS
    const activeCards = cards.filter(c => c.active);
    const withReview = cards.filter(c => c.review_url);

    view.innerHTML = `
      <div class="page-heading">
        <div>
          <p class="eyebrow">WORKSPACE KARTU DIGITAL</p>
          <h1>Halo, ${esc(accountUser?.name || 'Pemilik Usaha')}<span class="heading-dot">.</span></h1>
          <p class="subtitle">Kelola nama usaha, perbarui link Google Review, dan pantau pengalihan kartu NFC & QR Anda di satu tempat.</p>
        </div>
      </div>

      <!-- Google Policy Notice Alert -->
      <div class="google-alert-banner" role="note">
        <div class="alert-icon">${icon('info')}</div>
        <div class="alert-text">
          <strong>Informasi Kebijakan Google Review:</strong>
          <span>Jika saat link dibuka muncul pesan <em>"Kontribusi dinonaktifkan untuk tempat ini"</em>, hal tersebut merupakan pembatasan kebijakan Google Business Profile pada tempat tersebut, bukan kesalahan pengalihan kartu. Anda dapat mengubah link tujuan ke profil Google Review usaha yang aktif kapan saja.</span>
        </div>
      </div>

      <!-- Metric Summaries -->
      <section class="stats" aria-label="Ringkasan statistik pemindaian dan kartu">
        <!-- 1. Biru — Total Scan -->
        <article class="stat stat-blue">
          <div class="stat-top">
            <span>Total Scan</span>
            <span class="icon-box">${icon('wave')}</span>
          </div>
          <div class="metric-body">
            <div class="stat-value">${fmt(analytics.total_scans ?? 0)}</div>
            <span class="stat-unit">Scan</span>
          </div>
          <div class="stat-caption">Total semua pemindaian kartu</div>
        </article>

        <!-- 2. Merah — Scan Hari Ini -->
        <article class="stat stat-red">
          <div class="stat-top">
            <span>Scan Hari Ini</span>
            <span class="icon-box">${icon('calendar')}</span>
          </div>
          <div class="metric-body">
            <div class="stat-value">${fmt(analytics.scans_today ?? 0)}</div>
            <span class="stat-unit">Scan</span>
          </div>
          <div class="stat-caption">Pemindaian hari ini (WIB)</div>
        </article>

        <!-- 3. Kuning — Total Kartu Dimiliki -->
        <article class="stat stat-yellow">
          <div class="stat-top">
            <span>Total Kartu Dimiliki</span>
            <span class="icon-box">${icon('card')}</span>
          </div>
          <div class="metric-body">
            <div class="stat-value">${fmt(analytics.total_cards ?? cards.length)}</div>
            <span class="stat-unit">Kartu</span>
          </div>
          <div class="stat-caption">Kartu yang terdaftar</div>
        </article>
      </section>

      <!-- Scan Analytics Section -->
      <section class="panel section-gap" id="analytics-section" aria-labelledby="analytics-title">
        <div class="panel-head">
          <div>
            <h2 id="analytics-title">${icon('chart')} Statistik Scan</h2>
            <p>Pantau performa pemindaian QR Code dan NFC kartu ulasan Anda.</p>
          </div>
          <div class="analytics-filter-bar" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
            <div class="analytics-card-selector" style="display:flex;align-items:center;gap:6px;">
              <label for="analytics-card-filter" style="font-size:12px;color:var(--muted);font-weight:550;">Kartu:</label>
              <select id="analytics-card-filter" class="field-control" style="min-height:36px;padding:6px 12px;font-size:12px;border-radius:20px;background:#fff;border:1px solid #dbe2ee;color:#334155;cursor:pointer;" aria-label="Pilih kartu untuk melihat statistik">
                <option value="all" ${analyticsCardFilter === 'all' ? 'selected' : ''}>Semua Kartu (${cards.length})</option>
                ${cards.map(c => `
                  <option value="${esc(c.card_code)}" ${analyticsCardFilter === c.card_code ? 'selected' : ''}>
                    ${esc(c.card_code)}${c.business_name ? ` · ${esc(c.business_name)}` : ''}
                  </option>
                `).join('')}
              </select>
            </div>
            <div class="filter-pills" role="radiogroup" aria-label="Filter Periode Statistik">
              <button class="pill-btn ${analyticsPeriod === 7 ? 'active' : ''}" data-period="7" type="button">7 Hari</button>
              <button class="pill-btn ${analyticsPeriod === 30 ? 'active' : ''}" data-period="30" type="button">30 Hari</button>
              <button class="pill-btn ${analyticsPeriod === 90 ? 'active' : ''}" data-period="90" type="button">90 Hari</button>
            </div>
          </div>
        </div>

        <div class="chart-wrapper" id="chart-container">
          ${renderBarChart(analytics.chart_data, analyticsPeriod)}
        </div>
      </section>

      <!-- Cards Grid Section -->
      <section class="panel section-gap" id="card-section" aria-labelledby="cards-title">
        <div class="panel-head">
          <div>
            <h2 id="cards-title">Daftar Kartu Anda <span class="badge count-badge">${cards.length}</span></h2>
            <p>Pilih kartu untuk mengubah nama usaha, menyalin URL permanen, atau menguji link review.</p>
          </div>
          <div class="head-actions">
            <a class="btn primary small" href="/pembeli/mulai.html">${icon('store')} + Kartu Baru</a>
          </div>
        </div>

        <div class="toolbar">
          <div class="search-box">
            <span class="search-icon">${icon('search')}</span>
            <input class="field-control search" id="card-search" type="search" placeholder="Cari nama usaha atau kode kartu..." value="${esc(search)}">
          </div>
          <select class="field-control filter-select" id="card-filter" aria-label="Filter status kartu">
            <option value="all">Semua Status (${cards.length})</option>
            <option value="active">Sudah Aktif (${activeCards.length})</option>
            <option value="inactive">Belum Aktif (${cards.length - activeCards.length})</option>
          </select>
        </div>

        <div class="cards-container" id="cards-list"></div>
      </section>
    `;

    // Filter pills listeners
    view.querySelectorAll('.filter-pills .pill-btn').forEach(btn => {
      btn.onclick = () => {
        const p = parseInt(btn.getAttribute('data-period'), 10);
        fetchAnalytics(p, analyticsCardFilter);
      };
    });

    // Card filter dropdown listener
    const cardFilterSel = document.getElementById('analytics-card-filter');
    if (cardFilterSel) {
      cardFilterSel.onchange = () => {
        fetchAnalytics(analyticsPeriod, cardFilterSel.value);
      };
    }

    // Filter and search listeners
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
      const matchStatus = filter === 'all' || (filter === 'active' && c.active) || (filter === 'inactive' && !c.active);
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
                  <span class="badge ${card.active ? 'active' : 'pending'}">
                    ${card.active ? 'Aktif' : 'Belum Aktif'}
                  </span>
                </div>
              </div>

              <div class="card-item-body">
                <div class="business-row">
                  <span class="business-icon">${icon('store')}</span>
                  <div class="business-info">
                    <h3 class="business-title">${esc(card.business_name || 'Nama Usaha Belum Diatur')}</h3>
                    <small class="card-meta">Didaftarkan: ${card.created_at ? new Date(card.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</small>
                  </div>
                </div>

                <!-- Permanent URL Box -->
                <div class="info-block">
                  <div class="info-label">URL PERMANEN (QR CODE & NFC)</div>
                  <div class="url-copy-row">
                    <span class="url-text mono" title="${esc(permUrl)}">${esc(permUrl)}</span>
                    <button class="btn-copy" data-copy="${esc(permUrl)}" type="button" aria-label="Salin URL Permanen">
                      ${icon('copy')} Salin
                    </button>
                  </div>
                </div>

                <!-- Review Target Box -->
                <div class="info-block">
                  <div class="info-label">TUJUAN GOOGLE REVIEW</div>
                  <div class="review-target-box">
                    ${reviewTarget ? `
                      <a class="review-link" href="${esc(reviewTarget)}" target="_blank" rel="noopener noreferrer" title="${esc(reviewTarget)}">
                        ${icon('external')} <span>${esc(reviewTarget)}</span>
                      </a>
                    ` : `
                      <span class="review-empty">Belum ada link review yang disimpan</span>
                    `}
                  </div>
                </div>
              </div>

              <div class="card-item-actions">
                <button class="btn primary btn-edit-card" data-code="${esc(card.card_code)}" type="button">
                  ${icon('edit')} Edit Nama & Review
                </button>
                ${reviewTarget ? `
                  <a class="btn" href="${esc(reviewTarget)}" target="_blank" rel="noopener noreferrer">
                    ${icon('external')} Coba Review
                  </a>
                ` : ''}
                <a class="btn text" href="/r/${esc(card.card_code)}" target="_blank" rel="noopener noreferrer" title="Uji alur buka kartu seperti pelanggan">
                  Coba Scan
                </a>
              </div>
            </article>
          `;
        }).join('')}
      </div>
    `;

    // Bind copy buttons
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
          showToast('URL permanen berhasil disalin ke clipboard');
        } catch {
          showToast('Gagal menyalin otomatis. Silakan salin teks manual.');
        }
      };
    });

    // Bind edit buttons
    list.querySelectorAll('.btn-edit-card').forEach(btn => {
      btn.onclick = () => {
        const code = btn.getAttribute('data-code');
        const target = cards.find(c => c.card_code === code);
        if (target) openEditModal(target);
      };
    });
  }

  function openPasswordModal() {
    const modalContainer = document.getElementById('modal-container');
    if (!modalContainer) return;

    modalContainer.innerHTML = `
      <div class="modal-backdrop" id="pw-modal-backdrop"></div>
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="pw-modal-title">
        <div class="modal-head">
          <div>
            <h2 id="pw-modal-title">Password Akun</h2>
            <p>Akun <strong class="mono">${esc(accountUser?.email || '')}</strong></p>
          </div>
          <button class="icon-btn-close" id="pw-modal-close" type="button" aria-label="Tutup modal">
            ${icon('close')}
          </button>
        </div>

        <form id="password-form" class="modal-form">
          <div class="modal-body">
            <div id="pw-modal-error" class="inline-error" role="alert" hidden></div>
            <div id="pw-modal-success" class="inline-success" role="alert" hidden></div>

            <p style="font-size:13px;line-height:1.7;color:#5a687d;margin:0 0 16px;">
              Atur atau perbarui password untuk akun Anda. Anda dapat masuk menggunakan <strong>Email & Password</strong> maupun <strong>Google</strong> ke akun yang sama tanpa mengubah kepemilikan kartu Anda.
            </p>

            <div class="form-group">
              <label for="new-password-input">Password Baru</label>
              <div class="password-wrap" style="position:relative;display:flex;align-items:center;">
                <input class="field-control" id="new-password-input" name="password" type="password" minlength="8" maxlength="256" placeholder="Masukkan password Anda" required style="padding-right:42px;">
                <button type="button" class="btn-toggle-pw" aria-label="Lihat password" tabindex="-1" style="position:absolute;right:8px;background:none;border:none;cursor:pointer;color:#64748b;padding:6px;display:flex;align-items:center;">
                  ${icon('lock')}
                </button>
              </div>
              <small class="field-help">Gunakan kombinasi minimal 8 karakter huruf dan angka.</small>
            </div>

            <div class="form-group">
              <label for="confirm-password-input">Konfirmasi Password Baru</label>
              <div class="password-wrap" style="position:relative;display:flex;align-items:center;">
                <input class="field-control" id="confirm-password-input" name="confirm" type="password" minlength="8" maxlength="256" placeholder="Masukkan password Anda kembali" required style="padding-right:42px;">
                <button type="button" class="btn-toggle-pw" aria-label="Lihat konfirmasi password" tabindex="-1" style="position:absolute;right:8px;background:none;border:none;cursor:pointer;color:#64748b;padding:6px;display:flex;align-items:center;">
                  ${icon('lock')}
                </button>
              </div>
            </div>
          </div>

          <div class="modal-foot">
            <button class="btn secondary" id="pw-modal-cancel" type="button">Batal</button>
            <button class="btn primary" id="pw-modal-submit" type="submit">
              ${icon('check')} Simpan Password
            </button>
          </div>
        </form>
      </div>
    `;

    const close = () => { modalContainer.innerHTML = ''; };
    document.getElementById('pw-modal-close').onclick = close;
    document.getElementById('pw-modal-cancel').onclick = close;
    document.getElementById('pw-modal-backdrop').onclick = close;

    modalContainer.querySelectorAll('.btn-toggle-pw').forEach(btn => {
      btn.onclick = () => {
        const input = btn.parentElement.querySelector('input');
        if (!input) return;
        const isPw = input.type === 'password';
        input.type = isPw ? 'text' : 'password';
        btn.style.color = isPw ? '#306cce' : '#64748b';
      };
    });

    const form = document.getElementById('password-form');
    form.onsubmit = async ev => {
      ev.preventDefault();
      const errBox = document.getElementById('pw-modal-error');
      const succBox = document.getElementById('pw-modal-success');
      const submitBtn = document.getElementById('pw-modal-submit');
      const pw = form.password.value;
      const conf = form.confirm.value;

      errBox.hidden = true;
      succBox.hidden = true;

      if (pw.length < 8) {
        errBox.textContent = 'Password baru harus minimal 8 karakter.';
        errBox.hidden = false;
        return;
      }
      if (pw !== conf) {
        errBox.textContent = 'Konfirmasi password tidak cocok.';
        errBox.hidden = false;
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerHTML = `${icon('refresh')} Menyimpan...`;

      try {
        await client.requestBuyer('update-password', { password: pw });
        succBox.textContent = 'Password berhasil disimpan! Anda kini dapat login menggunakan email & password atau Google.';
        succBox.hidden = false;
        showToast('Password akun berhasil diperbarui');
        setTimeout(() => close(), 1500);
      } catch (err) {
        errBox.textContent = err.message || 'Gagal menyimpan password.';
        errBox.hidden = false;
        submitBtn.disabled = false;
        submitBtn.innerHTML = `${icon('check')} Simpan Password`;
      }
    };
  }

  function openEditModal(card) {
    editingCard = card;
    resolvedReview = card.review_url || null;
    const modalContainer = document.getElementById('modal-container');
    if (!modalContainer) return;

    modalContainer.innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-head">
          <div>
            <h2 id="modal-title">Edit Informasi Kartu</h2>
            <p>Kode kartu <strong class="mono">${esc(card.card_code)}</strong></p>
          </div>
          <button class="icon-btn-close" id="modal-close" type="button" aria-label="Tutup modal">
            ${icon('close')}
          </button>
        </div>

        <form id="card-edit-form" class="modal-form">
          <div class="modal-body">
            <div id="modal-error" class="inline-error" role="alert" hidden></div>
            <div id="modal-success" class="inline-success" role="alert" hidden></div>

            <div class="form-group">
              <label for="edit-card-code">Kode Kartu (Tetap & Permanen)</label>
              <input class="field-control readonly mono" id="edit-card-code" value="${esc(card.card_code)}" readonly>
              <small class="field-help">Kode kartu ini permanen dan dicetak pada QR Code & chip NFC fisik Anda.</small>
            </div>

            <div class="form-group">
              <label for="edit-business-name">Nama Usaha</label>
              <input class="field-control" id="edit-business-name" required maxlength="150" value="${esc(card.business_name || '')}" placeholder="Contoh: Kopi Ruang Pagi" autocomplete="organization">
              <small class="field-help">Nama usaha yang muncul pada kartu dan dashboard (maksimal 150 karakter).</small>
            </div>

            <div class="form-group">
              <div class="label-row">
                <label for="edit-review-url">Link Google Maps / Google Review</label>
                <a id="btn-try-preview-link" class="btn-text-link" href="${esc(card.review_url || '#')}" target="_blank" rel="noopener noreferrer" ${card.review_url ? '' : 'hidden'}>
                  ${icon('external')} Coba Link
                </a>
              </div>
              <input class="field-control" id="edit-review-url" type="url" required maxlength="8192" value="${esc(card.review_url || '')}" placeholder="Tempel link Google Maps atau link Google Review">
              <small class="field-help" id="edit-conversion-hint">Tempel link Google Maps atau Google Review tempat usaha Anda.</small>
            </div>

            <!-- Google Policy Notice Alert Inside Modal -->
            <div class="google-alert-banner small" role="note">
              <div class="alert-icon">${icon('info')}</div>
              <div class="alert-text">
                <strong>Catatan Penting Google Review:</strong>
                <span>Jika saat link dibuka muncul pesan <em>"Kontribusi dinonaktifkan untuk tempat ini"</em>, hal ini merupakan kebijakan Google Business Profile untuk lokasi usaha tersebut. Anda dapat mengganti link dengan lokasi ulasan Google yang aktif kapan saja.</span>
              </div>
            </div>
          </div>

          <div class="modal-foot">
            <button class="btn text" id="modal-cancel" type="button">Batal</button>
            <button class="btn primary" id="modal-submit" type="submit">
              ${icon('check')} Simpan Perubahan
            </button>
          </div>
        </form>
      </div>
    `;

    const close = () => {
      if (mapsWork?.dispose) mapsWork.dispose();
      mapsWork = null;
      editingCard = null;
      modalContainer.innerHTML = '';
    };

    document.getElementById('modal-backdrop').onclick = close;
    document.getElementById('modal-close').onclick = close;
    document.getElementById('modal-cancel').onclick = close;

    // Attach dynamic maps converter
    const urlInput = document.getElementById('edit-review-url');
    const hint = document.getElementById('edit-conversion-hint');
    const tryBtn = document.getElementById('btn-try-preview-link');
    const submitBtn = document.getElementById('modal-submit');

    import('../pembeli/maps.mjs').then(({ converter, resolveMaps }) => {
      mapsWork = converter({
        resolve: resolveMaps,
        update(result) {
          resolvedReview = result.url;
          submitBtn.disabled = (result.state !== 'ready');
          if (hint) hint.textContent = result.message || 'Tempel link Google Maps atau Google Review.';
          if (tryBtn) {
            tryBtn.hidden = !result.url;
            if (result.url) tryBtn.href = result.url;
          }
        }
      });
      urlInput.addEventListener('input', () => mapsWork.input(urlInput.value));
      if (urlInput.value.trim()) mapsWork.input(urlInput.value);
    }).catch(() => {
      if (hint) hint.textContent = 'Gunakan URL Google Review (https://search.google.com/local/writereview?placeid=...).';
    });

    // Form submit handler
    const form = document.getElementById('card-edit-form');
    form.onsubmit = async event => {
      event.preventDefault();
      const errBox = document.getElementById('modal-error');
      const succBox = document.getElementById('modal-success');
      errBox.hidden = true;
      succBox.hidden = true;

      const newName = document.getElementById('edit-business-name').value.trim();
      const rawUrl = urlInput.value.trim();
      const finalUrl = resolvedReview || rawUrl;

      if (!newName) {
        errBox.textContent = 'Nama usaha wajib diisi.';
        errBox.hidden = false;
        return;
      }
      if (!finalUrl || !/^https:\/\//i.test(finalUrl)) {
        errBox.textContent = 'Link Google Review wajib berupa URL HTTPS yang valid.';
        errBox.hidden = false;
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Menyimpan...';

      try {
        await client.requestBuyer('update', {
          card_code: card.card_code,
          business_name: newName,
          review_url: finalUrl
        });

        succBox.textContent = 'Perubahan informasi kartu berhasil disimpan!';
        succBox.hidden = false;
        showToast('Kartu ' + card.card_code + ' berhasil diperbarui');

        // Refresh card in local state
        card.business_name = newName;
        card.review_url = finalUrl;
        renderCardsList();

        setTimeout(() => close(), 1200);
      } catch (err) {
        errBox.textContent = 'Gagal menyimpan: ' + (err.message || 'Terjadi gangguan server.');
        errBox.hidden = false;
        submitBtn.disabled = false;
        submitBtn.innerHTML = `${icon('check')} Simpan Perubahan`;
      }
    };
  }

  async function loadDashboard() {
    state = 'loading';
    needsLogin = false;
    errorText = '';
    render();

    try {
      client = await import('./buyer-account.mjs');

      // 1. Fetch entire dashboard in single consolidated request
      let dash = null;
      try {
        dash = await client.requestBuyer('dashboard');
      } catch (e) {
        if (e.status === 401 || e.status === 403) throw e;
      }

      if (dash?.user) {
        accountUser = dash.user;
        cards = Array.isArray(dash.cards) ? dash.cards : [];
        if (dash.analytics && !dash.analytics.error) {
          analytics = dash.analytics;
        }
      } else {
        // Fallback for individual queries
        const session = await client.requestBuyer('session');
        if (!session?.user?.id) {
          throw Object.assign(new Error('Sesi akun tidak ditemukan. Silakan login kembali.'), { status: 401 });
        }
        accountUser = session.user;

        const data = await client.requestBuyer('cards');
        if (!Array.isArray(data?.cards)) {
          throw new Error('Format data kartu dari server tidak valid.');
        }
        cards = data.cards;

        if (cards.length > 0) {
          try {
            const stats = await client.requestBuyer('analytics', { days: analyticsPeriod, card: analyticsCardFilter });
            if (stats && !stats.error) analytics = stats;
          } catch (e) {
            console.warn('Analytics deferred:', e);
          }
        }
      }

      state = cards.length ? 'ready' : 'empty';
      render();
    } catch (err) {
      needsLogin = (err.status === 401 || err.status === 403);
      if (!navigator.onLine) {
        errorText = 'Koneksi internet Anda terputus. Pastikan perangkat Anda terhubung ke internet lalu coba lagi.';
      } else if (needsLogin) {
        errorText = 'Sesi akun Anda telah berakhir. Silakan masuk kembali untuk mengelola kartu usaha Anda.';
      } else {
        errorText = 'Layanan belum dapat dihubungi atau sedang dalam pemeliharaan. Silakan coba beberapa saat lagi.';
      }
      state = 'error';
      render();
    }
  }

  // Network offline/online listeners for automatic recovery
  window.addEventListener('online', () => {
    showToast('Koneksi internet terhubung kembali.');
    if (state === 'error') loadDashboard();
  });
  window.addEventListener('offline', () => {
    showToast('Koneksi internet terputus.');
  });

  // Auto-init on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadDashboard);
  } else {
    loadDashboard();
  }
})();
