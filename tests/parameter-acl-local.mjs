import fs from 'node:fs';
import path from 'node:path';
import {parameterACLQuery,exportParameterACL} from '../scripts/parameter-acl-export.mjs';
export async function testParameterACL({sql,run,base,bin,env}){
 const checks=[];let counter=0;
 const check=(name,ok)=>{if(!ok)throw{reason:name};checks.push({name,passed:true});};
 const throws=async fn=>{try{await fn();return false;}catch{return true;}};
 const apply=async text=>{const f=path.join(base,'parameter-restore-'+(++counter)+'.sql');fs.writeFileSync(f,text);const r=await run('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-f',f],true);if(r.code)throw{reason:r.err.match(/ERROR:\s*([^\r\n]+)/)?.[1]||'Parameter restore failed'};};
 await sql('CREATE ROLE acl_a NOLOGIN; CREATE ROLE acl_b NOLOGIN; CREATE ROLE supabase_realtime_admin NOLOGIN');
 const owner=await sql('SELECT pg_get_userbyid(10)'),roles=[owner,'acl_a','acl_b','supabase_realtime_admin'];
 const snapshot=async()=>JSON.parse(await sql(parameterACLQuery));
 const canonical=rows=>JSON.stringify(rows.map(({oid,paracl,...r})=>({...r,entries:[...r.entries].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))})).sort((a,b)=>a.parname.localeCompare(b.parname)));
 await apply(exportParameterACL([],{roles}));check('empty catalog exports/restores without omission',(await snapshot()).length===0);
 await sql(`GRANT SET ON PARAMETER log_min_messages TO supabase_realtime_admin; GRANT SET ON PARAMETER log_statement TO acl_a WITH GRANT OPTION; SET SESSION AUTHORIZATION acl_a; GRANT SET ON PARAMETER log_statement TO acl_b; RESET SESSION AUTHORIZATION; GRANT SET ON PARAMETER log_duration TO acl_a; REVOKE ALL ON PARAMETER log_duration FROM acl_a,${'"'+owner+'"'}; GRANT SET ON PARAMETER log_checkpoints TO PUBLIC;`);
 const before=await snapshot();fs.writeFileSync(path.join(base,'parameter-source.json'),JSON.stringify(before,null,2));check('explicit empty ACL captured',before.some(r=>r.parname==='log_duration'&&r.entries.length===0));
 check('grantor and grant option captured',before.some(r=>r.entries.some(e=>e.grantor==='acl_a'&&e.grantee==='acl_b'))&&before.some(r=>r.entries.some(e=>e.grantee==='acl_a'&&e.grantable)));
 const artifact=exportParameterACL(before,{roles});
 await sql(`REVOKE ALL ON PARAMETER log_min_messages,log_statement,log_duration,log_checkpoints FROM PUBLIC,acl_a,acl_b,supabase_realtime_admin,"${owner}" CASCADE`);
 await apply(artifact);check('all ACL entries round-trip including empty/PUBLIC/grantor/options',canonical(before)===canonical(await snapshot()));
 check('restored SET works for non-superuser',await sql("BEGIN; SET LOCAL ROLE acl_b; SET LOCAL log_statement='none'; SELECT current_setting('log_statement'); ROLLBACK;")==='none');
 check('ALTER SYSTEM not granted to realtime role',await sql("SELECT NOT has_parameter_privilege('supabase_realtime_admin','log_min_messages','ALTER SYSTEM')")==='t');
 check('existing custom target grants refuse overwrite',await throws(()=>apply(artifact)));
 check('failed restore leaves ACL intact',canonical(before)===canonical(await snapshot()));
 const exemplar=before.find(r=>r.entries.length);
 for(const [label,row]of [['unknown parameter',{...exemplar,known:false}],['unknown privilege',{...exemplar,entries:[{...exemplar.entries[0],privilege:'FUTURE'}]}],['unknown role',{...exemplar,entries:[{...exemplar.entries[0],grantee:'missing_role'}]}],['unresolvable grant chain',{...exemplar,entries:[{grantor:'acl_a',grantee:'acl_b',privilege:'SET',grantable:false}]}]])check(label+' fails closed',await throws(async()=>exportParameterACL([row],{roles})));
 check('bootstrap owner mismatch refuses restore',await throws(()=>apply(exportParameterACL([exemplar],{roles,roleMap:{[owner]:'acl_a'}}))));
 const original=JSON.parse(fs.readFileSync('.backups/v1-2026-11-05T18-44-21-732Z/roles.json')).parameter_acl[0];
 check('blocking live entry is fully represented',original.parname==='log_min_messages'&&before.some(r=>r.parname===original.parname&&r.entries.some(e=>e.grantee==='supabase_realtime_admin'&&e.privilege==='SET'&&!e.grantable)&&r.entries.some(e=>e.grantee===owner&&e.privilege==='ALTER SYSTEM')));
 const at=process.argv.indexOf('--parameter-snapshot');
 if(at>=0){
  const actual=JSON.parse(fs.readFileSync(process.argv[at+1])),mapping={[actual.parameter_acl[0].owner]:owner};
  const names=Object.values(actual.role_names);
  const artifact=exportParameterACL(actual.parameter_acl,{roles:names,roleMap:mapping});
  for(const row of actual.parameter_acl){
   const name='"'+row.parname.replaceAll('"','""')+'"';
   await sql(`REVOKE ALL ON PARAMETER ${name} FROM PUBLIC,acl_a,acl_b,supabase_realtime_admin,"${owner}" CASCADE`);
  }
  await apply(artifact);
  const expected=actual.parameter_acl.map(r=>({...r,owner:mapping[r.owner]||r.owner,entries:r.entries.map(e=>({...e,grantor:mapping[e.grantor]||e.grantor,grantee:mapping[e.grantee]||e.grantee}))}));
  const selected=(await snapshot()).filter(r=>expected.some(e=>e.parname===r.parname));
  check('latest live ACL snapshot round-trips with explicit local bootstrap mapping',canonical(expected)===canonical(selected));
  check('latest backup SET permission restored for realtime role',await sql("SELECT has_parameter_privilege('supabase_realtime_admin','log_min_messages','SET') AND NOT has_parameter_privilege('supabase_realtime_admin','log_min_messages','ALTER SYSTEM')")==='t');
 }
 fs.writeFileSync(path.join(base,'parameter-acl-tests.json'),JSON.stringify({status:'PASSED',tests:checks.length,checks,productionConnected:false,bootstrapMapping:'local bootstrap substitutes source supabase_admin; target owner must match',artifact:'parameter-restore-2.sql'},null,2));
 return {status:'PASSED',tests:checks.length};
}
