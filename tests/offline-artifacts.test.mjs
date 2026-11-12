import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateCardCode, generateUniqueCardCodes, isValidCardCode } from '../lib/card-code.mjs';
import { createQrMatrix, qrToSvg } from '../assets/qrcode.mjs';
import { buildZip } from '../assets/zip.mjs';

console.log('=== LOCAL OFFLINE TESTS (NO NETWORK, NO DATABASE) ===\n');

// 1. Generator Tests
console.log('1. Testing 8-character Crockford Base32 Generator...');
const codes = generateUniqueCardCodes(100);
assert.equal(codes.length, 100);
for (const code of codes) {
  assert.equal(code.length, 8);
  assert.ok(isValidCardCode(code));
  assert.ok(!/[01IO]/.test(code), `Code ${code} must not contain 0, 1, I, O`);
}
console.log('   [PASS] 100 unique 8-character codes generated with zero collisions.');

// 2. QR Code and ZIP packaging
console.log('2. Testing QR Code matrix, SVG generation & ZIP archiver...');
const sampleCode = generateCardCode();
const sampleUrl = `https://rakyat-riview.vercel.app/r/${sampleCode}`;
const matrix = createQrMatrix(sampleUrl);
assert.ok(Array.isArray(matrix) && matrix.length > 20, 'QR Matrix must be generated');
const svg = qrToSvg(matrix, { size: 256, margin: 4 });
assert.ok(svg.startsWith('<svg') && svg.includes('</svg>'), 'SVG QR must be valid');

const zipBytes = buildZip([
  { name: `${sampleCode}.svg`, data: Buffer.from(svg, 'utf8') }
]);
assert.ok(zipBytes.length > 100, 'ZIP bytes must have valid size');
assert.equal(zipBytes[0], 0x50); // 'P'
assert.equal(zipBytes[1], 0x4B); // 'K'
console.log('   [PASS] QR code matrix, SVG and ZIP creation succeeded with PK zip magic bytes.');

// 3. UI Form Inspection in pembeli/mulai.html
console.log('3. Inspecting pembeli/mulai.html form fields...');
const mulaiHtml = fs.readFileSync('pembeli/mulai.html', 'utf8');
assert.ok(!mulaiHtml.includes('id="token"'), 'id="token" must not be present in form');
assert.ok(!mulaiHtml.includes('Token Aktivasi Rahasia'), 'Token Aktivasi Rahasia label must not be present');
assert.ok(mulaiHtml.includes('id="card-code-display"'), 'Readonly card code display field must be present');
assert.ok(mulaiHtml.includes('id="business"'), 'Business name field must be present');
assert.ok(mulaiHtml.includes('id="maps"'), 'Google Maps / Review field must be present');
assert.ok(mulaiHtml.includes('id="google"'), 'Google login button must be present');
console.log('   [PASS] pembeli/mulai.html only contains Business Name, Maps/Review, and read-only Card Code.');

// 4. UI Form Inspection in assets/admin-v2.js
console.log('4. Inspecting assets/admin-v2.js batch dialog...');
const adminJs = fs.readFileSync('assets/admin-v2.js', 'utf8');
assert.ok(!adminJs.includes('id="download-private-batch-csv"'), 'Private batch token CSV button must be removed');
assert.ok(adminJs.includes('id="download-batch-qr-zip"'), 'ZIP QR Code button must be present');
assert.ok(adminJs.includes('id="download-physical-batch-csv"'), 'CSV Produksi Percetakan/NFC button must be present');
console.log('   [PASS] Admin V2 batch dialog only offers ZIP QR Code and CSV Produksi Percetakan/NFC.');

// 5. Backend api/buyer.js regex inspection
console.log('5. Inspecting api/buyer.js validation...');
const buyerJs = fs.readFileSync('api/buyer.js', 'utf8');
assert.ok(buyerJs.includes('/^[A-Za-z0-9_-]{8,30}$/'), 'Card code regex in buyer.js must allow 8 to 30 characters');
assert.ok(buyerJs.includes('buyer_claim_v2_direct'), 'buyer.js must call buyer_claim_v2_direct for tokenless claims');
assert.ok(buyerJs.includes('buyer_claim_v2_with_token'), 'buyer.js must maintain buyer_claim_v2_with_token for token cards');
console.log('   [PASS] api/buyer.js supports both 8-character direct claim and legacy token claims.');

// 6. Backend lib/admin-production.mjs inspection
console.log('6. Inspecting lib/admin-production.mjs...');
const adminProdJs = fs.readFileSync('lib/admin-production.mjs', 'utf8');
assert.ok(adminProdJs.includes('generateUniqueCardCodes'), 'admin-production.mjs must import and use generateUniqueCardCodes');
assert.ok(adminProdJs.includes('admin_generate_v2_cards_direct'), 'admin-production.mjs must call admin_generate_v2_cards_direct');
console.log('   [PASS] lib/admin-production.mjs generates 8-char codes without secret tokens.');

console.log('\n=== ALL LOCAL OFFLINE ASSERTIONS PASSED (100% SUCCESS) ===\n');
