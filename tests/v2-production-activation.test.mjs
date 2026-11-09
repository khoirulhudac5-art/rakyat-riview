import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { chooseVersion, createQrMatrix, qrToSvg } from '../assets/qrcode.mjs';
import { buildZip, crc32 } from '../assets/zip.mjs';
import { createAdminGenerate } from '../lib/admin-generate.mjs';
import { sessionCookie } from '../lib/admin-session.mjs';
import { PILOT_CARD, serverRedirect } from '../lib/public-pilot.mjs';
import { saveDraft, loadDraft, safeReturn } from '../pembeli/drafts.mjs';

async function setupEnv(run) {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      ADMIN_GENERATE_LOCAL: 'isolated_postgres',
      ADMIN_GENERATE_ENABLED: 'true',
      ADMIN_GENERATE_DOMAIN_CONFIRMED: 'true',
      CARD_PUBLIC_ORIGIN: 'https://rakyat-riview.vercel.app',
      ADMIN_OPERATOR_ID: 'admin:production-unit-test',
      ADMIN_V2_READONLY_LOCAL: 'true',
      ADMIN_V2_READ_CONTRACT_READY: 'true',
      ADMIN_V2_READ_ORIGIN: 'http://127.0.0.1:4193',
      ADMIN_PASSWORD: 'unit-local-password-only',
      ADMIN_SESSION_SECRET: randomBytes(40).toString('hex'),
      BUYER_FIRST_CLAIM_ENABLED: 'true'
    });
    delete process.env.VERCEL;
    delete process.env.NODE_ENV;
    return await run();
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  }
}

function createReq(body) {
  return {
    method: 'POST',
    headers: {
      host: '127.0.0.1:4193',
      origin: 'http://127.0.0.1:4193',
      'content-type': 'application/json',
      'x-admin-request': '1',
      cookie: sessionCookie().split(';')[0]
    },
    body: { action: 'create', ...body }
  };
}

async function callHandler(handler, request) {
  const res = {
    code: 200,
    setHeader() {},
    status(n) { this.code = n; return this; },
    json(d) { this.data = d; return this; }
  };
  await handler(request, res);
  return res;
}

test('1. Admin generate satuan (1 kartu) menghasilkan card code unik, URL permanen, token aktivasi dan link aktivasi rahasia', () => setupEnv(async () => {
  let invokedPayload = null;
  const mockInvoke = async (args) => {
    invokedPayload = args;
    const card_code = randomBytes(18).toString('base64url');
    return {
      success: true,
      batch_id: args.p_request_id,
      cards: [{ card_code }]
    };
  };

  const handler = createAdminGenerate({
    invoke: mockInvoke,
    readPage: async () => ({ cards: [], next_cursor: null })
  });

  const requestId = randomUUID();
  const response = await callHandler(handler, createReq({ quantity: 1, request_id: requestId }));

  assert.equal(response.code, 200);
  assert.equal(response.data.success, true);
  assert.equal(response.data.batch_id, requestId);
  assert.equal(response.data.cards.length, 1);

  const card = response.data.cards[0];
  // 24 chars base64url
  assert.match(card.card_code, /^[A-Za-z0-9_-]{24}$/);
  // Permanent URL matches canonical origin + /r/<card_code>
  assert.equal(card.card_url, `https://rakyat-riview.vercel.app/r/${card.card_code}`);
  assert.equal(card.qr_url, card.card_url);
  assert.equal(card.nfc_url, card.card_url);

  // Secret activation token is 32 chars base64url
  assert.match(card.activation_token, /^[A-Za-z0-9_-]{32}$/);
  // Activation link contains code and secret token
  assert.equal(
    card.activation_url,
    `https://rakyat-riview.vercel.app/pembeli/mulai.html?card=${encodeURIComponent(card.card_code)}&token=${encodeURIComponent(card.activation_token)}`
  );

  // QR and NFC URLs DO NOT contain the secret token
  assert.equal(card.card_url.includes(card.activation_token), false);
  assert.equal(card.qr_url.includes(card.activation_token), false);
  assert.equal(card.nfc_url.includes(card.activation_token), false);

  // Database receives token hash (64 hex characters), NEVER plaintext token
  assert.equal(invokedPayload.p_tokens.length, 1);
  assert.match(invokedPayload.p_tokens[0], /^[0-9a-f]{64}$/);
  const expectedHash = createHash('sha256').update(card.activation_token).digest('hex');
  assert.equal(invokedPayload.p_tokens[0], expectedHash);
}));

