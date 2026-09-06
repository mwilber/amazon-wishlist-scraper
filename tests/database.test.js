import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WishlistDatabase } from '../src/database.js';
import { buildMessage } from '../src/message-reporter.js';

function createDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'wishlist-db-'));
  let instant = new Date('2026-01-01T00:00:00.000Z');
  return {
    database: new WishlistDatabase(join(directory, 'state.sqlite'), { clock: () => new Date(instant) }),
    advance(ms = 1_000) { instant = new Date(instant.getTime() + ms); }
  };
}

const list = {
  id: 'family',
  name: 'Family Wish List',
  url: 'https://www.amazon.com/hz/wishlist/ls/EXAMPLE'
};
const item = (asin, title = asin) => ({ asin, title, url: `https://www.amazon.com/dp/${asin}` });
const save = (database, items) => database.persistSuccessfulScan({
  list,
  items,
  startedAt: '2026-01-01T00:00:00.000Z',
  buildMessage
});

test('first successful scan creates a baseline with no message', (t) => {
  const { database } = createDatabase();
  t.after(() => database.close());
  const result = save(database, [item('B000000001', 'Existing item')]);
  assert.equal(result.isBaseline, true);
  assert.equal(result.outboundMessage, null);
  assert.equal(database.getStatus().messages.length, 0);
});

test('new items create one combined, deduplicated message per scan', (t) => {
  const { database, advance } = createDatabase();
  t.after(() => database.close());
  save(database, [item('B000000001', 'Existing item')]);
  advance();
  const changed = save(database, [
    item('B000000001', 'Existing item'),
    item('B000000002', 'New item two'),
    item('B000000003', 'New item three')
  ]);
  assert.equal(changed.comparison.newItems.length, 2);
  assert.ok(changed.outboundMessage);
  assert.match(changed.outboundMessage.message, /^Two new items/);

  advance();
  const unchanged = save(database, [
    item('B000000001'), item('B000000002'), item('B000000003')
  ]);
  assert.equal(unchanged.outboundMessage, null);
  assert.deepEqual(
    database.getStatus().messages.map((row) => ({ ...row })),
    [{ status: 'pending', count: 1 }]
  );
});

test('a removed and later re-added historical item is not new', (t) => {
  const { database, advance } = createDatabase();
  t.after(() => database.close());
  save(database, [item('B000000001'), item('B000000002')]);
  advance();
  save(database, [item('B000000001')]);
  advance();
  const readded = save(database, [item('B000000001'), item('B000000002')]);
  assert.deepEqual(readded.comparison.newItems, []);
  assert.deepEqual(readded.comparison.reactivatedItems.map((entry) => entry.asin), ['B000000002']);
  assert.equal(readded.outboundMessage, null);
});

test('keeps product identity when an Amazon item later loses its ASIN link', (t) => {
  const { database, advance } = createDatabase();
  t.after(() => database.close());
  save(database, [{
    ...item('B000000001', 'Available product'),
    wishlistItemId: 'IROW000001',
    identifierType: 'asin'
  }]);
  advance();
  const changed = save(database, [{
    asin: 'WISHLIST_ITEM:IROW000001',
    title: 'Unavailable product label',
    url: null,
    wishlistItemId: 'IROW000001',
    identifierType: 'wishlist_item'
  }]);
  assert.deepEqual(changed.comparison.newItems, []);
  assert.equal(changed.outboundMessage, null);
  assert.deepEqual(database.getListState(list.id).activeItems.map((entry) => ({ ...entry })), [{
    asin: 'B000000001',
    title: 'Unavailable product label',
    url: 'https://www.amazon.com/dp/B000000001',
    wishlistItemId: 'IROW000001',
    identifierType: 'asin'
  }]);
});

test('tracks a new manual entry once using its visible label', (t) => {
  const { database, advance } = createDatabase();
  t.after(() => database.close());
  save(database, [item('B000000001')]);
  const manualItem = {
    asin: 'WISHLIST_ITEM:IMANUAL000001',
    title: 'A manually entered gift',
    url: null,
    wishlistItemId: 'IMANUAL000001',
    identifierType: 'wishlist_item'
  };
  advance();
  const changed = save(database, [item('B000000001'), manualItem]);
  assert.deepEqual(changed.comparison.newItems, [manualItem]);
  assert.match(changed.outboundMessage.message, /A manually entered gift/);
  advance();
  const unchanged = save(database, [item('B000000001'), manualItem]);
  assert.equal(unchanged.outboundMessage, null);
});

test('records scan failures without changing product activity', (t) => {
  const { database } = createDatabase();
  t.after(() => database.close());
  save(database, [item('B000000001')]);
  database.recordFailedScan({
    list,
    startedAt: '2026-01-02T00:00:00.000Z',
    errorCategory: 'SuspiciousResultError',
    errorMessage: 'No items',
    diagnosticsPath: '/tmp/example'
  });
  assert.equal(database.getListState(list.id).activeItems.length, 1);
  assert.equal(database.getStatus().lists[0].last_scan_status, 'failed');
});

test('failed scans atomically queue a titled failure notification', (t) => {
  const { database } = createDatabase();
  t.after(() => database.close());
  save(database, [item('B000000001')]);
  const result = database.persistFailedScan({
    list,
    startedAt: '2026-01-02T00:00:00.000Z',
    errorCategory: 'PageStructureError',
    errorMessage: 'Item rows no longer match parsed ASINs',
    diagnosticsPath: '/tmp/example',
    notificationTitle: 'Amazon Wish List Monitor Failure',
    notificationMessage: 'The scan failed and history was not changed.'
  });
  assert.ok(result.scanId);
  assert.equal(result.outboundMessage.kind, 'scan_failure');
  assert.equal(result.outboundMessage.title, 'Amazon Wish List Monitor Failure');
  assert.equal(result.outboundMessage.status, 'pending');
  assert.equal(database.getListState(list.id).activeItems.length, 1);
});

test('message attempts back off and eventually become failed', (t) => {
  const { database, advance } = createDatabase();
  t.after(() => database.close());
  save(database, [item('B000000001')]);
  advance();
  const { outboundMessage } = save(database, [item('B000000001'), item('B000000002')]);
  const first = database.markMessageFailure(outboundMessage.id, 'offline', {
    maxAttempts: 2,
    baseDelayMs: 5_000
  });
  assert.equal(first.status, 'pending');
  assert.equal(first.attempt_count, 1);
  assert.equal(first.next_attempt_at, '2026-01-01T00:00:06.000Z');
  const second = database.markMessageFailure(outboundMessage.id, 'still offline', {
    maxAttempts: 2,
    baseDelayMs: 5_000
  });
  assert.equal(second.status, 'failed');
  assert.equal(second.attempt_count, 2);
  assert.equal(second.next_attempt_at, null);
});

test('reset erases history but preserves the schema for a fresh baseline', (t) => {
  const { database, advance } = createDatabase();
  t.after(() => database.close());
  save(database, [item('B000000001')]);
  advance();
  save(database, [item('B000000001'), item('B000000002')]);

  const erased = database.resetHistory();
  assert.deepEqual(erased, {
    scope: 'all',
    lists: 1,
    products: 2,
    scans: 2,
    messages: 1
  });
  assert.deepEqual(database.getStatus(), { lists: [], messages: [], outstanding: [] });

  advance();
  const fresh = save(database, [item('B000000001'), item('B000000002')]);
  assert.equal(fresh.isBaseline, true);
  assert.equal(fresh.outboundMessage, null);
});
