import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { ConfigurationError } from '../src/errors.js';

function projectWithLists(lists) {
  const rootDir = mkdtempSync(join(tmpdir(), 'wishlist-config-'));
  mkdirSync(join(rootDir, 'config'));
  writeFileSync(join(rootDir, 'config/lists.json'), JSON.stringify(lists));
  return rootDir;
}

test('loads paths, settings, and enabled Amazon lists', () => {
  const rootDir = projectWithLists([
    { id: 'family', name: 'Family', url: 'https://www.amazon.com/hz/wishlist/ls/ABC', enabled: true },
    { id: 'off', name: 'Disabled', url: 'https://amazon.co.uk/hz/wishlist/ls/XYZ', enabled: false }
  ]);
  const config = loadConfig({
    rootDir,
    env: { MESSAGE_ENDPOINT_URL: 'https://example.test/messages', HEADLESS: 'false' }
  });
  assert.deepEqual(config.lists.map((list) => list.id), ['family']);
  assert.equal(config.headless, false);
  assert.equal(config.endpointFormat, 'message');
  assert.equal(config.databasePath, join(rootDir, 'data/wishlist-monitor.sqlite'));
});

test('loads and validates SID notification settings', () => {
  const rootDir = projectWithLists([
    { id: 'family', name: 'Family', url: 'https://www.amazon.com/hz/wishlist/ls/ABC' }
  ]);
  const config = loadConfig({
    rootDir,
    env: {
      MESSAGE_ENDPOINT_URL: 'https://sid.example.test/api/notifications',
      MESSAGE_ENDPOINT_FORMAT: 'sid',
      SID_NOTIFICATION_TITLE: 'Wish list changed',
      SID_NOTIFICATION_SOURCE: 'wishlist-monitor'
    }
  });
  assert.equal(config.endpointFormat, 'sid');
  assert.equal(config.sidNotificationTitle, 'Wish list changed');
  assert.equal(config.sidFailureNotificationTitle, 'Amazon Wish List Monitor Failure');
  assert.equal(config.sidNotificationSource, 'wishlist-monitor');
});

test('rejects invalid endpoint formats and SID sources', () => {
  const rootDir = projectWithLists([
    { id: 'family', name: 'Family', url: 'https://www.amazon.com/hz/wishlist/ls/ABC' }
  ]);
  assert.throws(() => loadConfig({
    rootDir,
    env: {
      MESSAGE_ENDPOINT_URL: 'https://example.test/messages',
      MESSAGE_ENDPOINT_FORMAT: 'unknown'
    }
  }), /MESSAGE_ENDPOINT_FORMAT/);
  assert.throws(() => loadConfig({
    rootDir,
    env: {
      MESSAGE_ENDPOINT_URL: 'https://example.test/messages',
      MESSAGE_ENDPOINT_FORMAT: 'sid',
      SID_NOTIFICATION_SOURCE: 'contains spaces'
    }
  }), /SID_NOTIFICATION_SOURCE/);
});

test('rejects non-Amazon list URLs', () => {
  const rootDir = projectWithLists([
    { id: 'bad', name: 'Bad', url: 'https://example.com/list' }
  ]);
  assert.throws(() => loadConfig({
    rootDir,
    env: { MESSAGE_ENDPOINT_URL: 'https://example.test/messages' }
  }), ConfigurationError);
});

test('rejects lookalike Amazon hostnames', () => {
  const rootDir = projectWithLists([
    { id: 'bad', name: 'Bad', url: 'https://amazon.evil.example.com/list' }
  ]);
  assert.throws(() => loadConfig({
    rootDir,
    env: { MESSAGE_ENDPOINT_URL: 'https://example.test/messages' }
  }), ConfigurationError);
});

test('requires a message endpoint for scan configuration', () => {
  const rootDir = projectWithLists([
    { id: 'family', name: 'Family', url: 'https://www.amazon.com/hz/wishlist/ls/ABC' }
  ]);
  assert.throws(() => loadConfig({ rootDir, env: {} }), /MESSAGE_ENDPOINT_URL/);
});

test('can load notification settings while bypassing a broken list file for fatal reporting', () => {
  const rootDir = projectWithLists([]);
  writeFileSync(join(rootDir, 'config/lists.json'), '{broken json');
  const config = loadConfig({
    rootDir,
    requireLists: false,
    requireEndpoint: true,
    loadLists: false,
    env: { MESSAGE_ENDPOINT_URL: 'https://example.test/messages' }
  });
  assert.deepEqual(config.lists, []);
  assert.equal(config.endpointUrl, 'https://example.test/messages');
});
