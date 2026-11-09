// Local fixture OAuth only; never logs or contacts Google/Supabase.
import {createRequire} from 'node:module';
import path from 'node:path';import fs from 'node:fs';
import {PILOT_CARD} from '../lib/public-pilot.mjs';
const require=createRequire(import.meta.url);
export async function pilotBrowser({fixture,check,folder,phase,winner='A'}){
 const {chromium}=require(path.resolve('.local-tools/browser-tests/node_modules/playwright'));
 const browser=await chromium.launch({channel:phase==='ready'?'chrome':'msedge',headless:true});let debugPage;
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  const page=await context.newPage();debugPage=page;let account=phase==='ready'?'A':winner;
  await context.route('https://**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.origin===fixture.issuer&&u.pathname==='/auth/v1/authorize')return route.fulfill({status:302,headers:{location:fixture.origin+'/fixture-google?challenge='+u.searchParams.get('code_challenge')+'&account='+account},body:''});
   return route.abort();
  });
  if(phase==='ready'){
   await page.goto(fixture.origin+'/r/'+PILOT_CARD);await page.waitForURL('**/pembeli/mulai.html?card=*');
   await page.locator('#business').waitFor();check('HTTP ready scan opens existing wizard',await page.locator('#business').isVisible());
   await page.locator('#business').fill('Synthetic pilot business');
   await page.locator('#maps').fill('https://search.google.com/local/writereview?placeid=ChISyntheticPilot2345');
   await page.locator('#continue').click();await page.locator('#google').click();await page.waitForURL('**/pembeli/mulai.html?card=*');
   await page.waitForFunction(()=>document.getElementById('identity').textContent.includes('Terhubung'));
   check('fixture PKCE callback restores account and draft',await page.locator('#sum-name').textContent()==='Synthetic pilot business');
   await page.reload();await page.waitForFunction(()=>document.getElementById('identity').textContent.includes('Terhubung'));
   check('refresh retains fixture session and draft',await page.locator('#sum-name').textContent()==='Synthetic pilot business');
   await page.locator('#wizard-logout').click();await page.waitForFunction(()=>document.getElementById('step-state-3').textContent!=='Selesai');
   check('logout synchronizes wizard and retains draft',await page.locator('#google').isVisible()&&await page.locator('#business').inputValue()==='Synthetic pilot business');
   for(const width of [320,375,400,1280]){await page.setViewportSize({width,height:900});check('wizard no overflow '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
   await page.screenshot({path:path.join(folder,'wizard-fixture.png'),fullPage:true});
   await page.setViewportSize({width:1280,height:900});
   await page.locator('#google').click();await page.waitForFunction(()=>document.getElementById('identity')?.textContent.includes('Terhubung'));
   await page.locator('#claim-card').click();await page.waitForURL('**/dashboard.html');await page.getByText('Synthetic pilot business',{exact:true}).first().waitFor();
   check('browser ready login claim dashboard end-to-end',true);
  }else{
   await page.goto(fixture.origin+'/pembeli/mulai.html?card='+PILOT_CARD);
   // Direct local fixture tokens are minted only by this test harness; UI login uses real callback code above.
   const uid=winner==='A'?'f1111111-1111-4111-8111-111111111111':'f2222222-2222-4222-8222-222222222222',s=fixture.session(uid);
   await context.addCookies([{name:'rr_buyer_a',value:s.access_token,url:fixture.origin,httpOnly:true,sameSite:'Strict'},{name:'rr_buyer_r',value:s.refresh_token,url:fixture.origin,httpOnly:true,sameSite:'Strict'}]);
   await page.goto(fixture.origin+'/dashboard.html');await page.getByText('Synthetic pilot business',{exact:true}).first().waitFor();
   check('approved dashboard reads local PostgreSQL ownership',(await page.locator('body').innerText()).includes(PILOT_CARD));
   for(const width of [320,375,400,1280]){await page.setViewportSize({width,height:900});check('dashboard no overflow '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
   await page.screenshot({path:path.join(folder,'dashboard-fixture.png'),fullPage:true});
   await page.goto(fixture.origin+'/kartu.html?id='+PILOT_CARD);await page.locator('#save').waitFor();
   check('pilot owner edit explicitly disabled',await page.locator('#save').isDisabled());
   await page.reload();await page.locator('#save').waitFor();check('dashboard refresh keeps owner card',await page.locator('#card-code').inputValue()===PILOT_CARD);
  }
  await context.close();
 }catch(error){if(debugPage){await debugPage.screenshot({path:path.join(folder,'browser-failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(folder,'browser-failure.txt'),(error.message||'').replace(/https?:\/\/\S+/g,'[URL]')+'\n'+await debugPage.locator('body').innerText().catch(()=>''));}throw error;}finally{await browser.close();}
}
