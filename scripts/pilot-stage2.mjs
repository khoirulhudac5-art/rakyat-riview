// Operator only. Executes only the three sealed, approved control transactions.
// Never logs Auth credentials or invokes a claim on the user's behalf.
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
import {snapshot,packageCheck,publicInvariant,generateData,compareSnapshots} from './public-pilot-live.mjs';
import {snapshot as deployment,verifyLocal} from './deploy-pilot-closed.mjs';
import {readSnapshot,setReadRole} from './admin-readonly-postflight.mjs';
import {firstClaimConnection} from './prepare-first-claim-live.mjs';
import {tool} from '../.backups/tooling/admin-readonly-live.mjs';
const card='iKRb7_7PyK6kg4Ye7EqvOhYu',origin='https://rakyat-riview.vercel.app';
const sealed=path.resolve('.backups/pilot-activation-approval-2026-11-07T13-14-25-857Z');
const hashes={'enable-guarded-pending-approval.sql':'eed4b41287342ae614b5d50ae0b0678d64b6859768c3df9d8955c74d5c4a92bc','close-claim.sql':'88c829b439c49d2d815166c59f225c5b3526a33aa21340045703c1ae0093764a','emergency-pause.sql':'c87b31d75908b574e20313b75627ab4348d908099303b67ede2d9e8131806020'};
const sha=b=>createHash('sha256').update(b).digest('hex'),md5=b=>createHash('md5').update(b).digest('hex');
const exe=path.resolve('.backups/tooling/pgsql/bin/psql.exe');
export function checkSQL(){for(const [f,h] of Object.entries(hashes))if(sha(fs.readFileSync(path.join(sealed,f)))!==h)throw Error('Approved activation SQL checksum mismatch');}
const save=(folder,name,value)=>fs.writeFileSync(path.join(folder,name),JSON.stringify(value,null,2));
function directory(input){const folder=path.resolve(input||'');if(path.dirname(folder)!==path.resolve('.backups')||!path.basename(folder).startsWith('pilot-stage2-backup-'))throw Error('Invalid stage2 folder');return folder;}
const invariantSQL=`SELECT md5(jsonb_build_object(
 'card',(SELECT jsonb_agg(to_jsonb(t) ORDER BY card_code) FROM public.card t WHERE card_code<>'${card}'),
 'activation',(SELECT jsonb_agg(to_jsonb(t) ORDER BY card_code) FROM public.card_activation t),
 'pin',(SELECT jsonb_agg(to_jsonb(t) ORDER BY card_code) FROM public.card_pin_attempts t),
 'inventory',(SELECT jsonb_agg(to_jsonb(t) ORDER BY card_code) FROM public.buyer_card_inventory t WHERE card_code<>'${card}'),
 'owners',(SELECT jsonb_agg(to_jsonb(t) ORDER BY card_code) FROM public.buyer_card_ownership t WHERE card_code<>'${card}'),
 'audit',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.buyer_ownership_audit t WHERE card_code<>'${card}'),
 'reset',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.buyer_activation_reset_audit t),
 'sequence',(SELECT jsonb_build_array(last_value,is_called) FROM public.card_id_seq))::text)`;
export async function inspect(){return readSnapshot({executable:exe,env:firstClaimConnection()},async s=>{
 await s.query("SELECT rr_v2_test.verify_state('closed')");await s.query('SELECT rr_claim_pilot.assert_acl()');
 const r=JSON.parse(await s.query(`SELECT jsonb_build_object('stage',s.stage,'state',s.state,'fingerprint',s.fingerprint,'actual',rr_v2_test.fingerprint(),
 'public_on',p.public_on,'claim_on',p.claim_on,'owner_on',p.owner_on,'redirect_on',p.redirect_on,'expires_at',p.expires_at,'expired',coalesce(p.expires_at<=clock_timestamp(),false),
 'inventory',i.state,'active',c.v2_activated_at IS NOT NULL,'owner_count',(SELECT count(*) FROM public.buyer_card_ownership WHERE card_code=c.card_code),
 'google_owner',(SELECT count(*)=1 FROM public.buyer_card_ownership o WHERE o.card_code=c.card_code AND EXISTS(SELECT 1 FROM auth.identities a WHERE a.user_id=o.user_id AND a.provider='google')),
 'audit_matches',(SELECT count(*)=1 FROM public.buyer_ownership_audit a JOIN public.buyer_card_ownership o ON o.card_code=a.card_code AND o.user_id=a.new_owner WHERE a.card_code=c.card_code AND a.old_owner IS NULL AND a.reason='first_claim' AND a.actor='google:'||o.user_id::text),
 'target_hash',md5(c.review_url),'identity_hash',md5((to_jsonb(c)-'business_name'-'review_url'-'v2_activated_at')::text),
 'inventory_identity_hash',md5((to_jsonb(i)-'state'-'claimed_at'-'updated_at'-'updated_by')::text),
 'attempts',(SELECT count(*) FROM rr_claim_pilot.attempts),'context',(SELECT count(*) FROM rr_claim_pilot.context),
 'quota',(SELECT coalesce(jsonb_object_agg(md5(user_id::text),md5(to_jsonb(q)::text)),'{}') FROM public.buyer_claim_limits q),
 'actors',(SELECT coalesce(jsonb_agg(DISTINCT md5(uid::text)),'[]') FROM rr_claim_pilot.attempts))
 FROM rr_v2_control.state s CROSS JOIN rr_claim_pilot.control p JOIN public.card c ON c.card_code=p.card_code JOIN public.buyer_card_inventory i ON i.card_code=c.card_code WHERE s.id AND p.id`));
 r.protectedFP=await s.query(publicInvariant);r.generateDigest=await s.query(generateData);r.nonPilotDigest=await s.query(invariantSQL);
 await setReadRole(s,'anon');r.anonymousPilotRows=Number(await s.query(`SELECT count(*) FROM public.card_public WHERE card_code='${card}'`));
 if(r.stage!==6||r.state!=='closed'||r.fingerprint!==r.actual||r.context!==0||r.anonymousPilotRows!==0)throw Error('Pilot state/privacy verification failed');return r;
 });}