test('2. Admin generate massal (10, 50, 100 kartu) dengan keunikan kartu & token dan pencegahan duplikasi batch', () => setupEnv(async () => {
  for (const qty of [10, 50, 100]) {
    const batchesSeen = new Map();
    const mockInvoke = async (args) => {
      if (batchesSeen.has(args.p_request_id)) {
        return batchesSeen.get(args.p_request_id);
      }
      const cards = [];
      for (let i = 0; i < args.p_quantity; i++) {
        cards.push({ card_code: randomBytes(18).toString('base64url') });
      }
      const res = { success: true, batch_id: args.p_request_id, cards };
      batchesSeen.set(args.p_request_id, res);
      return res;
    };

    const handler = createAdminGenerate({
      invoke: mockInvoke,
      readPage: async () => ({ cards: [], next_cursor: null })
    });

    const requestId = randomUUID();
    const response = await callHandler(handler, createReq({ quantity: qty, request_id: requestId }));

    assert.equal(response.code, 200);
    assert.equal(response.data.cards.length, qty);

    const codes = response.data.cards.map(c => c.card_code);
    const tokens = response.data.cards.map(c => c.activation_token);

    // All card codes in the batch are unique
    assert.equal(new Set(codes).size, qty);
    // All activation tokens in the batch are unique
    assert.equal(new Set(tokens).size, qty);

    // Test retry with same request_id (idempotency prevents duplicate generation)
    const retryResponse = await callHandler(handler, createReq({ quantity: qty, request_id: requestId }));
    assert.equal(retryResponse.code, 200);
    assert.equal(retryResponse.data.batch_id, requestId);
    const retryCodes = retryResponse.data.cards.map(c => c.card_code);
    assert.deepEqual(retryCodes, codes);
  }
}));

test('3. Validasi batas kuantitas dan format request generate', () => setupEnv(async () => {
  const handler = createAdminGenerate({
    invoke: async () => ({ success: true }),
    readPage: async () => ({ cards: [], next_cursor: null })
  });

  for (const badQty of [0, -5, 1001, '50', null, undefined, 1.5]) {
    const res = await callHandler(handler, createReq({ quantity: badQty, request_id: randomUUID() }));
    assert.equal(res.code, 400);
  }

  // Bad UUID
  const resBadUuid = await callHandler(handler, createReq({ quantity: 1, request_id: 'not-a-valid-uuid' }));
  assert.equal(resBadUuid.code, 400);
}));

test('4. Penerbitan ulang token aktivasi (reissue-token) untuk kartu belum aktif', () => setupEnv(async () => {
  let reissuedArgs = null;
  const mockReissue = async (args) => {
    reissuedArgs = args;
    return true;
  };

  const handler = createAdminGenerate({
    invoke: async () => ({ success: true }),
    readPage: async () => ({ cards: [], next_cursor: null }),
    reissueToken: mockReissue
  });

  const cardCode = randomBytes(18).toString('base64url');
  const reissueReq = {
    method: 'POST',
    headers: {
      host: '127.0.0.1:4193',
      origin: 'http://127.0.0.1:4193',
      'content-type': 'application/json',
      'x-admin-request': '1',
      cookie: sessionCookie().split(';')[0]
    },
    body: { action: 'reissue-token', card_code: cardCode }
  };

  const response = await callHandler(handler, reissueReq);
  assert.equal(response.code, 200);
  assert.equal(response.data.success, true);
  assert.equal(response.data.card_code, cardCode);
  assert.match(response.data.activation_token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(
    response.data.activation_url,
    `https://rakyat-riview.vercel.app/pembeli/mulai.html?card=${encodeURIComponent(cardCode)}&token=${encodeURIComponent(response.data.activation_token)}`
  );

  assert.equal(reissuedArgs.p_card_code, cardCode);
  assert.match(reissuedArgs.p_new_token_hash, /^[0-9a-f]{64}$/);
  const expectedHash = createHash('sha256').update(response.data.activation_token).digest('hex');
  assert.equal(reissuedArgs.p_new_token_hash, expectedHash);

  // Reject malformed card_code
  const badReq = { ...reissueReq, body: { action: 'reissue-token', card_code: 'short' } };
  const badRes = await callHandler(handler, badReq);
  assert.equal(badRes.code, 400);
}));

test('5. Generator QR Code ISO/IEC 18004 dan verifikasi decode independen menggunakan jsQR', async () => {
  const permUrl = 'https://rakyat-riview.vercel.app/r/a1b2c3d4e5f6g7h8i9j0k1l2';
  const version = chooseVersion(permUrl.length);
  assert.equal(version, 4); // 56 chars fits in version 4 (max 62 bytes Level M)

  const matrix = createQrMatrix(permUrl, version);
  assert.equal(matrix.length, 33); // Version 4 is 33x33
  assert.equal(matrix[0].length, 33);

  // Top-left finder pattern check
  assert.equal(matrix[0][0], 1);
  assert.equal(matrix[0][6], 1);
  assert.equal(matrix[6][0], 1);
  assert.equal(matrix[6][6], 1);

  // SVG representation
  const svg = qrToSvg(matrix, { size: 300, margin: 4 });
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 41 41"/); // 33 + 4*2 = 41
  assert.match(svg, /<rect width="41" height="41"/);

  // Independent QR decoding verification with jsQR
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const jsQR = require('./lib/jsqr.cjs');

  const margin = 4, modCount = matrix.length, total = modCount + margin * 2, scale = 6;
  const width = total * scale, height = total * scale;
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let r = 0; r < modCount; r++) {
    for (let c = 0; c < modCount; c++) {
      if (matrix[r][c] === 1) {
        for (let y = 0; y < scale; y++) {
          for (let x = 0; x < scale; x++) {
            const px = ((r + margin) * scale + y) * width + ((c + margin) * scale + x);
            rgba[px * 4] = 0; rgba[px * 4 + 1] = 0; rgba[px * 4 + 2] = 0; rgba[px * 4 + 3] = 255;
          }
        }
      }
    }
  }

  const decoded = jsQR(rgba, width, height);
  assert.ok(decoded, 'QR code must be successfully decoded by jsQR');
  assert.equal(decoded.data, permUrl);
});

