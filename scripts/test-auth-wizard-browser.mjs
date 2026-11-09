// Real local Auth preview, NO mocked accounts/tokens/provider responses.
// This fresh browser is intentionally NOT logged in; it verifies draft behavior,
// not real Google consent. The signed-in user's browser is never opened/copied.
import {createRequire} from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
process.env.PLAYWRIGHT_BROWSERS_PATH=path.resolve('.local-tools/browsers');
const require=createRequire(import.meta.url),{chromium,firefox}=require(path.resolve('.local-tools/browser-tests/node_modules/playwright'));
const base='http://127.0.0.1:4180',wizard=base+'/pembeli/mulai.html?card=AUTH-WIZARD-LOCAL';
const review='https://search.google.com/local/writereview?placeid=ChIJlXzqDCCyEmsRtNKefKjwtbo';
const reports=[],out=path.resolve('test-results/auth-wizard-'+new Date().toISOString().replace(/[:.]/g,'-'));await fs.mkdir(out,{recursive:true});
for(const [engine,width]of [[chromium,1440],[chromium,375],[firefox,375]]){
 const browser=await engine.launch({headless:true}),context=await browser.newContext({viewport:{width,height:900}});
 try{
  // No outbound browser navigation is allowed by this draft-only test.
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  const page=await context.newPage();await page.goto(base+'/preview-auth-wizard');assert.equal(page.url(),wizard);
  await page.locator('#business').fill('Uji OAuth sintetis');await page.locator('#maps').fill(review);await page.waitForFunction(()=>!document.getElementById('continue').disabled);await page.locator('#continue').click();await page.locator('#auth-wizard-controls').waitFor({state:'visible'});
  assert.equal(await page.locator('#demo').isVisible(),false);assert.equal(await page.locator('#claim-card').isVisible(),false);
  await page.reload();await page.locator('#summary').waitFor({state:'visible'});assert.equal(await page.locator('#business').inputValue(),'Uji OAuth sintetis');assert.equal(await page.locator('#maps').inputValue(),review);assert.equal(await page.locator('#sum-code').textContent(),'AUTH-WIZARD-LOCAL');
  await page.waitForFunction(()=>document.getElementById('google-status').textContent.includes('Belum terhubung'));assert.equal(await page.locator('#step-3').getAttribute('data-state'),'active');assert.equal(await page.locator('#step-state-3').textContent(),'Saat ini');assert.equal(await page.locator('#google-status').textContent().then(t=>t.includes('Akun terhubung')),false);
  await page.goto(base+'/pembeli/oauth.html?error=access_denied');await page.waitForFunction(()=>document.getElementById('status').textContent.includes('dibatalkan'));
  await page.goto(wizard);await page.locator('#summary').waitFor({state:'visible'});assert.equal(await page.locator('#business').inputValue(),'Uji OAuth sintetis');assert.equal(await page.locator('#maps').inputValue(),review);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const mode=await(await context.request.get(base+'/api/buyer?action=mode')).json();assert.equal(mode.mode,'supabase');assert.equal(mode.auth_wizard_test,true);
  const denied=await context.request.post(base+'/api/buyer',{headers:{Origin:base,'X-Buyer-Request':'1'},data:{action:'first-claim',card_code:'AUTH-WIZARD-LOCAL'}});assert.equal(denied.status(),403);
  assert.equal((await context.request.get(base+'/api/buyer-status?card=NOT-LOCAL-CARD')).status(),403);
  await page.screenshot({path:path.join(out,engine.name()+'-'+width+'.png'),fullPage:true});reports.push({browser:engine.name(),width,draftRefresh:true,cardContext:true,draftAfterCanceledOAuth:true,noOverflow:true,claimsBlocked:true,realGoogleRoundtrip:false});console.log(JSON.stringify(reports.at(-1)));
 }finally{await context.close();await browser.close();}
}
await fs.writeFile(path.join(out,'report.json'),JSON.stringify({reports,accountsOrTokensSimulated:false,googleLoginPerformed:false},null,2));console.log('Draft test report: '+out);
