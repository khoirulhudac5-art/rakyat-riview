// Metadata inspection only; SQL returned here is a restore artifact, never executed.
export const parameterACLQuery=`SELECT coalesce(json_agg(json_build_object(
 'oid',a.oid,'parname',a.parname,'paracl',a.paracl,
 'owner',pg_get_userbyid(10),'known',EXISTS(SELECT 1 FROM pg_settings WHERE name=a.parname),
 'entries',(SELECT coalesce(json_agg(json_build_object('grantor',pg_get_userbyid(x.grantor),'grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantor,x.grantee,x.privilege_type),'[]'::json) FROM aclexplode(coalesce(a.paracl,acldefault('p',10))) x)
) ORDER BY a.parname),'[]'::json) FROM pg_parameter_acl a`;
const id=s=>'"'+s.replaceAll('"','""')+'"';
const val=s=>"'"+s.replaceAll("'","''")+"'";
export function exportParameterACL(rows,{roles,roleMap={}}){
 if(!Array.isArray(rows))throw Error('Invalid parameter ACL snapshot');
 const known=new Set(roles),seen=new Set();let sql='-- Parameter ACL restore: privileged isolated/managed-compatible target only.\n';
 const mapped=r=>roleMap[r]||r;
 for(const row of rows){
  if(!row||typeof row.parname!=='string'||!row.parname||!row.known||!known.has(row.owner)||!Array.isArray(row.entries)||seen.has(row.parname))throw Error('Unknown/unsupported parameter ACL entry');
  seen.add(row.parname);const owner=mapped(row.owner),entries=row.entries.map(e=>{
   if(!e||!known.has(e.grantor)||(e.grantee!=='PUBLIC'&&!known.has(e.grantee))||!['SET','ALTER SYSTEM'].includes(e.privilege)||typeof e.grantable!=='boolean'||(e.grantee==='PUBLIC'&&e.grantable))throw Error('Unknown parameter ACL role/privilege');
   return {...e,grantor:mapped(e.grantor),grantee:e.grantee==='PUBLIC'?'PUBLIC':mapped(e.grantee)};
  });
  const available=new Set([owner+'|SET',owner+'|ALTER SYSTEM']),pending=[...entries],ordered=[];
  while(pending.length){const at=pending.findIndex(e=>available.has(e.grantor+'|'+e.privilege));if(at<0)throw Error('Unresolvable parameter ACL grant chain');const [e]=pending.splice(at,1);ordered.push(e);if(e.grantable)available.add(e.grantee+'|'+e.privilege);}
  const name=val(row.parname),restoreRoles=[...new Set([owner,...entries.map(e=>e.grantee).filter(r=>r!=='PUBLIC')])];
  sql+=`DO $acl$ BEGIN
 IF pg_get_userbyid(10)<>${val(owner)} THEN RAISE EXCEPTION 'Restore bootstrap owner mismatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper) THEN RAISE EXCEPTION 'Parameter ACL restore requires privileged session'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_settings WHERE name=${name}) THEN RAISE EXCEPTION 'Restore parameter unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM pg_parameter_acl a WHERE a.parname=${name} AND a.paracl IS NOT NULL AND cardinality(a.paracl)<>0 AND a.paracl<>acldefault('p',10)) THEN RAISE EXCEPTION 'Restore parameter has existing custom grants; review first'; END IF;
END $acl$;
-- Materialize the ACL row before REVOKE (REVOKE skips absent parameter ACLs).
-- Temporary PUBLIC privilege is confined to this uncommitted restore transaction.
GRANT SET ON PARAMETER ${id(row.parname)} TO PUBLIC;
REVOKE ALL ON PARAMETER ${id(row.parname)} FROM PUBLIC,${restoreRoles.map(id).join(',')};\n`;
  for(const e of ordered)sql+=`SET SESSION AUTHORIZATION ${id(e.grantor)};
GRANT ${e.privilege} ON PARAMETER ${id(row.parname)} TO ${e.grantee==='PUBLIC'?'PUBLIC':id(e.grantee)}${e.grantable?' WITH GRANT OPTION':''};
RESET SESSION AUTHORIZATION;\n`;
 }
 return 'BEGIN;\n'+sql+'COMMIT;\n';
}
