// One explicitly approved restricted run. Only frozen open/close SQL may be
// executed with DB-owner credentials; buyer mutations use real browser JWTs.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn,fork} from 'node:child_process';
import {firstClaimConnection,firstClaimReadinessSQL} from './prepare-first-claim-live.mjs';
import {inspect} from './readonly-psql.mjs';
import {createProductPreview} from './preview-product.mjs';
import {startRealProduct} from './preview-product-real.mjs';
import {createLiveClaimSession} from './first-claim-live-session.mjs';
const folder=path.resolve('.local-tools/first-claim-live'),planFile=path.join(folder,'plan.json'),resultFile=path.join(folder,'result.json'),watchFile=path.join(folder,'watchdog.json');
const executable=path.resolve('.backups/tooling/pgsql/bin/psql.exe');
const literal=v=>"'"+String(v).replaceAll("'","''")+"'";
const sha=b=>createHash('sha256').update(b).digest('hex');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function load(){const p=JSON.parse(fs.readFileSync(planFile,'utf8'));if(p.project_ref!=='svuagnobufhfpgzmsyxx'||p.minutes!==30||!p.run_id||!p.execution_files)throw Error('Approved plan identity invalid');return p;}
export async function frozenWrite(plan,kind){
 const spec=plan.execution_files[kind];if(!spec||!['open-run.sql','close-run.sql'].includes(spec.file))throw Error('Frozen SQL identity invalid');
 const file=path.join(folder,spec.file);if(sha(fs.readFileSync(file))!==spec.sha256)throw Error('Frozen SQL checksum mismatch');
 const env=firstClaimConnection();env.PGOPTIONS='-c default_transaction_read_only=off -c lock_timeout=5000 -c statement_timeout=20000';
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,['-X','-q','-w','-A','-t','-v','ON_ERROR_STOP=1','-f',file],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';
  const timer=setTimeout(()=>{child.kill();reject(Error('SQL client timeout; outcome ambiguous; no automatic retry'));},45000);
  child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',()=>{clearTimeout(timer);reject(Error('SQL process/connection failed'));});child.on('close',code=>{clearTimeout(timer);if(code===0)resolve(out.trim());else reject(Error(/timeout|timed out/i.test(err)?'SQL or lock timeout':'Frozen SQL failed; no retry or repair outside package'));});
 });
}
async function read(queries){return inspect({executable,env:firstClaimConnection(),queries});}
function dataDigestSQL(run){return `SELECT md5(jsonb_build_object(
 'card',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.card_code) FROM public.card c WHERE NOT EXISTS(SELECT 1 FROM rr_v2_test.cards d WHERE d.run_id=${literal(run)}::uuid AND d.card_code=c.card_code)),
 'activation',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.card_code) FROM public.card_activation c WHERE NOT EXISTS(SELECT 1 FROM rr_v2_test.cards d WHERE d.run_id=${literal(run)}::uuid AND d.card_code=c.card_code)),
 'pin_attempts',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.card_code) FROM public.card_pin_attempts c WHERE NOT EXISTS(SELECT 1 FROM rr_v2_test.cards d WHERE d.run_id=${literal(run)}::uuid AND d.card_code=c.card_code)),
 'owners',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.card_code) FROM public.buyer_card_ownership c WHERE NOT EXISTS(SELECT 1 FROM rr_v2_test.cards d WHERE d.run_id=${literal(run)}::uuid AND d.card_code=c.card_code)),
 'inventory',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.card_code) FROM public.buyer_card_inventory c WHERE NOT EXISTS(SELECT 1 FROM rr_v2_test.cards d WHERE d.run_id=${literal(run)}::uuid AND d.card_code=c.card_code)),
 'quota',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.user_id) FROM public.buyer_claim_limits c),
 'ownership_audit',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.buyer_ownership_audit c WHERE NOT EXISTS(SELECT 1 FROM rr_v2_test.cards d WHERE d.run_id=${literal(run)}::uuid AND d.card_code=c.card_code)),
 'reset_audit',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.buyer_activation_reset_audit c WHERE NOT EXISTS(SELECT 1 FROM rr_v2_test.cards d WHERE d.run_id=${literal(run)}::uuid AND d.card_code=c.card_code)))::text)`;}
