import { BuyerError, config, guard, token, cookies, upstream, user, cardInput, isAllowedOrigin } from '../lib/buyer-service.mjs';
import { directReview } from '../pembeli/maps.mjs';
import restrictedBuyer from '../lib/restricted-app-adapter.mjs';

const PILOT_CARD = 'iKRb7_7PyK6kg4Ye7EqvOhYu';

export default async function handler(req, res) {
  const selectedAction = req.method === 'GET' ? req.query?.action : req.body?.action;
  const cardCode = req.body?.card_code || req.query?.card_code;

  if (process.env.BUYER_PILOT_ENABLED === 'true' && (cardCode === PILOT_CARD || (!cardCode && selectedAction === 'mode')) && !['session', 'refresh', 'signout'].includes(selectedAction)) {
    const { createPilotHandlers } = await import('../lib/public-pilot.mjs');
    return createPilotHandlers().api(req, res);
  }
  if (process.env.BUYER_RESTRICTED_APP === 'true' && !['mode', 'session', 'refresh', 'signout'].includes(selectedAction)) return restrictedBuyer(req, res);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Metode tidak diizinkan.' });
  try {
    const cfg = config();
    guard(req, cfg);
    const reqOrigin = req.headers.origin || req.headers.referer;
    const effectiveOrigin = (reqOrigin && isAllowedOrigin(reqOrigin, cfg))
      ? (new URL(reqOrigin).origin)
      : cfg.origin;
    const action = req.method === 'GET' ? req.query?.action : req.body?.action;
    const body = req.body || {};
    if (req.method === 'GET' && action === 'mode') return res.status(200).json({ mode: process.env.BUYER_RESTRICTED_APP === 'true' ? 'restricted' : 'supabase', ...(process.env.BUYER_RESTRICTED_APP === 'true' || process.env.BUYER_FIRST_CLAIM_ENABLED === 'true' ? { activation_flow: 'first_claim' } : {}) });
    if (req.method === 'POST' && action === 'verify-card') {
      const code = typeof body.card_code === 'string' ? body.card_code.trim() : '';
      if (!/^[A-Za-z0-9_-]{1,30}$/.test(code)) {
        throw new BuyerError(400, 'Format kode kartu tidak valid.');
      }

      // Check card status from buyer_v2_public_card_status
      const status = await upstream(cfg, '/rest/v1/rpc/buyer_v2_public_card_status', {
        method: 'POST',
        body: { p_card_code: code }
      }).catch(() => null);

      if (!status || status.code !== code) {
        throw new BuyerError(404, 'Kartu tidak ditemukan dalam sistem.');
      }

      if (status.activation_state === 'active') {
        return res.status(200).json({
          success: false,
          code: 'already_active',
          error: 'Kartu ini sudah aktif dan sudah terhubung dengan akun.'
        });
      }

      return res.status(200).json({
        success: true,
        verified: true,
        card_code: code,
        message: 'Kartu valid dan siap diaktifkan.'
      });
    }
    if (req.method === 'POST' && ['signup', 'signin'].includes(action)) {
      if (typeof body.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ||
        typeof body.password !== 'string' || body.password.length > 256 || body.password.length < (action === 'signup' ? 8 : 1)) throw new BuyerError(400, 'Email atau password tidak valid. Password baru minimal 8 karakter.');
      const redirectTarget = `${effectiveOrigin}/pembeli/auth-callback.html`;

      let signupMeta = undefined;
      const effectiveCard = cardCode || body.card_code;
      if (action === 'signup' && effectiveCard && /^[A-Za-z0-9_-]{1,30}$/.test(effectiveCard)) {
        signupMeta = {
          pending_activation: {
            card_code: effectiveCard,
            business_name: typeof body.business_name === 'string' ? body.business_name.trim().slice(0, 150) : '',
            review_url: typeof body.review_url === 'string' && directReview(body.review_url) ? body.review_url : ''
          }
        };
      }

      let data;
      try {
        const payload = action === 'signup'
          ? { email: body.email.trim(), password: body.password, ...(signupMeta ? { data: signupMeta } : {}) }
          : { email: body.email.trim(), password: body.password };
        data = await upstream(cfg, action === 'signup' ? `/auth/v1/signup?redirect_to=${encodeURIComponent(redirectTarget)}` : '/auth/v1/token?grant_type=password',
          { method: 'POST', body: payload });
      } catch (err) {
        if (action === 'signin') {
          const errMsg = String(err.message || '');
          if (errMsg.includes('Invalid login credentials') || errMsg.includes('invalid_grant')) {
            throw new BuyerError(401, 'Email atau password tidak sesuai.');
          }
          if (errMsg.includes('Email not confirmed')) {
            throw new BuyerError(401, 'Silakan verifikasi email Anda terlebih dahulu.');
          }
        }
        throw err;
      }

      if (data?.access_token) res.setHeader('Set-Cookie', cookies(data, cfg));
      const userPayload = data?.user ? {
        id: data.user.id,
        email: data.user.email,
        name: data.user.user_metadata?.full_name || null,
        pending_activation: data.user.user_metadata?.pending_activation || null
      } : null;

      return res.status(200).json({
        success: true,
        signed_in: Boolean(data?.access_token),
        user: userPayload,
        message: action === 'signup' ? 'Jika pendaftaran dapat diproses, periksa email untuk verifikasi lalu masuk.' : 'Berhasil masuk.'
      });
    }
    if (req.method === 'POST' && action === 'exchange-session') {
      const accessToken = typeof body.access_token === 'string' ? body.access_token.trim() : '';
      const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token.trim() : '';
      const expiresIn = Number(body.expires_in) || 3600;

      if (!accessToken || !/^[A-Za-z0-9._~-]{1,8192}$/.test(accessToken)) {
        throw new BuyerError(400, 'Token akses tidak valid.');
      }

      // Verify token with Supabase GoTrue
      const userData = await upstream(cfg, '/auth/v1/user', { access: accessToken });
      if (!userData?.id) {
        throw new BuyerError(401, 'Sesi verifikasi tidak valid.');
      }

      const sessionData = {
        access_token: accessToken,
        refresh_token: refreshToken && /^[A-Za-z0-9._~-]{1,8192}$/.test(refreshToken) ? refreshToken : '',
        expires_in: expiresIn
      };

      res.setHeader('Set-Cookie', cookies(sessionData, cfg));
      return res.status(200).json({
        success: true,
        user: {
          id: userData.id,
          email: userData.email,
          name: userData.user_metadata?.full_name || null,
          pending_activation: userData.user_metadata?.pending_activation || null
        }
      });
    }
    if (req.method === 'POST' && ['recover', 'reset-password'].includes(action)) {
      if (typeof body.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
        throw new BuyerError(400, 'Format alamat email tidak valid.');
      }
      await upstream(cfg, `/auth/v1/recover?redirect_to=${encodeURIComponent(effectiveOrigin + '/pembeli/index.html#reset')}`, {
        method: 'POST',
        body: { email: body.email.trim() }
      }).catch(() => {
        // Do not leak email existence
      });
      return res.status(200).json({
        success: true,
        message: 'Jika alamat email terdaftar, instruksi dan tautan untuk membuat password baru telah dikirim ke email Anda.'
      });
    }
    if (req.method === 'POST' && action === 'reset-password-confirm') {
      if (typeof body.token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(body.token)) {
        throw new BuyerError(400, 'Token reset password tidak valid atau kedaluwarsa.');
      }
      if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 256) {
        throw new BuyerError(400, 'Password baru harus minimal 8 karakter.');
      }
      await upstream(cfg, '/auth/v1/user', {
        method: 'PUT',
        access: body.token,
        body: { password: body.password }
      });
      return res.status(200).json({
        success: true,
        message: 'Password berhasil diubah. Silakan masuk menggunakan email dan password baru Anda.'
      });
    }
    if (req.method === 'POST' && action === 'refresh') {
      const refresh = token(req, 'r', cfg);
      if (!refresh) throw new BuyerError(401, 'Silakan masuk kembali.');
      try {
        const data = await upstream(cfg, '/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refresh } });
        res.setHeader('Set-Cookie', cookies(data, cfg));
      } catch (error) { if (error.status === 400 || error.status === 401) res.setHeader('Set-Cookie', cookies(null, cfg)); throw error; }
      return res.status(200).json({ success: true });
    }
    if (req.method === 'POST' && action === 'signout') {
      let access = token(req, 'a', cfg);
      res.setHeader('Set-Cookie', cookies(null, cfg));
      try {
        const refresh = token(req, 'r', cfg);
        let revoked = false;
        if (access) { try { await upstream(cfg, '/auth/v1/logout?scope=local', { method: 'POST', access }); revoked = true; } catch (error) { if (error.status !== 401) throw error; } }
        if (!revoked && refresh) {
          try { const data = await upstream(cfg, '/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refresh } }); access = data.access_token; await upstream(cfg, '/auth/v1/logout?scope=local', { method: 'POST', access }); }
          catch (error) { if (![400, 401].includes(error.status)) throw error; }
        }
      } catch { return res.status(502).json({ error: 'Sesi browser dihapus, tetapi pencabutan sesi server belum terkonfirmasi.' }); }
      return res.status(200).json({ success: true });
    }
    const session = await user(req, cfg);
    if (req.method === 'GET' && action === 'session') return res.status(200).json({ user: session.user });
    if (req.method === 'GET' && action === 'dashboard') {
      const [cards, analytics] = await Promise.all([
        upstream(cfg, '/rest/v1/rpc/buyer_v2_list_cards', { method: 'POST', access: session.access, body: {} }),
        upstream(cfg, '/rest/v1/rpc/buyer_v2_analytics', { method: 'POST', access: session.access, body: { p_days: 7 } }).catch(() => null)
      ]);
      return res.status(200).json({
        user: session.user,
        cards: Array.isArray(cards) ? cards : [],
        analytics: analytics && !analytics.error ? analytics : null
      });
    }
    if (req.method === 'POST' && action === 'first-claim') {
      if (process.env.BUYER_FIRST_CLAIM_ENABLED !== 'true') throw new BuyerError(503, 'Klaim kartu baru belum diaktifkan. Informasi Anda tetap tersimpan.');
      if (!session?.user?.id) throw new BuyerError(401, 'Sesi Anda telah berakhir. Silakan masuk kembali.');
      const args = cardInput(body);
      if (!/^[A-Za-z0-9_-]{1,30}$/.test(body.card_code) || !directReview(body.review_url) || directReview(body.review_url) !== body.review_url) throw new BuyerError(400, 'Identitas kartu atau link review belum valid.');

      const result = await upstream(cfg, '/rest/v1/rpc/buyer_claim_v2_direct', {
        method: 'POST',
        access: session.access,
        body: {
          p_card_code: body.card_code,
          p_business_name: args.p_business_name,
          p_review_url: args.p_review_url
        }
      });

      if (result?.code === 'rate_limited') { res.setHeader('Retry-After', '900'); throw new BuyerError(429, 'Terlalu banyak percobaan klaim. Tunggu 15 menit lalu coba lagi.'); }
      if (result?.code === 'not_ready') throw new BuyerError(409, 'Kartu belum ditandai siap diaktifkan oleh sistem inventaris.');
      if (result?.code === 'already_claimed' && result?.success !== true) throw new BuyerError(409, 'Kartu ini sudah diaktifkan oleh akun lain.');
      if (result?.success !== true) throw new BuyerError(409, 'Kartu belum berhasil dihubungkan. Silakan coba kembali.');

      return res.status(200).json({ success: true, card_code: body.card_code });
    }
    if (req.method === 'GET' && action === 'cards') {
      const cards = await upstream(cfg, '/rest/v1/rpc/buyer_v2_list_cards', { method: 'POST', access: session.access, body: {} });
      if (!Array.isArray(cards)) throw new BuyerError(502, 'Respons daftar kartu tidak valid. Coba lagi.');
      return res.status(200).json({ cards, statistics: { available: true } });
    }
    if (action === 'analytics') {
      const rawDays = parseInt(req.method === 'GET' ? req.query?.days : body.days, 10);
      const days = [7, 30, 90].includes(rawDays) ? rawDays : 7;
      const rawCard = req.method === 'GET' ? req.query?.card : body.card;
      const cardFilter = (typeof rawCard === 'string' && /^[A-Za-z0-9_-]{1,30}$/.test(rawCard) && rawCard !== 'all') ? rawCard : null;
      
      const analytics = await upstream(cfg, '/rest/v1/rpc/buyer_v2_analytics', {
        method: 'POST',
        access: session.access,
        body: { p_days: days, ...(cardFilter ? { p_card_code: cardFilter } : {}) }
      });

      if (!analytics || analytics.error) {
        throw new BuyerError(502, 'Gagal memuat data statistik.');
      }

      if (analytics.total_cards === 0) {
        if (cardFilter) {
          throw new BuyerError(403, 'Akses kartu tidak diizinkan.');
        } else {
          throw new BuyerError(403, 'Dashboard analitik hanya dapat diakses oleh akun yang sudah memiliki kartu teraktivasi.');
        }
      }

      return res.status(200).json(analytics);
    }
    if (req.method === 'POST' && ['update-password', 'set-password'].includes(action)) {
      if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 256) {
        throw new BuyerError(400, 'Password baru harus minimal 8 karakter (maksimal 256).');
      }
      await upstream(cfg, '/auth/v1/user', {
        method: 'PUT',
        access: session.access,
        body: { password: body.password }
      });
      return res.status(200).json({
        success: true,
        message: 'Password akun Anda berhasil disimpan. Anda kini dapat masuk menggunakan email & password atau Google.'
      });
    }
    if (req.method === 'POST' && ['activate', 'update', 'claim'].includes(action)) {
      let args;
      if (action === 'claim') {
        if (typeof body.card_code !== 'string' || !/^[a-zA-Z0-9_-]{1,30}$/.test(body.card_code) || typeof body.pin !== 'string' || !body.pin || body.pin.length > 1024) throw new BuyerError(400, 'Kode kartu atau PIN tidak valid.');
        args = { p_card_code: body.card_code, p_pin: body.pin };
      } else if (action === 'update') {
        const canonical = directReview(body.review_url) || body.review_url;
        args = { p_card_code: body.card_code, p_business_name: typeof body.business_name === 'string' ? body.business_name.trim() : '', p_review_url: canonical };
      } else args = cardInput(body, action === 'activate');
      const rpc = { activate: 'buyer_activate_card', update: 'buyer_v2_update_card', claim: 'buyer_claim_card' }[action];
      const result = await upstream(cfg, `/rest/v1/rpc/${rpc}`, { method: 'POST', access: session.access, body: args });
      if (result !== true) throw new BuyerError(400, 'Kartu tidak dapat diproses. Periksa bukti kepemilikan, status kartu, atau tunggu jika terkunci.');
      return res.status(200).json({ success: true });
    }
    return res.status(400).json({ error: 'Aksi tidak dikenal.' });
  } catch (error) {
    return res.status(error instanceof BuyerError ? error.status : 500).json({ error: error instanceof BuyerError ? error.message : 'Terjadi gangguan server.' });
  }
}
