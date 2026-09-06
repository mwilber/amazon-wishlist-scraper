# Amazon Wish-list Monitor — Implemented Specification

This private macOS utility monitors a small set of shared Amazon wish lists with
Playwright and a persistent Chromium profile. It identifies ordinary products by ASIN
and manual or unavailable entries by their stable wishlist-row ID, stores current and
historical observations in SQLite, and sends one concise JSON message to a configured
HTTP endpoint for each list that gained items.

## Safety invariants

- The first valid scan, including a verified empty list, establishes a silent baseline.
- Historical item identities are never announced again, including after removal and
  re-addition or when an existing item loses its ASIN link.
- Sign-in, CAPTCHA, unrecognized markup, navigation errors, ambiguous empty results,
  incomplete loading, and item-row/identity mismatches fail closed.
- A failed scan never updates active products or creates an outbound message.
- Product state, scan history, and a pending outbound message are committed together.
- HTTP delivery occurs after that commit. Delivery failure does not invalidate the scan.
- Pending delivery is retried from stored message text, without rescanning Amazon.
- Scan and browser failures create durable outbound failure messages without changing
  product state; fatal startup errors use best-effort direct reporting.
- The monitor does not bypass access controls, modify lists, purchase products, monitor
  prices, or send notifications directly.

## Components

The implementation separates configuration, browser lifecycle, Amazon markup parsing,
comparison, SQLite persistence, diagnostics, message construction, HTTP delivery, and
CLI/scheduling. Runtime data, secrets, browser state, logs, and diagnostics are ignored
by Git.

See `README.md` for setup, operation, delivery semantics, and verification.
