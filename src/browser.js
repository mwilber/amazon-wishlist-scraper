import { chmod, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { WISHLIST_CONTAINER_SELECTOR } from './wishlist-selectors.js';

export async function launchBrowser(config, { headed = false } = {}) {
  await mkdir(config.browserProfilePath, { recursive: true, mode: 0o700 });
  await chmod(config.browserProfilePath, 0o700);
  return chromium.launchPersistentContext(config.browserProfilePath, {
    headless: headed ? false : config.headless,
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US'
  });
}

export function trackWishlistPagination(page) {
  const pendingRequests = new Set();
  const trackRequest = (request) => {
    if (/\/hz\/wishlist\/(?:slv\/)?items(?:[/?#]|$)/.test(request.url())) {
      pendingRequests.add(request);
    }
  };
  const finishRequest = (request) => pendingRequests.delete(request);
  page.on?.('request', trackRequest);
  page.on?.('requestfinished', finishRequest);
  page.on?.('requestfailed', finishRequest);
  return {
    pendingRequests,
    dispose() {
      page.off?.('request', trackRequest);
      page.off?.('requestfinished', finishRequest);
      page.off?.('requestfailed', finishRequest);
    }
  };
}

export async function settleWishlistPage(page, timeoutMs, pagination = trackWishlistPagination(page)) {
  let stableRounds = 0;
  let previousSignature = null;
  let amazonAllItemsLoaded = false;
  const requestedPages = new Set();
  const { pendingRequests } = pagination;

  try {
    await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
    await page.waitForSelector(
      `${WISHLIST_CONTAINER_SELECTOR}, #wishlist-page, [data-itemid], [data-asin], form[name="signIn"], form[action*="validateCaptcha"]`,
      { timeout: Math.min(timeoutMs, 10_000), state: 'attached' }
    );

    for (let iteration = 0; iteration < 30 && stableRounds < 3; iteration += 1) {
      const state = await page.evaluate(async ({ containerSelector, requestedPages, paginationInFlight }) => {
        const domComplete = Boolean(document.querySelector(
          '#endOfListMarker, #no-items-section, .wl-list-empty, [data-testid="empty-list"]'
        ));
        const list = document.querySelector(containerSelector);
        const paginationSentinel = list?.querySelector('input.showMoreUrl')?.closest('li');
        const pageJs = window.AmazonUIPageJS || window.P;
        const amazonState = await new Promise((resolve) => {
          if (!pageJs?.when) {
            resolve({ allItemsLoaded: false, usesAmazonPagination: false });
            return;
          }

          let finished = false;
          const finish = (value) => {
            if (finished) return;
            finished = true;
            window.clearTimeout(timer);
            resolve(value);
          };
          const timer = window.setTimeout(() => finish({
            allItemsLoaded: false,
            usesAmazonPagination: Boolean(paginationSentinel)
          }), 250);
          pageJs.when('A', 'ready').execute((A) => {
            // A timed-out callback must not issue a request on a later iteration.
            if (finished) return;
            const scrollState = A.state('scrollState') || {};
            const paginationInput = paginationSentinel?.querySelector('input.showMoreUrl');
            const paginationKey = JSON.stringify([
              paginationInput?.value || scrollState.showMoreUrl || '',
              scrollState.lastEvaluatedKey ?? paginationSentinel?.querySelector('input.lastEvaluatedKey')?.value ?? ''
            ]);
            let requestedPage;
            if (!domComplete && paginationSentinel && !scrollState.allItemsLoaded &&
                !paginationInFlight && !requestedPages.includes(paginationKey)) {
              // Issue at most one request for this cursor. A slow response must
              // advance pagination before another load can be requested.
              requestedPage = paginationKey;
              A.trigger('wl-load-more-items');
            }
            finish({
              allItemsLoaded: scrollState.allItemsLoaded === true,
              usesAmazonPagination: Boolean(paginationSentinel),
              requestedPage
            });
          });
        });
        const complete = domComplete || amazonState.allItemsLoaded;

        // Scrolling can trigger Amazon's loader too. Do not combine it with an
        // explicit load event or scroll again while a pagination request is pending.
        if (!complete && !amazonState.usesAmazonPagination && !paginationInFlight) {
          const scrollTarget = paginationSentinel || list?.lastElementChild;
          if (scrollTarget) {
            scrollTarget.scrollIntoView({ block: 'end' });
          } else {
            window.scrollTo(0, document.documentElement.scrollHeight);
          }
        }

        return {
          complete,
          amazonAllItemsLoaded: amazonState.allItemsLoaded,
          requestedPage: amazonState.requestedPage,
          hasMore: Boolean(paginationSentinel),
          height: document.documentElement.scrollHeight,
          itemCount: list?.querySelectorAll('.g-item-sortable').length || 0
        };
      }, {
        containerSelector: WISHLIST_CONTAINER_SELECTOR,
        requestedPages: [...requestedPages],
        paginationInFlight: pendingRequests.size > 0
      });
      if (state.requestedPage) requestedPages.add(state.requestedPage);
      amazonAllItemsLoaded ||= state.amazonAllItemsLoaded === true;
      if (state.complete && pendingRequests.size === 0) break;

      await page.waitForTimeout(350);
      const signature = `${state.height}:${state.itemCount}`;
      stableRounds = !state.hasMore && pendingRequests.size === 0 && signature === previousSignature ? stableRounds + 1 : 0;
      previousSignature = signature;
    }
    if (pendingRequests.size > 0) {
      throw new Error('Amazon wish-list pagination did not finish before the scan deadline');
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    if (!amazonAllItemsLoaded) {
      // Amazon can attach its completion marker shortly after the final lazy-loaded
      // item row. Give that marker (or a definitive empty state) a bounded chance
      // to arrive before the page-contract checks run.
      await page.waitForSelector(
        '#endOfListMarker, #no-items-section, .wl-list-empty, [data-testid="empty-list"]',
        { timeout: Math.min(timeoutMs, 5_000), state: 'attached' }
      ).catch(() => {});
    }
    return { amazonAllItemsLoaded };
  } finally {
    pagination.dispose();
  }
}
