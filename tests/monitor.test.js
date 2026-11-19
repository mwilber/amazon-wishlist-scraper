import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WishlistDatabase } from '../src/database.js';
import { createLogger } from '../src/logger.js';
import { inspectWishlists, retryPendingMessages, runMonitor } from '../src/index.js';

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/wishlist.html', import.meta.url)), 'utf8');
const extraItems = fixture.replace('</ul>', `
  <li data-itemid="B0DDD44444"><h2><a href="/dp/B0DDD44444">Robot Kit</a></h2></li>
  <li data-itemid="B0EEE55555"><h2><a href="/dp/B0EEE55555">Art Set</a></h2></li>
</ul>`);

function fakePage(html) {
  return {
    async goto() { return { status: () => 200 }; },
    async waitForLoadState() {},
    async waitForSelector() {},
    async evaluate(callback) {
      return callback.toString().includes('scrollHeight') ? 100 : undefined;
    },
    async waitForTimeout() {},
    async content() { return html; },
    async title() { return 'Family Wish List'; },
    url() { return 'https://www.amazon.com/hz/wishlist/ls/EXAMPLE'; },
    async screenshot() {},
    async close() {}
  };
}

function fakeBrowser(htmlProvider) {
  return async () => ({
    async newPage() { return fakePage(htmlProvider()); },
    async close() {}
  });
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'wishlist-monitor-'));
  const database = new WishlistDatabase(join(root, 'data/state.sqlite'));
  const config = {
    lists: [{
      id: 'family',
      name: 'Family Wish List',
      url: 'https://www.amazon.com/hz/wishlist/ls/EXAMPLE'
    }],
    browserProfilePath: join(root, 'profile'),
    diagnosticsPath: join(root, 'diagnostics'),
    endpointUrl: 'https://example.test/messages',
    endpointToken: null,
    endpointFormat: 'message',
    sidNotificationTitle: 'Amazon Wish List Update',
    sidFailureNotificationTitle: 'Amazon Wish List Monitor Failure',
    sidNotificationSource: 'amazon-wishlist-monitor',
    headless: true,
    scanTimeoutMs: 1_000,
    messageTimeoutMs: 100,
    maxMessageLength: 500,
    maxDeliveryAttempts: 5,
    retryBaseDelayMs: 1_000
  };
  return { root, database, config, logger: createLogger({ consoleOutput: false }) };
}

test('baseline, grouping, and duplicate prevention work through the monitor', async (t) => {
  const { database, config, logger } = setup();
  t.after(() => database.close());
  let html = fixture;
  const requests = [];
  const fetchImpl = async (_, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, status: 202 };
  };
  const options = {
    database, config, logger, fetchImpl,
    launchBrowserImpl: fakeBrowser(() => html)
  };

  const baseline = await runMonitor(options);
  assert.deepEqual(baseline, { scanFailures: 0, deliveryFailures: 0 });
  assert.equal(requests.length, 0);

  html = extraItems;
  await runMonitor(options);
  assert.equal(requests.length, 1);
  assert.match(requests[0].message, /^Two new items/);

  await runMonitor(options);
  assert.equal(requests.length, 1, 'unchanged products must not send another request');
});

test('switching between list and grid layouts preserves products without new-item notifications', async (t) => {
  const { database, config, logger } = setup();
  t.after(() => database.close());
  let html = fixture;
  const requests = [];
  const options = {
    database, config, logger,
    launchBrowserImpl: fakeBrowser(() => html),
    fetchImpl: async (_, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 200 };
    }
  };
  await runMonitor(options);
  const originalProducts = database.db.prepare('SELECT * FROM products ORDER BY asin').all();
  for (const layout of ['g-items-grid', 'g-items']) {
    html = fixture.replace('id="g-items"', `id="${layout}"`);
    assert.deepEqual(await runMonitor(options), { scanFailures: 0, deliveryFailures: 0 });
    const products = database.db.prepare('SELECT * FROM products ORDER BY asin').all();
    assert.deepEqual(products.map(({ last_seen_at, ...product }) => product),
      originalProducts.map(({ last_seen_at, ...product }) => product));
  }
  assert.equal(requests.length, 0);
  assert.equal(database.getStatus().outstanding.length, 0);
});

