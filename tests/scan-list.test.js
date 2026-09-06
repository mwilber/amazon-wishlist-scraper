import test from 'node:test';
import assert from 'node:assert/strict';
import { scanWishlistPage } from '../src/scan-list.js';
import {
  AuthenticationRequiredError,
  CaptchaDetectedError,
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

test('rejects a recognized but unexpectedly empty wish list', async () => {
  await assert.rejects(scanWishlistPage({
    page: pageFor({ html: '<html><div id="wishlist-page"><ul id="g-items"></ul></div></html>' }),
    list,
    timeoutMs: 1_000,
    previousActiveCount: 3
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
