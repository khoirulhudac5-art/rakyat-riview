import { config, upstream, BuyerError } from '../lib/buyer-service.mjs';
import {restrictedStatus} from '../lib/restricted-app-adapter.mjs';

const PILOT_CARD = 'iKRb7_7PyK6kg4Ye7EqvOhYu';

export default async function handler(req, res) {
  const code = req.query?.card;
  if (process.env.BUYER_PILOT_ENABLED === 'true' && code === PILOT_CARD) {
    const { createPilotHandlers } = await import('../lib/public-pilot.mjs');
    return createPilotHandlers().status(req, res);
  }
  if (process.env.BUYER_RESTRICTED_APP === 'true') return restrictedStatus(req, res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Metode tidak diizinkan.' });

  try {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,30}$/.test(code)) {
      throw new BuyerError(400, 'Identitas kartu tidak valid.');
    }
    const cfg = config();

    // 1. Try V2 card status RPC
    const status = await upstream(cfg, '/rest/v1/rpc/buyer_v2_public_card_status', {
      method: 'POST',
      body: { p_card_code: code }
    }).catch(() => null);

    if (status && status.code === code) {
      return res.status(200).json(status);
    }

    // 2. Legacy fallback
    if (process.env.BUYER_FIRST_CLAIM_ENABLED === 'true') {
      const legacyStatus = await upstream(cfg, '/rest/v1/rpc/buyer_public_card_status', {
        method: 'POST',
        body: { p_card_code: code }
      }).catch(() => null);
      if (legacyStatus) return res.status(200).json(legacyStatus);
    }

    const rows = await upstream(cfg, '/rest/v1/card_public?card_code=eq.' + encodeURIComponent(code) + '&select=card_code,review_url&limit=1');
    if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ error: 'Kartu tidak ditemukan.' });
    return res.status(200).json({ code, configured: Boolean(rows[0].review_url), activation_state: rows[0].review_url ? 'active' : 'unverified', claim_allowed: false });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e instanceof BuyerError ? e.message : 'Status kartu belum tersedia.' });
  }
}