test('failed delivery leaves the successful scan and retryable message intact', async (t) => {
  const { database, config, logger } = setup();
  t.after(() => database.close());
  let html = fixture;
  const browser = fakeBrowser(() => html);
  await runMonitor({
    database, config, logger, launchBrowserImpl: browser,
    fetchImpl: async () => ({ ok: true, status: 200 })
  });

  html = extraItems;
  const failed = await runMonitor({
    database, config, logger, launchBrowserImpl: browser,
    fetchImpl: async () => { throw new Error('endpoint offline'); }
  });
  assert.equal(failed.scanFailures, 0);
  assert.equal(failed.deliveryFailures, 1);
  const statusAfterFailure = database.getStatus();
  assert.equal(statusAfterFailure.lists[0].last_scan_status, 'success');
  assert.equal(statusAfterFailure.outstanding.length, 1);
  assert.equal(statusAfterFailure.outstanding[0].status, 'pending');

  let retryCalls = 0;
  const retried = await retryPendingMessages({
    database,
    config,
    logger,
    ignoreSchedule: true,
    fetchImpl: async () => {
      retryCalls += 1;
      return { ok: true, status: 204 };
    }
  });
  assert.deepEqual(retried, { attempted: 1, failed: 0 });
  assert.equal(retryCalls, 1);
  assert.equal(database.getStatus().outstanding.length, 0);

  const noDuplicateRetry = await retryPendingMessages({
    database,
    config,
    logger,
    ignoreSchedule: true,
    fetchImpl: async () => { retryCalls += 1; }
  });
  assert.deepEqual(noDuplicateRetry, { attempted: 0, failed: 0 });
  assert.equal(retryCalls, 1);
});

test('one list failure does not prevent a later list from being scanned', async (t) => {
  const { database, config, logger, root } = setup();
  t.after(() => database.close());
  config.lists = [
    { id: 'broken', name: 'Broken List', url: 'https://www.amazon.com/hz/wishlist/ls/BROKEN' },
    { id: 'family', name: 'Family List', url: 'https://www.amazon.com/hz/wishlist/ls/EXAMPLE' }
  ];
  const pages = ['<html><body>Unexpected page</body></html>', fixture];
  const notifications = [];
  let index = 0;
  const result = await runMonitor({
    database,
    config,
    logger,
    fetchImpl: async (_, options) => {
      notifications.push(JSON.parse(options.body));
      return { ok: true, status: 200 };
    },
    launchBrowserImpl: async () => ({
      async newPage() { return fakePage(pages[index++]); },
      async close() {}
    })
  });
  assert.equal(result.scanFailures, 1);
  assert.equal(result.deliveryFailures, 0);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /scan failed for Broken List/);
  const status = database.getStatus();
  assert.equal(status.lists.find((entry) => entry.id === 'broken').last_scan_status, 'failed');
  assert.equal(status.lists.find((entry) => entry.id === 'family').last_scan_status, 'success');
  assert.ok(status.lists.find((entry) => entry.id === 'family').baseline_established_at);
  const diagnosticRoot = join(root, 'diagnostics');
  const diagnosticDirectories = readdirSync(diagnosticRoot);
  assert.equal(diagnosticDirectories.length, 1);
  assert.ok(existsSync(join(diagnosticRoot, diagnosticDirectories[0], 'page.html')));
  assert.ok(existsSync(join(diagnosticRoot, diagnosticDirectories[0], 'metadata.json')));
  const failureMessage = database.db.prepare(`
    SELECT title, kind, status FROM outbound_messages WHERE list_id = 'broken'
  `).get();
  assert.equal(failureMessage.title, 'Amazon Wish List Monitor Failure');
  assert.equal(failureMessage.kind, 'scan_failure');
  assert.equal(failureMessage.status, 'sent');
});

test('browser startup failures notify for every unscanned list', async (t) => {
  const { database, config, logger } = setup();
  t.after(() => database.close());
  config.lists.push({
    id: 'second',
    name: 'Second List',
    url: 'https://www.amazon.com/hz/wishlist/ls/SECOND'
  });
  const notifications = [];
  const result = await runMonitor({
    database,
    config,
    logger,
    launchBrowserImpl: async () => { throw new Error('Chromium could not start'); },
    fetchImpl: async (_, options) => {
      notifications.push(JSON.parse(options.body));
      return { ok: true, status: 201 };
    }
  });
  assert.deepEqual(result, { scanFailures: 2, deliveryFailures: 0 });
  assert.equal(notifications.length, 2);
  assert.ok(notifications.every((payload) => /Chromium could not start/.test(payload.message)));
  assert.deepEqual(database.getStatus().lists.map((entry) => entry.last_scan_status), ['failed', 'failed']);
});

test('read-only inspection reports items and saves page evidence', async () => {
  const { config, logger, root } = setup();
  const result = await inspectWishlists({
    config,
    logger,
    launchBrowserImpl: fakeBrowser(() => fixture)
  });
  assert.equal(result.failures, 0);
  assert.equal(result.lists.length, 1);
  assert.equal(result.lists[0].itemCount, 3);
  assert.deepEqual(result.lists[0].items.map((item) => item.asin), [
    'B0AAA11111', 'B0BBB22222', 'B0CCC33333'
  ]);
  const inspectionDirectory = result.lists[0].diagnosticsPath;
  assert.ok(inspectionDirectory.startsWith(join(root, 'diagnostics')));
  assert.ok(existsSync(join(inspectionDirectory, 'page.html')));
  assert.ok(existsSync(join(inspectionDirectory, 'summary.json')));
});
