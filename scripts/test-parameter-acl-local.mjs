import {testParameterACL} from '../tests/parameter-acl-local.mjs';
import {ReadOnlyPSQL,inspect,assertInspection} from './readonly-psql.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
const root=process.cwd(),bin=path.join(root,'.backups/tooling/pgsql/bin'),backup=path.join(root,'.backups/v1-2026-11-05T17-00-39-619Z');
const base=path.join(root,'.backups','readonly-test-'+new Date().toISOString().replace(/[:.]/g,'-')),data=path.join(base,'pgdata');
const password=crypto.randomBytes(32).toString('hex');const env={};for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP','APPDATA','USERPROFILE','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{PGHOST:'127.0.0.1',PGPORT:'55481',PGUSER:'rr_local_restore',PGPASSWORD:password,PGDATABASE:'postgres',PGCONNECT_TIMEOUT:'5',PGCLIENTENCODING:'UTF8',PGTZ:'UTC'});
let started=false,stage='integrity';const report={target:'isolated local PostgreSQL only',host:'127.0.0.1',port:55481,productionConnected:false,migrationsRun:false,started_at:new Date().toISOString()};
function run(tool,args,allowFailure=false){return new Promise((resolve,reject)=>{const c=spawn(path.join(bin,tool+'.exe'),args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',v=>out+=v);c.stderr.on('data',v=>err+=v);c.on('error',()=>reject({reason:'Local tool failed to start'}));c.on(tool==='pg_ctl'?'exit':'close',code=>{if(tool==='pg_ctl'){c.stdout.destroy();c.stderr.destroy();}const r={code,out,err};if(code===0||allowFailure)resolve(r);else reject({reason:/extension.*(not available|control)|could not open extension control/i.test(err)?'Required extension unavailable':/permission denied/i.test(err)?'Local restore permission error':'Local tool failed',tool,code});});});}
async function sql(query,database='postgres'){const r=await run('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-d',database,'-c',query]);return r.out.trim();}
try{
 fs.mkdirSync(base,{recursive:false});const manifest=JSON.parse(fs.readFileSync(path.join(backup,'manifest.json')));
 for(const f of manifest.files){const bytes=fs.readFileSync(path.join(backup,f.name));if(bytes.length!==f.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==f.sha256)throw{reason:'Backup checksum mismatch'};}report.backupChecksums=true;
 stage='initdb';const pwfile=path.join(base,'local-bootstrap-password');fs.writeFileSync(pwfile,password,{flag:'wx'});
 try{await run('initdb',['-D',data,'-U','rr_local_restore','--pwfile='+pwfile,'--auth-host=scram-sha-256','--auth-local=scram-sha-256','--encoding=UTF8','--locale=C']);}finally{fs.unlinkSync(pwfile);}
 fs.appendFileSync(path.join(data,'postgresql.conf'),"\nlisten_addresses='127.0.0.1'\nport=55481\nlog_min_messages=panic\nlog_min_error_statement=panic\nlog_statement='none'\n");
 stage='start';await run('pg_ctl',['-D',data,'-l',path.join(base,'server.log'),'-w','start']);started=true;
 report.loopbackOnly=await sql("SELECT current_setting('listen_addresses')") ==='127.0.0.1';if(!report.loopbackOnly)throw{reason:'Local isolation check failed'};
 const executable=path.join(bin,'psql.exe'),checks=[];
 const check=(name,ok)=>{if(!ok)throw{reason:name};checks.push({name,passed:true});};
 const reject=async fn=>{try{await fn();return false;}catch{return true;}};
 const opts={executable,env:{...env,PGOPTIONS:'-c default_transaction_read_only=off'}};
 check('explicit BEGIN overrides ignored/off session default',(await inspect({...opts,queries:["SELECT current_setting('transaction_read_only');"]}))[0]==='on');
 for(let i=0;i<3;i++)check('reconnect independently verified '+i,(await inspect({...opts,queries:['SELECT 42;']}))[0]==='42');
 let p=new ReadOnlyPSQL(opts);await p.begin();await p.command('COMMIT;');check('unexpected COMMIT rejected before inspection',await reject(()=>p.query('SELECT 42;')));await p.close();
 p=new ReadOnlyPSQL({...opts,env:{...opts.env,PGOPTIONS:'-c default_transaction_read_only=on'}});await p.begin();await p.command('COMMIT;');check('unexpected COMMIT detected even with default read-only on',await reject(()=>p.query('SELECT 42;')));await p.close();
 p=new ReadOnlyPSQL(opts);await p.begin();await p.command('ROLLBACK;');await p.begin();check('pooled connection reuse reverified',(await p.query('SELECT 42;'))==='42');await p.close();
 p=new ReadOnlyPSQL(opts);await p.begin();p.child.kill();await new Promise(r=>setTimeout(r,100));check('lost connection fails closed',await reject(()=>p.query('SELECT 42;')));await p.close();
 for(const bad of ['COMMIT; SELECT 1;','SELECT 1; ROLLBACK;','\\connect postgres','SELECT 1; INSERT INTO x VALUES(1)'])check('transaction/meta/write injection rejected',await reject(async()=>assertInspection(bad)));
 await sql('CREATE TABLE public.synthetic_readonly_probe(id integer)');p=new ReadOnlyPSQL(opts);await p.begin();check('PostgreSQL rejects actual INSERT in verified transaction',await reject(()=>p.command('INSERT INTO public.synthetic_readonly_probe VALUES(1);')));await p.close();check('synthetic table unchanged',await sql('SELECT count(*) FROM public.synthetic_readonly_probe')==='0');
 report.parameterACL=await testParameterACL({sql,run,base,bin,env});
 report.checks=checks;report.tests=checks.length;report.status='PASSED';console.log(JSON.stringify({status:report.status,tests:checks.length,folder:base}));
}catch(error){report.status='FAILED';report.reason=error.reason||'Read-only local test failure';console.log(JSON.stringify({status:report.status,reason:report.reason,folder:base}));process.exitCode=1;}
finally{if(started){await run('pg_ctl',['-D',data,'-w','-m','fast','stop']);report.localServerStopped=true;}fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(report,null,2));}
