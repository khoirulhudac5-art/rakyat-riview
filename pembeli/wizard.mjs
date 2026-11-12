import {converter,resolveMaps,directReview} from './maps.mjs';
import {loadDraft,saveDraft,removeDraft,googleLogin} from './drafts.mjs';
import {mountReviewFallback} from './review-fallback.mjs';

const el = id => document.getElementById(id);
const searchParams = new URLSearchParams(location.search);
const rawCode = searchParams.get('card') || searchParams.get('kartu') || searchParams.get('code') || '';
const code = rawCode.trim().toUpperCase();
const initialToken = searchParams.get('token') || searchParams.get('activation_token') || '';

let canonical = null;
let synthetic = false;
let restoreSummary = false;
let claimEligible = false;
let account = null;
let googleEnabled = false;
let authTestUI = null;
let inventoryNotReady = false;
let restricted = false;
let realAuth = false;
let cardAccessClosed = false;
let localFallback = { update() {} };
let identityVersion = 0;

function feedback(e) {
  const msgEl = el('message');
  if (!msgEl) return;
  msgEl.className = 'message error';
  msgEl.textContent = e.message || 'Terjadi kendala. Silakan coba lagi.';
}

function clearFeedback() {
  const msgEl = el('message');
  if (msgEl) {
    msgEl.textContent = '';
    msgEl.className = 'message';
  }
}

function step(current, complete = false) {
  for (let n = 1; n <= 3; n++) {
    const sEl = el('step-' + n);
    const textEl = el('step-state-' + n);
    if (!sEl) continue;
    const state = n < current || complete ? 'done' : n === current ? 'active' : 'upcoming';
    sEl.dataset.state = state;
    if (textEl) textEl.textContent = state === 'done' ? 'Selesai' : state === 'active' ? 'Saat ini' : 'Belum dimulai';
    if (state === 'active') sEl.setAttribute('aria-current', 'step');
    else sEl.removeAttribute('aria-current');
  }
}

function persist() {
  const bizVal = el('business')?.value || '';
  const mapsVal = el('maps')?.value || '';
  const isSummary = !el('summary')?.hidden;
  const isDraftForm = !el('draft-form')?.hidden;
  const currentStep = isSummary ? 3 : isDraftForm ? 2 : 1;
  const draftData = {
    card_code: code,
    name: bizVal,
    maps: mapsVal,
    canonical: canonical || '',
    step: currentStep
  };
  saveDraft(sessionStorage, code, draftData);
  try {
    saveDraft(localStorage, code, draftData);
  } catch {}
}

const work = converter({
  resolve: resolveMaps,
  update(result) {
    canonical = result.url;
    const convEl = el('conversion');
    if (convEl) {
      convEl.textContent = result.message || '';
      convEl.dataset.state = result.state;
    }
    const contBtn = el('continue');
    if (contBtn) contBtn.disabled = result.state !== 'ready' || !el('business')?.value.trim();
    const tryBtn = el('try-link');
    if (tryBtn) {
      tryBtn.hidden = !result.url;
      tryBtn.removeAttribute('href');
      if (result.url) tryBtn.href = result.url;
    }
    localFallback.update(result);
    if (result.state === 'ready' && restoreSummary) {
      restoreSummary = false;
      showSummary().catch(feedback);
    }
  }
});

el('maps').addEventListener('input', () => {
  restoreSummary = false;
  canonical = null;
  work.input(el('maps').value);
  try { persist(); } catch { feedback(Error('Informasi belum dapat disimpan di browser.')); }
});

el('business').addEventListener('input', () => {
  const contBtn = el('continue');
  if (contBtn) contBtn.disabled = !canonical || !el('business').value.trim();
  try { persist(); } catch { feedback(Error('Informasi belum dapat disimpan di browser.')); }
});

function renderSession(state) {
  const connected = state === 'connected' && Boolean(account);
  const connBox = el('auth-connected-box');
  const unconnBox = el('auth-unconnected-box');
  const idEl = el('identity');

  if (connBox) connBox.hidden = !connected;
  if (unconnBox) unconnBox.hidden = connected;

  if (connected && idEl && account?.email) {
    idEl.innerHTML = `Email: <strong>${escapeHtml(account.email)}</strong>` + (account.name ? `<br><small style="color:#64748b;">Nama: ${escapeHtml(account.name)}</small>` : '');
  }

  const claimBtn = el('claim-card');
  if (claimBtn) {
    claimBtn.hidden = !connected;
    claimBtn.disabled = !claimEligible;
  }

  step(3, connected);
}

