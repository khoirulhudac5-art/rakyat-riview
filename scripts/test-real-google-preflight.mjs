// Real UI -> real Supabase authorize -> real Google page. Fresh anonymous
// browser: does not enter credentials, consent, exchange a code, or touch cards.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {publicReviewExample} from '../pembeli/review-fallback.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH=path.resolve('.local-tools/browsers');
const require=createRequire(import.meta.url),{chromium}=require(path.resolve('.local-tools/browser-tests/node_modules/playwright'));
const out=path.resolve('test-results/google-live-preflight-'+new Date().toISOString().replace(/[:.]/g,'-'));await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true}),context=await browser.newContext(),page=await context.newPage();
try{
 await page.goto('http://127.0.0.1:4186/preview-new-card');assert.equal(new URL(page.url()).origin,'http://127.0.0.1:4180');
 const mode=await context.request.get('http://127.0.0.1:4180/api/buyer?action=mode').then(r=>r.json());assert.equal(mode.real_auth,true);assert.equal(mode.card_access,'closed');
 await page.fill('#business','Uji Login Lokal Tanpa Klaim');await page.fill('#maps',publicReviewExample.review_url);await page.click('#continue');await page.waitForFunction(()=>!document.getElementById('google').disabled);assert.equal(await page.locator('#demo').isHidden(),true);
 await page.click('#google');await page.waitForURL(url=>url.hostname==='accounts.google.com',{timeout:25000});
 const report={entry:'http://127.0.0.1:4186/preview-new-card',applicationOrigin:'http://127.0.0.1:4180',destination:new URL(page.url()).origin,title:await page.title(),realGooglePageReached:true,realAccountLoginCompleted:false,cardWrites:false};
 await page.screenshot({path:path.join(out,'google-anonymous.png'),fullPage:true});await fs.writeFile(path.join(out,'RESULT.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));console.log('Report: '+out);
}finally{await context.close();await browser.close();}
