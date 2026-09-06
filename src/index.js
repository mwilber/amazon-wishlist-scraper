import { buildFailureMessage, buildMessage, createMessageReporter } from './message-reporter.js';
import { launchBrowser } from './browser.js';
import { scanWishlistPage } from './scan-list.js';
import { saveDiagnostics, saveInspection } from './diagnostics.js';
import { errorDetails } from './errors.js';

function reporterOptions(config, fetchImpl) {
  return {
    endpointUrl: config.endpointUrl,
    token: config.endpointToken,
    timeoutMs: config.messageTimeoutMs,
    endpointFormat: config.endpointFormat,
    sidTitle: config.sidNotificationTitle,
    sidSource: config.sidNotificationSource,
    fetchImpl
  };
}

export function createConfiguredReporter(config, fetchImpl) {
  return createMessageReporter(reporterOptions(config, fetchImpl));
}

async function deliver({ database, outboundMessage, reporter, config, logger, retry = false }) {
  const eventDetails = {
    messageId: outboundMessage.id,
    listId: outboundMessage.list_id,
    attempt: outboundMessage.attempt_count + 1,
    kind: outboundMessage.kind || 'item_added',
    message: outboundMessage.message
  };
  if (retry || outboundMessage.attempt_count > 0) await logger.info('message.retry', eventDetails);
  try {
    const result = await reporter(outboundMessage.message, { title: outboundMessage.title });
    database.markMessageSent(outboundMessage.id);
    await logger.info('message.sent', { ...eventDetails, httpStatus: result.status });
    return true;
  } catch (error) {
    const saved = database.markMessageFailure(outboundMessage.id, error.message, {
      maxAttempts: config.maxDeliveryAttempts,
      baseDelayMs: config.retryBaseDelayMs
    });
    await logger.error('message.failed', {
      ...eventDetails,
      status: saved.status,
      error: error.message,
      nextAttemptAt: saved.next_attempt_at
    });
    return false;
  }
}

export async function retryPendingMessages({ database, config, logger, includeFailed = false, ignoreSchedule = false, fetchImpl }) {
  const messages = database.getRetryableMessages({ includeFailed, ignoreSchedule });
  if (messages.length === 0) return { attempted: 0, failed: 0 };
  const reporter = createConfiguredReporter(config, fetchImpl);
  let failed = 0;
  for (const message of messages) {
    const sent = await deliver({ database, outboundMessage: message, reporter, config, logger, retry: true });
    if (!sent) failed += 1;
  }
  return { attempted: messages.length, failed };
}

