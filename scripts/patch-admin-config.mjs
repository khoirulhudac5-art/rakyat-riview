import fs from 'node:fs';

const raw = fs.readFileSync('lib/admin-production.mjs', 'utf8');
const lines = raw.split('\n');

const startIdx = lines.findIndex(l => l.includes('export function getAdminV2Password'));
const endIdx = lines.findIndex(l => l.includes('const sign=payload=>createHmac'));

if (startIdx === -1 || endIdx === -1) {
  console.error('Indices not found:', { startIdx, endIdx });
  process.exit(1);
}

const newLines = [
  'export function getAdminV2Password(env=process.env){',
  ' if(typeof env.ADMIN_V2_PASSWORD===\'string\'&&!!env.ADMIN_V2_PASSWORD)return env.ADMIN_V2_PASSWORD;',
  ' if(typeof env.ADMIN_PASSWORD===\'string\'&&!!env.ADMIN_PASSWORD)return env.ADMIN_PASSWORD;',
  ' return \'\';',
  '}',
  '',
  'export function getAdminV2SigningSecret(env=process.env){',
  ' if(typeof env.ADMIN_V2_SESSION_SECRET===\'string\'&&!!env.ADMIN_V2_SESSION_SECRET)return env.ADMIN_V2_SESSION_SECRET;',
  ' if(typeof env.ADMIN_SESSION_SECRET===\'string\'&&!!env.ADMIN_SESSION_SECRET)return env.ADMIN_SESSION_SECRET;',
  ' return \'\';',
  '}',
  '',
  'export function isAllowedAdminOrigin(value){',
  ' if(!value||typeof value!==\'string\')return false;',
  ' let parsed;',
  ' try{parsed=new URL(value).host;}catch{parsed=value;}',
  ' if(parsed===\'rakyat-riview.vercel.app\')return true;',
  ' if(/^rakyat-riview(-[a-z0-9_-]+)?\\.vercel\\.app$/i.test(parsed))return true;',
  ' if(process.env.ADMIN_V2_READONLY_LOCAL===\'true\'&&([\'localhost\',\'127.0.0.1\'].includes(parsed.split(\':\')[0])||/^http:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?$/i.test(value)))return true;',
  ' return false;',
  '}',
  '',
  'export function adminConfigurationChecks(env=process.env){',
  ' const password=getAdminV2Password(env);',
  ' const sessionSecret=getAdminV2SigningSecret(env);',
  ' return {',
  '  production_enabled:env.ADMIN_V2_PRODUCTION_ENABLED===\'true\'||env.ADMIN_V2_READONLY_PRODUCTION===\'true\',',
  '  origin_matches:isAllowedAdminOrigin(env.ADMIN_V2_ORIGIN),',
  '  read_contract_enabled:env.ADMIN_V2_READ_CONTRACT_READY===\'true\',',
  '  supabase_target_valid:normalizeAdminSupabaseUrl(env.SUPABASE_URL)!==null,',
  '  server_key_present:typeof env.SUPABASE_SECRET_KEY===\'string\'&&!!env.SUPABASE_SECRET_KEY&&!env.SUPABASE_SECRET_KEY.startsWith(\'sb_publishable_\'),',
  '  admin_password_present:!!password,',
  '  admin_password_policy:typeof password===\'string\'&&password.length>=16&&!/^(demo-admin|test-only-password|password|changeme)$/i.test(password),',
  '  signing_secret_present:typeof sessionSecret===\'string\'&&!!sessionSecret,',
  '  signing_secret_policy:typeof sessionSecret===\'string\'&&Buffer.byteLength(sessionSecret)>=32&&!/^(demo|test|example|changeme)/i.test(sessionSecret)',
  ' };',
  '}',
  '',
  'let lastGuardFailure=\'\';',
  'function configuration(){',
  ' const env=process.env,checks=adminConfigurationChecks(env);',
  ' if(!Object.values(checks).every(Boolean)){',
  '  const signature=JSON.stringify(checks);',
  '  if(signature!==lastGuardFailure){console.error(JSON.stringify({event:\'admin_v2_configuration_guard_failed\',category:\'ADMIN_CONFIG_UNAVAILABLE\',checks}));lastGuardFailure=signature;}',
  '  throw fail(503,\'Admin V2 production belum dikonfigurasi. Akses tetap tertutup.\');',
  ' }',
  ' lastGuardFailure=\'\';',
  ' return env;',
  '}',
  '',
  'function validateRequest(req){',
  ' configuration();',
  ' const host=req.headers.host;',
  ' const reqOrigin=req.headers.origin;',
  ' if(!host||!isAllowedAdminOrigin(host)||(reqOrigin&&!isAllowedAdminOrigin(reqOrigin))||(req.headers[\'sec-fetch-site\']&&![\'same-origin\',\'none\'].includes(req.headers[\'sec-fetch-site\'])))throw fail(403,\'Permintaan Admin harus berasal dari website yang sama.\');',
  ' if(![\'GET\',\'POST\'].includes(req.method))throw fail(405,\'Metode tidak diizinkan.\');',
  ' if(req.method===\'POST\'&&((reqOrigin&&!isAllowedAdminOrigin(reqOrigin))||req.headers[\'x-admin-request\']!==\'1\'||!/^application\\/json(?:;|$)/i.test(req.headers[\'content-type\']||\'\')))throw fail(403,\'Permintaan tidak diizinkan.\');',
  ' if(req.method===\'POST\'&&Buffer.byteLength(JSON.stringify(req.body||{}))>4096)throw fail(413,\'Permintaan terlalu besar.\');',
  '}',
  '',
  'const sign=payload=>createHmac(\'sha256\',getAdminV2SigningSecret(configuration())).update(payload).digest(\'base64url\');'
];

lines.splice(startIdx, endIdx - startIdx + 1, ...newLines);

// Also replace in login:
const loginIdx = lines.findIndex(l => l.includes('configuration().ADMIN_V2_SESSION_SECRET'));
if (loginIdx !== -1) {
  lines[loginIdx] = lines[loginIdx].replace('configuration().ADMIN_V2_SESSION_SECRET', 'getAdminV2SigningSecret(configuration())');
}

fs.writeFileSync('lib/admin-production.mjs', lines.join('\n'), 'utf8');
console.log('Successfully patched lib/admin-production.mjs');
