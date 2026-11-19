import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { settleWishlistPage } from '../src/browser.js';

function settlingPage(states) {
  const calls = {
    readySelector: null,
    waits: 0,
    scrollEvaluations: 0
  };
  return {
    calls,
    async waitForLoadState() {},
    async waitForSelector(selector) {
      if (!calls.readySelector) calls.readySelector = selector;
    },
    async evaluate(callback) {
      if (!callback.toString().includes('paginationSentinel')) return undefined;
      calls.scrollEvaluations += 1;
      return states.shift() || { complete: true, hasMore: false, height: 100, itemCount: 0 };
    },
    async waitForTimeout() {
      calls.waits += 1;
    }
  };
}

test('waits for wishlist-specific markup before trying to scroll', async () => {
  const page = settlingPage([{ complete: true, hasMore: false, height: 100, itemCount: 0 }]);

  await settleWishlistPage(page, 1_000);

  assert.match(page.calls.readySelector, /#g-items/);
  assert.doesNotMatch(page.calls.readySelector, /(?:^|[,\s])body(?:$|[,\s])/);
});

test('keeps revisiting Amazon pagination while a next page is available', async () => {
  const page = settlingPage([
    { complete: false, amazonAllItemsLoaded: false, hasMore: true, height: 100, itemCount: 10 },
    { complete: false, amazonAllItemsLoaded: false, hasMore: true, height: 100, itemCount: 10 },
    { complete: false, amazonAllItemsLoaded: false, hasMore: true, height: 100, itemCount: 10 },
    { complete: true, amazonAllItemsLoaded: false, hasMore: false, height: 180, itemCount: 18 }
  ]);

  await settleWishlistPage(page, 2_000);

  assert.equal(page.calls.scrollEvaluations, 4);
  assert.equal(page.calls.waits, 3);
});

test('waits for an in-flight pagination response even when a completion marker is already present', async () => {
  const events = new EventEmitter();
  const page = settlingPage(Array.from({ length: 4 }, () => ({
    complete: true, amazonAllItemsLoaded: true, hasMore: false, height: 100, itemCount: 13
  })));
  page.on = events.on.bind(events);
  page.off = events.off.bind(events);
  const evaluate = page.evaluate.bind(page);
  const request = { url: () => 'https://www.amazon.com/hz/wishlist/slv/items?cursor=last' };
  page.evaluate = async (callback, arg) => {
    const result = await evaluate(callback, arg);
    if (page.calls.scrollEvaluations === 1) events.emit('request', request);
    if (page.calls.scrollEvaluations === 4) events.emit('requestfinished', request);
    return result;
  };

  const result = await settleWishlistPage(page, 2_000);

  assert.equal(result.amazonAllItemsLoaded, true);
  assert.equal(page.calls.scrollEvaluations, 4);
  assert.equal(page.calls.waits, 3);
  assert.deepEqual(events.eventNames(), []);
});

test('rejects pagination that remains in flight rather than accepting a premature completion marker', async () => {
  const events = new EventEmitter();
  const page = settlingPage(Array.from({ length: 30 }, () => ({
    complete: true, amazonAllItemsLoaded: true, hasMore: false, height: 100, itemCount: 10
  })));
  page.on = events.on.bind(events);
  page.off = events.off.bind(events);
  const evaluate = page.evaluate.bind(page);
  const request = { url: () => 'https://www.amazon.com/hz/wishlist/slv/items?cursor=last' };
  page.evaluate = async (callback, arg) => {
    const result = await evaluate(callback, arg);
    if (page.calls.scrollEvaluations === 1) events.emit('request', request);
    return result;
  };

  await assert.rejects(settleWishlistPage(page, 2_000), /pagination did not finish/);
  assert.deepEqual(events.eventNames(), []);
});
