# Commerce Operations Hub

A prototype with three separate views in one application and repository:

- **Commerce hub** (`/`): live charts and portfolio metrics from the source/table channels you subscribe to.
- **Event hub** (`/event-hub`): the complete accepted CDC event journal, with source system, receipt/event timestamps, filters, pagination, and before/after inspection.
- **Event simulator** (`/simulator`): select a system of record, table, brand and record change; preview the CDC envelope, then publish it to the hub.

The included ERP and e-commerce systems, brands and source data are fictional. CDC messages simulate database changes; no real database connector or commerce store is connected.

## Run

Requires **Node.js 24+** with its built-in SQLite module. No third-party runtime packages, store credentials, containers or separate broker are needed.

```sh
cd TraBot
npm ci
npm test
npm start
```

The app binds to loopback port **3000**. Open `http://localhost:3000` in a local browser and use the sidebar to move between views. `npm run dev` enables backend file watching; refresh the browser after frontend edits. Optional `PORT`, `HOST` and `DATA_FILE` override port, bind address and SQLite location.

The default database is `.data/commerce.sqlite`. Existing version-one events migrate automatically once into source-aware CDC without deleting the old tables: order events map to ERP orders, cart events to e-commerce carts. Their source systems are inferred during this migration and labeled `legacy-migration`; they are not evidence of real ERP capture. New source changes and subscriptions persist across restarts.

Reset is available **only in the simulator**, with confirmation. It deletes the active CDC journal and current source records, then restores fictional history. It preserves subscription choices. Do not run reset or the browser smoke test against data you need to keep.

## Run from GitHub in VS Code

1. Install Git, VS Code and Node.js 24+.
2. In the Command Palette choose **Git: Clone**, enter `https://github.com/srilony/TraBot.git`, and open the cloned folder.
3. In **Terminal → New Terminal**, run `npm ci`, `npm test` and `npm start`.
4. Open the local application on port 3000. Keep the terminal running; press Ctrl+C to stop.

You can also choose **Terminal → Run Task → Start commerce demo**. Use the Node server rather than a static Live Server extension, because the app needs its backend APIs and event subscriptions. No API keys or `.env` file is required. Python/Playwright is optional and only used by the browser smoke test.

To update an existing clone, stop the server, run `git pull --ff-only` and `npm ci`, then restart it. The ignored `.data` folder preserves your local demo state.

## Data flow and subscriptions

```text
Event simulator → Event hub ingestion → SQLite CDC journal/current source records
                                      → Pub-sub notification → Commerce subscription → Live charts
                                      → Live event-hub journal view
```

A preview never publishes data. Publishing validates the record change, commits it, and only then notifies hub and commerce subscribers over Server-Sent Events. Reconnect supplies an authoritative current snapshot instead of applying deltas twice.

Default subscriptions are **ERP / Orders: on**, **E-commerce / Carts: on**, and **E-commerce / Orders: off**. Change these in the commerce hub and save. Settings apply to this shared demo workspace and every open browser window; they are not per-user preferences. Changes rebuild metrics from retained source history immediately. The hub retains all accepted events regardless of subscription settings. Turning every channel off produces empty commerce metrics without deleting hub data.

Current records are keyed by source, table, brand and record ID. If subscribed sources contain the same brand/table/record ID, the latest event timestamp wins (receipt sequence breaks ties), including deletions. Unsubscribing that source can reveal an older record from another enabled source. Use distinct IDs for unrelated records; this demo does not reconcile source-specific identifiers automatically.

An in-process event bus keeps this a small single-process MVP. It is not a managed Azure Event Hubs/Kafka deployment or a production CDC connector. There is no multi-process broker or consumer checkpoint service.

## CDC format

```json
{
  "eventId": "change-001",
  "occurredAt": "2026-10-27T12:00:00Z",
  "systemId": "erp",
  "table": "orders",
  "op": "c",
  "brandId": "northstar",
  "before": null,
  "after": {
    "orderId": "ORDER-001",
    "amountCents": 10000,
    "currency": "EUR",
    "status": "placed",
    "placedAt": "2026-10-27T12:00:00Z"
  }
}
```

