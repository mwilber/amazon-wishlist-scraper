import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const gridFixture = readFileSync(new URL('./fixtures/wishlist-grid.html', import.meta.url), 'utf8');

test('accepts a complete grid wish list', async () => {
  const result = await scanWishlistPage({ page: pageFor({ html: gridFixture }), list, timeoutMs: 1_000 });
  assert.equal(result.items.length, 3);
  assert.equal(result.inspection.containerCount, 1);
  assert.equal(result.inspection.candidateRowCount, 3);
});

test('keeps completeness and row-validation safeguards for grids', async (t) => {
  const cases = [
    {
      name: 'missing end-of-list marker',
      html: gridFixture.replace('id="endOfListMarker"', 'id="missing-marker"'),
      error: SuspiciousResultError
    },
    {
      name: 'unparseable grid row',
      html: gridFixture.replace('</ul>', '<li class="g-item-sortable" data-itemid="IUNKNOWN00001">Unknown markup</li></ul>'),
      error: PageStructureError
    },
    {
      name: 'duplicate product identities',
      html: gridFixture.replaceAll('B0BBB22222', 'B0AAA11111'),
      error: PageStructureError
    },
    {
      name: 'contradictory empty marker',
      html: gridFixture.replace('</ul>', '<li id="no-items-section">No items</li></ul>'),
      error: SuspiciousResultError
    },
    {
      name: 'both grid and list containers',
      html: gridFixture.replace('</body>', '<ul id="g-items"></ul></body>'),
      error: PageStructureError
    },
    {
      name: 'multiple grid containers',
      html: gridFixture.replace('</body>', '<ul id="g-items-grid"></ul></body>'),
      error: PageStructureError
    }
  ];
  for (const { name, html, error } of cases) {
    await t.test(name, async () => {
      await assert.rejects(scanWishlistPage({ page: pageFor({ html }), list, timeoutMs: 1_000 }), error);
    });
  }
});

test('accepts a definitive empty grid while rejecting ambiguous empty grids', async () => {
  const html = '<ul id="g-items-grid"></ul><div id="no-items-section">No items</div>';
  const result = await scanWishlistPage({ page: pageFor({ html }), list, timeoutMs: 1_000 });
  assert.deepEqual(result.items, []);
  await assert.rejects(scanWishlistPage({
    page: pageFor({ html: '<ul id="g-items-grid"></ul>' }), list, timeoutMs: 1_000, previousActiveCount: 8
  }), SuspiciousResultError);
});

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

test('accepts Amazon pagination state as completion when its DOM marker is omitted', async () => {
  const page = pageFor({
    html: '<html><div id="wishlist-page"><ul id="g-items"><li class="g-item-sortable" data-itemid="ITEM"><h2><a href="/dp/B000000001">Item</a></h2></li></ul></div></html>'
  });
  page.evaluate = async (callback) => callback.toString().includes('paginationSentinel')
    ? {
        complete: true,
        amazonAllItemsLoaded: true,
        hasMore: true,
        height: 100,
        itemCount: 1
      }
    : undefined;

  const result = await scanWishlistPage({ page, list, timeoutMs: 1_000 });

  assert.equal(result.items.length, 1);
  assert.equal(result.inspection.amazonAllItemsLoaded, true);
});

test('rejects item rows that cannot all be mapped to unique identities', async () => {
  await assert.rejects(scanWishlistPage({
    page: pageFor({
      html: '<html><div id="wishlist-page"><ul id="g-items"><li class="g-item-sortable" data-itemid="ONE"><h2><a href="/dp/B000000001">Item</a></h2></li><li class="g-item-sortable" data-itemid="TWO">Changed markup</li></ul><div id="endOfListMarker"></div></div></html>'
    }),
    list,
    timeoutMs: 1_000
  }), PageStructureError);
});

test('accepts labeled manual entries without product links', async () => {
  const result = await scanWishlistPage({
    page: pageFor({
      html: '<html><div id="wishlist-page"><ul id="g-items"><li class="g-item-sortable" data-itemid="IPRODUCT00001"><span id="itemName_IPRODUCT00001"><a href="/dp/B000000001">Product</a></span></li><li class="g-item-sortable awl-ul-keyword-item-container-desktop" data-itemid="IMANUAL000001"><span id="itemName_IMANUAL000001">A manually entered gift</span><a href="?buyingElsewhere=1">Buying this gift elsewhere?</a></li></ul><div id="endOfListMarker"></div></div></html>'
    }),
    list,
    timeoutMs: 1_000
  });
  assert.equal(result.inspection.candidateRowCount, 2);
  assert.deepEqual(result.items.map((item) => item.asin), [
    'B000000001',
    'WISHLIST_ITEM:IMANUAL000001'
  ]);
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
