import fs from 'node:fs';

// 1. Patch pembeli/mulai.html
let mulaiHtml = fs.readFileSync('pembeli/mulai.html', 'utf8');

const oldTokenWrap = '<div class="field" id="token-wrap"><label for="token">Token Aktivasi Rahasia</label><input id="token" type="text" autocomplete="off" spellcheck="false" placeholder="Masukkan token aktivasi rahasia"><p class="hint" id="token-hint">Token rahasia disertakan bersama kartu atau link aktivasi khusus kartu.</p></div>';
const newCardField = '<div class="field" id="card-code-field"><label for="card-code-display">Kode Kartu</label><input id="card-code-display" type="text" readonly placeholder="Membaca kode kartu..." style="background:#f1f3f4;font-family:monospace;font-weight:600;letter-spacing:0.05em"></div>';

if (!mulaiHtml.includes(oldTokenWrap)) {
  throw new Error('oldTokenWrap not found in pembeli/mulai.html');
}
mulaiHtml = mulaiHtml.replace(oldTokenWrap, newCardField);
fs.writeFileSync('pembeli/mulai.html', mulaiHtml, 'utf8');
console.log('Successfully patched pembeli/mulai.html');

// 2. Patch pembeli/wizard.mjs
let wizardMjs = fs.readFileSync('pembeli/wizard.mjs', 'utf8');

// Update claim options to conditionally include activation_token only if truthy
const oldClaimOptions = `const options={method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify({action:'first-claim',card_code:code,activation_token:tokenVal,business_name:el('business').value.trim(),review_url:canonical})};`;
const newClaimOptions = `const options={method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Buyer-Request':'1'},body:JSON.stringify({action:'first-claim',card_code:code,...(tokenVal?{activation_token:tokenVal}:{}),business_name:el('business').value.trim(),review_url:canonical})};`;

if (!wizardMjs.includes(oldClaimOptions)) {
  throw new Error('oldClaimOptions not found in pembeli/wizard.mjs');
}
wizardMjs = wizardMjs.replace(oldClaimOptions, newClaimOptions);

// Populate card-code-display
const oldCardLabel = `el('card-label').textContent='KARTU '+status.code;`;
const newCardLabel = `el('card-label').textContent='KARTU '+status.code;if(el('card-code-display'))el('card-code-display').value=status.code||code;`;

if (!wizardMjs.includes(oldCardLabel)) {
  throw new Error('oldCardLabel not found in pembeli/wizard.mjs');
}
wizardMjs = wizardMjs.replace(oldCardLabel, newCardLabel);

fs.writeFileSync('pembeli/wizard.mjs', wizardMjs, 'utf8');
console.log('Successfully patched pembeli/wizard.mjs');