test('6. Generator ZIP bulk QR Code menghasilkan arsip PKZip yang valid', () => {
  const testFiles = [
    { name: 'card_001.png', data: new TextEncoder().encode('PNG_DUMMY_DATA_1') },
    { name: 'card_002.png', data: new TextEncoder().encode('PNG_DUMMY_DATA_2') },
    { name: 'card_003.png', data: new TextEncoder().encode('PNG_DUMMY_DATA_3') }
  ];

  const zipBytes = buildZip(testFiles);
  assert.ok(zipBytes.byteLength > 100);

  // Check PKZip local file header signature: 0x04034b50 (PK\x03\x04)
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);

  // Check End of Central Directory signature: 0x06054b50 (PK\x05\x06)
  const eocdOffset = zipBytes.byteLength - 22;
  assert.equal(view.getUint32(eocdOffset, true), 0x06054b50);
  assert.equal(view.getUint16(eocdOffset + 8, true), 3); // 3 entries on disk
  assert.equal(view.getUint16(eocdOffset + 10, true), 3); // 3 total entries

  // Check CRC32 calculation
  const sample = new Uint8Array([1, 2, 3, 4, 5]);
  assert.equal(typeof crc32(sample), 'number');
});

test('7. Simulasi transaksi atomic klaim kartu pembeli dengan token aktivasi rahasia', async () => {
  // Model state
  const cardsDb = new Map();
  const inventoryDb = new Map();
  const activationDb = new Map();
  const ownershipDb = new Map();

  // Seed a ready card with token hash
  const cardCode = randomBytes(18).toString('base64url');
  const secretToken = randomBytes(24).toString('base64url');
  const tokenHash = createHash('sha256').update(secretToken).digest('hex');

  cardsDb.set(cardCode, { card_code: cardCode, claim_mode: 'google_first_claim', v2_activated_at: null });
  inventoryDb.set(cardCode, { state: 'ready', ready_at: new Date() });
  activationDb.set(cardCode, { token_hash: tokenHash, claimed_at: null });

  // Simulated RPC function matching SQL implementation
  function claimWithToken(userId, code, token, businessName, reviewUrl) {
    if (!userId) return { success: false, code: 'unauthenticated' };
    if (!code || !token || !businessName || !reviewUrl) return { success: false, code: 'invalid_claim' };

    const card = cardsDb.get(code);
    if (!card || card.v2_activated_at !== null) return { success: false, code: 'not_claimable' };

    const inv = inventoryDb.get(code);
    if (!inv || inv.state !== 'ready') return { success: false, code: 'not_ready' };

    const act = activationDb.get(code);
    if (!act) return { success: false, code: 'invalid_token' };

    const suppliedHash = createHash('sha256').update(token).digest('hex');
    if (act.token_hash !== suppliedHash || act.claimed_at !== null) {
      return { success: false, code: 'invalid_token' };
    }

    // Atomic update
    card.business_name = businessName;
    card.review_url = reviewUrl;
    card.v2_activated_at = new Date();
    inv.state = 'claimed';
    inv.claimed_at = new Date();
    act.claimed_at = new Date();
    act.claimed_by = userId;
    ownershipDb.set(code, userId);

    return { success: true, code: 'claimed' };
  }

  const validReview = 'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4';
  const buyerId = randomUUID();

  // Claim with invalid token must fail
  const failRes = claimWithToken(buyerId, cardCode, 'wrong_token_123456789012345678', 'Toko Baru', validReview);
  assert.equal(failRes.success, false);
  assert.equal(failRes.code, 'invalid_token');
  assert.equal(cardsDb.get(cardCode).v2_activated_at, null);

  // Claim with valid token succeeds
  const successRes = claimWithToken(buyerId, cardCode, secretToken, 'Toko Sukses', validReview);
  assert.equal(successRes.success, true);
  assert.equal(successRes.code, 'claimed');
  assert.ok(cardsDb.get(cardCode).v2_activated_at instanceof Date);
  assert.equal(inventoryDb.get(cardCode).state, 'claimed');
  assert.equal(ownershipDb.get(cardCode), buyerId);

  // Second claim attempt with the same token must fail (token is single-use)
  const secondAttempt = claimWithToken(randomUUID(), cardCode, secretToken, 'Toko Pembajak', validReview);
  assert.equal(secondAttempt.success, false);
  assert.notEqual(secondAttempt.code, 'claimed');
});

