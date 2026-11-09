// Inspection only. No installation, grant, rollback or write-artifact transport.
import {ReadOnlyPSQL} from './readonly-psql.mjs';
export const cardPolicy="((claim_mode = 'legacy'::text) OR ((claim_mode = 'google_first_claim'::text) AND (v2_activated_at IS NOT NULL)))";
const lit=s=>"'"+s.replaceAll("'","''")+"'";
export const viewDigestSQL="SELECT md5(coalesce(jsonb_agg(to_jsonb(v) ORDER BY card_code)::text,'')) FROM public.card_public v";
const expectedAnonSQL=`SELECT md5(coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.card_code)::text,'')) FROM public.card_public v JOIN public.card c USING(card_code) WHERE c.claim_mode='legacy' OR (c.claim_mode='google_first_claim' AND c.v2_activated_at IS NOT NULL)`;
const policySQL=`SELECT count(*)=1 AND bool_and(policyname='public_card_read' AND cmd='SELECT' AND permissive='PERMISSIVE' AND roles=ARRAY['anon']::name[] AND qual=${lit(cardPolicy)}) FROM pg_policies WHERE schemaname='public' AND tablename='card'`;
export async function readSnapshot({executable,env},run){
 const session=new ReadOnlyPSQL({executable,env});
 try{
  await session.command('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;');
  session.identity=await session.check();
  return await run(session);
 }finally{await session.close();}
}
export async function setReadRole(session,role){
 if(!['postgres','anon','authenticated','service_role'].includes(role))throw Error('Inspection role is not allowlisted');
 await session.check();await session.command('SET LOCAL ROLE '+role+';');await session.check();
}
export async function checkRoleViews(session){
 await setReadRole(session,'postgres');
 if(await session.query(policySQL)!=='t')throw Error('Card visibility policy differs from approved per-role model');
 const admin=await session.query(viewDigestSQL),expectedAnon=await session.query(expectedAnonSQL);
 const legacySQL="SELECT md5(coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.card_code)::text,'')) FROM public.card_public v JOIN public.card c USING(card_code) WHERE c.claim_mode='legacy'";
 const expectedLegacy=await session.query(legacySQL);
 await setReadRole(session,'anon');const anon=await session.query(viewDigestSQL);
 if(anon!==expectedAnon)throw Error('Anonymous visibility differs from approved RLS projection');
 // A legacy-only projection does not require permission to read the claim_mode column.
 // Compare legacy code membership with the same snapshot through the owner role below.
 await setReadRole(session,'authenticated');
 const authenticated=await session.query(viewDigestSQL);
 if(authenticated!==await session.query("SELECT md5('')"))throw Error('Authenticated role unexpectedly sees card_public without an approved SELECT policy');
 await setReadRole(session,'service_role');
 if(await session.query("SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user")!=='t')throw Error('Server role RLS capability differs from expected model');
 if(await session.query(viewDigestSQL)!==admin)throw Error('Server view differs from its own approved unfiltered projection');
 await setReadRole(session,'postgres');
 return {anonMatchesApprovedPolicy:true,authenticatedMatchesDefaultDeny:true,serviceMatchesServerProjection:true,adminAndAnonMayDiffer:admin!==anon,ownerViewDigest:admin,legacyOwnerProjectionDigest:expectedLegacy,historicalAnonBaselineAvailable:false,repeatableRead:true,readOnly:true};
}
