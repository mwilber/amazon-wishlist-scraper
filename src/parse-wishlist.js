import * as cheerio from 'cheerio';

const ASIN_PATTERN = /^[A-Z0-9]{10}$/i;
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
  const selectors = [
    'li[data-itemid]',
    '[data-asin]',
    '.g-item-sortable',
    '[id^="item_"]',
    'a[href*="/dp/"]',
    'a[href*="/gp/product/"]'
  ];
  $(selectors.join(',')).each((_, element) => candidates.add(element));

  const items = new Map();
  for (const element of candidates) {
    const asin = asinFromElement($, element);
    if (!asin) continue;
    const existing = items.get(asin);
    const item = {
      asin,
      title: titleFromElement($, element, asin),
      url: urlFromElement($, element, asin, baseUrl)
    };
    if (!existing) {
      items.set(asin, item);
    } else {
      items.set(asin, {
        asin,
        title: existing.title || item.title,
        url: existing.url || item.url
      });
    }
  }
  return [...items.values()];
}

export function hasWishlistStructure(html) {
  const $ = cheerio.load(html);
  return $('#g-items, #wishlist-page, [data-itemid], .g-item-sortable, #profile-list-name').length > 0;
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