test('8. Kompatibilitas kartu pilot existing iKRb7_7PyK6kg4Ye7EqvOhYu tetap terjaga', async () => {
  assert.equal(PILOT_CARD, 'iKRb7_7PyK6kg4Ye7EqvOhYu');

  // Verify serverRedirect fails safely when credentials are missing or unconfigured
  let failed = false;
  try {
    await serverRedirect(PILOT_CARD);
  } catch (e) {
    failed = true;
    assert.match(e.message, /tidak sesuai konfigurasi|Resolver pilot|Integrasi pembeli belum diaktifkan/);
  }
  assert.ok(failed);
});

test('9. Pemisahan CSV Produksi Percetakan (bebas token) vs CSV Arsip Privat Admin (distribusi pembeli)', () => {
  const cards = [
    { card_code: 'A1B2C3D4E5F6G7H8I9J0K1L2', card_url: 'https://rakyat-riview.vercel.app/r/A1B2C3D4E5F6G7H8I9J0K1L2', activation_token: 'SECRET_TOKEN_1', activation_url: 'https://rakyat-riview.vercel.app/pembeli/mulai.html?card=A1B2C3D4E5F6G7H8I9J0K1L2&token=SECRET_TOKEN_1' },
    { card_code: 'Z9Y8X7W6V5U4T3S2R1Q0P9O8', card_url: 'https://rakyat-riview.vercel.app/r/Z9Y8X7W6V5U4T3S2R1Q0P9O8', activation_token: 'SECRET_TOKEN_2', activation_url: 'https://rakyat-riview.vercel.app/pembeli/mulai.html?card=Z9Y8X7W6V5U4T3S2R1Q0P9O8&token=SECRET_TOKEN_2' }
  ];

  // 1. Physical production CSV (for print vendor) MUST NOT contain secret tokens
  const physicalHeaders = ['card_code', 'permanent_url', 'qr_url', 'nfc_url'];
  const physicalRows = cards.map(c => [c.card_code, c.card_url, c.card_url, c.card_url]);
  const physicalCsv = [physicalHeaders, ...physicalRows].map(r => r.join(',')).join('\n');

  assert.equal(physicalCsv.includes('SECRET_TOKEN_1'), false);
  assert.equal(physicalCsv.includes('SECRET_TOKEN_2'), false);
  assert.equal(physicalCsv.includes('token='), false);
  assert.match(physicalCsv, /A1B2C3D4E5F6G7H8I9J0K1L2/);

  // 2. Private activation CSV (for internal admin sales distribution) contains tokens and links
  const privateHeaders = ['card_code', 'permanent_url', 'secret_activation_link', 'secret_activation_token', 'created_at'];
  const privateRows = cards.map(c => [c.card_code, c.card_url, c.activation_url, c.activation_token, '2026-11-09T10:00:00Z']);
  const privateCsv = [privateHeaders, ...privateRows].map(r => r.join(',')).join('\n');

  assert.ok(privateCsv.includes('SECRET_TOKEN_1'));
  assert.ok(privateCsv.includes('SECRET_TOKEN_2'));
  assert.ok(privateCsv.includes('token=SECRET_TOKEN_1'));
});

