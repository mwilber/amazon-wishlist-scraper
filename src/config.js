import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { ConfigurationError } from './errors.js';

function parseEnvFile(contents) {
  const result = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function pathFrom(rootDir, value, fallback) {
  const selected = value || fallback;
  return isAbsolute(selected) ? selected : resolve(rootDir, selected);
}

function positiveInteger(value, fallback, name, minimum = 1) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new ConfigurationError(`${name} must be an integer of at least ${minimum}`);
  }
  return parsed;
}

function booleanValue(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  if (String(value).toLowerCase() === 'true') return true;
  if (String(value).toLowerCase() === 'false') return false;
  throw new ConfigurationError(`${name} must be true or false`);
}

function choiceValue(value, fallback, name, choices) {
  const selected = String(value || fallback).toLowerCase();
  if (!choices.includes(selected)) {
    throw new ConfigurationError(`${name} must be one of: ${choices.join(', ')}`);
  }
  return selected;
}

function sidTitle(value) {
  const title = value || 'Amazon Wish List Update';
  if (typeof title !== 'string' || !title.trim() || title.length > 120 || /[\r\n]/.test(title)) {
    throw new ConfigurationError('SID_NOTIFICATION_TITLE must be 1-120 characters with no line breaks');
  }
  return title.trim();
}

function sidSource(value) {
  const source = value || 'amazon-wishlist-monitor';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(source)) {
    throw new ConfigurationError('SID_NOTIFICATION_SOURCE must be an ASCII token of 1-64 characters');
  }
  return source;
}

function endpointUrl(value, required) {
  if (!value) {
    if (required) throw new ConfigurationError('MESSAGE_ENDPOINT_URL is required');
    return null;
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    return url.toString();
  } catch {
    throw new ConfigurationError('MESSAGE_ENDPOINT_URL must be a valid HTTP or HTTPS URL');
  }
}

const AMAZON_DOMAINS = [
  'amazon.com', 'amazon.ca', 'amazon.com.mx', 'amazon.com.br',
  'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es',
  'amazon.nl', 'amazon.se', 'amazon.pl', 'amazon.com.be',
  'amazon.co.jp', 'amazon.in', 'amazon.com.au', 'amazon.sg',
  'amazon.ae', 'amazon.sa', 'amazon.com.tr'
];

function isAmazonHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return AMAZON_DOMAINS.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

function validateList(list, index) {
  if (!list || typeof list !== 'object' || Array.isArray(list)) {
    throw new ConfigurationError(`List entry ${index + 1} must be an object`);
  }
  for (const property of ['id', 'name', 'url']) {
    if (typeof list[property] !== 'string' || !list[property].trim()) {
      throw new ConfigurationError(`List entry ${index + 1} requires a non-empty ${property}`);
    }
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(list.id)) {
    throw new ConfigurationError(`List id "${list.id}" may contain only letters, numbers, hyphens, and underscores`);
  }
  let url;
  try {
    url = new URL(list.url);
  } catch {
    throw new ConfigurationError(`List "${list.id}" has an invalid URL`);
  }
  if (url.protocol !== 'https:' || !isAmazonHostname(url.hostname)) {
    throw new ConfigurationError(`List "${list.id}" must use an HTTPS Amazon URL`);
  }
  return {
    id: list.id,
    name: list.name.trim(),
    url: url.toString(),
    enabled: list.enabled !== false
  };
}

export function loadConfig({ rootDir = process.cwd(), requireLists = true, requireEndpoint = true, env = process.env } = {}) {
  const envPath = resolve(rootDir, '.env');
  const fileEnv = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
  const values = { ...fileEnv, ...env };
  const listsPath = pathFrom(rootDir, values.LISTS_CONFIG_PATH, 'config/lists.json');
  let lists = [];

  if (existsSync(listsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(listsPath, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('top level must be an array');
      lists = parsed.map(validateList);
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError(`Could not parse ${listsPath}: ${error.message}`);
    }
  } else if (requireLists) {
    throw new ConfigurationError(`List configuration not found: ${listsPath}`);
  }

  const enabledLists = lists.filter((list) => list.enabled);
  if (requireLists && enabledLists.length === 0) {
    throw new ConfigurationError('At least one enabled wish list is required');
  }
  if (new Set(lists.map((list) => list.id)).size !== lists.length) {
    throw new ConfigurationError('Wish-list ids must be unique');
  }

  return {
    rootDir,
    listsPath,
    lists: enabledLists,
    databasePath: pathFrom(rootDir, values.DATABASE_PATH, 'data/wishlist-monitor.sqlite'),
    browserProfilePath: pathFrom(rootDir, values.BROWSER_PROFILE_PATH, 'browser-profile'),
    diagnosticsPath: pathFrom(rootDir, values.DIAGNOSTICS_PATH, 'diagnostics'),
    logPath: pathFrom(rootDir, values.LOG_PATH, 'logs/wishlist-monitor.log'),
    endpointUrl: endpointUrl(values.MESSAGE_ENDPOINT_URL, requireEndpoint),
    endpointToken: values.MESSAGE_ENDPOINT_TOKEN || null,
    endpointFormat: choiceValue(
      values.MESSAGE_ENDPOINT_FORMAT,
      'message',
      'MESSAGE_ENDPOINT_FORMAT',
      ['message', 'sid']
    ),
    sidNotificationTitle: sidTitle(values.SID_NOTIFICATION_TITLE),
    sidNotificationSource: sidSource(values.SID_NOTIFICATION_SOURCE),
    headless: booleanValue(values.HEADLESS, true, 'HEADLESS'),
    scanTimeoutMs: positiveInteger(values.SCAN_TIMEOUT_MS, 45_000, 'SCAN_TIMEOUT_MS', 1_000),
    messageTimeoutMs: positiveInteger(values.MESSAGE_TIMEOUT_MS, 10_000, 'MESSAGE_TIMEOUT_MS', 100),
    maxMessageLength: positiveInteger(values.MAX_MESSAGE_LENGTH, 500, 'MAX_MESSAGE_LENGTH', 100),
    maxDeliveryAttempts: positiveInteger(values.MAX_DELIVERY_ATTEMPTS, 5, 'MAX_DELIVERY_ATTEMPTS'),
    retryBaseDelayMs: positiveInteger(values.RETRY_BASE_DELAY_MS, 60_000, 'RETRY_BASE_DELAY_MS', 1_000)
  };
}

export { parseEnvFile };