async function identity() {
  const version = ++identityVersion;
  renderSession('checking');

  try {
    let r = await fetch('/api/buyer?action=session', {
      cache: 'no-store',
      credentials: 'same-origin'
    });
    if (r.status === 401) {
      const refreshed = await fetch('/api/buyer', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Buyer-Request': '1' },
        body: JSON.stringify({ action: 'refresh' })
      });
      if (refreshed.ok) {
        r = await fetch('/api/buyer?action=session', {
          cache: 'no-store',
          credentials: 'same-origin'
        });
      }
    }
    if (version !== identityVersion) return account;
    if (r.ok) {
      const data = await r.json();
      if (version !== identityVersion) return account;
      if (!data.user?.id) throw Error('Invalid session');
      account = data.user;
      renderSession('connected');

      // Cross-device assistance: If pending activation data exists and fields are empty, prefill
      if (account.pending_activation) {
        const p = account.pending_activation;
        if (p.business_name && el('business') && !el('business').value.trim()) {
          el('business').value = p.business_name;
        }
        if (p.review_url && el('maps') && !el('maps').value.trim()) {
          el('maps').value = p.review_url;
          work.input(p.review_url);
        }
      }
    } else if (r.status === 401) {
      account = null;
      renderSession('signed-out');
    } else {
      throw Error('Session unavailable');
    }
  } catch {
    if (version !== identityVersion) return account;
    account = null;
    renderSession('error');
  }
  return account;
}

async function executeClaim() {
  clearFeedback();
  const claimBtn = el('claim-card');
  if (claimBtn) claimBtn.disabled = true;

  try {
    if (!account?.id) {
      const current = await identity();
      if (!current?.id) throw Error('Sesi Anda telah berakhir. Silakan masuk kembali.');
    }
    if (!canonical || !el('business')?.value.trim()) throw Error('Lengkapi nama usaha dan link review terlebih dahulu.');

    persist();
    const options = {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Buyer-Request': '1' },
      body: JSON.stringify({
        action: 'first-claim',
        card_code: code,
        business_name: el('business').value.trim(),
        review_url: canonical
      })
    };

    let response = await fetch('/api/buyer', options);
    if (response.status === 401) {
      const refreshed = await fetch('/api/buyer', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Buyer-Request': '1' },
        body: JSON.stringify({ action: 'refresh' })
      });
      if (refreshed.ok) response = await fetch('/api/buyer', options);
    }

    const data = await response.json();
    if (!response.ok || data.success !== true) {
      throw Error(data.error || 'Kartu belum berhasil dihubungkan. Silakan coba kembali.');
    }

    // Success! Show confirmation
    try {
      removeDraft(sessionStorage, code);
      removeDraft(localStorage, code);
      localStorage.removeItem('rr-pending-card');
      sessionStorage.setItem('rr-buyer-activation-flash', code);
    } catch {}

    el('summary').hidden = true;
    const successSec = el('activation-success');
    if (successSec) {
      successSec.hidden = false;
      const cardEl = el('success-card-code');
      if (cardEl) cardEl.textContent = code;
      const bizEl = el('success-biz-name');
      if (bizEl) bizEl.textContent = el('business').value.trim();
    }
    step(3, true);
  } catch (err) {
    feedback(err);
  } finally {
    if (claimBtn) claimBtn.disabled = false;
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

async function showSummary() {
  if (!canonical || !el('business').value.trim()) return;
  el('sum-code').textContent = code;
  el('sum-name').textContent = el('business').value.trim();
  el('sum-link').textContent = canonical;
  el('summary-try-link').href = canonical;
  el('draft-form').hidden = true;
  el('summary').hidden = false;
  persist();
  step(3);
  await identity();
}

el('draft-form').onsubmit = async e => {
  e.preventDefault();
  if (!canonical) return;
  if (!el('business').value.trim()) {
    feedback(Error('Isi nama usaha Anda terlebih dahulu.'));
    el('business').focus();
    return;
  }
  try { await showSummary(); } catch (err) { feedback(err); }
};

// Summary toggle accordion
const summaryToggle = el('summary-toggle-btn');
const summaryPanel = el('summary-detail-panel');
if (summaryToggle && summaryPanel) {
  summaryToggle.onclick = () => {
    const isExpanded = summaryToggle.getAttribute('aria-expanded') === 'true';
    summaryToggle.setAttribute('aria-expanded', String(!isExpanded));
    summaryPanel.hidden = isExpanded;
  };
}

el('back').onclick = () => {
  el('summary').hidden = true;
  el('draft-form').hidden = false;
  clearFeedback();
  persist();
  step(2);
};

// Step 1: Back to Step 1 from Step 2
const btnBackStep1 = el('btn-back-to-step-1');
if (btnBackStep1) {
  btnBackStep1.onclick = () => {
    el('draft-form').hidden = true;
    el('step-1-panel').hidden = false;
    clearFeedback();
    persist();
    step(1);
  };
}

// Step 1: Start Activation button & Retry
const btnStartActivation = el('btn-start-activation');
if (btnStartActivation) {
  btnStartActivation.onclick = () => {
    const pillCode = el('verified-card-code');
    if (pillCode) pillCode.textContent = code;
    el('step-1-panel').hidden = true;
    el('draft-form').hidden = false;
    clearFeedback();
    persist();
    step(2);
    el('business')?.focus();
  };
}

const btnRetryCheck = el('btn-retry-check');
if (btnRetryCheck) {
  btnRetryCheck.onclick = () => {
    checkCardStatus();
  };
}

// Wire up Claim button
const claimBtn = el('claim-card');
if (claimBtn) claimBtn.onclick = executeClaim;

// Wire up Logout / Switch Account button
const logoutBtn = el('wizard-logout');
if (logoutBtn) {
  logoutBtn.onclick = async () => {
    logoutBtn.disabled = true;
    try {
      persist();
      await fetch('/api/buyer', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Buyer-Request': '1' },
        body: JSON.stringify({ action: 'signout' })
      });
      identityVersion++;
      account = null;
      renderSession('signed-out');
    } catch (e) {
      feedback(e);
    } finally {
      logoutBtn.disabled = false;
    }
  };
}