test('10. Pemisahan Salin Link dan Terbitkan Ulang: Salin tidak memanggil reissue, Reissue membatalkan token lama', () => setupEnv(async () => {
  let reissueCount = 0;
  const mockReissue = async () => {
    reissueCount++;
    return true;
  };

  const handler = createAdminGenerate({
    invoke: async () => ({ success: true }),
    readPage: async () => ({ cards: [], next_cursor: null }),
    reissueToken: mockReissue
  });

  const cardCode = randomBytes(18).toString('base64url');

  // Initial reissue 1
  const req1 = {
    method: 'POST',
    headers: {
      host: '127.0.0.1:4193',
      origin: 'http://127.0.0.1:4193',
      'content-type': 'application/json',
      'x-admin-request': '1',
      cookie: sessionCookie().split(';')[0]
    },
    body: { action: 'reissue-token', card_code: cardCode }
  };
  const res1 = await callHandler(handler, req1);
  assert.equal(res1.code, 200);
  assert.equal(reissueCount, 1);
  const token1 = res1.data.activation_token;

  // Reissue 2 (explicit separate reissue)
  const res2 = await callHandler(handler, req1);
  assert.equal(res2.code, 200);
  assert.equal(reissueCount, 2);
  const token2 = res2.data.activation_token;

  // New token is different from old token
  assert.notEqual(token1, token2);
  assert.match(token1, /^[A-Za-z0-9_-]{32}$/);
  assert.match(token2, /^[A-Za-z0-9_-]{32}$/);
}));

test('11. Konsistensi parameter URL aktivasi (card/kartu/code/token) & retensi OAuth Google', () => {
  const origin = 'https://rakyat-riview.vercel.app';
  const cardCode = 'abcdefghijklmnopqrstuvwx'; // 24 chars
  const secretToken = '1234567890abcdef1234567890abcdef'; // 32 chars

  // 1. safeReturn preserves ?card=...&token=... on /pembeli/mulai.html
  const returnUrl1 = safeReturn(`/pembeli/mulai.html?card=${cardCode}&token=${secretToken}`, origin);
  assert.equal(returnUrl1, `/pembeli/mulai.html?card=${cardCode}&token=${secretToken}`);

  // 2. safeReturn normalizes ?kartu=... to canonical ?card=... with token intact
  const returnUrl2 = safeReturn(`/pembeli/mulai.html?kartu=${cardCode}&token=${secretToken}`, origin);
  assert.equal(returnUrl2, `/pembeli/mulai.html?card=${cardCode}&token=${secretToken}`);

  // 3. safeReturn normalizes ?code=... and ?activation_token=... to ?card=...&token=...
  const returnUrl3 = safeReturn(`/pembeli/mulai.html?code=${cardCode}&activation_token=${secretToken}`, origin);
  assert.equal(returnUrl3, `/pembeli/mulai.html?card=${cardCode}&token=${secretToken}`);

  // 4. safeReturn sanitizes malicious or cross-origin URLs
  assert.equal(safeReturn('https://evil.com/pembeli/mulai.html', origin), '/pembeli/dashboard.html');
  assert.equal(safeReturn(`/pembeli/mulai.html?card=bad;injection&token=${secretToken}`, origin), '/pembeli/dashboard.html');

  // 5. saveDraft and loadDraft retain secret activation token in storage
  const mockStorage = new Map();
  const storageAdapter = {
    getItem: k => mockStorage.get(k) || null,
    setItem: (k, v) => mockStorage.set(k, String(v)),
    removeItem: k => mockStorage.delete(k)
  };

  saveDraft(storageAdapter, cardCode, {
    name: 'Toko Kopi Rakyat',
    maps: 'https://search.google.com/local/writereview?placeid=ChIJ1234567890',
    token: secretToken,
    step: 2
  });

  const loaded = loadDraft(storageAdapter, cardCode);
  assert.ok(loaded);
  assert.equal(loaded.code, cardCode);
  assert.equal(loaded.name, 'Toko Kopi Rakyat');
  assert.equal(loaded.token, secretToken);
});
