import test from 'node:test';
import assert from 'node:assert/strict';
import {converter} from '../pembeli/maps.mjs';
import {localProductPreview,publicReviewExample} from '../pembeli/review-fallback.mjs';
const review=publicReviewExample.review_url;
test('direct review works with unavailable network/API, aborts pending Maps resolution and rejects stale results',async()=>{
 let scheduled,resolvePending,signal,network=0;const updates=[];
 const work=converter({schedule:fn=>{scheduled=fn;return 1;},cancel(){},update:r=>updates.push(r),resolve:(_,s)=>{network++;signal=s;return new Promise(r=>resolvePending=r);}});
 work.input('https://maps.app.goo.gl/pending-fixture');const pending=scheduled();assert.equal(network,1);
 work.input('  '+review+'  ');assert.equal(signal.aborted,true);assert.equal(updates.at(-1).state,'ready');assert.equal(updates.at(-1).url,review);assert.equal(updates.at(-1).verification,'user_provided');
 resolvePending({review_url:review.replace('ChIJ','ChITestOnly')});await pending;assert.equal(updates.at(-1).url,review);
 for(const bad of ['https://evil.example/','javascript:alert(1)','https://user:pw@search.google.com/local/writereview?placeid=ChIBadFixture','https://search.google.com/local/writereview?placeid=bad']){work.input(bad);assert.notEqual(updates.at(-1).state,'ready');assert.equal(updates.at(-1).url,null);}
 work.input(review);assert.equal(updates.at(-1).state,'ready');assert.equal(network,1);work.dispose();
});
test('resolver failure retains diagnostic code and never treats the failed Maps URL as a review result',async()=>{
 let task;const updates=[];
 const work=converter({schedule:f=>{task=f;return 1;},cancel(){},resolve:async()=>{throw Object.assign(Error('Network blocked'),{code:'RESOLVER_NETWORK_BLOCKED'});},update:r=>updates.push(r)});
 work.input('https://maps.app.goo.gl/error-fixture');await task();assert.equal(updates.at(-1).code,'RESOLVER_NETWORK_BLOCKED');assert.equal(updates.at(-1).url,null);assert.equal(updates.at(-1).state,'error');
});
test('public simulation choice is gated to explicit product preview on HTTP loopback',()=>{
 assert.equal(localProductPreview(true,'http://127.0.0.1:4186'),true);assert.equal(localProductPreview(true,'http://localhost:4186'),true);
 for(const [flag,url] of [[false,'http://127.0.0.1:4186'],[true,'https://review.example'],[true,'http://192.168.1.5:4186'],[true,'invalid']])assert.equal(localProductPreview(flag,url),false);
});
