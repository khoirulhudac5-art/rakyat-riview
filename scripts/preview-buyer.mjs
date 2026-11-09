// Legacy preview entry. Buyer pages share the tested OAuth origin at 4180;
// the legacy activation preview stays static. No database writes or API proxy.
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const files = new Map([
  ['/', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/dashboard.html', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/kartu.html', ['kartu.html', 'text/html; charset=utf-8']],
  ['/aktivasi.html', ['aktivasi.html', 'text/html; charset=utf-8']],
  ['/assets/activation.css', ['assets/activation.css', 'text/css; charset=utf-8']],
  ['/assets/rakyat-review-logo.png', ['assets/rakyat-review-logo.png', 'image/png']],
  ['/assets/buyer.css', ['assets/buyer.css', 'text/css; charset=utf-8']],
  ['/assets/buyer.js', ['assets/buyer.js', 'text/javascript; charset=utf-8']]
]);
const server = http.createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  const url = new URL(req.url, 'http://localhost');
  if(['/', '/dashboard.html', '/kartu.html'].includes(url.pathname)){
    res.writeHead(302,{'Location':'http://127.0.0.1:4180'+(url.pathname==='/'?'/dashboard.html':url.pathname)+url.search,'Cache-Control':'no-store'});res.end();return;
  }
  const file = files.get(url.pathname);
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const data = await readFile(new URL(`../${file[0]}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(500); res.end('Preview file unavailable'); }
});
server.on('error', error => { console.error(`Preview gagal: ${error.message}`); process.exitCode = 1; });
server.listen(4173, '127.0.0.1', () => console.log('Dashboard final: http://127.0.0.1:4173/dashboard.html\nDashboard/detail mengarah ke origin Google Auth lokal 4180.\nPreview visual SIMULASI: http://127.0.0.1:4187/dashboard.html\nAktivasi lama tetap statis: http://127.0.0.1:4173/aktivasi.html\nTidak ada perubahan Supabase. Ctrl+C untuk berhenti.'));
