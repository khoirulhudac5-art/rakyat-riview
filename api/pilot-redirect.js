import crypto from 'node:crypto';
import { createPilotHandlers, serverRedirect } from '../lib/public-pilot.mjs';
import { config, upstream } from '../lib/buyer-service.mjs';

const handlers = createPilotHandlers({ redirectRPC: serverRedirect });
const BOT_REGEX = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegrambot|twitterbot|pinterest|slackbot|discordbot|applebot|bingbot|googlebot|yandex|duckduckbot|baiduspider|headless|phantom|preview|curl|wget|python|postman/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  if (process.env.BUYER_PILOT_ENABLED !== 'true') return res.status(503).json({ error: 'Pilot belum dibuka.' });

  // Record pilot scan asynchronously
  try {
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    if (serviceKey) {
      const forwarded = req.headers['x-forwarded-for'];
      const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0] : req.socket?.remoteAddress || '').trim();
      const ua = req.headers['user-agent'] || '';
      const isBot = BOT_REGEX.test(ua);
      const visitorHash = crypto.createHash('sha256').update(`${ip}|${ua}|${serviceKey}`).digest('hex');
      const cfg = config();
      const result = await upstream({ ...cfg, key: serviceKey }, '/rest/v1/rpc/resolve_and_record_card_scan', {
        method: 'POST',
        access: serviceKey,
        body: { p_card_code: 'iKRb7_7PyK6kg4Ye7EqvOhYu', p_visitor_hash: visitorHash, p_is_bot: isBot }
      });
      if (result?.status === 'active' && typeof result.review_url === 'string' && result.review_url.startsWith('https://')) {
        res.setHeader('Location', result.review_url);
        return res.status(302).end();
      }
    }
  } catch {}

  return handlers.redirect(req, res);
}