export async function inspectWishlists({ config, logger, headed = false, launchBrowserImpl = launchBrowser }) {
  let context;
  let failures = 0;
  const lists = [];
  try {
    context = await launchBrowserImpl(config, { headed });
    for (const list of config.lists) {
      const startedAt = new Date().toISOString();
      const page = await context.newPage();
      try {
        const result = await scanWishlistPage({
          page,
          list,
          timeoutMs: config.scanTimeoutMs,
          previousActiveCount: 0
        });
        const diagnosticsPath = await saveInspection({
          rootPath: config.diagnosticsPath,
          list,
          page,
          result
        });
        const summary = {
          listId: list.id,
          listName: list.name,
          finalUrl: result.url,
          pageTitle: result.title,
          itemCount: result.inspection.itemCount,
          explicitEmpty: result.inspection.explicitEmpty,
          selectorCounts: result.inspection.selectorCounts,
          items: result.items,
          diagnosticsPath
        };
        lists.push(summary);
        await logger.info('scan.contents', summary);
      } catch (error) {
        failures += 1;
        const details = errorDetails(error);
        const diagnosticsPath = await saveDiagnostics({
          rootPath: config.diagnosticsPath,
          list,
          page,
          error,
          startedAt
        }).catch(() => null);
        await logger.error('scan.inspect_failed', { listId: list.id, ...details, diagnosticsPath });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } catch (error) {
    failures += config.lists.length || 1;
    await logger.error('browser.failed', errorDetails(error));
  } finally {
    await context?.close().catch(() => {});
  }
  return { failures, lists };
}

async function handleScanFailure({
  database,
  config,
  logger,
  reporter,
  list,
  page,
  error,
  startedAt
}) {
  const details = errorDetails(error);
  let diagnosticsPath = null;
  try {
    diagnosticsPath = await saveDiagnostics({
      rootPath: config.diagnosticsPath,
      list,
      page,
      error,
      startedAt
    });
  } catch (diagnosticError) {
    await logger.error('diagnostics.failed', {
      listId: list.id,
      error: diagnosticError.message
    });
  }

  const notificationMessage = buildFailureMessage(
    list.name,
    error,
    config.maxMessageLength
  );
  let failureRecord;
  try {
    failureRecord = database.persistFailedScan({
      list,
      startedAt,
      errorCategory: details.category,
      errorMessage: details.message,
      diagnosticsPath,
      notificationTitle: config.sidFailureNotificationTitle,
      notificationMessage
    });
  } catch (databaseError) {
    await logger.error('scan.failure_record_failed', {
      listId: list.id,
      error: databaseError.message
    });
    await logger.error('scan.failed', { listId: list.id, ...details, diagnosticsPath });
    try {
      const result = await reporter(notificationMessage, {
        title: config.sidFailureNotificationTitle
      });
      await logger.info('message.sent', {
        listId: list.id,
        kind: 'scan_failure',
        untracked: true,
        message: notificationMessage,
        httpStatus: result.status
      });
      return { deliveryFailed: false };
    } catch (deliveryError) {
      await logger.error('message.failed', {
        listId: list.id,
        kind: 'scan_failure',
        untracked: true,
        message: notificationMessage,
        error: deliveryError.message
      });
      return { deliveryFailed: true };
    }
  }

  await logger.error('scan.failed', {
    listId: list.id,
    scanId: failureRecord.scanId,
    ...details,
    diagnosticsPath
  });
  await logger.info('message.created', {
    messageId: failureRecord.outboundMessage.id,
    listId: list.id,
    kind: 'scan_failure',
    message: notificationMessage
  });
  const sent = await deliver({
    database,
    outboundMessage: failureRecord.outboundMessage,
    reporter,
    config,
    logger
  });
  return { deliveryFailed: !sent };
}

export async function runMonitor({ database, config, logger, headed = false, debug = false, fetchImpl, launchBrowserImpl = launchBrowser }) {
  let scanFailures = 0;
  let deliveryFailures = 0;
  const retryResult = await retryPendingMessages({ database, config, logger, fetchImpl });
  deliveryFailures += retryResult.failed;

  const reporter = createConfiguredReporter(config, fetchImpl);
  const handledLists = new Set();
  let context;
  try {
    context = await launchBrowserImpl(config, { headed });

    for (const list of config.lists) {
      const startedAt = new Date().toISOString();
      let page = null;
      let scanResult = null;
      try {
        page = await context.newPage();
        await logger.info('scan.started', { listId: list.id, listName: list.name });
        const state = database.getListState(list.id);
        const extracted = await scanWishlistPage({
          page,
          list,
          timeoutMs: config.scanTimeoutMs,
          previousActiveCount: state.activeItems.length
        });
        if (debug) {
          await logger.info('scan.contents', {
            listId: list.id,
            listName: list.name,
            finalUrl: extracted.url,
            pageTitle: extracted.title,
            itemCount: extracted.inspection.itemCount,
            explicitEmpty: extracted.inspection.explicitEmpty,
            selectorCounts: extracted.inspection.selectorCounts,
            items: extracted.items
          });
        }
        scanResult = database.persistSuccessfulScan({
          list,
          items: extracted.items,
          startedAt,
          buildMessage: (name, items) => buildMessage(name, items, config.maxMessageLength)
        });
        await logger.info(scanResult.isBaseline ? 'scan.baseline' : 'scan.completed', {
          listId: list.id,
          scanId: scanResult.scanId,
          itemCount: scanResult.comparison.currentItems.length,
          newItemCount: scanResult.isBaseline ? 0 : scanResult.comparison.newItems.length,
          removedItemCount: scanResult.comparison.removedItems.length,
          reactivatedItemCount: scanResult.comparison.reactivatedItems.length
        });
      } catch (error) {
        scanFailures += 1;
        const failure = await handleScanFailure({
          database,
          config,
          logger,
          reporter,
          list,
          page,
          error,
          startedAt
        });
        if (failure.deliveryFailed) deliveryFailures += 1;
      } finally {
        handledLists.add(list.id);
        await page?.close().catch(() => {});
      }

      if (scanResult?.outboundMessage) {
        await logger.info('message.created', {
          messageId: scanResult.outboundMessage.id,
          listId: list.id,
          message: scanResult.outboundMessage.message
        });
        const sent = await deliver({
          database,
          outboundMessage: scanResult.outboundMessage,
          reporter,
          config,
          logger
        });
        if (!sent) deliveryFailures += 1;
      }
    }
  } catch (error) {
    await logger.error('browser.failed', errorDetails(error));
    const unhandledLists = config.lists.filter((list) => !handledLists.has(list.id));
    if (unhandledLists.length === 0) throw error;
    scanFailures += unhandledLists.length;
    for (const list of unhandledLists) {
      const failure = await handleScanFailure({
        database,
        config,
        logger,
        reporter,
        list,
        page: null,
        error,
        startedAt: new Date().toISOString()
      });
      if (failure.deliveryFailed) deliveryFailures += 1;
    }
  } finally {
    await context?.close().catch(() => {});
  }
  return { scanFailures, deliveryFailures };
}
