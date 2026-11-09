// Local preparation for the installed restricted wrappers. This module never
// opens a run, changes grants, or falls back to the original business RPCs.
import { createHash } from 'node:crypto';
import { BuyerError, config, guard, user, upstream, cardInput } from './buyer-service.mjs';
import { requireAdminRequest, requireAdminSession } from './admin-session.mjs';
import { rpc as adminRpc } from './admin-buyer.mjs';
import { directReview } from '../pembeli/maps.mjs';

const TARGET = 'https://svuagnobufhfpgzmsyxx.supabase.co';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARD = /^[A-Za-z0-9_-]{24}$/;
const unavailableStatistics = () => ({
  available: false, synthetic: false, visits: null, redirects: null, series: [],
  message: 'Statistik scan belum tersedia melalui akses pengujian terbatas. Scan bukan jumlah review Google.'
});

function headers(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function restrictedConfig(req, write = false) {
  if (process.env.BUYER_RESTRICTED_APP !== 'true' || !UUID.test(process.env.RR_TEST_RUN_ID || '') ||
      /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(process.env.RR_TEST_RUN_ID || '')) {
    throw new BuyerError(503, 'Akses pengujian terbatas belum dikonfigurasi. Akses V2 tetap tertutup.');
  }
  const cfg = config();
  // Configuration alone cannot authorize a user: the database registry remains
  // authoritative for run, user, card, operation, expiry and ownership.
  let raw;
  try { raw = new URL(process.env.SUPABASE_URL); } catch { throw new BuyerError(503, 'Target pengujian tidak valid.'); }
  if (!cfg.local || cfg.url !== TARGET || raw.pathname !== '/' || raw.search || raw.hash || raw.port ||
      (req.headers.host && req.headers.host !== new URL(cfg.origin).host)) {
    throw new BuyerError(503, 'Adapter restricted hanya tersedia pada preview loopback dengan target yang disetujui.');
  }
  if (write && process.env.RR_TEST_APP_WRITES !== 'true') {
    throw new BuyerError(503, 'Operasi tulis pengujian belum diaktifkan. Tidak ada perubahan kartu yang dijalankan.');
  }
  return { ...cfg, run: process.env.RR_TEST_RUN_ID };
}

async function googleSession(req, cfg) {
  const session = await user(req, cfg); // Supabase Auth validates the real access cookie.
  if (!session.user.google) throw new BuyerError(403, 'Gunakan akun Google penguji yang terdaftar.');
  return session;
}

async function buyerRpc(cfg, session, operation, values = {}) {
  const result = await upstream(cfg, '/rest/v1/rpc/buyer_test_action', {
    method: 'POST', access: session.access,
    body: { p_run: cfg.run, p_op: operation, ...values }
  });
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new BuyerError(502, 'Respons pengujian tidak valid.');
  if (result.code === 'test_denied') throw new BuyerError(403, 'Run belum dibuka, sudah berakhir, atau akun/kartu tidak terdaftar untuk pengujian.');
  if (result.code === 'rate_limited') throw new BuyerError(429, 'Terlalu banyak percobaan klaim. Tunggu 15 menit lalu coba lagi.');
  if (result.code === 'not_ready') throw new BuyerError(409, 'Kartu pengujian belum siap diklaim.');
  return result;
}

function codeFrom(req) {
  const value = req.query?.card ?? req.query?.card_code ?? req.body?.card_code;
  if (typeof value !== 'string' || !CARD.test(value)) throw new BuyerError(400, 'Identitas kartu V2 tidak valid.');
  return value;
}

function editInput(body) {
  // PIN and legacy activation are intentionally absent from this interface.
  if (Object.hasOwn(body, 'pin') || Object.hasOwn(body, 'activation_code')) throw new BuyerError(400, 'Alur V2 tidak menggunakan PIN atau kode aktivasi.');
  const input = cardInput(body);
  if (!CARD.test(body.card_code) || directReview(body.review_url) !== body.review_url) {
    throw new BuyerError(400, 'Identitas kartu atau link Google Review langsung belum valid.');
  }
  return input;
}

function failure(res, error) {
  if (error instanceof BuyerError && error.status === 429) res.setHeader('Retry-After', '900');
  return res.status(error instanceof BuyerError ? error.status : 503).json({
    error: error instanceof BuyerError ? error.message : 'Layanan pengujian belum dapat dihubungi. Tidak ada hasil simulasi yang digunakan.'
  });
}

export default async function restrictedBuyer(req, res) {
  headers(res);
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Metode tidak diizinkan.' });
  const action = req.method === 'GET' ? req.query?.action : req.body?.action;
  const isRead = req.method === 'GET' && ['cards', 'status', 'stats', 'statistics'].includes(action);
  const isWrite = req.method === 'POST' && ['first-claim', 'update'].includes(action);
  if (!isRead && !isWrite) return res.status(400).json({ error: 'Aksi tidak tersedia melalui adapter restricted.' });
  try {
    const cfg = restrictedConfig(req, isWrite);
    guard(req, cfg);
    const session = await googleSession(req, cfg);
    if (action === 'stats' || action === 'statistics') return res.status(200).json({ statistics: unavailableStatistics(), mode: 'restricted' });
    if (action === 'cards') {
      const result = await buyerRpc(cfg, session, 'list');
      if (result.success !== true || !Array.isArray(result.cards)) throw new BuyerError(502, 'Respons daftar kartu pengujian tidak valid.');
      return res.status(200).json({ cards: result.cards, statistics: unavailableStatistics(), mode: 'restricted' });
    }
    if (action === 'status') {
      const result = await buyerRpc(cfg, session, 'status', { p_card_code: codeFrom(req) });
      if (result.success !== true) throw new BuyerError(403, 'Status kartu pengujian ditolak.');
      if (!result.status || typeof result.status !== 'object' || Array.isArray(result.status)) throw new BuyerError(404, 'Kartu pengujian tidak ditemukan.');
      return res.status(200).json(result.status);
    }
    const values = editInput(req.body || {});
    const result = await buyerRpc(cfg, session, action === 'first-claim' ? 'claim' : 'update', values);
    if (result.success !== true) throw new BuyerError(409, 'Kartu tidak dapat diproses. Muat ulang status kartu dan periksa kepemilikan Anda.');
    return res.status(200).json({ success: true, card_code: values.p_card_code });
  } catch (error) { return failure(res, error); }
}

export async function restrictedStatus(req, res) {
  if (req.method !== 'GET') { headers(res); return res.status(405).json({ error: 'Metode tidak diizinkan.' }); }
  return restrictedBuyer({ ...req, query: { ...req.query, action: 'status' } }, res);
}

export async function restrictedAdminReset(req, res) {
  headers(res);
  if(process.env.ADMIN_V2_READONLY_LOCAL==='true')return res.status(405).json({error:'Reset Admin tidak tersedia pada mode read-only.'});
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metode tidak diizinkan.' });
  try {
    const cfg = restrictedConfig(req, true);
    if (!requireAdminRequest(req, res) || !requireAdminSession(req, res)) return;
    if (req.headers.origin !== cfg.origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new BuyerError(403, 'Permintaan tidak diizinkan.');
    if (process.env.ADMIN_V2_RESET_ENABLED !== 'true') throw new BuyerError(503, 'Reset aktivasi pengujian belum diaktifkan.');
    const { card_code, confirmation, expected_revision, reason, acknowledged } = req.body || {};
    if (typeof card_code !== 'string' || !CARD.test(card_code) || confirmation !== card_code || acknowledged !== true ||
        !Number.isSafeInteger(expected_revision) || expected_revision < 0 || typeof reason !== 'string' || reason.trim().length < 20 || reason.trim().length > 1000) {
      throw new BuyerError(400, 'Konfirmasikan ID kartu, dampak reset, revision, dan alasan minimal 20 karakter.');
    }
    const actor = 'admin-session:' + createHash('sha256').update(req.headers.cookie || '').digest('hex').slice(0, 24);
    const result = await adminRpc('admin_test_reset', {
      p_run: cfg.run, p_card_code: card_code, p_confirmation: confirmation,
      p_expected_revision: expected_revision, p_actor: actor, p_reason: reason.trim()
    });
    if (result !== true) throw new BuyerError(409, 'Reset ditolak: registry, expiry, kepemilikan, atau revision kartu tidak sesuai.');
    return res.status(200).json({ success: true });
  } catch (error) { return failure(res, error); }
}

export function restrictedAdminUnsupported(req, res) {
  headers(res);
  return res.status(503).json({ error: 'Operasi daftar, pembuatan, dan statistik Admin tidak tersedia melalui wrapper restricted yang terpasang.', mode: 'restricted' });
}
