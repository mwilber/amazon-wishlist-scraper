import * as cheerio from 'cheerio';
import {
  WISHLIST_CONTAINERS,
  WISHLIST_CONTAINER_SELECTOR,
  WISHLIST_ROW_SELECTOR
} from './wishlist-selectors.js';

const ASIN_PATTERN = /^[A-Z0-9]{10}$/i;
const WISHLIST_ITEM_ID_PATTERN = /^[A-Z0-9]{6,64}$/i;
const PRODUCT_PATH_PATTERN = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/i;

function cleanText(value) {
  return value?.replace(/\s+/g, ' ').trim() || null;
}

function asinFromElement($, element) {
  const node = $(element);
  const attributes = [node.attr('data-asin'), node.attr('data-itemid')];
  for (const value of attributes) {
    const candidate = cleanText(value);
    if (candidate && ASIN_PATTERN.test(candidate)) return candidate.toUpperCase();
  }

  const links = node.is('a[href]') ? node : node.find('a[href]');
  let found = null;
  links.each((_, link) => {
    const match = $(link).attr('href')?.match(PRODUCT_PATH_PATTERN);
    if (match && !found) found = match[1].toUpperCase();
  });
  return found;
}

function wishlistItemIdFromElement($, element) {
  const candidate = cleanText($(element).attr('data-itemid'));
  return candidate && WISHLIST_ITEM_ID_PATTERN.test(candidate) ? candidate.toUpperCase() : null;
}

function titleFromElement($, element, asin) {
  const node = $(element);
  const selectors = [
    '[id^="itemName_"]',
    'h2 a',
    'h2',
    '.a-truncate-full',
    '.a-size-base-plus',
    'a[title]'
  ];
  for (const selector of selectors) {
    const match = node.is(selector) ? node : node.find(selector).first();
    const title = cleanText(match.attr('title')) || cleanText(match.text());
    if (title && title.toUpperCase() !== asin && title.length > 2) return title;
  }
  return null;
}

function urlFromElement($, element, asin, baseUrl) {
  const node = $(element);
  const links = node.is('a[href]') ? node : node.find('a[href]');
  let href = null;
  links.each((_, link) => {
    const candidate = $(link).attr('href');
    if (!href && candidate?.match(PRODUCT_PATH_PATTERN)?.[1]?.toUpperCase() === asin) href = candidate;
  });
  try {
    const base = new URL(baseUrl);
    if (href) {
      const resolved = new URL(href, base);
      return `${resolved.origin}/dp/${asin}`;
    }
    return `${base.origin}/dp/${asin}`;
  } catch {
    return href || null;
  }
}

export function parseWishlistHtml(html, { baseUrl = 'https://www.amazon.com/' } = {}) {
  const $ = cheerio.load(html);
  const candidates = new Set();
  $(WISHLIST_ROW_SELECTOR).each((_, element) => candidates.add(element));

  const items = new Map();
  for (const element of candidates) {
    const productAsin = asinFromElement($, element);
    const wishlistItemId = wishlistItemIdFromElement($, element);
    const title = titleFromElement($, element, productAsin || wishlistItemId || '');
    if (!productAsin && (!wishlistItemId || !title)) continue;
    const identifier = productAsin || `WISHLIST_ITEM:${wishlistItemId}`;
    const existing = items.get(identifier);
    const item = {
      asin: identifier,
      title,
      url: productAsin ? urlFromElement($, element, productAsin, baseUrl) : null,
      wishlistItemId,
      identifierType: productAsin ? 'asin' : 'wishlist_item'
    };
    if (!existing) {
      items.set(identifier, item);
    } else {
      items.set(identifier, {
        asin: identifier,
        title: existing.title || item.title,
        url: existing.url || item.url,
        wishlistItemId: existing.wishlistItemId || item.wishlistItemId,
        identifierType: existing.identifierType || item.identifierType
      });
    }
  }
  return [...items.values()];
}

export function hasWishlistStructure(html) {
  const $ = cheerio.load(html);
  return $(`${WISHLIST_CONTAINER_SELECTOR}, #wishlist-page, #no-items-section, .wl-list-empty, #profile-list-name`).length > 0;
}

export function hasExplicitEmptyState(html) {
  const $ = cheerio.load(html);
  if ($('#no-items-section, .wl-list-empty, [data-testid="empty-list"]').length > 0) return true;
  const listText = cleanText($(`#wishlist-page, ${WISHLIST_CONTAINER_SELECTOR}`).text()) || '';
  return /(?:there are no items|this list is empty|no items in this list)/i.test(listText);
}

export function inspectWishlistHtml(html, options = {}) {
  const $ = cheerio.load(html);
  const selectorCounts = Object.fromEntries([
    ...WISHLIST_CONTAINERS.flatMap((container) => [
      container,
      `${container} > li`,
      `${container} li[data-itemid]`,
      `${container} .g-item-sortable`,
      `${container} [data-asin]`
    ]),
    '#no-items-section',
    '#endOfListMarker',
    'a[href*="/dp/"]'
  ].map((selector) => [selector, $(selector).length]));
  const candidateRowCount = $(WISHLIST_ROW_SELECTOR).length;
  const items = parseWishlistHtml(html, options);
  return {
    items,
    itemCount: items.length,
    explicitEmpty: hasExplicitEmptyState(html),
    recognizedStructure: hasWishlistStructure(html),
    containerCount: $(WISHLIST_CONTAINER_SELECTOR).length,
    candidateRowCount,
    selectorCounts
  };
}

export function detectAccessIssue({ html, url = '', title = '' }) {
  const text = `${title}\n${html}`.toLowerCase();
  if (/\/ap\/(?:signin|cvf)/i.test(url) ||
      /<form[^>]+(?:name|id)=["'](?:signIn|ap_signin_form)/i.test(html) ||
      text.includes('sign in to continue')) {
    return 'authentication';
  }
  if (/\/errors\/validatecaptcha/i.test(url) ||
      /<form[^>]+action=["'][^"']*validatecaptcha/i.test(html) ||
      text.includes('enter the characters you see below') ||
      text.includes('type the characters you see in this image')) {
    return 'captcha';
  }
  return null;
}
