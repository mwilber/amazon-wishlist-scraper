import test from 'node:test';
import assert from 'node:assert/strict';
import { sendFatalErrorNotification } from '../src/cli.js';

test('fatal errors use best-effort direct failure reporting', async () => {
  const requests = [];
  const output = [];
  await sendFatalErrorNotification(new Error('Database could not be opened'), {
    configLoader: (options) => {
      assert.deepEqual(options, {
        requireLists: false,
        requireEndpoint: true,
        loadLists: false
      });
      return {
        endpointUrl: 'https://sid.example.test/api/notifications',
        endpointToken: 'secret',
        endpointFormat: 'sid',
        sidNotificationTitle: 'Amazon Wish List Update',
        sidFailureNotificationTitle: 'Amazon Wish List Monitor Failure',
        sidNotificationSource: 'amazon-wishlist-monitor',
        messageTimeoutMs: 100,
        maxMessageLength: 240
      };
    },
    fetchImpl: async (_, options) => {
      requests.push({
        authorization: options.headers.authorization,
        body: JSON.parse(options.body)
      });
      return { ok: true, status: 201 };
    },
    output: { write: (value) => output.push(value) }
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, 'Bearer secret');
  assert.equal(requests[0].body.title, 'Amazon Wish List Monitor Failure');
  assert.match(requests[0].body.body, /Database could not be opened/);
  assert.equal(requests[0].body.source, 'amazon-wishlist-monitor');
  assert.match(output.join(''), /fatal_notification.sent/);
});
