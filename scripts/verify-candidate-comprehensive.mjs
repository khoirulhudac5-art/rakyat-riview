import path from 'node:path';
import { spawn } from 'node:child_process';

const candidateOrigin = 'https://rakyat-riview-f65zdoutg-rakprem.vercel.app';
const binary = path.resolve('.local-tools/npm-cache/_npx/69f9afb961c37556/node_modules/vercel/dist/vc.js');
const root = path.resolve('.backups/admin-production-release-2026-11-09T11-36-06-192Z/release');
const scope = 'rakprem';

async function curl(route, flags = ['-s', '-i']) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [binary, 'curl', route, '--deployment', candidateOrigin, '--scope', scope, ...flags], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    child.stdout.on('data', b => out += b);
    child.stderr.on('data', b => err += b);
    child.on('close', code => resolve({ code, out, err }));
  });
}

function parseHttp(out) {
  const parts = out.split(/\r?\n\r?\n/);
  const headerBlock = parts[0] || '';
  const body = parts.slice(1).join('\n\n');
  const statusMatch = headerBlock.match(/HTTP\/[0-9.]+\s+([0-9]{3})/);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  const locationMatch = headerBlock.match(/Location:\s*([^\r\n]+)/i);
  const location = locationMatch ? locationMatch[1].trim() : null;
  return { status, location, body, raw: out };
}

async function main() {
  console.log('Running comprehensive regression probe on candidate:', candidateOrigin);

  const checks = [
    {
      name: '1. Admin V2 HTML Shell',
      route: '/admin-v2.html',
      verify: r => r.status === 200 && r.body.includes('Admin V2') && r.body.includes('/assets/admin-v2.js')
    },
    {
      name: '2. Admin V2 JS Module with Batch Modal & Reissue Separation',
      route: '/assets/admin-v2.js',
      verify: r => r.status === 200 && r.body.includes('batch-dialog') && r.body.includes('reissue-dialog') && r.body.includes('exportPhysicalProductionCsv') && r.body.includes('exportPrivateActivationCsv')
    },
    {
      name: '3. QR Code ISO/IEC 18004 Generator Module',
      route: '/assets/qrcode.mjs',
      verify: r => r.status === 200 && r.body.includes('generateQrPngBlob') && r.body.includes('createQrMatrix')
    },
    {
      name: '4. Zero-Dependency PKZip Exporter Module',
      route: '/assets/zip.mjs',
      verify: r => r.status === 200 && r.body.includes('buildZip') && r.body.includes('crc32')
    },
    {
      name: '5. Buyer Self-Serve Activation Page (Wizard)',
      route: '/pembeli/mulai.html',
      verify: r => r.status === 200 && r.body.includes('id="token"') && r.body.includes('Token Aktivasi Rahasia') && r.body.includes('wizard.mjs')
    },
    {
      name: '6. Buyer Wizard Script with Token & Parameter Normalization',
      route: '/pembeli/wizard.mjs',
      verify: r => r.status === 200 && r.body.includes('searchParams.get(\'kartu\')') && r.body.includes('tokenVal')
    },
    {
      name: '7. Pilot Card NFC/QR 302 Redirect to Google Review',
      route: '/r/iKRb7_7PyK6kg4Ye7EqvOhYu',
      verify: r => r.status === 302 && r.location === 'https://search.google.com/local/writereview?placeid=ChIJd_JEgNDk1y0RAozRzJRqzXE'
    },
    {
      name: '8. Admin V2 Session Guard on Candidate Host (403 Origin Guard, Config Intact)',
      route: '/api/v2-admin?action=session',
      verify: r => {
        let json = {};
        try { json = JSON.parse(r.body.slice(r.body.indexOf('{'))); } catch {}
        return r.status === 403 && json.mode === 'admin_readonly' && json.capabilities?.list === true;
      }
    },
    {
      name: '9. Anonymous Buyer Session API returns 401 Unauthorized',
      route: '/api/buyer?action=session',
      verify: r => r.status === 401 && (r.body.includes('Silakan masuk') || r.body.includes('Unauthorized'))
    },
    {
      name: '10. Legacy Admin V1 HTML Shell intact',
      route: '/admin.html',
      verify: r => r.status === 200 && r.body.includes('<!doctype html>')
    },
    {
      name: '11. Buyer Dashboard intact',
      route: '/dashboard.html',
      verify: r => r.status === 200
    }
  ];

  const results = [];
  for (const c of checks) {
    const raw = await curl(c.route);
    const parsed = parseHttp(raw.out);
    const pass = c.verify(parsed);
    results.push({ name: c.name, route: c.route, status: parsed.status, pass, location: parsed.location });
    console.log(`${pass ? '✔ PASS' : '✖ FAIL'}: ${c.name} (${parsed.status})`);
  }

  const allPass = results.every(r => r.pass);
  console.log('\nFinal Candidate Verification:', allPass ? 'ALL_TESTS_PASSED' : 'SOME_TESTS_FAILED');
}

main().catch(console.error);
