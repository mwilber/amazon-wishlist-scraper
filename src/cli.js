#!/usr/bin/env node
import { loadConfig } from './config.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from './logger.js';
import { WishlistDatabase } from './database.js';
import { runMonitor, retryPendingMessages } from './index.js';
import { launchBrowser } from './browser.js';
import { errorDetails } from './errors.js';

function usage() {
  return `Usage: node src/cli.js <command> [options]

Commands:
  scan [--headed]       Retry due messages, then scan every enabled list
  retry [--all]         Retry due messages; --all also revives exhausted failures
  status                Show list, scan, and outbound-message state
  profile [url]         Open the persistent browser profile for manual setup
  help                  Show this help`;
}

async function openProfile(config, url) {
  const context = await launchBrowser(config, { headed: true });
  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  await page.goto(url || 'https://www.amazon.com/', { waitUntil: 'domcontentloaded', timeout: config.scanTimeoutMs });
  process.stdout.write('Browser profile is open. Sign in or verify list access, then close the browser window.\n');
  await new Promise((resolve) => context.once('close', resolve));
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'scan';
  if (['help', '--help', '-h'].includes(command)) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const isStatus = command === 'status';
  const isProfile = command === 'profile';
  const isRetry = command === 'retry';
  if (!['scan', 'status', 'profile', 'retry'].includes(command)) {
    process.stderr.write(`Unknown command: ${command}\n\n${usage()}\n`);
    return 2;
  }

  const config = loadConfig({
    requireLists: command === 'scan',
    requireEndpoint: command === 'scan' || isRetry
  });
  const logger = createLogger({ logPath: config.logPath, consoleOutput: !isStatus });
  if (isProfile) {
    await openProfile(config, argv[1]);
    return 0;
  }

  const database = new WishlistDatabase(config.databasePath);
  try {
    if (isStatus) {
      process.stdout.write(`${JSON.stringify(database.getStatus(), null, 2)}\n`);
      return 0;
    }
    if (isRetry) {
      const all = argv.includes('--all');
      const result = await retryPendingMessages({
        database,
        config,
        logger,
        includeFailed: all,
        ignoreSchedule: all
      });
      await logger.info('retry.completed', result);
      return result.failed > 0 ? 1 : 0;
    }

    const result = await runMonitor({
      database,
      config,
      logger,
      headed: argv.includes('--headed')
    });
    await logger.info('run.completed', result);
    return result.scanFailures > 0 || result.deliveryFailures > 0 ? 1 : 0;
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'run.fatal', ...errorDetails(error) })}\n`);
    process.exitCode = 1;
  });
}
