// Existing UI against the isolated PostgreSQL preview, never production.
import fs from 'node:fs/promises';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(path.resolve('.local-tools/browser-tests/node_modules/playwright'));
const folder=path.resolve('test-results/admin-generate-browser-'+new Date().toISOString().replace(/[:.]/g,'-'));await fs.mkdir(folder,{recursive:true});
const results=[];let browser;
try{
 for(const [channel,width] of [['chrome',1440],['chrome',320],['msedge',400]]){
  browser=await chromium.launch({channel,headless:true});const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>{const u=new URL(r.request().url());return u.origin==='http://127.0.0.1:4193'?r.continue():r.abort();});
  await page.goto('http://127.0.0.1:4193/admin-v2.html');await page.locator('input[type=password]').fill('local-generate-admin-only');await page.locator('button[type=submit]').click();
  await page.locator('#open-create').waitFor();await page.waitForFunction(()=>document.querySelector('#inventory-result')?.textContent.includes('kartu'));
  if(await page.locator('#open-create').isDisabled())throw Error('Generate unexpectedly disabled');
  if(!await page.locator('#export-cards').isDisabled()||!await page.locator('#production-export').isDisabled())throw Error('URL export enabled without confirmed domain');
  await page.locator('#open-create').click();await page.locator('#create-quantity').fill('1');
  const responsePromise=page.waitForResponse(r=>r.url().includes('/api/v2-admin')&&r.request().method()==='POST'&&r.request().postDataJSON()?.action==='create');
  await page.locator('#create-submit').click();const response=await responsePromise,body=await response.json();
  if(response.status()!==200||!body.success||body.cards.length!==1||body.cards[0].card_url!==null)throw Error('Generate UI/HTTP failed');
  await page.waitForFunction(()=>!document.querySelector('#create-dialog')?.open);
  if(await page.evaluate(()=>sessionStorage.getItem('rr-admin-generate-pending-v1')!==null))throw Error('Confirmed request UUID was not cleared');
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Horizontal overflow');
  if(errors.length)throw Error('Browser page error');
  await page.screenshot({path:path.join(folder,channel+'-'+width+'.png'),fullPage:false});
  results.push({channel,width,pass:true,checks:['real Admin HTTP session','local SQL generate','existing UI/no page errors','domain export disabled','request UUID cleared on success','no horizontal overflow']});
  await context.close();await browser.close();browser=null;
 }
}finally{if(browser)await browser.close();await fs.writeFile(path.join(folder,'RESULT.json'),JSON.stringify({productionConnected:false,source:'isolated_postgres_synthetic',results},null,2));console.log(JSON.stringify({passed:results.length,checks:results.length*6,folder}));}
