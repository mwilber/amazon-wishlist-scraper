# Amazon Wish-list Monitor — Implemented Specification

This private macOS utility monitors a small set of shared Amazon wish lists with
Playwright and a persistent Chromium profile. It identifies products by ASIN,
stores current and historical observations in SQLite, and sends one concise JSON
message to a configured HTTP endpoint for each list that gained products.

## Safety invariants

- The first valid, non-empty scan establishes a silent baseline.
- Historical ASINs are never announced again, including after removal and re-addition.
- Sign-in, CAPTCHA, unrecognized markup, navigation errors, and empty results fail closed.
- A failed scan never updates active products or creates an outbound message.
- Product state, scan history, and a pending outbound message are committed together.
- HTTP delivery occurs after that commit. Delivery failure does not invalidate the scan.
- Pending delivery is retried from stored message text, without rescanning Amazon.
- The monitor does not bypass access controls, modify lists, purchase products, monitor
  prices, or send notifications directly.

## Components

The implementation separates configuration, browser lifecycle, Amazon markup parsing,
comparison, SQLite persistence, diagnostics, message construction, HTTP delivery, and
CLI/scheduling. Runtime data, secrets, browser state, logs, and diagnostics are ignored
by Git.

See `README.md` for setup, operation, delivery semantics, and verification.
