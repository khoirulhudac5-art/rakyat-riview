// Explicit existing-project preparation. Does not execute SQL or create users.
export function existingConfig(env=process.env){
  if(env.NODE_ENV==='production'||env.VERCEL)throw Error('Existing-project runner is local only.');
  const ref='svuagnobufhfpgzmsyxx';
  if(env.SUPABASE_URL!==`https://${ref}.supabase.co`||env.BUYER_EXISTING_CONFIRMED_REF!==ref)throw Error('Existing project does not match the reviewed card redirect configuration.');
  if(env.BUYER_APP_ORIGIN!=='http://127.0.0.1:4180'||env.BUYER_LOCAL_HTTP!=='1')throw Error('Existing-project preview must use http://127.0.0.1:4180.');
  if(!/^sb_publishable_[A-Za-z0-9_-]+$/.test(env.SUPABASE_PUBLISHABLE_KEY||''))throw Error('Use only the existing project publishable key.');
  return {ref,url:env.SUPABASE_URL,key:env.SUPABASE_PUBLISHABLE_KEY};
}
