// Real loopback HTTP + Supabase read-only acceptance. No simulated transport or SQL.
import fs from 'node:fs';import path from 'node:path';import {randomBytes} from 'node:crypto';
import {readAdminEnv,adminConfigStatus} from './admin-readonly-config.mjs';
const folder=path.resolve('test-results/admin-readonly-live-http-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(folder,{recursive:false});
const report={status:'RUNNING',realHTTP:true,supabaseTransport:'real',databaseWrites:false,fixtures:false,startedAt:new Date().toISOString(),checks:[]};
function check(name,ok,status){report.checks.push({name,pass:Boolean(ok),...(status===undefined?{}:{status})});if(!ok)throw Error(name);}
try{
 const env={...process.env,...readAdminEnv('.env.admin-readonly')};check('backend environment ready',adminConfigStatus(env).ready);
 const origin=env.ADMIN_V2_READ_ORIGIN;check('requested loopback port 4192',origin==='http://127.0.0.1:4192'||origin==='http://localhost:4192');
 const secrets=[env.SUPABASE_SECRET_KEY,env.ADMIN_PASSWORD,env.ADMIN_SESSION_SECRET];
 async function api(action,{cookie='',body}={}){
  const r=await fetch(origin+'/api/v2-admin?action='+action,{method:body?'POST':'GET',headers:{...(cookie?{cookie}:{}),...(body?{origin,'content-type':'application/json','x-admin-request':'1'}:{})},body:body?JSON.stringify({action,...body}):undefined,redirect:'error',signal:AbortSignal.timeout(45000)});
  const raw=await r.text();check('response excludes backend credentials: '+action,!secrets.some(s=>raw.includes(s)));
  let data;try{data=JSON.parse(raw);}catch{throw Error('HTTP response is not JSON');}return {r,data};
 }
 const page=await fetch(origin+'/admin-v2.html',{signal:AbortSignal.timeout(10000)});check('existing Dashboard UI served',page.status===200,page.status);
 for(const [label,cookie] of [['anon',''],['buyer','rr_buyer_a=not-an-admin-session'],['forged','__Host-rr_admin=invalid']]){
  const {r}=await api('cards',{cookie});check(label+' rejected',r.status===401,r.status);
 }
 const wrong=await api('login',{body:{password:randomBytes(32).toString('hex')}});check('incorrect Admin password rejected',wrong.r.status===401,wrong.r.status);
 const login=await api('login',{body:{password:env.ADMIN_PASSWORD}});check('real configured Admin login',login.r.status===200&&login.data.success===true,login.r.status);
 const setCookie=login.r.headers.get('set-cookie')||'';check('server issues hardened signed cookie',['HttpOnly','Secure','SameSite=Strict'].every(f=>setCookie.includes(f)));
 const cookie=setCookie.split(';')[0];
 const session=await api('session',{cookie});check('Admin session verified on HTTP request',session.r.status===200&&session.data.authenticated===true,session.r.status);
 for(const action of ['cards','audit']){
  const {r,data}=await api(action,{cookie});check('live Supabase HTTP '+action,r.status===200,r.status);
  check('real data source without fixture fallback: '+action,data.data_source==='supabase'&&data.mode==='admin_readonly'&&data.read_only===true);
  const rows=data[action==='cards'?'cards':'events'];check('valid list response: '+action,Array.isArray(rows));
  check('write capabilities closed: '+action,data.capabilities?.create===false&&data.capabilities?.reset===false);
  check('private response not cached: '+action,/no-store/.test(r.headers.get('cache-control')||''));
  report[action==='cards'?'inventoryRows':'auditRows']=rows.length;
 }
 for(const action of ['create','reset','ready','recover']){const {r}=await api(action,{cookie,body:{}});check('mutation blocked locally: '+action,r.status===405,r.status);}
 const logout=await api('logout',{cookie,body:{}});check('Admin logout clears cookie',logout.r.status===200&&/Max-Age=0/.test(logout.r.headers.get('set-cookie')||''),logout.r.status);
 const after=await api('audit');check('audit without Admin session rejected after logout',after.r.status===401,after.r.status);
 report.status='LIVE_ADMIN_HTTP_PASS';
}catch(e){report.status='STOPPED';report.reason=report.checks.at(-1)?.pass===false?report.checks.at(-1).name:'HTTP connection/response failed; sensitive details suppressed';process.exitCode=1;}
report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(folder,'RESULT.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({status:report.status,checks:report.checks.length,inventoryRows:report.inventoryRows,auditRows:report.auditRows,reason:report.reason,folder}));
