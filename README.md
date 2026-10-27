# Commerce Operations Hub

An investor prototype for multi-brand ecommerce observability. Publish an order or abandoned-cart event, watch the subscribed dashboard update, record a mock nudge, and separately simulate checkout. All demo companies and commerce data are fictional.

Read the [completeness assessment and scope](docs/PROTOTYPE_SCOPE.md) and [three-minute demo guide](docs/DEMO_GUIDE.md).

## Run

Requires **Node.js 24+** with its built-in SQLite module. No third-party runtime packages, store credentials, containers or separate broker are needed.

```sh
cd TraBot
npm ci --ignore-scripts
npm test
npm start
```

The app binds to loopback port **3000**. `npm run dev` enables file watching. Optional `PORT`, `HOST` and `DATA_FILE` override port, bind address and SQLite location. The default database is `.data/commerce.sqlite`; it is seeded only on first start. Reset deletes events in the active demo database and restores fictional history. Do not use a database you need to preserve.

## Run from GitHub in VS Code

GitHub stores the source; the application runs on your computer. Install Git, VS Code and Node.js 24+ first.

1. In VS Code, open the Command Palette and choose **Git: Clone**.
2. Enter `https://github.com/srilony/TraBot.git`, choose a local folder, then open the cloned repository.
3. Choose **Terminal → New Terminal** and run:

   ```sh
   node --version
   npm ci
   npm test
   npm start
   ```

4. Open `http://localhost:3000` in your browser. Keep the terminal running; use Ctrl+C to stop the server. Use the event simulator to explore the demo. Alternatively, choose **Terminal → Run Task → Start commerce demo** in VS Code after installing dependencies.

For development, use `npm run dev` instead of `npm start`; the backend restarts when files change. Refresh the browser after frontend edits. On later visits, reopen the folder and run `npm start`. To pull future changes, stop the server, run `git pull --ff-only` and `npm ci`, then restart. The ignored `.data` folder keeps your local demo state; it is not stored in Git.

No account, API keys or environment-variable file is needed for the fictional-data demo. Python and Playwright are only needed for the optional browser smoke test, not to run the app or `npm test`. The Node app serves its own frontend and API; use `npm start` rather than VS Code's static Live Server extension.

This cloud onboarding interface has no public app preview. The running server supports internal validation. For investor access, use a Node 24 host with persistent disk and SSE support (one process), or run it locally and screen-share. There is no authentication; add access controls before exposing write/reset APIs publicly. No hosting deployment has been performed.

## Architecture and metrics

One Node server serves the frontend and API. Events are validated and stored transactionally in SQLite with order/cart projections, then published to an in-process hub. Browser subscribers receive authoritative snapshots over Server-Sent Events. Reload/reconnect recovers current state without adding deltas twice. This demonstrates pub-sub without a cloud broker; multi-process delivery and live integrations are outside scope.

Amounts are integer EUR cents. Gross order value means merchandise value before discounts, excluding tax/shipping; it is booked demand, not cash received or reconciled revenue. Open-cart value is opportunity, not a forecast. Calendar months use UTC. Full definitions are in the scope document.

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Readiness check |
| GET | `/api/dashboard?brandId=all` | Snapshot; filter with a brand ID |
| GET | `/api/stream?brandId=all` | Live SSE `snapshot` events, including an initial snapshot |
| POST | `/api/events` | Publish a normalized event |
| POST | `/api/demo/order` | Simulated order: `{ "brandId": "northstar", "amountCents": 10000 }` |
| POST | `/api/demo/abandon` | Simulated abandonment: same fields |
| POST | `/api/demo/nudge` | Mock nudge: `{ "cartId": "..." }` |
| POST | `/api/demo/recover` | Simulated checkout: `{ "cartId": "..." }` |
| POST | `/api/demo/reset` | Restore fictional history: `{}` |

POST requests require `Content-Type: application/json`. Brand IDs: `northstar`, `atelier`, `fieldwork`. Include `brandId` when a cart ID occurs in multiple brands.

Example event body (use a current timestamp when trying it):

```json
{
  "eventId": "demo-delivery-001",
  "type": "order.placed",
  "occurredAt": "2026-10-27T12:00:00Z",
  "brandId": "northstar",
  "source": "demo-publisher",
  "payload": {
    "orderId": "ORDER-001",
    "amountCents": 10000,
    "currency": "EUR"
  }
}
```

Future timestamps beyond five minutes are rejected. Orders deduplicate by delivery ID and stable brand/order ID. Conflicts return HTTP 409. A linked `cartId` closes its opportunity even if checkout arrives before the abandonment.

## Verification

`npm test` covers metric arithmetic, validation, duplicates, late events, cart recovery, SQLite persistence, reset, HTTP APIs, live delivery to two subscribers and reconnection. Browser checks additionally exercise actual dashboard actions and responsive layout.

Publishing the environment saves files/configuration, not live server processes. Future tasks should use the existing checkout, start the server and verify health and dashboard endpoints.
