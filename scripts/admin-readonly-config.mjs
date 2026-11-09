// Local server configuration only. No network, SQL or implicit .env loading.
import fs from 'node:fs';
const keys=['ADMIN_V2_READONLY_LOCAL','ADMIN_V2_READ_ORIGIN','ADMIN_V2_READ_CONTRACT_READY','SUPABASE_URL','SUPABASE_SECRET_KEY','ADMIN_PASSWORD','ADMIN_SESSION_SECRET','CARD_PUBLIC_ORIGIN'];
export function readAdminEnv(file){
 const out={};if(!fs.existsSync(file))return out;
 for(const line of fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/)){
  if(!line.trim()||line.trim().startsWith('#'))continue;
  const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(!m)throw Error('Format konfigurasi Admin tidak valid.');
  if(!keys.includes(m[1]))continue;
  if(Object.hasOwn(out,m[1]))throw Error('Variabel konfigurasi Admin duplikat.');
  let v=m[2];if(v.startsWith('"')||v.startsWith("'")){if(v.at(-1)!==v[0]||v.length<2)throw Error('Format konfigurasi Admin tidak valid.');v=v.slice(1,-1);}
  out[m[1]]=v;
 }return out;
}
export function adminConfigStatus(env){
 const missing=['SUPABASE_SECRET_KEY','ADMIN_PASSWORD','ADMIN_SESSION_SECRET'].filter(k=>!env[k]);
 const invalid=[];
 if(env.NODE_ENV==='production'||env.VERCEL)invalid.push('LOCAL_RUNTIME');
 if(env.SUPABASE_URL!=='https://svuagnobufhfpgzmsyxx.supabase.co')invalid.push('SUPABASE_URL');
 try{const u=new URL(env.ADMIN_V2_READ_ORIGIN);if(u.protocol!=='http:'||!['127.0.0.1','localhost'].includes(u.hostname)||u.origin!==env.ADMIN_V2_READ_ORIGIN||!u.port)throw Error();}catch{invalid.push('ADMIN_V2_READ_ORIGIN');}
 if(env.ADMIN_V2_READONLY_LOCAL!=='true')invalid.push('ADMIN_V2_READONLY_LOCAL');
 if(env.ADMIN_V2_READ_CONTRACT_READY!=='true')invalid.push('ADMIN_V2_READ_CONTRACT_READY');
 if(env.ADMIN_PASSWORD&&(env.ADMIN_PASSWORD.length<16||/^(demo-admin|test-only-password|password|changeme)$/i.test(env.ADMIN_PASSWORD)))invalid.push('ADMIN_PASSWORD');
 if(env.ADMIN_SESSION_SECRET&&(Buffer.byteLength(env.ADMIN_SESSION_SECRET)<32||/^(demo|test|example|changeme)/i.test(env.ADMIN_SESSION_SECRET)))invalid.push('ADMIN_SESSION_SECRET');
 if(env.SUPABASE_SECRET_KEY){
  const k=env.SUPABASE_SECRET_KEY;let valid=/^sb_secret_[A-Za-z0-9_-]+$/.test(k);
  if(!valid){try{const p=JSON.parse(Buffer.from(k.split('.')[1]||'','base64url'));valid=k.split('.').length===3&&p.role==='service_role'&&(!p.ref||p.ref==='svuagnobufhfpgzmsyxx');}catch{}}
  if(!valid)invalid.push('SUPABASE_SECRET_KEY');
 }
 return {ready:!missing.length&&!invalid.length,missing,invalid};
}
export function applyAdminReadConfig(env){
 const status=adminConfigStatus(env);if(!status.ready)throw Error('Konfigurasi Admin belum siap: '+[...new Set([...status.missing,...status.invalid])].join(', '));
 for(const k of keys){if(env[k]!==undefined)process.env[k]=env[k];else delete process.env[k];}
 Object.assign(process.env,{ADMIN_V2_RESET_ENABLED:'false',ADMIN_V2_CREATION_ENABLED:'false',RR_TEST_APP_WRITES:'false'});
 return Number(new URL(env.ADMIN_V2_READ_ORIGIN).port);
}
