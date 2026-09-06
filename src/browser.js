import { chmod, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

export async function launchBrowser(config, { headed = false } = {}) {
  await mkdir(config.browserProfilePath, { recursive: true, mode: 0o700 });
  await chmod(config.browserProfilePath, 0o700);
  return chromium.launchPersistentContext(config.browserProfilePath, {
    headless: headed ? false : config.headless,
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US'
  });
}

export async function settleWishlistPage(page, timeoutMs) {
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
  await page.waitForSelector(
    '#g-items, [data-itemid], [data-asin], form[name="signIn"], form[action*="validateCaptcha"], body',
    { timeout: Math.min(timeoutMs, 10_000) }
  );

  let stableRounds = 0;
  let previousHeight = 0;
  for (let iteration = 0; iteration < 30 && stableRounds < 3; iteration += 1) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(350);
    stableRounds = height === previousHeight ? stableRounds + 1 : 0;
    previousHeight = height;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}
