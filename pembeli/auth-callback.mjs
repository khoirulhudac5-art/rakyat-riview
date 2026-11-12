import { loadDraft, removeDraft, safeReturn } from './drafts.mjs';
import { directReview } from './maps.mjs';

const el = id => document.getElementById(id);

async function runCallback() {
  const query = new URLSearchParams(window.location.search);
  const rawHash = window.location.hash?.startsWith('#') ? window.location.hash.slice(1) : '';
  const fragment = new URLSearchParams(rawHash);

  const error = fragment.get('error') || query.get('error');
  const errorCode = fragment.get('error_code') || query.get('error_code');
  const errorDesc = fragment.get('error_description') || query.get('error_description');

  const accessToken = fragment.get('access_token') || query.get('access_token');
  const refreshToken = fragment.get('refresh_token') || query.get('refresh_token') || '';
  const expiresIn = fragment.get('expires_in') || query.get('expires_in') || '3600';

  // Clean URL fragment and query parameters immediately so tokens are never exposed in history, logs, or referer
  if (window.location.hash || (accessToken && window.location.search.includes('access_token'))) {
    const cleanSearch = new URLSearchParams(window.location.search);
    cleanSearch.delete('access_token');
    cleanSearch.delete('refresh_token');
    cleanSearch.delete('expires_in');
    cleanSearch.delete('token_type');
    cleanSearch.delete('type');
    const searchStr = cleanSearch.toString() ? '?' + cleanSearch.toString() : '';
    try {
      window.history.replaceState(null, '', window.location.pathname + searchStr);
    } catch {}
  }

  const rawCard = query.get('card') || localStorage.getItem('rr-pending-card') || '';
  const targetCard = /^[A-Za-z0-9_-]{1,30}$/.test(rawCard) ? rawCard.toUpperCase() : '';

  // Handle explicit errors from GoTrue (e.g. otp_expired)
  if (error || errorCode) {
    showError({
      title: errorCode === 'otp_expired' ? 'Tautan Verifikasi Sudah Digunakan' : 'Verifikasi Belum Selesai',
      desc: errorCode === 'otp_expired'
        ? 'Tautan email ini telah digunakan atau kedaluwarsa. Jika Anda baru saja mendaftar, akun Anda kemungkinan sudah berhasil diverifikasi di sistem.'
        : (errorDesc || 'Tautan verifikasi tidak valid atau telah kedaluwarsa.'),
      cardCode: targetCard
    });
    return;
  }

  if (!accessToken) {
    // If no access token in fragment, check if there's already an active session cookie
    try {
      const sessRes = await fetch('/api/buyer?action=session', {
        cache: 'no-store',
        credentials: 'same-origin'
      });
      if (sessRes.ok) {
        const sessData = await sessRes.json();
        if (sessData?.user?.id) {
          await processCardClaimOrRedirect(targetCard, sessData.user);
          return;
        }
      }
    } catch {}

    showError({
      title: 'Tautan Tidak Memiliki Sesi',
      desc: 'Tidak ada informasi verifikasi pada tautan ini. Silakan buka link terbaru dari email Anda atau masuk dengan password Anda.',
      cardCode: targetCard
    });
    return;
  }

  // Exchange access token for HttpOnly session cookies via backend
  try {
    const exRes = await fetch('/api/buyer', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Buyer-Request': '1'
      },
      body: JSON.stringify({
        action: 'exchange-session',
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: Number(expiresIn) || 3600
      })
    });

    const exData = await exRes.json();
    if (!exRes.ok || !exData.success) {
      throw Error(exData.error || 'Gagal menyimpan sesi verifikasi.');
    }

    // Session successfully established! Now handle card claim or redirect
    await processCardClaimOrRedirect(targetCard, exData.user);
  } catch (err) {
    showError({
      title: 'Gagal Memproses Verifikasi',
      desc: err.message || 'Terjadi gangguan saat memvalidasi sesi. Silakan coba masuk kembali.',
      cardCode: targetCard
    });
  }
}

