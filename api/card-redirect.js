import crypto from 'node:crypto';
import { config, upstream } from '../lib/buyer-service.mjs';

const BOT_REGEX = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegrambot|twitterbot|pinterest|slackbot|discordbot|applebot|bingbot|googlebot|yandex|duckduckbot|baiduspider|headless|phantom|preview|curl|wget|python|postman/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const cardCode = (req.query?.code || '').trim();
  if (!cardCode || !/^[A-Za-z0-9_-]{1,30}$/.test(cardCode)) {
    res.setHeader('Location', '/');
    return res.status(302).end();
  }

  try {
    const cfg = config();
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    if (!serviceKey) {
      res.setHeader('Location', `/pembeli/mulai.html?card=${encodeURIComponent(cardCode)}`);
      return res.status(302).end();
    }

    const forwarded = req.headers['x-forwarded-for'];
    const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0] : req.socket?.remoteAddress || '').trim();
    const ua = req.headers['user-agent'] || '';
    const isBot = BOT_REGEX.test(ua);

    // Cryptographic visitor hash server-side
    const visitorHash = crypto.createHash('sha256').update(`${ip}|${ua}|${serviceKey}`).digest('hex');

    const result = await upstream(
      { ...cfg, key: serviceKey },
      '/rest/v1/rpc/resolve_and_record_card_scan',
      {
        method: 'POST',
        access: serviceKey,
        body: {
          p_card_code: cardCode,
          p_visitor_hash: visitorHash,
          p_is_bot: isBot
        }
      }
    );

    if (result?.status === 'active' && typeof result.review_url === 'string' && result.review_url.startsWith('https://')) {
      res.setHeader('Location', result.review_url);
      return res.status(302).end();
    }

    if (result?.status === 'inactive' && typeof result.redirect_url === 'string') {
      res.setHeader('Location', result.redirect_url);
      return res.status(302).end();
    }

    // Default fallback to activation wizard
    res.setHeader('Location', `/pembeli/mulai.html?card=${encodeURIComponent(cardCode)}`);
    return res.status(302).end();
  } catch (err) {
    // Fail-safe fallback to client-side resolver if RPC error
    res.setHeader('Location', `/pembeli/mulai.html?card=${encodeURIComponent(cardCode)}`);
    return res.status(302).end();
  }
}
