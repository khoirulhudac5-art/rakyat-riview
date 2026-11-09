// Local runner guard; a matching reference is an explicit operator assertion,
// not independent proof that an external project is safe for migrations.
export function stagingConfig(env=process.env){
  if(env.NODE_ENV==='production'||env.VERCEL)throw Error('Staging runner is local only.');
  let url;try{url=new URL(env.SUPABASE_URL);}catch{throw Error('Separate staging SUPABASE_URL is required.');}
  const ref=url.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/)?.[1];
  const oldRefs=new Set(['svuagnobufhfpgzmsyxx','svuagnobuhfpgzmsyxx']);
  if(!ref||url.origin!==env.SUPABASE_URL||oldRefs.has(ref)||env.SUPABASE_STAGING_CONFIRMED_REF!==ref)throw Error('Staging reference must be explicitly confirmed and different from legacy configuration.');
  if(env.BUYER_APP_ORIGIN!=='http://127.0.0.1:4179'||env.BUYER_LOCAL_HTTP!=='1')throw Error('Staging preview must use http://127.0.0.1:4179.');
  if(!env.SUPABASE_PUBLISHABLE_KEY||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(env.SUPABASE_PUBLISHABLE_KEY))throw Error('Staging requires a publishable key, never a secret/service key.');
  return {ref,url:url.origin,key:env.SUPABASE_PUBLISHABLE_KEY};
}
