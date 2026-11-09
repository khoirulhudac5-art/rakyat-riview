import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDashboard} from '../pembeli/dashboard-data.mjs';
const card={card_code:'D'.repeat(24),business_name:'Fixture',active:true,review_url:'https://search.google.com/local/writereview?placeid=ChITestOnly'};
test('dashboard accepts server ownership rows; missing or malformed card responses fail instead of becoming an empty dashboard',()=>{
 assert.equal(normalizeDashboard({cards:[card]}).cards[0].card_code,card.card_code);
 for(const cards of [null,{},[null],[{...card,card_code:'../other'}],[card,card]])assert.throws(()=>normalizeDashboard({cards}));
 assert.equal(normalizeDashboard({cards:[{...card,active:'false'}]}).cards[0].active,false);
});
test('missing counters are unknown, measured zero is zero, and no channel count is inferred from total scans',()=>{
 const a=normalizeDashboard({cards:[card],statistics:{available:true,visits:null,redirects:0,nfc:undefined,qr:'',series:[]}}).statistics;
 assert.equal(a.available,true);assert.equal(a.visits,null);assert.equal(a.redirects,0);assert.equal(a.nfc,null);assert.equal(a.qr,null);
 const b=normalizeDashboard({cards:[card],statistics:{available:true,visits:20,redirects:'15'}}).statistics;
 assert.equal(b.visits,20);assert.equal(b.redirects,15);assert.equal(b.nfc,null);assert.equal(b.qr,null);
});
test('real dashboard discards synthetic statistics; explicit simulation remains labeled synthetic',()=>{
 const payload={cards:[card],statistics:{available:true,synthetic:true,visits:999,redirects:999,series:[{date:'2026-11-07',visits:999,redirects:999}]}};
 const real=normalizeDashboard(payload).statistics;assert.equal(real.available,false);assert.equal(real.visits,null);assert.deepEqual(real.series,[]);
 const simulated=normalizeDashboard(payload,{simulation:true}).statistics;assert.equal(simulated.available,true);assert.equal(simulated.synthetic,true);assert.equal(simulated.visits,999);
});
test('statistics use valid daily measurements and only matching server-owned card keys without fabricating missing dates',()=>{
 const statistics=normalizeDashboard({cards:[card],statistics:{available:true,visits:8,series:[{date:'2026-11-06',visits:2,redirects:1},{date:'2026-02-31',visits:2,redirects:1},{date:'2026-11-01',visits:3,redirects:2},{date:'2026-11-02',visits:null,redirects:0}],by_card:{[card.card_code]:{visits:8,redirects:0},UNLISTED:{visits:999}}}}).statistics;
 assert.deepEqual(statistics.series.map(p=>p.date),['2026-11-01','2026-11-06']);assert.deepEqual(Object.keys(statistics.by_card),[card.card_code]);
 assert.equal(statistics.by_card[card.card_code].redirects,0);assert.equal(statistics.by_card[card.card_code].nfc,null);
 const duplicate=normalizeDashboard({cards:[card],statistics:{available:true,series:[{date:'2026-11-06',visits:2,redirects:1},{date:'2026-11-06',visits:3,redirects:1}]}}).statistics;
 assert.deepEqual(duplicate.series,[]);assert.equal(duplicate.available,false);
});