async function processCardClaimOrRedirect(cardCode, user) {
  let effectiveCard = cardCode;
  let effectiveName = '';
  let effectiveReview = '';

  // 1. Check local draft
  if (effectiveCard) {
    const draft = loadDraft(localStorage, effectiveCard) || loadDraft(sessionStorage, effectiveCard);
    if (draft?.name) effectiveName = draft.name;
    const targetReview = draft?.canonical || (draft?.maps && directReview(draft.maps) ? draft.maps : null);
    if (targetReview) effectiveReview = targetReview;
  }

  // 2. Cross-device support: If local draft didn't have full info, check server-side user metadata
  const pending = user?.pending_activation;
  if (pending?.card_code && (!effectiveCard || !effectiveReview)) {
    effectiveCard = effectiveCard || pending.card_code;
    effectiveName = effectiveName || pending.business_name || '';
    if (pending.review_url && directReview(pending.review_url)) {
      effectiveReview = effectiveReview || pending.review_url;
    }
  }

  if (!effectiveCard) {
    // No card associated; normal user signup
    showSuccess({
      title: 'Email Berhasil Diverifikasi!',
      desc: 'Akun Anda telah aktif. Mengalihkan ke dashboard...',
      btnHref: '/pembeli/dashboard.html'
    });
    setTimeout(() => { window.location.replace('/pembeli/dashboard.html'); }, 1500);
    return;
  }

  if (effectiveName && effectiveReview) {
    // Automatically complete card claim
    const loadTitle = el('callback-loading-title');
    const loadDesc = el('callback-loading-desc');
    if (loadTitle) loadTitle.textContent = 'Menghubungkan Kartu...';
    if (loadDesc) loadDesc.textContent = `Email terverifikasi! Sedang mengaktifkan kartu ${effectiveCard} untuk ${effectiveName}...`;

    try {
      const claimRes = await fetch('/api/buyer', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Buyer-Request': '1'
        },
        body: JSON.stringify({
          action: 'first-claim',
          card_code: effectiveCard,
          business_name: effectiveName,
          review_url: effectiveReview
        })
      });

      const claimData = await claimRes.json();
      if (claimRes.ok && claimData.success === true) {
        // Claim succeeded!
        try {
          removeDraft(localStorage, effectiveCard);
          removeDraft(sessionStorage, effectiveCard);
          localStorage.removeItem('rr-pending-card');
        } catch {}

        showSuccess({
          title: `Kartu ${effectiveCard} Berhasil Diaktifkan!`,
          desc: `Usaha "${effectiveName}" telah aktif dan terhubung ke akun Anda. Mengalihkan ke dashboard...`,
          btnHref: '/pembeli/dashboard.html'
        });
        setTimeout(() => { window.location.replace('/pembeli/dashboard.html'); }, 1800);
        return;
      }
    } catch {}
  }

  // If claim could not be completed automatically (draft missing or need user action),
  // redirect directly to mulai.html with the card code. User is already authenticated!
  showSuccess({
    title: 'Akun Berhasil Diverifikasi!',
    desc: `Melanjutkan aktivasi kartu ${effectiveCard}...`,
    btnHref: `/pembeli/mulai.html?card=${encodeURIComponent(effectiveCard)}`
  });
  setTimeout(() => {
    window.location.replace(`/pembeli/mulai.html?card=${encodeURIComponent(effectiveCard)}`);
  }, 1200);
}

function showSuccess({ title, desc, btnHref }) {
  if (el('callback-loading')) el('callback-loading').hidden = true;
  if (el('callback-error')) el('callback-error').hidden = true;
  const sBox = el('callback-success');
  if (sBox) sBox.hidden = false;
  if (el('callback-success-title')) el('callback-success-title').textContent = title;
  if (el('callback-success-desc')) el('callback-success-desc').textContent = desc;
  if (el('callback-success-btn')) el('callback-success-btn').href = btnHref || '/pembeli/dashboard.html';
}

function showError({ title, desc, cardCode }) {
  if (el('callback-loading')) el('callback-loading').hidden = true;
  if (el('callback-success')) el('callback-success').hidden = true;
  const eBox = el('callback-error');
  if (eBox) eBox.hidden = false;
  if (el('callback-error-title')) el('callback-error-title').textContent = title;
  if (el('callback-error-desc')) el('callback-error-desc').textContent = desc;

  const resumeBtn = el('callback-action-resume');
  if (resumeBtn) {
    if (cardCode) {
      resumeBtn.href = `/pembeli/mulai.html?card=${encodeURIComponent(cardCode)}&tab=login`;
      resumeBtn.textContent = 'Masuk & Lanjutkan Aktivasi Kartu ➔';
      resumeBtn.hidden = false;
    } else {
      resumeBtn.hidden = true;
    }
  }

  const loginBtn = el('callback-action-login');
  if (loginBtn) {
    loginBtn.href = '/pembeli/index.html';
  }
}

// Execute on load
runCallback();
