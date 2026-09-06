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
  assert.equal(config.databasePath, join(rootDir, 'data/wishlist-monitor.sqlite'));
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