The hub adds `receivedAt`, receipt `sequence`, and `source` metadata. Operations are `c` create (`before: null`), `u` update (both record images), and `d` delete (`after: null`). This is a CDC-style envelope, not a claim of compatibility with a specific vendor's full schema.

- **ERP** supports `orders`; **E-commerce platform** supports `orders` and `carts`.
- Orders contain `orderId`, integer `amountCents`, `currency: "EUR"`, `status` (`placed` or `cancelled`), `placedAt`, and optional linked `cartId`.
- Carts contain `cartId`, integer `amountCents`, `currency: "EUR"`, `status` (`active`, `abandoned`, `converted`), `abandonedAt` and `nudgedAt` (nullable ISO timestamps).
- Updates and deletes require the current source record as their before image. Stale or conflicting previews fail with HTTP 409; refresh the selection and preview again.
- Replaying an event does not duplicate its effects. A duplicate delivery is not a new journal row. Invalid changes are rejected rather than shown as accepted events.

All amounts use EUR cents; reporting months use UTC. The chart shows the latest value of placed orders in subscribed source records, before discounts and excluding tax/shipping. Updates replace an order's value; cancellations/deletions remove it. This is current booked order value, not cash received, recognized revenue or a historical net-sales ledger. Simulator updates preserve the original order month. Open-cart value is current opportunity, not a forecast. A linked subscribed order removes its cart from open opportunity; a cart explicitly marked converted also leaves opportunity without inventing order revenue.

## API

POST/PUT requests require `Content-Type: application/json`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Readiness and schema version |
| GET | `/api/catalog` | Brands, systems, tables and subscription choices |
| GET / PUT | `/api/subscriptions` | Read/save all three `{ systemId, table, enabled }` rules in `{ subscriptions: [...] }` |
| GET | `/api/dashboard?brandId=all` | Subscribed commerce snapshot |
| GET | `/api/stream?brandId=all` | Live commerce SSE `snapshot` events |
| GET | `/api/hub/events` | Full accepted history; filters `systemId`, `table`, `op`, `brandId`, `limit` (1–100), `offset` |
| GET | `/api/hub/stream` | Same filters, live `hub-snapshot` SSE |
| POST | `/api/hub/events` | Publish a CDC envelope |
| GET | `/api/source-records?systemId=erp&table=orders&brandId=all` | Current records for simulator selection |
| POST | `/api/simulator/preview` | Build an unpublished envelope from selected source/record/change |
| POST | `/api/demo/reset` | Restore fictional source history; keep subscriptions |

Preview body: `{ "systemId": "erp", "table": "orders", "op": "c", "brandId": "northstar", "recordId": "ORDER-001", "amountCents": 10000, "status": "placed" }`. `recordId` may be omitted for create; update/delete require an existing ID. To publish, send the returned `event` unchanged to `/api/hub/events`.

For compatibility, `/api/events` still accepts the original normalized event format as well as CDC, and `/api/demo/order`, `/abandon`, `/nudge` and `/recover` remain API adapters. All writes still pass through the CDC hub. The commerce UI no longer contains simulation controls.

## Verification and presentation

`npm test` covers CRUD projections, before/after integrity, duplicate/stale delivery, source subscriptions, retained-history rebuild, cross-source identities, persistence, migration, HTTP routes and live SSE. Optional `python3 test/browser_smoke.py` exercises all three screens against a running disposable demo. Its configuration is documented in that file; it requires Python Playwright and Chromium and resets the test database.

See [scope and assumptions](docs/PROTOTYPE_SCOPE.md) and [investor walkthrough](docs/DEMO_GUIDE.md).

The cloud onboarding interface has no public app preview. No public hosting deployment has been performed. A hosted demo needs a Node 24 host with persistent disk and SSE support (one process), plus access controls before exposing its unauthenticated write/reset APIs publicly. Publishing the cloud environment saves files/configuration, not running server processes.