function baselineOK(s,plan){return s.stage===6&&s.state==='closed'&&s.fingerprint===plan.checkpoint.fingerprint&&s.fingerprint===s.live_fingerprint&&s.original_count===11&&s.original_closed&&s.wrapper_count===2&&s.wrappers_closed&&s.active_runs===0&&s.private_rls&&s.waiting_locks===0;}
export function approvedPreparation(plan,previous,{continuePreparation=false}={}){
 if(!Array.isArray(plan.fixtures)||plan.fixtures.length!==2||plan.fixtures.some(f=>f.card_code))throw Error('Fixture allocation already attempted; do not retry');
 if(plan.status==='PREPARED_READ_ONLY_AWAITING_APPROVAL')return 'initial';
 if(continuePreparation&&plan.status==='CLOSED_RETIRED'&&previous?.runId===plan.run_id&&previous.openRunAttempted===false&&previous.closedVerified===true&&previous.originalRPCsClosed===true&&previous.wrappersClosed===true&&previous.customerDataUnchanged===true&&previous.dummyCleanup?.registered===0&&previous.dummyCleanup?.owned===0)return 'continued-unopened-preparation';
 throw Error('Run has already been attempted or plan changed; do not retry');
}
async function watchdog(){
 const w=JSON.parse(fs.readFileSync(watchFile,'utf8'));await wait(Math.max(1,w.close_at-Date.now()));
 try{if(fs.existsSync(resultFile)&&JSON.parse(fs.readFileSync(resultFile,'utf8')).closedVerified)return;}catch{}
 let result;try{const output=await frozenWrite(load(),'close');result={closeRunInvoked:true,returned:output==='t',at:new Date().toISOString()};}catch{result={closeRunInvoked:true,failed:true,at:new Date().toISOString()};}
 fs.writeFileSync(path.join(folder,'watchdog-result.json'),JSON.stringify(result,null,2));
}
export async function executeApproved(){
 if(!process.argv.includes('--approved'))throw Error('Explicit approved execution flag required');
 const plan=load();let previous;try{previous=JSON.parse(fs.readFileSync(resultFile,'utf8'));}catch{}
 const preparation=approvedPreparation(plan,previous,{continuePreparation:process.argv.includes('--continue-preparation')});
 if(preparation==='continued-unopened-preparation')fs.copyFileSync(resultFile,path.join(folder,'preparation-result-before-approved-run.json'));
 const report={project:plan.project_ref,runId:plan.run_id,startedAt:new Date().toISOString(),status:'WAITING_FOR_REAL_SESSIONS',realGoogleJWTs:true,openRunAttempted:false,closeRunInvoked:false,closedVerified:false,tests:[]};
 const save=()=>fs.writeFileSync(resultFile,JSON.stringify(report,null,2));save();
 const harness=createLiveClaimSession(plan);let app,worker,cleanupPromise,before;
 const mark=(name,pass)=>{const record={name,pass:Boolean(pass)};report.tests.push(record);harness.results.push(record);save();console.log((pass?'PASS ':'FAIL ')+name);if(!pass)throw Error(name);};
 const cleanup=()=>cleanupPromise||=(async()=>{
  app?.server.closeRestrictedRun();harness.clear();harness.phase='STOPPED';report.closeRunInvoked=true;save();
  try{
   const output=await frozenWrite(plan,'close');report.closeRunReturned=output==='t';
   const [stateRaw,digest,fixturesRaw]=await read([firstClaimReadinessSQL,dataDigestSQL(plan.run_id),`SELECT json_build_object('registered',count(*),'retired',coalesce(bool_and(t.retired),true),'owned',(SELECT count(*) FROM public.buyer_card_ownership o JOIN rr_v2_test.cards d USING(card_code) WHERE d.run_id=${literal(plan.run_id)}::uuid)) FROM rr_v2_test.cards t WHERE t.run_id=${literal(plan.run_id)}::uuid`]);
   const state=JSON.parse(stateRaw),fixtures=JSON.parse(fixturesRaw);report.closedVerified=baselineOK(state,plan);report.customerDataUnchanged=before?digest===before:null;report.dummyCleanup=fixtures;
   report.originalRPCsClosed=state.original_count===11&&state.original_closed;report.wrappersClosed=state.wrapper_count===2&&state.wrappers_closed;
   plan.status=report.closedVerified?'CLOSED_RETIRED':'CLOSURE_REQUIRES_REVIEW';fs.writeFileSync(planFile,JSON.stringify(plan,null,2));
  }catch(error){report.cleanupError=error.message;}
  if(report.closedVerified&&worker)worker.kill();report.finishedAt=new Date().toISOString();save();
 })();
 const interrupt=async()=>{report.error='Execution interrupted';try{await cleanup();}finally{process.exit(report.closedVerified?0:1);}};
 process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
 try{
  const [raw,digest,exists]=await read([firstClaimReadinessSQL,dataDigestSQL(plan.run_id),`SELECT EXISTS(SELECT 1 FROM rr_v2_test.runs WHERE run_id=${literal(plan.run_id)}::uuid)`]);if(!baselineOK(JSON.parse(raw),plan)||exists!=='f')throw Error('Minimum closed preflight mismatch or run ID already exists');before=digest;report.preflightPassed=true;report.preparation=preparation;save();
  app=await startRealProduct(options=>createProductPreview({...options,claimTest:harness}));
  console.log('READY: open http://127.0.0.1:4180/pembeli/claim-test.html in the existing A and B browser profiles. Run remains closed until both real sessions are verified.');
  // Preparation has no run countdown. The database's 30-minute deadline starts
  // only after an explicitly approved open_run succeeds, never during login.
  while(!harness.ready)await wait(1000);
  for(const label of ['A','B']){const verified=await harness.call(label,'session');if(verified.status!==200||verified.data.user?.google!==true||verified.data.user.id!==plan.accounts[label].uid)throw Error('Live Google session '+label+' no longer valid before open');}
  const [fresh]=await read([firstClaimReadinessSQL]);if(!baselineOK(JSON.parse(fresh),plan))throw Error('Closed checkpoint changed before open');
  // Independent process is armed BEFORE open. It invokes the already approved
  // close_run even if this process dies; database expiry independently denies JWTs.
  fs.writeFileSync(watchFile,JSON.stringify({close_at:Date.now()+29*60000,run_id:plan.run_id}));
  const childEnv={...process.env};for(const key of Object.keys(childEnv))if(key.startsWith('PG')||/TOKEN|SECRET|PASSWORD|DATABASE_URL/.test(key))delete childEnv[key];
  worker=fork(fileURLToPath(import.meta.url),['--watchdog'],{cwd:process.cwd(),env:childEnv,detached:true,windowsHide:true,stdio:'ignore'});worker.unref();
  report.openRunAttempted=true;report.status='OPENING';plan.status='OPEN_ATTEMPTED';fs.writeFileSync(planFile,JSON.stringify(plan,null,2));save();
  const output=await frozenWrite(plan,'open'),codes=output.split(/\r?\n/).filter(Boolean);if(codes.length!==2||codes.some(c=>!/^[A-Za-z0-9_-]{24}$/.test(c)))throw Error('Unexpected open result; no retry');
  const [runRaw,stateRaw,acl]=await read([`SELECT json_build_object('status',r.status,'expires_at',r.expires_at,'a',r.user_a,'b',r.user_b,'cards',(SELECT json_agg(json_build_object('label',d.label,'card_code',d.card_code) ORDER BY d.label) FROM rr_v2_test.cards d WHERE d.run_id=r.run_id)) FROM rr_v2_test.runs r WHERE run_id=${literal(plan.run_id)}::uuid`,firstClaimReadinessSQL,'SELECT rr_v2_test.assert_acl()']);
  const run=JSON.parse(runRaw),state=JSON.parse(stateRaw);if(run.status!=='active'||run.a!==plan.accounts.A.uid||run.b!==plan.accounts.B.uid||run.cards.length!==2||run.cards.some(c=>!codes.includes(c.card_code))||state.stage!==6||state.state!=='testing_restricted'||!state.original_closed||state.original_count!==11||state.fingerprint!==state.live_fingerprint)throw Error('Active run postflight failed');
  plan.status='ACTIVE_RESTRICTED_TEST';plan.expires_at=run.expires_at;plan.fixtures=run.cards;fs.writeFileSync(planFile,JSON.stringify(plan,null,2));app.server.configureRestrictedRun(plan);harness.phase='RUNNING';report.status='TESTING';report.expiresAt=run.expires_at;save();
  const [c1,c2]=plan.fixtures.map(c=>c.card_code),initial=plan.review_destinations.initial,updated=plan.review_destinations.updated;
  let result=await harness.call('A','first-claim',{card_code:c1,business_name:'RR JWT DUMMY A',review_url:initial});mark('A first claim dummy 1 with real Google JWT',result.status===200&&result.data.success===true);
  result=await harness.call('B','first-claim',{card_code:c2,business_name:'RR JWT DUMMY B',review_url:initial});mark('B positive-control claim dummy 2 with real Google JWT',result.status===200&&result.data.success===true);
  result=await harness.call('B','first-claim',{card_code:c1,business_name:'Must not replace A',review_url:updated});mark('B cannot take A ownership',[403,409].includes(result.status));
  result=await harness.call('A','update',{card_code:c1,business_name:'RR JWT DUMMY A EDIT',review_url:updated});mark('A edits business name and different review destination',result.status===200&&result.data.success===true);
  result=await harness.call('B','update',{card_code:c1,business_name:'Forbidden edit',review_url:initial});mark('B cannot edit A card',[403,409].includes(result.status));
  const a=await harness.call('A','cards'),b=await harness.call('B','cards');mark('Each account lists only its own registered dummy',a.status===200&&b.status===200&&a.data.cards.length===1&&a.data.cards[0].card_code===c1&&b.data.cards.length===1&&b.data.cards[0].card_code===c2);
  const publicScan=await fetch('http://127.0.0.1:4180/r/'+c1,{redirect:'manual',signal:AbortSignal.timeout(20000)});mark('Anonymous active scan redirects to updated Google Review URL',publicScan.status===302&&publicScan.headers.get('location')===updated);
  const [owned]=await read([`SELECT count(*)=2 AND bool_and((o.card_code=${literal(c1)} AND o.user_id=${literal(plan.accounts.A.uid)}::uuid) OR (o.card_code=${literal(c2)} AND o.user_id=${literal(plan.accounts.B.uid)}::uuid)) FROM public.buyer_card_ownership o JOIN rr_v2_test.cards d USING(card_code) WHERE d.run_id=${literal(plan.run_id)}::uuid`]);mark('Live ownership rows agree with both authenticated accounts',owned==='t');
  harness.phase='WAITING_FOR_A_RELOGIN';report.status=harness.phase;save();console.log('ACTION: account A can now use the harness logout/relogin button; B session can stay signed in.');
  const reauthDeadline=Date.parse(plan.expires_at)-120000;
  while(!harness.proofs.get('A')?.fresh||!harness.sessions.has('A')){if(Date.now()>reauthDeadline)throw Error('Fresh A session was not provided before persistence-test timeout');await wait(1000);}
  result=await harness.call('A','cards');const ownedCard=result.data.cards?.find(c=>c.card_code===c1);mark('Ownership and edits persist after real logout and new Google session',result.status===200&&ownedCard?.business_name==='RR JWT DUMMY A EDIT'&&ownedCard?.review_url===updated);
 }catch(error){report.error=error.message;harness.failure='Pengujian dihentikan; penutupan akses sedang dijalankan.';console.log('STOP:',error.message);}
 finally{
  await cleanup();const pass=!report.error&&report.tests.length===9&&report.tests.every(t=>t.pass)&&report.closedVerified&&report.customerDataUnchanged&&report.dummyCleanup?.registered===2&&report.dummyCleanup?.retired&&report.dummyCleanup?.owned===0;
  report.status=pass?'PASS':'FAIL';harness.phase='FINISHED';harness.failure=pass?null:'Pengujian belum seluruhnya PASS. Lihat laporan operator; akses pengujian sudah ditutup bila closedVerified=true.';save();
  console.log(JSON.stringify({status:report.status,tests:report.tests.length,closedVerified:report.closedVerified,originalRPCsClosed:report.originalRPCsClosed,wrappersClosed:report.wrappersClosed,customerDataUnchanged:report.customerDataUnchanged,report:'.local-tools/first-claim-live/result.json'}));
 }
 return {app,report};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){if(process.argv.includes('--watchdog'))await watchdog();else await executeApproved();}
