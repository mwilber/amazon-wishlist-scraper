import { MessageDeliveryError } from './errors.js';

const NUMBER_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

function countLabel(count, startOfSentence = true) {
  if (count <= 10) return startOfSentence ? NUMBER_WORDS[count] : NUMBER_WORDS[count].toLowerCase();
  return String(count);
}

function itemLabel(item) {
  return item.title || item.url || `Amazon item ${item.asin}`;
}

function naturalList(values) {
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return '…'.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

export function buildMessage(listName, items, maxLength = 500) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new TypeError('At least one item is required to build a message');
  }
  const labels = items.map(itemLabel);
  const full = items.length === 1
    ? `A new item was added to ${listName}: ${labels[0]}.`
    : `${countLabel(items.length)} new items were added to ${listName}: ${naturalList(labels)}.`;
  if (full.length <= maxLength) return full;

  const prefix = `${countLabel(items.length)} new items were added to ${listName}, including `;
  for (let count = Math.min(3, labels.length); count >= 1; count -= 1) {
    const summarized = `${prefix}${naturalList(labels.slice(0, count))}.`;
    if (summarized.length <= maxLength) return summarized;
  }
  return truncate(`${countLabel(items.length)} new items were added to ${listName}.`, maxLength);
}

export function buildFailureMessage(listName, error, maxLength = 500) {
  const category = error?.name || 'Error';
  const reason = error?.message || String(error);
  return truncate(
    `Amazon wish-list scan failed for ${listName} (${category}): ${reason} Product history was not changed.`,
    maxLength
  );
}

export function buildRequestBody(message, {
  endpointFormat = 'message',
  sidTitle = 'Amazon Wish List Update',
  sidSource = 'amazon-wishlist-monitor'
} = {}) {
  if (endpointFormat === 'sid') {
    return { title: sidTitle, body: message, source: sidSource };
  }
  return { message };
}

export function createMessageReporter({
  endpointUrl,
  token = null,
  timeoutMs = 10_000,
  endpointFormat = 'message',
  sidTitle = 'Amazon Wish List Update',
  sidSource = 'amazon-wishlist-monitor',
  fetchImpl = globalThis.fetch
}) {
  if (!endpointUrl) throw new TypeError('endpointUrl is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  return async function sendMessage(message, { title = null } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { 'content-type': 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetchImpl(endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildRequestBody(message, {
          endpointFormat,
          sidTitle: title || sidTitle,
          sidSource
        })),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new MessageDeliveryError(`Message endpoint returned HTTP ${response.status}`);
      }
      return { status: response.status };
    } catch (error) {
      if (error instanceof MessageDeliveryError) throw error;
      if (error?.name === 'AbortError') {
        throw new MessageDeliveryError(`Message delivery timed out after ${timeoutMs} ms`, { cause: error });
      }
      throw new MessageDeliveryError(`Message delivery failed: ${error.message}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  };
}
