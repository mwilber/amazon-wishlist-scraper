import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WishlistDatabase } from '../src/database.js';
import { createLogger } from '../src/logger.js';
import { retryPendingMessages, runMonitor } from '../src/index.js';

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
  let index = 0;
  const result = await runMonitor({
    database,
    config,
    logger,
    fetchImpl: async () => ({ ok: true, status: 200 }),
    launchBrowserImpl: async () => ({
      async newPage() { return fakePage(pages[index++]); },
      async close() {}
    })
  });
  assert.equal(result.scanFailures, 1);
  const status = database.getStatus();
  assert.equal(status.lists.find((entry) => entry.id === 'broken').last_scan_status, 'failed');
  assert.equal(status.lists.find((entry) => entry.id === 'family').last_scan_status, 'success');
  assert.ok(status.lists.find((entry) => entry.id === 'family').baseline_established_at);
  const diagnosticRoot = join(root, 'diagnostics');
  const diagnosticDirectories = readdirSync(diagnosticRoot);
  assert.equal(diagnosticDirectories.length, 1);
  assert.ok(existsSync(join(diagnosticRoot, diagnosticDirectories[0], 'page.html')));
  assert.ok(existsSync(join(diagnosticRoot, diagnosticDirectories[0], 'metadata.json')));
});
