import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectAccessIssue, hasWishlistStructure, parseWishlistHtml } from '../src/parse-wishlist.js';

const fixtureUrl = new URL('./fixtures/wishlist.html', import.meta.url);
const fixture = readFileSync(fileURLToPath(fixtureUrl), 'utf8');

test('extracts stable ASINs, titles, and canonical product URLs', () => {
  const items = parseWishlistHtml(fixture, { baseUrl: 'https://www.amazon.com/hz/wishlist/ls/example' });
  assert.deepEqual(items, [
    {
      asin: 'B0AAA11111',
      title: 'Wooden Marble Run',
      url: 'https://www.amazon.com/dp/B0AAA11111'
    },
    {
      asin: 'B0BBB22222',
      title: 'Illustrated Space Atlas',
      url: 'https://www.amazon.com/dp/B0BBB22222'
    },
    {
      asin: 'B0CCC33333',
      title: null,
      url: 'https://www.amazon.com/dp/B0CCC33333'
    }
  ]);
  assert.equal(hasWishlistStructure(fixture), true);
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
