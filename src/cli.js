#!/usr/bin/env node
import { loadConfig } from './config.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from './logger.js';
import { WishlistDatabase } from './database.js';
import {
  createConfiguredReporter,
  inspectWishlists,
  runMonitor,
  retryPendingMessages
} from './index.js';
import { launchBrowser } from './browser.js';
import { errorDetails } from './errors.js';
import { buildFailureMessage } from './message-reporter.js';

function usage() {
  return `Usage: node src/cli.js <command> [options]

Commands:
  scan [--headed] [--debug]
                        Retry due messages, then scan every enabled list
  inspect [--headed]    Read-only scan with item logs, HTML, screenshots, and summaries
  retry [--all]         Retry due messages; --all also revives exhausted failures
  status                Show list, scan, and outbound-message state
  reset --yes [--list id]
                        Erase saved history so the next scan creates a new baseline
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

export async function sendFatalErrorNotification(error, {
  configLoader = loadConfig,
  fetchImpl = globalThis.fetch,
  output = process.stderr
} = {}) {
  try {
    const config = configLoader({
      requireLists: false,
      requireEndpoint: true,
      loadLists: false
    });
    const reporter = createConfiguredReporter(config, fetchImpl);
    const message = buildFailureMessage(
      'the monitor process',
      error,
      config.maxMessageLength
    );
    const result = await reporter(message, { title: config.sidFailureNotificationTitle });
    output.write(`${JSON.stringify({
      level: 'info',
      event: 'fatal_notification.sent',
      httpStatus: result.status
    })}\n`);
  } catch (notificationError) {
    output.write(`${JSON.stringify({
      level: 'error',
      event: 'fatal_notification.failed',
      category: notificationError.name,
      message: notificationError.message
    })}\n`);
  }
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
  const isInspect = command === 'inspect';
  const isReset = command === 'reset';
  if (!['scan', 'inspect', 'status', 'profile', 'retry', 'reset'].includes(command)) {
    process.stderr.write(`Unknown command: ${command}\n\n${usage()}\n`);
    return 2;
  }

  const config = loadConfig({
    requireLists: command === 'scan' || isInspect,
    requireEndpoint: command === 'scan' || isRetry
  });
  const logger = createLogger({ logPath: config.logPath, consoleOutput: !isStatus });
  if (isProfile) {
    await openProfile(config, argv[1]);
    return 0;
  }
  if (isInspect) {
    const result = await inspectWishlists({
      config,
      logger,
      headed: argv.includes('--headed')
    });
    return result.failures > 0 ? 1 : 0;
  }

  const database = new WishlistDatabase(config.databasePath);
  try {
    if (isStatus) {
      process.stdout.write(`${JSON.stringify(database.getStatus(), null, 2)}\n`);
      return 0;
    }
    if (isReset) {
      if (!argv.includes('--yes')) {
        process.stderr.write('History was not erased. Re-run with --yes to confirm.\n');
        return 2;
      }
      const listOption = argv.indexOf('--list');
      if (listOption >= 0 && !argv[listOption + 1]) {
        process.stderr.write('--list requires a list id.\n');
        return 2;
      }
      const result = database.resetHistory({
        listId: listOption >= 0 ? argv[listOption + 1] : null
      });
      await logger.warn('history.reset', result);
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
      headed: argv.includes('--headed'),
      debug: argv.includes('--debug')
    });
    await logger.info('run.completed', result);
    return result.scanFailures > 0 || result.deliveryFailures > 0 ? 1 : 0;
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let fatalReporting = false;
  const handleFatalProcessError = async (reason) => {
    if (fatalReporting) return;
    fatalReporting = true;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'run.fatal', ...errorDetails(error) })}\n`);
    await sendFatalErrorNotification(error);
    process.exitCode = 1;
  };
  process.once('uncaughtException', handleFatalProcessError);
  process.once('unhandledRejection', handleFatalProcessError);
  main().then((code) => {
    process.exitCode = code;
  }).catch(handleFatalProcessError);
}
