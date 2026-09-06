# Amazon Wish-list Monitor

A conservative, local-only Node.js utility for watching a small number of shared Amazon
wish lists. It runs Chromium headlessly through Playwright, stores product history in
SQLite, and sends short messages to an external HTTP endpoint when genuinely new ASINs
appear.

The receiving application decides what to do with each message. This project does not
send email, SMS, push, Slack, or macOS notifications itself.

## Requirements

- Apple Silicon Mac running a current macOS release
- Node.js 22.5 or newer (the app uses Node's built-in `node:sqlite` module)
- Network access to the configured Amazon lists and message endpoint

## Install

```bash
npm install
npx playwright install chromium
cp .env.example .env
cp config/lists.example.json config/lists.json
```

Edit `config/lists.json`. Each entry needs a stable local `id`, a human-readable `name`,
and an HTTPS Amazon wish-list `url`. Set `enabled` to `false` to skip a list.

Edit `.env` and set at minimum:

```dotenv
MESSAGE_ENDPOINT_URL=https://example.com/message-endpoint
```

Relative paths in `.env` are resolved from this project directory. `MESSAGE_ENDPOINT_TOKEN`
is optional. If provided, it is sent as a bearer token and is never written to logs.
The default scan is headless; `SCAN_TIMEOUT_MS`, `MESSAGE_TIMEOUT_MS`,
`MAX_MESSAGE_LENGTH`, `MAX_DELIVERY_ATTEMPTS`, and `RETRY_BASE_DELAY_MS` are configurable.

Both `.env` and `config/lists.json` are intentionally ignored by Git because list URLs
and endpoint credentials may be private.

## Browser profile setup

Shared public lists may work immediately. If Amazon legitimately requires you to sign in,
open the dedicated persistent profile:

```bash
npm run profile
```

Sign in manually, confirm that the wish list is visible, and close the Chromium window.
The profile is saved under `browser-profile/` and reused by future headless scans. The app
does not solve CAPTCHAs or bypass authentication, throttling, or other Amazon controls.

## Run and verify

Run the first scan in a visible browser while setting up:

```bash
npm run scan:headed
```

The first successful non-empty scan for each list creates a baseline and sends nothing.
Normal runs use:

```bash
npm run scan
```

Inspect state without opening Amazon:

```bash
npm run status
```

The JSON output shows the last scan, active and historical counts, message counts, and
every pending or exhausted outbound message. For direct SQLite inspection:

```bash
sqlite3 data/wishlist-monitor.sqlite \
  "SELECT id,list_id,status,attempt_count,next_attempt_at,last_error FROM outbound_messages ORDER BY id;"
```

Run all automated tests (they mock both Amazon pages and the message endpoint):

```bash
npm test
```

## HTTP message contract

Each request is an HTTP `POST` with `Content-Type: application/json` and exactly one
required body property:

```json
{
  "message": "Two new items were added to Niece's Wish List: Building Set and Space Atlas."
}
```

With `MESSAGE_ENDPOINT_TOKEN=example-token`, the request also includes:

```http
Authorization: Bearer example-token
```

One new product produces a message such as:

```text
A new item was added to Niece's Wish List: Building Set.
```

Multiple products found on one list in one scan are grouped into one POST. Different
lists get separate POSTs. Long messages are summarized to `MAX_MESSAGE_LENGTH`; a missing
title falls back to the canonical Amazon product URL.

Test the receiver independently, without scanning Amazon:

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer example-token" \
  -d '{"message":"Test message from the Amazon wish-list monitor."}' \
  https://example.com/message-endpoint
```

Omit the `Authorization` header if the receiver does not require it.

## Delivery and retry behavior

For a successful scan, product changes and a pending `outbound_messages` row are stored
in one SQLite transaction. The HTTP request happens afterward. A timeout, network error,
or non-2xx response leaves the scan successful and records the delivery error.

At the beginning of each normal run, due pending messages are retried from the database
before Amazon is scanned. Retries use exponential delays starting at
`RETRY_BASE_DELAY_MS`. After `MAX_DELIVERY_ATTEMPTS`, a message is marked `failed` and no
longer retried automatically. Inspect it with `npm run status`, fix the receiver, then
explicitly revive all pending and failed messages:

```bash
npm run retry -- --all
```

Use `npm run retry` to send only currently due pending messages. A sent row is never
selected again. Historical products are not made new by an endpoint outage or by being
removed and later re-added.

## Failure protection and diagnostics

The monitor rejects sign-in pages, CAPTCHAs, HTTP/navigation failures, unrecognized page
markup, and empty item results. On these failures it does not change product activity or
create an item-added message. It records a failed scan and saves, when available:

- `diagnostics/<timestamp>-<list-id>/page.png`
- `diagnostics/<timestamp>-<list-id>/page.html`
- `diagnostics/<timestamp>-<list-id>/metadata.json`

One list failure does not stop remaining lists. Logs are JSON Lines in
`logs/wishlist-monitor.log`. Browser profile contents, cookies, tokens, and request
authorization headers are never logged.

## Schedule with launchd

After configuration and one manual baseline scan, install the per-user launch agent.
The optional argument is the interval in seconds; the default is 3600 (one hour):

```bash
./scripts/install-launch-agent.sh 3600
```

The generated plist uses absolute paths for this checkout and the currently selected
Node executable. It runs headlessly and writes launchd's standard streams under `logs/`.
Changing `.env` does not require regenerating the plist. To uninstall:

```bash
./scripts/uninstall-launch-agent.sh
```

Uninstalling leaves the SQLite database, diagnostics, logs, and browser profile intact.

## CLI reference

```text
node src/cli.js scan [--headed]
node src/cli.js retry [--all]
node src/cli.js status
node src/cli.js profile [url]
```

Exit status is nonzero for configuration/browser/scan failures or message-delivery
failures. Logs distinguish `scan.failed` from `message.failed`.

## Maintenance notes

Amazon can change its HTML. Parser logic is isolated in `src/parse-wishlist.js`, with
fixture coverage in `tests/`. Review diagnostics before updating selectors; never treat a
broken page as an empty list. This is a small private utility, not a large-scale scraper.
