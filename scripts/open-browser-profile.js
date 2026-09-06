#!/usr/bin/env node
import { main } from '../src/cli.js';

main(['profile', ...process.argv.slice(2)]).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`Could not open the browser profile: ${error.message}\n`);
  process.exitCode = 1;
});
