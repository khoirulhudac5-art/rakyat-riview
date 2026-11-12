import assert from 'node:assert/strict';
import { generateCardCode, generateUniqueCardCodes, isValidCardCode, CARD_CODE_CHARSET } from '../lib/card-code.mjs';

console.log('Testing card-code generator...');

// 1. Single generation
const single = generateCardCode();
assert.equal(single.length, 8, 'Card code length must be 8');
assert.ok(isValidCardCode(single), `Card code ${single} must match valid format`);
assert.ok(!/[01IO]/.test(single), `Card code ${single} must not contain ambiguous chars 0, 1, I, O`);

// 2. Batch generation of 1, 10, 50, 100
for (const count of [1, 10, 50, 100]) {
  const batch = generateUniqueCardCodes(count);
  assert.equal(batch.length, count, `Batch size should match ${count}`);
  const set = new Set(batch);
  assert.equal(set.size, count, `Batch of ${count} must have 0 collisions`);
  for (const c of batch) {
    assert.ok(isValidCardCode(c), `Code ${c} must be valid`);
  }
}

// 3. Collision test on 10,000 codes
console.log('Generating 10,000 codes for collision test...');
const largeBatch = generateUniqueCardCodes(10000);
const largeSet = new Set(largeBatch);
assert.equal(largeSet.size, 10000, '10,000 codes must all be distinct');
assert.ok(!largeBatch.some(c => /[01IO]/.test(c)), 'None should contain ambiguous characters');

console.log('PASS: All card-code generator tests passed.');
