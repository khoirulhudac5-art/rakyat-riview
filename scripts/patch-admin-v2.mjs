import fs from 'node:fs';

let content = fs.readFileSync('assets/admin-v2.js', 'utf8');

// 1. Update batch-dialog in dialogsMarkup
const oldBatchDialog = `<dialog id="batch-dialog" aria-labelledby="batch-title"><div class="dialog-head"><div><h2 id="batch-title">Kartu Baru Berhasil Disimpan</h2><p id="batch-subtitle"></p></div><button class="icon-btn" type="button" data-close="batch-dialog" aria-label="Tutup">\${icon('close')}</button></div><div class="dialog-body"><div class="info-box" style="background:#e8f0fe;border-color:#1a73e8;color:#174ea6;padding:12px;border-radius:8px"><strong>Satu kartu, satu kode pendek, satu URL permanen.</strong><br>Kartu langsung siap diklaim oleh pembeli melalui URL/QR/NFC tanpa memerlukan token aktivasi.</div><div style="display:flex;flex-direction:column;gap:10px;margin-top:16px"><button class="btn primary" id="download-batch-qr-zip">\${icon('download')} Unduh ZIP QR Code (\${icon('card')} PNG per kartu)</button><button class="btn" id="download-physical-batch-csv">\${icon('download')} Unduh CSV Produksi Percetakan & NFC</button></div><p class="help" style="margin-top:12px">CSV Produksi memuat kode kartu dan URL permanen yang sama untuk QR dan NFC.</p></div><div class="dialog-foot"><button class="btn" type="button" data-close="batch-dialog">Selesai</button></div></dialog>`;

const newBatchDialog = `<dialog id="batch-dialog" aria-labelledby="batch-title"><div class="dialog-head"><div><h2 id="batch-title">Kartu Baru Berhasil Disimpan</h2><p id="batch-subtitle"></p></div><button class="icon-btn" type="button" data-close="batch-dialog" aria-label="Tutup">\${icon('close')}</button></div><div class="dialog-body"><div class="info-box" style="background:#e8f0fe;border-color:#1a73e8;color:#174ea6;padding:12px;border-radius:8px"><strong>Satu kartu, satu kode aktivasi, satu URL permanen.</strong><br>Setiap kartu dilengkapi kode aktivasi 6 digit untuk verifikasi pembeli di Tahap 1 aktivasi.</div><div id="batch-card-list" style="margin-top:14px;max-height:220px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;"></div><div style="display:flex;flex-direction:column;gap:10px;margin-top:16px"><button class="btn primary" id="download-batch-qr-zip">\${icon('download')} Unduh ZIP QR Code (\${icon('card')} PNG per kartu)</button><button class="btn" id="download-physical-batch-csv">\${icon('download')} Unduh CSV Produksi Percetakan & Kode Aktivasi</button></div><p class="help" style="margin-top:12px">CSV Produksi memuat kode kartu, kode aktivasi 6 digit, dan URL permanen.</p></div><div class="dialog-foot"><button class="btn" type="button" data-close="batch-dialog">Selesai</button></div></dialog>`;

if (!content.includes(oldBatchDialog)) {
  console.error('oldBatchDialog not found!');
  process.exit(1);
}
content = content.replace(oldBatchDialog, newBatchDialog);

// 2. Update openBatchResult
const oldOpenBatch = `function openBatchResult(cards) {
  if(byId('batch-subtitle'))byId('batch-subtitle').textContent=\`\${number(cards.length)} kartu baru siap diproduksi dan diklaim pembeli.\`;
  if(byId('batch-dialog'))byId('batch-dialog').showModal();
}`;

const newOpenBatch = `function openBatchResult(cards) {
  state.lastGeneratedBatch = cards;
  if(byId('batch-subtitle'))byId('batch-subtitle').textContent=\`\${number(cards.length)} kartu baru siap diproduksi dan diklaim pembeli.\`;
  const listEl = byId('batch-card-list');
  if (listEl) {
    listEl.innerHTML = \`<table style="width:100%;border-collapse:collapse;font-size:13px;text-align:left;">
      <thead>
        <tr style="background:#f8fafc;border-bottom:1px solid #e2e8f0;">
          <th style="padding:8px 12px;">Kode Kartu</th>
          <th style="padding:8px 12px;">Kode Aktivasi</th>
          <th style="padding:8px 12px;">URL Kartu</th>
        </tr>
      </thead>
      <tbody>
        \${cards.map(c => \`
          <tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:8px 12px;font-family:monospace;font-weight:700;">\${escapeHtml(c.card_code)}</td>
            <td style="padding:8px 12px;font-family:monospace;font-weight:700;color:#1a73e8;">\${escapeHtml(c.activation_code || '—')}</td>
            <td style="padding:8px 12px;font-size:12px;color:#64748b;"><a href="\${escapeHtml(c.card_url)}" target="_blank" rel="noopener noreferrer">\${escapeHtml(c.card_url)}</a></td>
          </tr>
        \`).join('')}
      </tbody>
    </table>\`;
  }
  if(byId('batch-dialog'))byId('batch-dialog').showModal();
}`;

if (!content.includes(oldOpenBatch)) {
  console.error('oldOpenBatch not found!');
  process.exit(1);
}
content = content.replace(oldOpenBatch, newOpenBatch);

// 3. Update exportPhysicalProductionCsv
const oldExportProd = `function exportPhysicalProductionCsv(cards) {
  if(!cards||!cards.length){notify('Belum ada kartu untuk diekspor.',true);return;}
  const rows=[['card_code','permanent_url','qr_url','nfc_url'],...cards.map(c=>{const url=c.card_url||permanentUrl(c);return [c.card_code,url,url,url];})];
  const blob=new Blob(['\\uFEFF'+rows.map(row=>row.map(csvValue).join(',')).join('\\r\\n')],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='rakyat-review-PRODUKSI-PERCETAKAN-'+new Date().toISOString().slice(0,10)+'.csv';document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  notify('CSV Produksi Percetakan berhasil diunduh (bebas token/link rahasia).');
}`;

const newExportProd = `function exportPhysicalProductionCsv(cards) {
  if(!cards||!cards.length){notify('Belum ada kartu untuk diekspor.',true);return;}
  const rows=[['card_code','activation_code','permanent_url','qr_url','nfc_url'],...cards.map(c=>{const url=c.card_url||permanentUrl(c);return [c.card_code,c.activation_code||'',url,url,url];})];
  const blob=new Blob(['\\uFEFF'+rows.map(row=>row.map(csvValue).join(',')).join('\\r\\n')],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='rakyat-review-PRODUKSI-PERCETAKAN-'+new Date().toISOString().slice(0,10)+'.csv';document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  notify('CSV Produksi Percetakan (dengan Kode Aktivasi 6 digit) berhasil diunduh.');
}`;

if (!content.includes(oldExportProd)) {
  console.error('oldExportProd not found!');
  process.exit(1);
}
content = content.replace(oldExportProd, newExportProd);

fs.writeFileSync('assets/admin-v2.js', content, 'utf8');
console.log('Successfully patched assets/admin-v2.js');