export function assertScope(before,after){for(const k of ['protectedFP','generateDigest','nonPilotDigest','identity_hash','inventory_identity_hash'])if(before[k]!==after[k])throw Error('Unexpected protected change: '+k);
 const actors=new Set(after.actors);for(const [k,v] of Object.entries(before.quota))if(!Object.hasOwn(after.quota,k)||(!actors.has(k)&&after.quota[k]!==v))throw Error('Unrelated claim quota changed');
 for(const k of Object.keys(after.quota))if(!Object.hasOwn(before.quota,k)&&!actors.has(k))throw Error('Unrelated quota created');
 if(after.owner_count>1||(after.owner_count===1&&(!after.active||after.inventory!=='claimed'||!after.google_owner||!after.audit_matches)))throw Error('Ownership consistency failed');}
async function writeOnce(folder,file,marker){checkSQL();fs.writeFileSync(path.join(folder,marker),JSON.stringify({at:new Date().toISOString(),sql:file,sha256:hashes[file]}),{flag:'wx'});
 const env={...firstClaimConnection(),PGOPTIONS:'-c default_transaction_read_only=off -c lock_timeout=3000 -c statement_timeout=60000',PGAPPNAME:'rr-pilot-stage2-approved'};
 await tool('psql',['-X','-q','-w','-A','-t','-v','ON_ERROR_STOP=1','-f',path.join(sealed,file)],env);
}
async function pause(folder){if(!fs.existsSync(path.join(folder,'PAUSE-ATTEMPT.json')))await writeOnce(folder,'emergency-pause.sql','PAUSE-ATTEMPT.json');const r=await inspect();if(r.public_on||r.claim_on||r.owner_on||r.redirect_on)throw Error('Emergency pause not verified');save(folder,'PAUSED.json',r);return r;}
async function close(folder){if(!fs.existsSync(path.join(folder,'CLOSE-ATTEMPT.json')))await writeOnce(folder,'close-claim.sql','CLOSE-ATTEMPT.json');const r=await inspect();if(r.claim_on)throw Error('Claim closure not verified');save(folder,'CLAIM-CLOSED.json',r);return r;}
export async function redirectCheck(r){const response=await fetch(origin+'/r/'+card,{redirect:'manual',signal:AbortSignal.timeout(20000)}),loc=response.headers.get('location');
 if(r.owner_count===1){if(response.status!==302||!loc||!/^https:\/\/search\.google\.com\/local\/writereview\?placeid=ChI[A-Za-z0-9_-]{5,250}$/.test(loc)||md5(loc)!==r.target_hash)throw Error('Active Google redirect verification failed');return {status:302,savedTargetMatches:true};}
 if(response.status!==303||!loc||!loc.includes('/pembeli/mulai.html?card='+card))throw Error('Ready wizard redirect failed');return {status:303,wizard:true};}
