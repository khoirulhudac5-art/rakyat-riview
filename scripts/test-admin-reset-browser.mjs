// Real admin DOM/browser; explicitly synthetic HTTP store (no Auth/production).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {firstClaimModel} from './first-claim-model.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH=path.resolve('.local-tools/browsers');
const require=createRequire(import.meta.url),{chromium,firefox}=require(path.resolve('.local-tools/browser-tests/node_modules/playwright'));
const out=path.resolve('test-results/admin-reset-'+new Date().toISOString().replace(/[:.]/g,'-'));await fs.mkdir(out,{recursive:true});const reports=[];
const files=new Map([['/admin.html','admin.html'],['/assets/admin-v2-reset.js','assets/admin-v2-reset.js'],['/assets/admin-v2-reset.css','assets/admin-v2-reset.css']]);
for(const [engine,width]of [[chromium,1440],[chromium,320],[chromium,375],[firefox,375]]){
 const cards=[],audit=[],limits=new Map();let resetRequests=0;
 const server=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://127.0.0.1'),send=(status,v)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(v));};
  if(files.has(u.pathname)){res.setHeader('Content-Type',u.pathname.endsWith('.js')?'text/javascript':u.pathname.endsWith('.css')?'text/css':'text/html');return res.end(await fs.readFile(files.get(u.pathname)));}
  let body={};if(req.method==='POST'){let raw='';for await(const c of req)raw+=c;body=JSON.parse(raw);}
  if(u.pathname==='/api/admin-session')return send(200,{success:true});
  if(u.pathname==='/api/list-cards')return send(200,{success:true,cards:[{card_code:'001',business_name:'V1 synthetic unchanged'}]});
  if(u.pathname==='/api/admin-v2-cards')return send(200,{cards:cards.map(c=>({...c,activation_revision:c.revision})),creation_enabled:true,reset_enabled:true});
  if(u.pathname==='/api/admin-create-v2'){const c={card_code:'R'.repeat(24),claim_mode:'google_first_claim',inventory_state:'ready',business_name:'',review_url:'',owner:null,active:false,revision:0};cards.push(c);return send(200,{cards:[c]});}
  if(u.pathname==='/test/claim'){const c=cards[0],r=firstClaimModel(cards,{id:body.account,google:true},{card_code:c.card_code,business_name:'Owner '+body.account,review_url:'https://search.google.com/local/writereview?placeid=ChITestFixtureOnly'},limits);return send(r.status,r.data);}
  if(u.pathname==='/test/edit')return send(cards[0].owner===body.account?200:403,{success:cards[0].owner===body.account});
  if(u.pathname==='/api/admin-reset-v2'){resetRequests++;const c=cards[0];if(body.confirmation!==c.card_code||body.expected_revision!==c.revision||!body.acknowledged||!c.active)return send(409,{error:'Synthetic stale state'});audit.push({oldOwner:c.owner});Object.assign(c,{owner:null,business_name:'',review_url:'',active:false,inventory_state:'ready',revision:c.revision+1});return send(200,{success:true});}
  send(404,{});
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port,browser=await engine.launch({headless:true});
 try{const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());await page.goto(base+'/admin.html');await page.waitForFunction(()=>!document.getElementById('v2-create').disabled);await page.locator('#v2-create').click();await page.locator('#v2-cards').getByText('Siap diklaim',{exact:false}).waitFor();assert.equal(cards[0].inventory_state,'ready');
  assert.equal((await context.request.post(base+'/test/claim',{data:{account:'A'}})).status(),200);await page.locator('#v2-reload').click();await page.locator('[data-v2-reset]').waitFor();await page.locator('[data-v2-reset]').click();assert.ok(await page.locator('#v2-submit').isDisabled());await page.locator('#v2-confirmation').fill('wrong');await page.locator('#v2-reason').fill('Synthetic documented reset request');await page.locator('#v2-ack').check();assert.ok(await page.locator('#v2-submit').isDisabled());await page.locator('#v2-cancel').click();assert.equal(resetRequests,0);
  await page.locator('[data-v2-reset]').click();await page.locator('#v2-confirmation').fill(cards[0].card_code);await page.locator('#v2-reason').fill('Synthetic documented reset request');await page.locator('#v2-ack').check();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,engine.name()+'-'+width+'-confirmation.png')});await page.locator('#v2-submit').click();await page.waitForFunction(()=>document.getElementById('v2-result').textContent.includes('Reset berhasil'));assert.equal(resetRequests,1);assert.equal(cards[0].card_code,'R'.repeat(24));assert.equal(audit.length,1);
  assert.equal((await context.request.post(base+'/test/edit',{data:{account:'A'}})).status(),403);assert.equal((await context.request.post(base+'/test/claim',{data:{account:'B'}})).status(),200);assert.equal((await context.request.post(base+'/test/claim',{data:{account:'A'}})).status(),409);assert.ok(await page.locator('#cardList').textContent().then(t=>t.includes('V1 synthetic unchanged')));
  reports.push({browser:engine.name(),width,status:'PASSED',autoReady:true,confirmationAndCancel:true,oldOwnerDenied:true,reclaimSingleOwner:true,V1Untouched:true});console.log(JSON.stringify(reports.at(-1)));await context.close();
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
await fs.writeFile(path.join(out,'report.json'),JSON.stringify({reports,backend:'SYNTHETIC',realGoogleJWT:false,productionConnected:false},null,2));console.log('Admin browser report: '+out);
