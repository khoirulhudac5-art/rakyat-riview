// GET-only deployment inspection; does not execute page scripts, Auth or RPCs.
import fs from 'node:fs';import path from 'node:path';
const origin='https://rakyat-riview.vercel.app',card='iKRb7_7PyK6kg4Ye7EqvOhYu';
const folder=path.resolve('.backups/public-pilot-routing-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(folder,{recursive:false});
const report={origin,card,method:'GET',pageScriptsExecuted:false,productionWrites:false,routes:[],at:new Date().toISOString()};
try{
 for(const route of ['/r/'+card,'/r/'+card+'/','/pembeli/mulai.html','/pembeli/oauth.html','/pembeli/dashboard.html','/dashboard.html','/api/buyer-google','/api/buyer?action=mode']){
  const response=await fetch(origin+route,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(20000)}),body=await response.text();
  const row={path:route,status:response.status,contentType:response.headers.get('content-type'),location:response.headers.get('location')||null};
  if(row.contentType?.includes('text/html'))Object.assign(row,{dynamicCardCode:body.includes('location.pathname'),targetsReviewedProject:body.includes('svuagnobufhfpgzmsyxx'),publicStatusRPC:body.includes('buyer_public_card_status'),pilotRPC:body.includes('buyer_pilot_'),wizardModule:body.includes('wizard.mjs')||body.includes('mulai.mjs'),oauthModule:body.includes('oauth.mjs')});
  if(row.contentType?.includes('application/json')){try{const data=JSON.parse(body);row.jsonKeys=Object.keys(data);if(typeof data.enabled==='boolean')row.googleEnabled=data.enabled;}catch{row.invalidJSON=true;}}
  report.routes.push(row);
 }
 report.status='READONLY_ROUTING_AUDIT_COMPLETE';
}catch{report.status='STOPPED_NETWORK';report.reason='GET inspection failed; no mutation or retry attempted';process.exitCode=1;}
fs.writeFileSync(path.join(folder,'RESULT.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,folder,routes:report.routes}));
