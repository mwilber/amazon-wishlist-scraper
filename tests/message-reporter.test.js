import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, createMessageReporter } from '../src/message-reporter.js';
import { MessageDeliveryError } from '../src/errors.js';

test('builds the requested singular message', () => {
  assert.equal(
    buildMessage("Niece's Wish List", [{ asin: 'B000000001', title: 'LEGO Tree House' }]),
    "A new item was added to Niece's Wish List: LEGO Tree House."
  );
});

test('builds a natural combined message for multiple items', () => {
  assert.equal(
    buildMessage('Nephew List', [
      { asin: 'B000000001', title: 'Item One' },
      { asin: 'B000000002', title: 'Item Two' },
      { asin: 'B000000003', title: 'Item Three' }
    ]),
    'Three new items were added to Nephew List: Item One, Item Two, and Item Three.'
  );
});

test('falls back to a product URL when title is unavailable', () => {
  assert.equal(
    buildMessage('Gift List', [{ asin: 'B000000001', url: 'https://www.amazon.com/dp/B000000001' }]),
    'A new item was added to Gift List: https://www.amazon.com/dp/B000000001.'
  );
});

test('summarizes and limits long messages', () => {
  const message = buildMessage('A List With Several New Things', Array.from({ length: 7 }, (_, index) => ({
    asin: `B00000000${index}`,
    title: `Product number ${index + 1} with a needlessly descriptive and very long name`
  })), 160);
  assert.ok(message.length <= 160);
  assert.match(message, /^Seven new items were added/);
  assert.match(message, /including/);
});

test('posts exactly the JSON message with an optional bearer token', async () => {
  const calls = [];
  const reporter = createMessageReporter({
    endpointUrl: 'https://example.test/messages',
    token: 'private-value',
    fetchImpl: async (...args) => {
      calls.push(args);
      return { ok: true, status: 204 };
    }
  });
  const result = await reporter('Hello');
  assert.equal(result.status, 204);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://example.test/messages');
  assert.deepEqual(JSON.parse(calls[0][1].body), { message: 'Hello' });
  assert.equal(calls[0][1].headers.authorization, 'Bearer private-value');
  assert.equal(calls[0][1].headers['content-type'], 'application/json');
});

test('omits authorization when no token is configured', async () => {
  let options;
  const reporter = createMessageReporter({
    endpointUrl: 'https://example.test/messages',
    fetchImpl: async (_, received) => {
      options = received;
      return { ok: true, status: 200 };
    }
  });
  await reporter('Hello');
  assert.equal('authorization' in options.headers, false);
});

test('treats non-2xx responses as failures', async () => {
  const reporter = createMessageReporter({
    endpointUrl: 'https://example.test/messages',
    fetchImpl: async () => ({ ok: false, status: 503 })
  });
  await assert.rejects(reporter('Hello'), (error) => {
    assert.ok(error instanceof MessageDeliveryError);
    assert.match(error.message, /HTTP 503/);
    return true;
  });
});

test('aborts and reports a network timeout', async () => {
  const reporter = createMessageReporter({
    endpointUrl: 'https://example.test/messages',
    timeoutMs: 10,
    fetchImpl: async (_, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })
  });
  await assert.rejects(reporter('Hello'), /timed out after 10 ms/);
});
