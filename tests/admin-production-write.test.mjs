import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createProductionAdmin } from '../lib/admin-production.mjs';

const secret = () => randomBytes(40).toString('hex');
const origin = 'https://rakyat-riview.vercel.app';

test('Production HTTP Admin with ADMIN_V2_GENERATE_ENABLED supports batch creation & token reissue securely', async t => {
  const saved = { ...process.env };
  let server;
  let rpcCalls = [];

  const env = {
    NODE_ENV: 'production',
    VERCEL: '1',
    ADMIN_V2_PRODUCTION_ENABLED: 'true',
    ADMIN_V2_GENERATE_ENABLED: 'true',
    ADMIN_V2_ORIGIN: origin,
    CARD_PUBLIC_ORIGIN: origin,
    ADMIN_V2_READ_CONTRACT_READY: 'true',
    ADMIN_V2_SESSION_SECRET: secret(),
    ADMIN_PASSWORD: secret(),
    SUPABASE_URL: 'https://svuagnobufhfpgzmsyxx.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_' + secret()
  };
  Object.assign(process.env, env);

  const mockInvokeRpc = async (fnName, args) => {
    rpcCalls.push({ fnName, args });
    if (fnName === 'admin_generate_v2_cards_with_tokens') {
      return {
        success: true,
        batch_id: args.p_request_id,
        cards: args.p_cards.map(c => ({ card_code: c.card_code }))
      };
    }
    if (fnName === 'admin_reissue_v2_activation_token') {
      if (args.p_card_code === 'nonexistent_card_code___') return false;
      return true;
    }
    throw Error('Unexpected RPC: ' + fnName);
  };

  const handler = createProductionAdmin({
    readPage: async () => ({ cards: [], next_cursor: null }),
    invokeRpc: mockInvokeRpc
  });

  server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    req.body = raw ? JSON.parse(raw) : {};
    req.query = Object.fromEntries(new URL(req.url, 'http://local').searchParams);
    const output = {
      setHeader: (...args) => res.setHeader(...args),
      status(n) { this.code = n; return this; },
      json(v) {
        res.writeHead(this.code || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(v));
      }
    };
    await handler(req, output);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = 'http://127.0.0.1:' + server.address().port;

  const request = (action, { cookie = '', body, headers = {}, method } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(local + '/?action=' + action, {
        method: method || (body === undefined ? 'GET' : 'POST'),
        headers: {
          host: new URL(origin).host,
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-admin-request': '1' }),
          ...headers
        }
      }, res => {
        let text = '';
        res.on('data', chunk => text += chunk);
        res.on('end', () => resolve(new Response(text, { status: res.statusCode, headers: res.headers })));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify({ action, ...body }));
    });

  try {
    // 1. Authenticate admin
    const loginRes = await request('login', { body: { password: env.ADMIN_PASSWORD } });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];

    // 2. Session check returns write capabilities
    await t.test('session check reports write-enabled capabilities when ADMIN_V2_GENERATE_ENABLED=true', async () => {
      const res = await request('session', { cookie });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.authenticated, true);
      assert.equal(data.mode, 'admin_production');
      assert.equal(data.read_only, false);
      assert.equal(data.capabilities.create, true);
      assert.equal(data.capabilities.reissue, true);
      assert.equal(data.capabilities.idempotent_create, true);
    });

    // 3. Generate single card (quantity = 1)
    await t.test('generate 1 card generates valid permanent URL and secret token', async () => {
      rpcCalls = [];
      const reqId = randomUUID();
      const res = await request('create', { cookie, body: { quantity: 1, request_id: reqId } });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.batch_id, reqId);
      assert.equal(data.cards.length, 1);

      const card = data.cards[0];
      assert.match(card.card_code, /^[A-Za-z0-9_-]{24}$/);
      assert.equal(card.card_url, `${origin}/r/${card.card_code}`);
      assert.equal(card.qr_url, card.card_url);
      assert.equal(card.nfc_url, card.card_url);
      assert.match(card.activation_token, /^[A-Za-z0-9_-]{32}$/);
      assert.equal(card.activation_url, `${origin}/pembeli/mulai.html?card=${encodeURIComponent(card.card_code)}&token=${encodeURIComponent(card.activation_token)}`);

      // Verify RPC call
      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fnName, 'admin_generate_v2_cards_with_tokens');
      assert.equal(rpcCalls[0].args.p_quantity, 1);
      assert.equal(rpcCalls[0].args.p_cards.length, 1);
      assert.equal(rpcCalls[0].args.p_cards[0].card_code, card.card_code);
      const expectedHash = createHash('sha256').update(card.activation_token).digest('hex');
      assert.equal(rpcCalls[0].args.p_cards[0].token_hash, expectedHash);
    });

    // 4. Generate batch cards for quantities 10, 50, 100
    for (const qty of [10, 50, 100]) {
      await t.test(`generate batch of ${qty} cards produces unique codes and tokens`, async () => {
        rpcCalls = [];
        const reqId = randomUUID();
        const res = await request('create', { cookie, body: { quantity: qty, request_id: reqId } });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.cards.length, qty);

        const codes = new Set(data.cards.map(c => c.card_code));
        const tokens = new Set(data.cards.map(c => c.activation_token));
        assert.equal(codes.size, qty);
        assert.equal(tokens.size, qty);

        // Verify all have identical QR/NFC URLs matching /r/<card_code>
        for (const card of data.cards) {
          assert.equal(card.card_url, `${origin}/r/${card.card_code}`);
          assert.equal(card.qr_url, card.card_url);
          assert.equal(card.nfc_url, card.card_url);
          assert.ok(card.activation_url.includes(card.activation_token));
          assert.ok(!card.card_url.includes(card.activation_token));
        }
      });
    }

    // 5. Invalid quantity rejection
    await t.test('invalid quantities (0, 5, 25, 200, -1, non-uuid) rejected with HTTP 400', async () => {
      for (const invalidQty of [0, 5, 25, 200, -1, '10']) {
        const res = await request('create', { cookie, body: { quantity: invalidQty, request_id: randomUUID() } });
        assert.equal(res.status, 400);
      }
      const resBadId = await request('create', { cookie, body: { quantity: 1, request_id: 'not-a-uuid' } });
      assert.equal(resBadId.status, 400);
    });

    // 6. Token reissue
    await t.test('reissue token generates new secret token and updates activation link', async () => {
      rpcCalls = [];
      const testCode = randomBytes(18).toString('base64url');
      const res = await request('reissue-token', { cookie, body: { card_code: testCode } });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.card_code, testCode);
      assert.match(data.activation_token, /^[A-Za-z0-9_-]{32}$/);
      assert.equal(data.activation_url, `${origin}/pembeli/mulai.html?card=${encodeURIComponent(testCode)}&token=${encodeURIComponent(data.activation_token)}`);

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fnName, 'admin_reissue_v2_activation_token');
      assert.equal(rpcCalls[0].args.p_card_code, testCode);
      const expectedHash = createHash('sha256').update(data.activation_token).digest('hex');
      assert.equal(rpcCalls[0].args.p_new_token_hash, expectedHash);
    });

    // 7. Token reissue failure (card already claimed or not found)
    await t.test('reissue token returns HTTP 409 when RPC returns false', async () => {
      const res = await request('reissue-token', { cookie, body: { card_code: 'nonexistent_card_code___' } });
      assert.equal(res.status, 409);
    });

    // 8. Security guards: anon & CSRF
    await t.test('anonymous or forged requests to create/reissue rejected', async () => {
      const resAnon = await request('create', { body: { quantity: 1, request_id: randomUUID() } });
      assert.equal(resAnon.status, 401);

      const resBadOrigin = await request('create', {
        cookie,
        body: { quantity: 1, request_id: randomUUID() },
        headers: { origin: 'https://evil.example' }
      });
      assert.equal(resBadOrigin.status, 403);

      const resNoCsrf = await request('create', {
        cookie,
        body: { quantity: 1, request_id: randomUUID() },
        headers: { 'x-admin-request': '' }
      });
      assert.equal(resNoCsrf.status, 403);
    });

    // 9. Reset and destructive mutations remain closed
    await t.test('reset and unsupported mutations remain HTTP 405', async () => {
      const res = await request('reset', { cookie, body: {} });
      assert.equal(res.status, 405);
    });

  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  }
});
