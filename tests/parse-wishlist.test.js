import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  detectAccessIssue,
  hasExplicitEmptyState,
  hasWishlistStructure,
  inspectWishlistHtml,
  parseWishlistHtml
} from '../src/parse-wishlist.js';

const fixtureUrl = new URL('./fixtures/wishlist.html', import.meta.url);
const fixture = readFileSync(fileURLToPath(fixtureUrl), 'utf8');

test('extracts stable ASINs, titles, and canonical product URLs', () => {
  const items = parseWishlistHtml(fixture, { baseUrl: 'https://www.amazon.com/hz/wishlist/ls/example' });
  assert.deepEqual(items, [
    {
      asin: 'B0AAA11111',
      title: 'Wooden Marble Run',
      url: 'https://www.amazon.com/dp/B0AAA11111',
      wishlistItemId: 'IEXAMPLE000001',
      identifierType: 'asin'
    },
    {
      asin: 'B0BBB22222',
      title: 'Illustrated Space Atlas',
      url: 'https://www.amazon.com/dp/B0BBB22222',
      wishlistItemId: 'IEXAMPLE000002',
      identifierType: 'asin'
    },
    {
      asin: 'B0CCC33333',
      title: null,
      url: 'https://www.amazon.com/dp/B0CCC33333',
      wishlistItemId: 'IEXAMPLE000003',
      identifierType: 'asin'
    }
  ]);
  assert.equal(hasWishlistStructure(fixture), true);
  assert.equal(items.some((item) => item.asin === 'B0REC99999'), false);
});

test('uses a stable wishlist-row identity for manual and unavailable entries', () => {
  const html = `
    <div id="wishlist-page">
      <ul id="g-items">
        <li class="g-item-sortable awl-ul-keyword-item-container-desktop"
            data-itemid="IMANUAL000001">
          <span id="itemName_IMANUAL000001">PS1 games, Game Boy games, DVDs</span>
          <a href="/hz/wishlist/ls/example?buyingElsewhere=1">Buying this gift elsewhere?</a>
        </li>
      </ul>
      <div id="endOfListMarker"></div>
    </div>
  `;
  const inspection = inspectWishlistHtml(html, { baseUrl: 'https://www.amazon.com/list' });
  assert.equal(inspection.candidateRowCount, 1);
  assert.deepEqual(inspection.items, [{
    asin: 'WISHLIST_ITEM:IMANUAL000001',
    title: 'PS1 games, Game Boy games, DVDs',
    url: null,
    wishlistItemId: 'IMANUAL000001',
    identifierType: 'wishlist_item'
  }]);
});

test('recognizes a definitive Amazon empty-list state without parsing recommendations', () => {
  const html = `
    <div id="wishlist-page">
      <ul id="g-items"><li class="a-spacing-none"></li></ul>
      <div id="no-items-section">There are no items in this List.</div>
    </div>
    <a href="/dp/B0REC99999">Recommended product</a>
  `;
  const inspection = inspectWishlistHtml(html, { baseUrl: 'https://www.amazon.com/list' });
  assert.equal(hasExplicitEmptyState(html), true);
  assert.equal(inspection.explicitEmpty, true);
  assert.equal(inspection.itemCount, 0);
  assert.deepEqual(inspection.items, []);
  assert.equal(inspection.selectorCounts['a[href*="/dp/"]'], 1);
});

test('detects sign-in and CAPTCHA pages without interpreting products', () => {
  assert.equal(detectAccessIssue({
    html: '<form name="signIn"></form>',
    url: 'https://www.amazon.com/ap/signin',
    title: 'Amazon Sign-In'
  }), 'authentication');
  assert.equal(detectAccessIssue({
    html: '<p>Enter the characters you see below</p>',
    url: 'https://www.amazon.com/errors/validateCaptcha',
    title: 'Robot Check'
  }), 'captcha');
});
