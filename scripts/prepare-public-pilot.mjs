// Offline preparation only. No environment files, credentials, network or SQL execution.
import path from 'node:path';import fs from 'node:fs';
import {writePilotPackage} from './public-pilot-package.mjs';
const expected=process.argv[2];
if(!/^[a-f0-9]{32}$/.test(expected||''))throw Error('Supply the approved baseline fingerprint; this script does NOT verify a live database.');
const folder=path.resolve('.backups','public-pilot-review-'+new Date().toISOString().replace(/[:.]/g,'-'));
const m=writePilotPackage(folder,expected);
const sources=['supabase/pilots/001_first_claim_pilot.sql','scripts/public-pilot-package.mjs','lib/public-pilot.mjs','api/pilot-redirect.js','api/buyer.js','api/buyer-status.js','pembeli/wizard.mjs','assets/buyer.js','vercel.json'];
const {createHash}=await import('node:crypto');m.sources=sources.map(file=>({file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(m,null,2));
console.log(JSON.stringify({folder:path.relative(process.cwd(),folder),package_id:m.package_id,files:m.files,livePreflightPerformed:false}));