// Tab Switching: Pembeli Baru (Biru) vs Sudah Punya Akun (Kuning)
const tabNew = el('tab-btn-new');
const tabExisting = el('tab-btn-existing');
const panelNew = el('panel-new-buyer');
const panelExisting = el('panel-existing-buyer');
const hintText = el('dynamic-hint-text');

if (tabNew && tabExisting) {
  tabNew.onclick = () => {
    clearFeedback();
    tabNew.classList.add('active');
    tabNew.setAttribute('aria-selected', 'true');
    tabExisting.classList.remove('active');
    tabExisting.setAttribute('aria-selected', 'false');
    panelNew.hidden = false;
    panelExisting.hidden = true;
    if (hintText) {
      hintText.textContent = 'Belum pernah aktivasi? Buat akun baru agar kartu tersimpan dan bisa dikelola kapan saja.';
    }
  };
  tabExisting.onclick = () => {
    clearFeedback();
    tabExisting.classList.add('active');
    tabExisting.setAttribute('aria-selected', 'true');
    tabNew.classList.remove('active');
    tabNew.setAttribute('aria-selected', 'false');
    panelExisting.hidden = false;
    panelNew.hidden = true;
    if (hintText) {
      hintText.textContent = 'Pernah aktivasi kartu? Masuk dengan akun sebelumnya supaya semua kartu terkumpul di satu dashboard.';
    }
  };
}

// Password toggles with visual eye feedback
function bindPwToggle(btnId, inputId) {
  const btn = el(btnId);
  const input = el(inputId);
  if (btn && input) {
    btn.onclick = () => {
      const isPw = input.type === 'password';
      input.type = isPw ? 'text' : 'password';
      btn.style.color = isPw ? '#1a73e8' : '#64748b';
    };
  }
}
bindPwToggle('reg-toggle-pw', 'reg-password');
bindPwToggle('reg-toggle-pw-confirm', 'reg-password-confirm');
bindPwToggle('login-toggle-pw', 'login-password');

// Google Login Buttons
const regGoogle = el('btn-reg-google');
if (regGoogle) {
  regGoogle.onclick = async () => {
    regGoogle.disabled = true;
    try {
      persist();
      await googleLogin(location.pathname + location.search);
    } catch (e) {
      feedback(e);
      regGoogle.disabled = false;
    }
  };
}
const loginGoogle = el('btn-login-google');
if (loginGoogle) {
  loginGoogle.onclick = async () => {
    loginGoogle.disabled = true;
    try {
      persist();
      await googleLogin(location.pathname + location.search);
    } catch (e) {
      feedback(e);
      loginGoogle.disabled = false;
    }
  };
}

