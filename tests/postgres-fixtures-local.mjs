// Synthetic companion database on the SAME isolated loopback test cluster.
// Shared roles already exist; only CREATE ROLE bootstrap lines are omitted.
import fs from 'node:fs';
import path from 'node:path';
export async function runSQLFixtures({sql,run,base,root}){
 const db='rr_sql_fixtures';await sql('CREATE DATABASE rr_sql_fixtures TEMPLATE template0');
 async function file(file,copy=false){
  let target=path.join(root,'supabase',file);
  if(copy){let text=fs.readFileSync(target,'utf8').replace(/^CREATE ROLE (?:anon|authenticated|service_role) NOLOGIN;\r?\n/gm,'');
   text=text.replace(/\\ir \.\.\/migrations\/([^\r\n]+)/g,(_,name)=>"\\ir '"+path.join(root,'supabase/migrations',name.trim()).replaceAll('\\','/')+"'");
   target=path.join(base,path.basename(file));fs.writeFileSync(target,text);
  }
  const r=await run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',db,'-f',target],true);
  if(r.code!==0){const e=r.err.match(/ERROR:\s+([^\r\n]+)/)?.[1]||'SQL failure';throw{reason:'Fixture '+file+': '+e.replace(/"[^"]*"|'[^']*'/g,'[redacted]').slice(0,150)};}
 }
 const passed=[];
 await file('tests/buyer_account_fixture.sql',true);
 await file('migrations/20261105000100_buyer_accounts.sql');
 await file('tests/buyer_accounts.sql');passed.push('buyer_accounts.sql');
 await file('tests/google_first_claim.sql',true);passed.push('google_first_claim.sql');
 await file('tests/existing_public_visibility.sql');passed.push('existing_public_visibility.sql');
 await file('migrations/20261105000400_fix_legacy_pin_cooldown.sql');
 await file('tests/update_card_review_url.sql');passed.push('update_card_review_url.sql');
 // Match service-role table/sequence rights in the actual restored project.
 await sql('GRANT ALL ON public.card,public.card_activation,public.card_pin_attempts TO service_role; GRANT USAGE ON SCHEMA extensions TO service_role; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role',db);
 await file('migrations/20261104000100_create_review_card.sql');
 await file('tests/create_review_card.sql');passed.push('create_review_card.sql');
 return passed;
}
