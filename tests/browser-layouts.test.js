import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { scanWishlistPage } from '../src/scan-list.js';

const list = {
  id: 'family',
  name: 'Family Wish List',
  url: 'https://www.amazon.com/hz/wishlist/ls/EXAMPLE'
};

test('scans both layouts and paginates grids in Chromium without network access', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  async function scanHtml(html, paginationHandler) {
    const page = await browser.newPage();
    try {
      await page.route('**/*', (route) => {
        if (paginationHandler && new URL(route.request().url()).pathname === '/hz/wishlist/slv/items') {
          return paginationHandler(route);
        }
        return route.fulfill({ contentType: 'text/html', body: html });
      });
      const result = await scanWishlistPage({ page, list, timeoutMs: 5_000 });
      const paginationRequests = await page.evaluate(() => window.paginationRequests);
      return { ...result, paginationRequests };
    } finally {
      await page.close();
    }
  }

  for (const fixture of ['wishlist.html', 'wishlist-grid.html']) {
    await t.test(fixture, async () => {
      const html = readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8');
      const result = await scanHtml(html);
      assert.equal(result.items.length, 3);
      assert.equal(result.inspection.containerCount, 1);
      assert.equal(result.inspection.candidateRowCount, 3);
      assert.equal(result.items[0].title, 'Wooden Marble Run');
      assert.equal(result.items.some((item) => item.asin === 'B0REC99999'), false);
    });
  }

  await t.test('a hidden wishlist wrapper does not block parsing a complete list', async () => {
    const result = await scanHtml(`<!doctype html>
      <div id="wishlist-page" style="display: none"></div>
      <ul id="g-items"><li class="g-item-sortable" data-itemid="IEXAMPLE000001">
        <a href="/dp/B0AAA11111">Product</a>
      </li></ul><div id="endOfListMarker"></div>`);
    assert.equal(result.items.length, 1);
  });

  await t.test('grid pagination with an unchanged page height', async () => {
    const result = await scanHtml(`<!doctype html>
      <style>html { height: 1000px } #g-items-grid { height: 200px; overflow: auto }</style>
      <ul id="g-items-grid">
        <li class="g-item-sortable" data-itemid="IEXAMPLE000001">
          <a title="First product" href="/dp/B0AAA11111">Quick View</a>
        </li>
        <li id="pagination"><input class="showMoreUrl" type="hidden" value="/next-page"></li>
      </ul>
      <script>
        window.paginationRequests = 0;
        const scrollState = { allItemsLoaded: false };
        window.P = {
          when: () => ({ execute: (callback) => callback({
            state: () => scrollState,
            trigger: (event) => {
              if (event !== 'wl-load-more-items') throw new Error('Unexpected event');
              window.paginationRequests += 1;
              // A slow page must not be requested again while the cursor is unchanged.
              if (window.paginationRequests === 1) {
                window.setTimeout(() => {
                  document.querySelector('#pagination').insertAdjacentHTML('beforebegin',
                    '<li class="g-item-sortable" data-itemid="IEXAMPLE000002">' +
                      '<a title="Second product" href="/dp/B0BBB22222">Quick View</a></li>');
                  scrollState.allItemsLoaded = true;
                }, 1_200);
              }
            }
          }) })
        };
      </script>`);
    assert.deepEqual(result.items.map((item) => item.asin), ['B0AAA11111', 'B0BBB22222']);
    assert.equal(result.paginationRequests, 1);
    assert.equal(result.inspection.amazonAllItemsLoaded, true);
    assert.equal(result.inspection.selectorCounts['#endOfListMarker'], 0);
  });

  for (const container of ['g-items', 'g-items-grid']) {
    await t.test(`${container}: tracks pagination started during navigation`, async () => {
      let paginationRequests = 0;
      const result = await scanHtml(`<!doctype html>
        <ul id="${container}">
          <li class="g-item-sortable" data-itemid="IEXAMPLE000001">
            <a href="/dp/B0AAA11111">First product</a>
          </li>
          <li id="pagination"><input class="showMoreUrl" type="hidden" value="/hz/wishlist/slv/items?cursor=last"></li>
        </ul>
        <script>
          const scrollState = { allItemsLoaded: false };
          function loadMore() {
            fetch('/hz/wishlist/slv/items?cursor=last').then(response => response.json()).then(() => {
              document.querySelector('#pagination').insertAdjacentHTML('beforebegin',
                '<li class="g-item-sortable" data-itemid="IEXAMPLE000002">' +
                  '<a href="/dp/B0BBB22222">Second product</a></li><li id="endOfListMarker"></li>');
              scrollState.allItemsLoaded = true;
            });
          }
          window.P = { when: () => ({ execute: callback => callback({
            state: () => scrollState, trigger: loadMore
          }) }) };
          // Amazon can load the next page before DOMContentLoaded and our settling loop.
          loadMore();
        </script>`, async (route) => {
        paginationRequests += 1;
        await new Promise(resolve => setTimeout(resolve, 600));
        await route.fulfill({ json: {} });
      });
      assert.equal(paginationRequests, 1);
      assert.equal(result.items.length, 2);
      assert.equal(result.inspection.candidateRowCount, 2);
      assert.equal(result.inspection.selectorCounts['#endOfListMarker'], 1);
    });

    await t.test(`${container}: delayed pagination responses never overlap or duplicate items`, async () => {
      const cursors = [];
      let activeRequests = 0;
      let maxActiveRequests = 0;
      const result = await scanHtml(`<!doctype html>
        <style>html { height: 2000px }</style>
        <ul id="${container}">
          ${Array.from({ length: 10 }, (_, i) => `
            <li class="g-item-sortable" data-itemid="IEXAMPLE${String(i).padStart(6, '0')}">
              <a href="/dp/B${String(i).padStart(9, '0')}">Product ${i}</a>
            </li>`).join('')}
          <li id="pagination"><input class="showMoreUrl" type="hidden" value="/hz/wishlist/slv/items"></li>
        </ul>
        <script>
          window.paginationRequests = 0;
          const scrollState = { allItemsLoaded: false, lastEvaluatedKey: 'first' };
          function loadMore() {
            if (scrollState.allItemsLoaded) return;
            window.paginationRequests += 1;
            fetch('/hz/wishlist/slv/items?cursor=' + scrollState.lastEvaluatedKey)
              .then(response => response.json())
              .then(data => {
                const pagination = document.querySelector('#pagination');
                for (const i of data.items) {
                  pagination.insertAdjacentHTML('beforebegin',
                    '<li class="g-item-sortable" data-itemid="IEXAMPLE' + String(i).padStart(6, '0') + '">' +
                      '<a href="/dp/B' + String(i).padStart(9, '0') + '">Product ' + i + '</a></li>');
                }
                scrollState.lastEvaluatedKey = data.nextCursor;
                if (!data.nextCursor) {
                  scrollState.allItemsLoaded = true;
                  pagination.insertAdjacentHTML('beforebegin', '<li id="endOfListMarker">End of list</li>');
                }
              });
          }
          window.P = { when: () => ({ execute: callback => callback({
            state: () => scrollState,
            trigger: loadMore
          }) }) };
          // Scrolling is a second possible source of requests, as on Amazon.
          window.addEventListener('scroll', loadMore);
        </script>`, async (route) => {
        const cursor = new URL(route.request().url()).searchParams.get('cursor');
        cursors.push(cursor);
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        try {
          // Longer than the scanner's polling interval, exposing overlapping loads.
          await new Promise(resolve => setTimeout(resolve, 600));
          await route.fulfill({
            json: cursor === 'first'
              ? { items: [10, 11], nextCursor: 'last' }
              : { items: [12], nextCursor: '' }
          });
        } finally {
          activeRequests -= 1;
        }
      });
      assert.deepEqual(cursors, ['first', 'last']);
      assert.equal(maxActiveRequests, 1);
      assert.equal(result.paginationRequests, 2);
      assert.equal(result.items.length, 13);
      assert.equal(result.inspection.candidateRowCount, 13);
      assert.equal(result.inspection.selectorCounts['#endOfListMarker'], 1);
    });
  }
});