async function watch(folder){
 save(folder,'WATCH-READY.json',{pid:process.pid,at:new Date().toISOString()});const deadline=Date.now()+35*60000;
 try{while(Date.now()<deadline){if(fs.existsSync(path.join(folder,'OPEN-ATTEMPT.json'))){const r=await inspect();const before=JSON.parse(fs.readFileSync(path.join(folder,'SCOPE-BEFORE.json')));assertScope(before,r);save(folder,'LATEST.json',r);
 if(r.claim_on&&(r.owner_count===1||r.expired)){const final=await close(folder);assertScope(before,final);const http=await redirectCheck(final);save(folder,'WATCH-RESULT.json',{status:r.owner_count===1?'CLAIMED_CLOSED_VERIFIED':'EXPIRED_CLOSED_VERIFIED',http,final,at:new Date().toISOString()});return;}
 if(!r.claim_on&&fs.existsSync(path.join(folder,'OPENED.json'))){save(folder,'WATCH-RESULT.json',{status:'CLAIM_ALREADY_CLOSED',final:r});return;}}
 await new Promise(resolve=>setTimeout(resolve,5000));}
 throw Error('Watch deadline exceeded');
 }catch(e){try{const final=await pause(folder);save(folder,'WATCH-RESULT.json',{status:'EMERGENCY_PAUSED',reason:e.message,final});}catch{save(folder,'WATCH-RESULT.json',{status:'EMERGENCY_PAUSE_NOT_VERIFIED',reason:'Manual investigation required; no automatic retry'});}}
}
function verifyBackup(folder){const m=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json')));if(m.status!=='VERIFIED_CURRENT_BACKUP'||m.project_ref!=='svuagnobufhfpgzmsyxx'||m.tls!=='verify-full'||m.beforeFingerprint!=='59f0d0d9a4fee9a96481e0630c7b74a7'||m.afterFingerprint!==m.beforeFingerprint||Date.now()-Date.parse(m.created_at)>30*60000||!m.verification.fullArchiveDecode||!m.verification.allLiveTableDataEntries||!m.verification.authUsersAndIdentities||!m.verification.parameterACL)throw Error('Fresh verified backup unavailable');for(const f of m.files)if(path.basename(f.name)!==f.name||sha(fs.readFileSync(path.join(folder,f.name)))!==f.sha256)throw Error('Backup checksum mismatch');}
async function main(){checkSQL();const action=process.argv[2],folder=directory(process.argv[3]);
 if(action==='--watch'){await watch(folder);return;}
 if(action==='--inspect'){const r=await inspect();assertScope(JSON.parse(fs.readFileSync(path.join(folder,'SCOPE-BEFORE.json'))),r);console.log(JSON.stringify({status:'INSPECTION_PASS',...r,http:await redirectCheck(r)}));return;}
 if(action!=='--open-user-session-ready')throw Error('Explicit stage2 user-session-ready action required');
 verifyLocal();packageCheck();verifyBackup(folder);const d=await deployment();if(d.current.id!=='dpl_6bSToPRzkLAtApYtqXTMn4jkXwiy'||d.current.state!=='READY')throw Error('Reader deployment drift');
 const db=await snapshot(true),previous=JSON.parse(fs.readFileSync(path.join(folder,'preflight.json')));compareSnapshots(previous,db);if(db.state.fingerprint!=='59f0d0d9a4fee9a96481e0630c7b74a7')throw Error('Fresh fingerprint drift');
 const scope=await inspect();save(folder,'SCOPE-BEFORE.json',scope);
 if(fs.existsSync(path.join(folder,'OPEN-ATTEMPT.json'))||fs.existsSync(path.join(folder,'WATCH-READY.json')))throw Error('Previous activation/watch attempt; no retry');
 const child=spawn(process.execPath,[path.resolve('scripts/pilot-stage2.mjs'),'--watch',folder],{detached:true,windowsHide:true,stdio:'ignore'});child.unref();
 for(let n=0;n<30&&!fs.existsSync(path.join(folder,'WATCH-READY.json'));n++)await new Promise(resolve=>setTimeout(resolve,500));
 if(!fs.existsSync(path.join(folder,'WATCH-READY.json')))throw Error('Durable closure watcher not ready');process.kill(child.pid,0);
 try{await writeOnce(folder,'enable-guarded-pending-approval.sql','OPEN-ATTEMPT.json');const r=await inspect();assertScope(scope,r);if(!r.public_on||!r.claim_on||!r.owner_on||!r.redirect_on||r.owner_count!==0||r.expired||Date.parse(r.expires_at)-Date.now()>30*60000)throw Error('Pilot opening postflight failed');
 const http=await redirectCheck(r);save(folder,'OPENED.json',{at:new Date().toISOString(),deployment:d.current.id,final:r,http});console.log(JSON.stringify({status:'PILOT_OPENED_30_MINUTES',folder,expires_at:r.expires_at,fingerprint:r.fingerprint,http,watcherReady:true,claimPerformedByOperator:false}));
 }catch(e){try{await pause(folder);}catch{}throw Error('Pilot stopped; inspect pause evidence, no automatic retry: '+e.message);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)try{await main();}catch(e){console.log(JSON.stringify({status:'STOPPED',reason:e.message}));process.exitCode=1;}
