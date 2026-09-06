import test from 'node:test';
import assert from 'node:assert/strict';
import { compareItems } from '../src/compare-items.js';

test('comparison separates new, removed, and reactivated products', () => {
  const result = compareItems({
    currentItems: [
      { asin: 'b000000002', title: 'Still here' },
      { asin: 'B000000003', title: 'Returned' },
      { asin: 'B000000004', title: 'Brand new' }
    ],
    activeItems: [
      { asin: 'B000000001' },
      { asin: 'B000000002' }
    ],
    historicalItems: [
      { asin: 'B000000001' },
      { asin: 'B000000002' },
      { asin: 'B000000003' }
    ]
  });

  assert.deepEqual(result.newItems.map((item) => item.asin), ['B000000004']);
  assert.deepEqual(result.reactivatedItems.map((item) => item.asin), ['B000000003']);
  assert.deepEqual(result.removedItems, ['B000000001']);
});

test('comparison deduplicates current products by ASIN', () => {
  const result = compareItems({
    currentItems: [
      { asin: 'B000000001', title: 'First' },
      { asin: 'b000000001', title: 'Duplicate' }
    ],
    activeItems: [],
    historicalItems: []
  });
  assert.equal(result.currentItems.length, 1);
  assert.equal(result.newItems.length, 1);
});