// Email Registration Submit
const btnReg = el('btn-reg-submit');
if (btnReg) {
  btnReg.onclick = async () => {
    clearFeedback();
    const email = el('reg-email')?.value.trim();
    const password = el('reg-password')?.value;
    const confirmPw = el('reg-password-confirm')?.value;
    if (!email || !password) {
      feedback(Error('Lengkapi alamat email dan password Anda.'));
      return;
    }
    if (password.length < 8) {
      feedback(Error('Password baru harus minimal 8 karakter.'));
      return;
    }
    if (password !== confirmPw) {
      feedback(Error('Konfirmasi password tidak cocok dengan password yang dibuat.'));
      return;
    }
    btnReg.disabled = true;
    btnReg.textContent = 'Mendaftarkan...';
    persist();
    try {
      try {
        localStorage.setItem('rr-pending-card', code);
        localStorage.setItem('rr-pending-email', email);
      } catch {}
      const res = await fetch('/api/buyer', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Buyer-Request': '1' },
        body: JSON.stringify({
          action: 'signup',
          email,
          password,
          card_code: code,
          business_name: el('business')?.value.trim() || '',
          review_url: canonical || ''
        })
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error || 'Pendaftaran gagal.');
      if (data.signed_in) {
        if (data.user?.id) {
          account = data.user;
          renderSession('connected');
        } else {
          await identity();
        }
        await executeClaim();
      } else {
        const msgEl = el('message');
        if (msgEl) {
          msgEl.className = 'message success';
          msgEl.innerHTML = `<strong>Pendaftaran Berhasil Dikirim!</strong><br>Email verifikasi telah dikirim ke <strong>${escapeHtml(email)}</strong>.<br>Silakan buka inbox email Anda dan klik tautan verifikasi. Setelah diklik, sistem akan otomatis menghubungkan kartu Anda.<br><span style="display:inline-block;margin-top:8px;font-size:13px;color:#1e3a8a;">Sudah klik link verifikasi di email? Silakan masuk melalui tab <strong>Sudah Punya Akun</strong> di atas untuk menyelesaikan aktivasi kartu.</span>`;
        }
      }
    } catch (err) {
      feedback(err);
    } finally {
      btnReg.disabled = false;
      btnReg.textContent = 'Daftar & Hubungkan Kartu';
    }
  };
}

// Email Signin Submit
const btnLogin = el('btn-login-submit');
if (btnLogin) {
  btnLogin.onclick = async () => {
    clearFeedback();
    const email = el('login-email')?.value.trim();
    const password = el('login-password')?.value;
    if (!email || !password) {
      feedback(Error('Lengkapi alamat email dan password Anda.'));
      return;
    }
    btnLogin.disabled = true;
    btnLogin.textContent = 'Memverifikasi...';
    persist();
    try {
      const res = await fetch('/api/buyer', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Buyer-Request': '1' },
        body: JSON.stringify({ action: 'signin', email, password })
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error || 'Email atau password tidak sesuai.');
      if (data.user?.id) {
        account = data.user;
        renderSession('connected');
      } else {
        await identity();
      }
      await executeClaim();
    } catch (err) {
      feedback(err);
    } finally {
      btnLogin.disabled = false;
      btnLogin.textContent = 'Masuk & Hubungkan Kartu';
    }
  };
}

// Forgot Password Modal Wiring
const btnForgot = el('btn-forgot-pw');
const modalForgot = el('forgot-modal');
const btnCloseForgot = el('btn-close-forgot');
const btnSubmitForgot = el('btn-submit-forgot');
const forgotFeedback = el('forgot-feedback');

if (btnForgot && modalForgot) {
  btnForgot.onclick = () => {
    modalForgot.hidden = false;
    const prefillEmail = el('login-email')?.value.trim();
    if (prefillEmail && el('forgot-email')) el('forgot-email').value = prefillEmail;
    if (forgotFeedback) { forgotFeedback.style.display = 'none'; forgotFeedback.textContent = ''; }
  };
}
if (btnCloseForgot && modalForgot) {
  btnCloseForgot.onclick = () => { modalForgot.hidden = true; };
}
if (btnSubmitForgot) {
  btnSubmitForgot.onclick = async () => {
    const email = el('forgot-email')?.value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (forgotFeedback) {
        forgotFeedback.className = 'message error';
        forgotFeedback.style.display = 'block';
        forgotFeedback.textContent = 'Format alamat email tidak valid.';
      }
      return;
    }
    btnSubmitForgot.disabled = true;
    btnSubmitForgot.textContent = 'Mengirim...';
    try {
      const res = await fetch('/api/buyer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Buyer-Request': '1' },
        body: JSON.stringify({ action: 'recover', email })
      });
      const data = await res.json();
      if (forgotFeedback) {
        forgotFeedback.className = 'message success';
        forgotFeedback.style.display = 'block';
        forgotFeedback.textContent = data.message || 'Instruksi reset password telah dikirim ke email Anda.';
      }
    } catch (err) {
      if (forgotFeedback) {
        forgotFeedback.className = 'message error';
        forgotFeedback.style.display = 'block';
        forgotFeedback.textContent = err.message || 'Gagal mengirim instruksi reset.';
      }
    } finally {
      btnSubmitForgot.disabled = false;
      btnSubmitForgot.textContent = 'Kirim Link Reset Password';
    }
  };
}

