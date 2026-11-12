// Separate buyer integration. Never uses the service-role key.
export class BuyerError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  const origin = process.env.BUYER_APP_ORIGIN;
  if (process.env.BUYER_INTEGRATION_ENABLED !== 'true' || !url || !key || !origin) {
    throw new BuyerError(503, 'Integrasi pembeli belum diaktifkan. Konfigurasi dan migration perlu ditinjau.');
  }
  let keyRole;
  try { keyRole = JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString()).role; } catch { /* Publishable keys are not JWTs. */ }
  if (key.startsWith('sb_secret_') || keyRole === 'service_role') throw new BuyerError(503, 'Gunakan publishable/anon key untuk integrasi pembeli.');
  let app, supabase;
  try { app = new URL(origin); supabase = new URL(url); } catch { throw new BuyerError(503, 'Konfigurasi tidak valid.'); }
  const local = process.env.BUYER_LOCAL_HTTP === '1' && app.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(app.hostname);
  if ((!local && app.protocol !== 'https:') || supabase.protocol !== 'https:' || app.origin !== origin || supabase.username || supabase.password) {
    throw new BuyerError(503, 'Konfigurasi origin tidak aman.');
  }
  return { url: supabase.origin, key, origin, local };
}
export function isAllowedOrigin(originOrReferer, cfg) {
  if (!originOrReferer || typeof originOrReferer !== 'string') return false;
  let parsed;
  try { parsed = new URL(originOrReferer).origin; } catch { parsed = originOrReferer; }
  if (parsed === cfg.origin) return true;
  if (/^https:\/\/rakyat-riview(-[a-z0-9_-]+)?\.vercel\.app$/i.test(parsed)) return true;
  if (cfg.local && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(parsed)) return true;
  return false;
}
export function guard(req, cfg) {
  if (req.method !== 'POST') return;
  const origin = req.headers.origin || req.headers.referer;
  const secSite = req.headers['sec-fetch-site'];
  if (req.headers['x-buyer-request'] !== '1' ||
    !isAllowedOrigin(origin, cfg) ||
    (secSite && !['same-origin', 'same-site'].includes(secSite)) ||
    !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new BuyerError(403, 'Permintaan tidak diizinkan.');
  }
}
function cookieName(kind, cfg) { return `${cfg.local ? '' : '__Host-'}rr_buyer_${kind}`; }
export function token(req, kind, cfg) {
  const parts = (req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${cookieName(kind, cfg)}=`));
  if (parts.length !== 1) return null;
  const value = parts[0].slice(parts[0].indexOf('=') + 1);
  return /^[A-Za-z0-9._~-]{1,8192}$/.test(value) ? value : null;
}
export function cookies(data, cfg) {
  return ['a', 'r'].map(kind => {
    const value = data ? (kind === 'a' ? data.access_token : (data.refresh_token || '')) : '';
    if (data && kind === 'a' && (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(value))) {
      throw new BuyerError(502, 'Respons sesi tidak valid.');
    }
    if (data && kind === 'r' && value && !/^[A-Za-z0-9._~-]{1,8192}$/.test(value)) {
      throw new BuyerError(502, 'Respons sesi tidak valid.');
    }
    const age = !data || (kind === 'r' && !value) ? 0 : kind === 'a' ? Math.min(Math.max(Number(data.expires_in) || 3600, 1), 86400) : 60 * 60 * 24 * 30;
    return `${cookieName(kind, cfg)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${cfg.local ? '' : '; Secure'}`;
  });
}
export async function upstream(cfg, path, { method = 'GET', body, access } = {}) {
  let response;
  try {
    response = await fetch(`${cfg.url}${path}`, { method, headers: { apikey: cfg.key, 'Content-Type': 'application/json', ...(access ? { Authorization: `Bearer ${access}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000) });
  } catch { throw new BuyerError(502, 'Layanan belum dapat dihubungi. Coba lagi.'); }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 429) throw new BuyerError(429, 'Terlalu banyak percobaan. Tunggu sebelum mencoba lagi.');
    if (response.status >= 500 || data?.code === 'PGRST202' || data?.code === '42P01') throw new BuyerError(503, 'Integrasi database pembeli belum siap.');
    const msg = data?.error_description || data?.msg || data?.message || data?.error || 'Permintaan ditolak. Periksa isian atau verifikasi email Anda.';
    if (response.status === 401 || response.status === 403) throw new BuyerError(401, msg);
    throw new BuyerError(400, msg);
  }
  return data;
}
export async function user(req, cfg) {
  const access = token(req, 'a', cfg);
  if (!access) throw new BuyerError(401, 'Silakan masuk ke akun pembeli.');
  const result = await upstream(cfg, '/auth/v1/user', { access });
  if (!result?.id) throw new BuyerError(401, 'Sesi tidak valid.');
  const google = Array.isArray(result.identities) && result.identities.some(identity=>identity.provider==='google');
  const hasPassword = Boolean(result.encrypted_password || (Array.isArray(result.identities) && result.identities.some(identity => identity.provider === 'email')));
  return { access, user: { id: result.id, email: result.email, google, has_password: hasPassword,
    name: typeof result.user_metadata?.full_name==='string'?result.user_metadata.full_name.slice(0,100):null,
    pending_activation: result.user_metadata?.pending_activation || null } };
}
export function reviewUrl(value) {
  try { const u = new URL(value); return typeof value === 'string' && value.length <= 2048 && u.protocol === 'https:' && !u.username && !u.password && !u.port && ['maps.app.goo.gl','www.google.com','google.com','search.google.com'].includes(u.hostname); } catch { return false; }
}
export function cardInput(body, activation = false) {
  if (typeof body.card_code !== 'string' || !/^[a-zA-Z0-9_-]{1,30}$/.test(body.card_code) ||
    typeof body.business_name !== 'string' || !body.business_name.trim() || body.business_name.trim().length > 150 || !reviewUrl(body.review_url)) {
    throw new BuyerError(400, 'Isian kartu tidak valid.');
  }
  return { p_card_code: body.card_code, p_business_name: body.business_name.trim(), p_review_url: body.review_url };
}
