// Offline activation approval artifacts only. Does not connect or execute SQL/deploy.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex'),base=path.resolve('.backups/public-pilot-review-2026-11-07T07-54-21-397Z');
const m=JSON.parse(fs.readFileSync(path.join(base,'manifest.json')));for(const f of m.files)if(sha(fs.readFileSync(path.join(base,f.file)))!==f.sha256)throw Error('Audited SQL drift');
const folder=path.resolve('.backups/pilot-activation-approval-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(folder,{recursive:false});
const guard=`
DO $pilot_activation_guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM rr_v2_control.state WHERE id AND stage=6 AND state='closed' AND fingerprint='59f0d0d9a4fee9a96481e0630c7b74a7' AND fingerprint=rr_v2_test.fingerprint())
 OR NOT EXISTS(SELECT 1 FROM rr_claim_pilot.control WHERE id AND card_code='iKRb7_7PyK6kg4Ye7EqvOhYu' AND package_id='1ae5113e1ab1c26ade99cd4edc6d4430a2f5ad4ab377d6931ee2bdf13be6ef2f' AND NOT public_on AND NOT claim_on AND NOT owner_on AND NOT redirect_on AND expires_at IS NULL)
 OR EXISTS(SELECT 1 FROM rr_claim_pilot.context) OR EXISTS(SELECT 1 FROM rr_claim_pilot.attempts)
 OR EXISTS(SELECT 1 FROM rr_v2_test.runs WHERE status IN ('active','provisioning'))
 THEN RAISE EXCEPTION 'Pilot activation baseline mismatch; stop without retry';END IF;
 PERFORM 1 FROM public.card c JOIN public.buyer_card_inventory i USING(card_code)
 WHERE c.card_code='iKRb7_7PyK6kg4Ye7EqvOhYu' AND c.claim_mode='google_first_claim' AND c.business_name IS NULL AND c.review_url IS NULL AND c.pin_hash IS NULL AND c.v2_activated_at IS NULL AND i.state='ready'
 AND NOT EXISTS(SELECT 1 FROM public.buyer_card_ownership o WHERE o.card_code=c.card_code)
 AND NOT EXISTS(SELECT 1 FROM public.card_activation a WHERE a.card_code=c.card_code)
 FOR UPDATE OF c,i NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Pilot no longer ready/unowned';END IF;
END $pilot_activation_guard$;
`;
const original=fs.readFileSync(path.join(base,'enable-separate-approval.sql'),'utf8'),marker="SELECT rr_v2_test.verify_state('closed');";
if(!original.includes(marker))throw Error('Audited transaction shape mismatch');
const sql={'enable-guarded-pending-approval.sql':original.replace(marker,marker+guard),'close-claim.sql':fs.readFileSync(path.join(base,'close-claim.sql'),'utf8'),'emergency-pause.sql':fs.readFileSync(path.join(base,'emergency-pause.sql'),'utf8')};
const files=Object.entries(sql).map(([file,s])=>{fs.writeFileSync(path.join(folder,file),s);return {file,sha256:sha(s)};});
const manifest={status:'NOT_APPROVED_NOT_EXECUTABLE_UNTIL_READER_READY',project_ref:'svuagnobufhfpgzmsyxx',card_code:'iKRb7_7PyK6kg4Ye7EqvOhYu',expected_database_fingerprint:'59f0d0d9a4fee9a96481e0630c7b74a7',current_closed_deployment:'dpl_e2THSUZz1c5yH2Kf74oAPMJpJPGp',artifact_manifest_sha256:'5c891b2b7222cb09cabd3835e400fdd52e29db87862fc682ff6458aa7c300e34',claim_window_minutes:30,
 reader:{destination_runtime_env:'SUPABASE_SERVICE_ROLE_KEY',private_source_file:'.env.admin-readonly',private_source_variable:'SUPABASE_SECRET_KEY',copy_to_frontend:false,secret_value_stored_in_artifact:false,new_closed_deployment_required:true},
 gates:['reader runtime alias must be installed only on a new CLOSED deployment after explicit approval','new reader-capable deployment ID, HTTP postflight and rollback must be recorded before SQL activation','claimant Google session and real business/review input ready before starting the 30-minute window','guarded activation SQL and entire artifact set must pass isolated local transaction rehearsal before live execution','fresh verified backup and current fingerprint/ACL/locks/readiness check before authorized SQL','original 11 RPC + 2 test wrappers + Reset/Owner Edit remain closed; no table grants or V1 changes'],
 files,source_enable_sha256:m.files.find(f=>f.file==='enable-separate-approval.sql').sha256};
fs.writeFileSync(path.join(folder,'MANIFEST.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({folder,status:manifest.status,files,productionChangesMade:false}));
