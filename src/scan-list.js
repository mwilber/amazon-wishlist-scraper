import {
  AuthenticationRequiredError,
  CaptchaDetectedError,
  NavigationError,
  PageStructureError,
  SuspiciousResultError
} from './errors.js';
import { settleWishlistPage, trackWishlistPagination } from './browser.js';
import { detectAccessIssue, inspectWishlistHtml } from './parse-wishlist.js';

export async function scanWishlistPage({ page, list, timeoutMs, previousActiveCount = 0 }) {
  let response;
  let settlement;
  // Amazon may start lazy loading before DOMContentLoaded. Track those requests
  // before navigation so settling cannot trigger a second load for the same page.
  const pagination = trackWishlistPagination(page);
  try {
    response = await page.goto(list.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!response) throw new Error('navigation returned no response');
    if (response.status() >= 400) throw new Error(`Amazon returned HTTP ${response.status()}`);
    settlement = await settleWishlistPage(page, timeoutMs, pagination);
  } catch (error) {
    if (error instanceof NavigationError) throw error;
    throw new NavigationError(`Could not load ${list.name}: ${error.message}`, { cause: error });
  } finally {
    pagination.dispose();
  }

  const [html, title, url] = await Promise.all([page.content(), page.title(), Promise.resolve(page.url())]);
  const accessIssue = detectAccessIssue({ html, title, url });
  if (accessIssue === 'authentication') {
    throw new AuthenticationRequiredError(`${list.name} requires Amazon sign-in; run the profile setup command`);
  }
  if (accessIssue === 'captcha') {
    throw new CaptchaDetectedError(`${list.name} displayed an Amazon CAPTCHA; no bypass was attempted`);
  }

  const inspection = {
    ...inspectWishlistHtml(html, { baseUrl: url || list.url }),
    amazonAllItemsLoaded: settlement?.amazonAllItemsLoaded === true
  };
  if (!inspection.recognizedStructure && inspection.items.length === 0) {
    throw new PageStructureError(`${list.name} did not contain recognized wish-list markup`);
  }
  if (inspection.containerCount !== 1) {
    throw new PageStructureError(
      `${list.name} contained ${inspection.containerCount} wish-list containers; expected exactly one`
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
      `${list.name} exposed ${inspection.candidateRowCount} item rows but only ${inspection.itemCount} unique item identities were parsed`
    );
  }
  if (!inspection.explicitEmpty &&
      inspection.selectorCounts['#endOfListMarker'] !== 1 &&
      !inspection.amazonAllItemsLoaded) {
    throw new SuspiciousResultError(
      `${list.name} did not confirm the end of the list after scrolling; the result may be incomplete`
    );
  }
  return { items: inspection.items, html, title, url, inspection };
}
