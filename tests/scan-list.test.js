import test from 'node:test';
import assert from 'node:assert/strict';
import { scanWishlistPage } from '../src/scan-list.js';
import {
  AuthenticationRequiredError,
  CaptchaDetectedError,
  PageStructureError,
  SuspiciousResultError
} from '../src/errors.js';

function pageFor({ html, url = 'https://www.amazon.com/hz/wishlist/ls/EXAMPLE', title = 'List' }) {
  return {
    async goto() { return { status: () => 200 }; },
    async waitForLoadState() {},
    async waitForSelector() {},
    async evaluate(callback) {
      return callback.toString().includes('scrollHeight') ? 100 : undefined;
    },
    async waitForTimeout() {},
    async content() { return html; },
    async title() { return title; },
    url() { return url; }
  };
}

const list = {
  id: 'family',
  name: 'Family List',
  url: 'https://www.amazon.com/hz/wishlist/ls/EXAMPLE'
};

test('accepts a definitive empty-list state without treating recommendations as items', async () => {
  const result = await scanWishlistPage({
    page: pageFor({
      html: '<html><div id="wishlist-page"><ul id="g-items"></ul><div id="no-items-section">There are no items in this List.</div></div><a href="/dp/B0REC99999">Recommendation</a></html>'
    }),
    list,
    timeoutMs: 1_000,
    previousActiveCount: 3
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.inspection.explicitEmpty, true);
});

test('rejects a recognized but ambiguous empty wish list', async () => {
  await assert.rejects(scanWishlistPage({
    page: pageFor({ html: '<html><div id="wishlist-page"><ul id="g-items"></ul></div></html>' }),
    list,
    timeoutMs: 1_000,
    previousActiveCount: 3
  }), SuspiciousResultError);
});

test('rejects non-empty results without a completed-list marker', async () => {
  await assert.rejects(scanWishlistPage({
    page: pageFor({
      html: '<html><div id="wishlist-page"><ul id="g-items"><li class="g-item-sortable" data-itemid="ITEM"><h2><a href="/dp/B000000001">Item</a></h2></li></ul></div></html>'
    }),
    list,
    timeoutMs: 1_000
  }), SuspiciousResultError);
});

test('rejects item rows that cannot all be mapped to unique ASINs', async () => {
  await assert.rejects(scanWishlistPage({
    page: pageFor({
      html: '<html><div id="wishlist-page"><ul id="g-items"><li class="g-item-sortable" data-itemid="ONE"><h2><a href="/dp/B000000001">Item</a></h2></li><li class="g-item-sortable" data-itemid="TWO">Changed markup</li></ul><div id="endOfListMarker"></div></div></html>'
    }),
    list,
    timeoutMs: 1_000
  }), PageStructureError);
});

test('rejects contradictory empty and populated markers', async () => {
  await assert.rejects(scanWishlistPage({
    page: pageFor({
      html: '<html><div id="wishlist-page"><ul id="g-items"><li class="g-item-sortable" data-itemid="ONE"><h2><a href="/dp/B000000001">Item</a></h2></li></ul><div id="no-items-section">No items</div><div id="endOfListMarker"></div></div></html>'
    }),
    list,
    timeoutMs: 1_000
  }), SuspiciousResultError);
});

test('rejects sign-in pages', async () => {
  await assert.rejects(scanWishlistPage({
    page: pageFor({
      html: '<html><form name="signIn"></form></html>',
      url: 'https://www.amazon.com/ap/signin'
    }),
    list,
    timeoutMs: 1_000
  }), AuthenticationRequiredError);
});

test('rejects CAPTCHA pages', async () => {
  await assert.rejects(scanWishlistPage({
    page: pageFor({
      html: '<html>Enter the characters you see below</html>',
      url: 'https://www.amazon.com/errors/validateCaptcha'
    }),
    list,
    timeoutMs: 1_000
  }), CaptchaDetectedError);
});
