import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {writePackage,verifyPackage,installSQL,pauseSQL,rollbackSQL,packageId} from '../scripts/admin-readonly-package.mjs';

test('Admin read approval artifacts are deterministic, complete and fail closed on tampering',()=>{
 const folder=fs.mkdtempSync(path.resolve('.backups/admin-read-package-unit-'));
 const m=writePackage(folder,'a'.repeat(32));
 assert.equal(verifyPackage(folder).package_id,packageId);
 assert.equal(m.files.length,6);assert.equal(m.sources.length,11);
 assert.equal(m.authorization,'NOT APPROVED FOR PRODUCTION');
 const file=path.join(folder,'install.sql');const original=fs.readFileSync(file);
 fs.appendFileSync(file,'\n-- unapproved edit');
 assert.throws(()=>verifyPackage(folder),/checksum/);
 fs.writeFileSync(file,original);
 assert.equal(verifyPackage(folder).original_business_rpcs,11);
});
test('install is one transaction, binds previous fingerprint and records protected public objects',()=>{
 const sql=installSQL('b'.repeat(32));
 assert.ok(sql.startsWith('BEGIN;'));assert.ok(sql.trim().endsWith('COMMIT;'));
 assert.match(sql,/pg_advisory_xact_lock\(728401\)/);
 assert.match(sql,/expected_fingerprint/);assert.match(sql,/Protected public functions\/RLS\/grants\/view changed/);
 assert.match(sql,/rr_admin_read_definer NOLOGIN NOSUPERUSER/);
 assert.match(sql,/GRANT EXECUTE ON FUNCTION public.admin_read_v2_inventory[\s\S]*?TO service_role/);
 assert.doesNotMatch(sql,/GRANT\s+(?:ALL|SELECT).*ON\s+(?:public\.card|auth\.users)/i);
 assert.doesNotMatch(sql,/PERFORM rr_v2_test\.open_run|SELECT rr_v2_test\.open_run/);
 assert.throws(()=>installSQL('missing'),/fingerprint/);
});
test('pause/rollback cannot resume or delete customer card data',()=>{
 for(const sql of [pauseSQL(),rollbackSQL()]){
  assert.ok(sql.startsWith('BEGIN;'));assert.ok(sql.trim().endsWith('COMMIT;'));
  assert.doesNotMatch(sql,/\b(?:INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+public\./i);
  assert.doesNotMatch(sql,/\bCASCADE\b|open_run\(|resume/i);
 }
 assert.match(pauseSQL(),/read_enabled=false/);
 assert.match(rollbackSQL(),/Rollback fingerprint did not return to baseline/);
 assert.match(rollbackSQL(),/REVOKE USAGE ON SCHEMA public/);
});
