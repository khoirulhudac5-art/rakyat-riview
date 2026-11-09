// Local synthetic visibility regression only. No .env, backup data or network credentials.
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {randomBytes} from 'node:crypto';
import {readSnapshot,checkRoleViews,setReadRole} from './admin-readonly-postflight.mjs';
const folder=path.resolve('.backups/admin-postflight-local-'+new Date().toISOString().replace(/[:.]/g,'-')),data=path.join(folder,'data'),bin=path.resolve('.backups/tooling/pgsql/bin');
fs.mkdirSync(folder,{recursive:false});const env={};for(const k of ['SystemRoot','WINDIR','PATH','TEMP','TMP','APPDATA','USERPROFILE','COMSPEC','PATHEXT'])if(process.env[k])env[k]=process.env[k];
Object.assign(env,{PGHOST:'127.0.0.1',PGPORT:'55485',PGUSER:'postgres',PGDATABASE:'postgres',PGPASSWORD:randomBytes(24).toString('hex'),PGSSLMODE:'disable',PGCONNECT_TIMEOUT:'5'});
const config={executable:path.join(bin,'psql.exe'),env};let started=false;
const report={productionConnected:false,status:'RUNNING',checks:[]};
function tool(name,args){return new Promise((resolve,reject)=>{const c=spawn(path.join(bin,name+'.exe'),args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.on('error',()=>reject(Error('Local tool failed')));c.on(name==='pg_ctl'?'exit':'close',code=>{if(name==='pg_ctl'){c.stdout.destroy();c.stderr.destroy();}if(code===0)resolve(out.trim());else reject(Error('Local synthetic SQL failed: '+err));});});}
const sql=q=>tool('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-c',q]);
const check=(name,pass)=>{report.checks.push({name,pass:Boolean(pass)});if(!pass)throw Error(name);};
try{
 const pw=path.join(folder,'pw');fs.writeFileSync(pw,env.PGPASSWORD);try{await tool('initdb',['-D',data,'--username=postgres','--pwfile='+pw,'--auth-host=scram-sha-256','--auth-local=scram-sha-256','--encoding=UTF8','--locale=C']);}finally{fs.unlinkSync(pw);}
 fs.appendFileSync(path.join(data,'postgresql.conf'),"\nlisten_addresses='127.0.0.1'\nport=55485\nlog_statement='none'\nlog_min_error_statement=panic\n");
 await tool('pg_ctl',['-D',data,'-l',path.join(folder,'server.log'),'-w','start']);started=true;
 await sql(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
 CREATE TABLE public.card(card_code text PRIMARY KEY,business_name text,review_url text,claim_mode text,v2_activated_at timestamptz);
 ALTER TABLE public.card ENABLE ROW LEVEL SECURITY;
 CREATE POLICY public_card_read ON public.card FOR SELECT TO anon USING(claim_mode='legacy' OR (claim_mode='google_first_claim' AND v2_activated_at IS NOT NULL));
 CREATE VIEW public.card_public WITH(security_invoker=true) AS SELECT card_code,business_name,review_url FROM public.card;
 GRANT SELECT ON public.card_public TO anon,authenticated,service_role;GRANT SELECT(card_code,business_name,review_url) ON public.card TO anon,authenticated,service_role;
 INSERT INTO public.card VALUES('L','Synthetic legacy',NULL,'legacy',NULL),('N','Synthetic hidden',NULL,'google_first_claim',NULL),('A','Synthetic active',NULL,'google_first_claim',now());`);
 const result=await readSnapshot(config,checkRoleViews);
 check('different Admin/anon digests are valid when inactive V2 is hidden',result.adminAndAnonMayDiffer&&result.anonMatchesApprovedPolicy);
 check('authenticated default-deny and server view evaluated independently',result.authenticatedMatchesDefaultDeny&&result.serviceMatchesServerProjection);
 check('same-snapshot explicit READ ONLY checks remain active',result.readOnly&&result.repeatableRead);
 let denied=false;try{await readSnapshot(config,s=>setReadRole(s,'postgres; RESET ROLE'));}catch{denied=true;}check('inspection role interpolation cannot inject SQL',denied);
 await sql('TRUNCATE public.card');const empty=await readSnapshot(config,checkRoleViews);check('empty views accepted without requiring digests to differ',!empty.adminAndAnonMayDiffer&&empty.anonMatchesApprovedPolicy);
 await sql('ALTER POLICY public_card_read ON public.card USING(true)');denied=false;try{await readSnapshot(config,checkRoleViews);}catch(e){denied=/policy differs/.test(e.message);}check('policy drift rejected instead of rebaselined',denied);
 report.status='LOCAL_POSTFLIGHT_PASS';
}catch(e){report.status='FAILED';report.reason=e.message;process.exitCode=1;}
finally{if(started){await tool('pg_ctl',['-D',data,'-w','-m','fast','stop']);report.localServerStopped=true;}fs.writeFileSync(path.join(folder,'RESULT.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:report.checks.length,folder,productionConnected:false,reason:report.reason}));}