// Initialize Wizard & Automatic Card Detection
async function checkCardStatus() {
  clearFeedback();
  const displayInput = el('card-code-display');
  const labelEl = el('card-label');
  const stateEl = el('card-state');
  const startBtn = el('btn-start-activation');
  const retryBtn = el('btn-retry-check');
  const detectedBox = el('card-detected-box');
  const activeBox = el('card-already-active-box');

  if (startBtn) startBtn.disabled = true;
  if (retryBtn) retryBtn.hidden = true;

  if (!code || !/^[A-Za-z0-9_-]{1,30}$/.test(code)) {
    if (displayInput) displayInput.value = code || '';
    if (labelEl) labelEl.textContent = 'Deteksi Kartu';
    if (stateEl) stateEl.textContent = 'Scan QR atau tap NFC pada kartu fisik Anda untuk memulai aktivasi otomatis.';
    if (el('scan-help')) el('scan-help').hidden = false;
    if (retryBtn) retryBtn.hidden = false;
    return;
  }

  // Immediately display the normalized code so it never hangs on placeholder
  if (displayInput) displayInput.value = code;
  if (labelEl) labelEl.textContent = 'KARTU ' + code;
  if (stateEl) stateEl.textContent = 'Memeriksa status kartu...';

  try {
    const r = await fetch('/api/buyer-status?card=' + encodeURIComponent(code), { cache: 'no-store' });
    const status = await r.json();

    if (!r.ok || !status || status.error) {
      throw Error(status?.error || 'Kartu tidak ditemukan dalam sistem.');
    }

    claimEligible = status.claim_allowed === true;
    const canonicalCode = status.code || code;
    if (displayInput) displayInput.value = canonicalCode;
    if (labelEl) labelEl.textContent = 'KARTU ' + canonicalCode;
    const pillCode = el('verified-card-code');
    if (pillCode) pillCode.textContent = canonicalCode;

    if (status.activation_state === 'active') {
      if (stateEl) stateEl.textContent = 'Kartu ini sudah aktif dan terhubung ke link Google Review.';
      if (activeBox) activeBox.hidden = false;
      if (detectedBox) detectedBox.hidden = true;
      step(1);
    } else {
      if (stateEl) stateEl.textContent = 'Kartu terdeteksi dan siap diaktifkan.';
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.hidden = false;
      }
      step(1);

      // Restore draft from storage if previously entered
      const draft = loadDraft(sessionStorage, code) || loadDraft(localStorage, code);
      if (draft) {
        if (draft.name && el('business')) el('business').value = draft.name;
        if (draft.canonical && directReview(draft.canonical)) {
          canonical = draft.canonical;
        }
        if (draft.maps && el('maps')) {
          el('maps').value = draft.maps;
          work.input(draft.maps);
        }
        if (draft.step === 2) {
          el('step-1-panel').hidden = true;
          el('draft-form').hidden = false;
          step(2);
        } else if (draft.step === 3 && draft.name && draft.maps) {
          restoreSummary = true;
        }
      }

      // Check session in the background & assist cross-device continuation
      identity().then(userAcc => {
        if (userAcc?.pending_activation?.card_code === code) {
          const p = userAcc.pending_activation;
          if (p.business_name && el('business') && !el('business').value.trim()) {
            el('business').value = p.business_name;
          }
          if (p.review_url && directReview(p.review_url) && !canonical) {
            canonical = p.review_url;
            if (el('maps') && !el('maps').value.trim()) {
              el('maps').value = p.review_url;
              work.input(p.review_url);
            }
          }
        }
      }).catch(() => {});

      // Check if user came from verification redirect wanting to log in
      if (searchParams.get('tab') === 'login' && tabExisting) {
        tabExisting.click();
        const pendingEmail = localStorage.getItem('rr-pending-email');
        if (pendingEmail && el('login-email') && !el('login-email').value) {
          el('login-email').value = pendingEmail;
        }
      }
    }
  } catch (err) {
    if (labelEl) labelEl.textContent = 'Pemeriksaan Kartu';
    if (stateEl) stateEl.textContent = err.message || 'Kartu tidak dapat diperiksa saat ini.';
    if (startBtn) startBtn.hidden = true;
    if (retryBtn) retryBtn.hidden = false;
  }
}

// Run immediately on page load
checkCardStatus();
