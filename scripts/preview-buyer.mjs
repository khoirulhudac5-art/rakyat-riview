// Static preview restricted to the buyer demo; no API or production connections.
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const files = new Map([
  ['/', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/dashboard.html', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/kartu.html', ['kartu.html', 'text/html; charset=utf-8']],
  ['/assets/buyer.css', ['assets/buyer.css', 'text/css; charset=utf-8']],
  ['/assets/buyer.js', ['assets/buyer.js', 'text/javascript; charset=utf-8']]
]);
const server = http.createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  const file = files.get(new URL(req.url, 'http://localhost').pathname);
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const data = await readFile(new URL(`../${file[0]}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(500); res.end('Preview file unavailable'); }
});
server.on('error', error => { console.error(`Preview gagal: ${error.message}`); process.exitCode = 1; });
server.listen(4173, '127.0.0.1', () => console.log('Dashboard: http://127.0.0.1:4173/dashboard.html\nDetail: http://127.0.0.1:4173/kartu.html?id=demo-101\nCtrl+C untuk berhenti.'));
