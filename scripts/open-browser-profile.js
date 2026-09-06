#!/usr/bin/env node
import { main, sendFatalErrorNotification } from '../src/cli.js';

main(['profile', ...process.argv.slice(2)]).then((code) => {
  process.exitCode = code;
}).catch(async (error) => {
  process.stderr.write(`Could not open the browser profile: ${error.message}\n`);
  await sendFatalErrorNotification(error);
  process.exitCode = 1;
});
