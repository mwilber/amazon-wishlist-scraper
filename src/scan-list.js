import {
  AuthenticationRequiredError,
  CaptchaDetectedError,
  NavigationError,
  PageStructureError,
  SuspiciousResultError
} from './errors.js';
import { settleWishlistPage } from './browser.js';
import { detectAccessIssue, inspectWishlistHtml } from './parse-wishlist.js';

export async function scanWishlistPage({ page, list, timeoutMs, previousActiveCount = 0 }) {
  let response;
  try {
    response = await page.goto(list.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!response) throw new Error('navigation returned no response');
    if (response.status() >= 400) throw new Error(`Amazon returned HTTP ${response.status()}`);
    await settleWishlistPage(page, timeoutMs);
  } catch (error) {
    if (error instanceof NavigationError) throw error;
    throw new NavigationError(`Could not load ${list.name}: ${error.message}`, { cause: error });
  }

  const [html, title, url] = await Promise.all([page.content(), page.title(), Promise.resolve(page.url())]);
  const accessIssue = detectAccessIssue({ html, title, url });
  if (accessIssue === 'authentication') {
    throw new AuthenticationRequiredError(`${list.name} requires Amazon sign-in; run the profile setup command`);
  }
  if (accessIssue === 'captcha') {
    throw new CaptchaDetectedError(`${list.name} displayed an Amazon CAPTCHA; no bypass was attempted`);
  }

  const inspection = inspectWishlistHtml(html, { baseUrl: url || list.url });
  if (!inspection.recognizedStructure && inspection.items.length === 0) {
    throw new PageStructureError(`${list.name} did not contain recognized wish-list markup`);
  }
  if (inspection.selectorCounts['#g-items'] !== 1) {
    throw new PageStructureError(
      `${list.name} contained ${inspection.selectorCounts['#g-items']} wish-list containers; expected exactly one`
    );
  }
  if (inspection.explicitEmpty && inspection.candidateRowCount > 0) {
    throw new SuspiciousResultError(
      `${list.name} simultaneously displayed an empty-list marker and ${inspection.candidateRowCount} item rows`
    );
  }
  if (inspection.items.length === 0 && !inspection.explicitEmpty) {
    const context = previousActiveCount > 0 ? `; ${previousActiveCount} items were previously active` : '';
    throw new SuspiciousResultError(`${list.name} returned no products${context}`);
  }
  if (!inspection.explicitEmpty && inspection.candidateRowCount !== inspection.itemCount) {
    throw new PageStructureError(
      `${list.name} exposed ${inspection.candidateRowCount} item rows but only ${inspection.itemCount} unique ASINs were parsed`
    );
  }
  if (!inspection.explicitEmpty && inspection.selectorCounts['#endOfListMarker'] !== 1) {
    throw new SuspiciousResultError(
      `${list.name} did not expose Amazon's end-of-list marker after scrolling; the result may be incomplete`
    );
  }
  return { items: inspection.items, html, title, url, inspection };
}
