# Workflow automation

Workflow automation is a fourth feature in the existing Commerce Operations Hub, at `/workflows`. It shares the Node server, SQLite database and event journal. No extra npm packages, broker or separate application are required.

## Build a flow

1. Open **Workflow automation** in the sidebar. Start a blank flow or load an example.
2. Drag blocks from the palette onto the canvas (or use the add controls). Move blocks to arrange the flow.
3. Connect an output port to the next block's input. Conditions have separate **true** and **false** outputs. Select a block to configure it.
4. Save as a draft. Drafts may be incomplete and never run automatically. Fix the listed validation errors before testing or enabling.
5. Run a test against a matching retained event, or test a schedule flow immediately. Inspect each step's inputs, output, selected branch and error in run history. Tests always capture email in the outbox.
6. Configure Resend and replace example recipients before enabling real email actions. Enable the saved flow to listen for new events or its scheduled interval. Disable it to stop new triggers.

Each workflow has one trigger and at most 25 nodes. Connections form an acyclic graph with one incoming edge per block and one next block per output port. Unconnected condition branches end the run normally. Loops, parallel forks, branch joins, delays and nested workflows are outside this MVP.

## Triggers

**Event trigger:** choose one or more system/table/CDC-operation combinations (for example ERP / Orders / Created and E-commerce / Carts / Created). Matching is OR across those choices. These subscriptions are independent of the commerce dashboard's selected channels. An enabled workflow only starts for new matching events after activation; it does not replay historical events automatically.

The full accepted hub envelope is available as `event`, including source, operation, before/after record images, event ID, timestamps and brand. Map any desired subset into named typed variables, for example:

```json
{
  "matches": [{ "systemId": "erp", "table": "orders", "op": "c" }],
  "fields": [
    { "key": "orderId", "path": "event.after.orderId" },
    { "key": "amount", "path": "event.after.amountCents" }
  ]
}
```

`vars.amount` remains a number. Mapping fields does not discard the complete event. Re-delivering the same event cannot start a duplicate run for that workflow. A simulator reset restores seed data without treating those seed changes as new automation triggers.

**Schedule trigger:** configure a start date/time and positive interval in seconds, minutes, hours or days. The stored anchor is an ISO timestamp. Intervals are elapsed durations; a day means 24 hours rather than a timezone-aware calendar/cron rule. A past start date selects the next aligned future interval on initial activation. While the server runs, due checks occur approximately once a second. Across downtime, missed intervals coalesce into one run for the latest due slot, then resume the original cadence. Schedules and due slots persist; the process must be running for execution.

## Conditions and variables

A condition compares a variable path or typed constant on each side. Supported operators are equals, not equals, greater/greater-or-equal, less/less-or-equal, contains and exists. Ordered comparisons require numeric inputs. Equality preserves types: number `100` is different from text `"100"`. A missing value fails the run visibly, except when deliberately checked with **exists**.

Available roots:

| Reference | Meaning |
| --- | --- |
| `event.after.amountCents` | Full event's current order/cart value |
| `event.before.amountCents` | Previous value on an update/delete |
| `vars.amount` | A selected trigger field alias |
| `nodes.lookup.data.limitCents` | JSON returned by an earlier HTTP block whose ID is `lookup` |
| `nodes.check.result` | Boolean output from an earlier condition |
| `schedule.scheduledAt` | Anchored scheduled slot |
| `schedule.missedIntervals` | Number of coalesced missed slots |

Text inputs support `{{vars.amount}}` and `{{nodes.lookup.data.limitCents}}` templates. No JavaScript expressions or `eval` are used. Reference paths read only existing own-properties; constructor/prototype access is blocked. A field from a node that has not run is unavailable. Use the stable node ID shown in the inspector for references, not its visual position.

## HTTP Get

The HTTP Get block makes a server-side GET request and expects JSON. Its output is `{ status, data, url }`. Later conditions and email blocks can reference any received JSON field. Substituted URL values are encoded as URL components.

A working built-in example uses a real HTTP request to:

```text
/api/workflow-demo/reference?brandId={{event.brandId}}
```

It returns a fictional threshold in integer EUR cents and a demo team address. `/api/source-records` can also be used as a relative URL. These built-in endpoints provide a repeatable demo without external credentials. Public HTTP/HTTPS JSON endpoints are supported subject to the cloud environment's destination allowlist. Private/local destinations and URL-embedded credentials are rejected, except for the two explicit built-in relative endpoints. Custom authentication headers are not part of this first version.

Requests have a ten-second timeout, a one-megabyte decoded response limit and bounded redirects. Non-success status, invalid JSON, timeouts and missing fields stop dependent steps and appear in run history.

## Real email through Resend

The **Resend** email action supports a recipient, subject and plain-text body, including variable templates. Sending requires:

- `WORKFLOW_EMAIL_API_KEY`: a Resend API key, entered securely as an environment secret. HTTPS destination: `api.resend.com`.
- `WORKFLOW_EMAIL_FROM`: an address or `Display Name <address>` using a sender/domain verified in Resend.

For this cloud environment, these requirements are saved in its configuration draft. Enter values securely in environment settings; review/save the changes and publish the environment configuration as appropriate. Never put the key in a workflow definition, committed file or chat. Runtime bindings may need to propagate or the app may need restarting. The capability indicator reports configuration presence without exposing values.

For a local VS Code session, set those environment variables in your shell before `npm start`. The app reads process environment variables; it does **not** automatically load `.env` files. No credential values are stored in workflow definitions or run history. `RESEND_API_KEY` is also accepted if already bound locally; the cloud draft declares the application-specific `WORKFLOW_EMAIL_API_KEY`.

Enabled flows with Resend actions require the provider configuration. Manual tests force outbox capture even when a node is configured for real Resend delivery. The optional **Demo outbox** delivery mode can be enabled for fictional-data demonstrations without credentials. It never sends mail.

A `submitted` result means Resend accepted the message, not that the recipient received it. Demo, submitted, failed and uncertain outcomes are distinct. Each run/node email action is persisted and idempotent; provider calls use an idempotency key. Failed/uncertain actions are not automatically resent. No real email is sent merely by loading a page or saving a draft.

## Run history and persistence

Definitions, activation state, next schedule slots, queued runs, selected event values, per-node results and email outcomes persist in the same SQLite file. Each run captures the saved workflow version; later edits do not change that run. Disabling stops new triggers while already accepted work may finish. Deleting a workflow stops queued work; prior run history remains available. A server interruption marks in-flight runs interrupted instead of replaying non-idempotent actions automatically. Queued work and newly received hub events can resume using persisted trigger state.

This remains a single-process prototype, not a distributed durable workflow platform. The existing application has no user authentication or role separation. Keep it in a controlled demo environment; add access controls and production operational guarantees before wider deployment.

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/workflows/catalog` | Event choices, examples, references, email capability status |
| GET / POST | `/api/workflows` | List or create saved definitions |
| GET / PUT / DELETE | `/api/workflows/:id` | Read, update with revision, or remove a flow |
| POST | `/api/workflows/:id/test` | Test saved flow; optional `{ "eventId": "..." }`; email always captured |
| GET | `/api/workflows/:id/runs` | Latest 50 runs for that flow |
| GET | `/api/workflows/runs` | Latest 50 runs across flows |
| GET | `/api/workflows/outbox` | Recent captured/submitted/failed email records |
| GET | `/api/workflows/capabilities` | Credential presence and HTTP limits, no secret values |

Run `npm test` for engine, schedule, IO and HTTP integration checks. Optional browser workflow checks use `test/workflow_browser.py` against a disposable database. They use outbox capture and must not send real email.

## Customer events and Update CRM

The existing simulator has a **Custom customer event** JSON editor. Preview validates without publishing; **Publish to event hub** commits to the same journal and notifies enabled workflows. The hub supports **Custom customer events / Customers** filters and displays the complete payload. Customer events are separate from commerce projections and subscriptions. Use synthetic data for demonstrations:

```json
{
  "table": "customers",
  "idField": "customerid",
  "data": {
    "customerid": 123,
    "name": "SYNTHETIC Demo Customer",
    "emailid": "demo@example.invalid",
    "phone": "0000000000",
    "nationality": "Indian",
    "documentID": "DEMO-123"
  }
}
```

POST this structure directly to `/api/hub/events`, or preview it at `/api/simulator/preview` and publish the returned `event`. The hub supplies event ID, receipt sequence, timestamps, `systemId: "custom"`, `op: "c"` and source metadata. An optional stable `eventId` deduplicates delivery; a conflicting payload with the same event ID is rejected. A new event ID represents a new event even when the customer ID is unchanged. No customer database persistence is implied by ingestion into this journal.

In the visual editor, add an **Event trigger**, select **Custom customer events · Customer event created**, and remove any unwanted order/cart mappings. The complete customer payload is accessible as `event.table`, `event.idField`, and `event.data`. Map selected fields such as `event.data.customerid` into `vars.customerId`; numbers, strings, booleans and null remain native JSON values. Customer column names use **emailid**, not `email`.

Connect an **Update CRM** block. Configure table (default `customers`), ID field (default `customerid`), and the customer fields JSON mapping. Each field selects a typed constant or a safe variable path, including previous node output:

```json
{
  "customerid": { "kind": "path", "value": "vars.customerId" },
  "name": { "kind": "constant", "value": "SYNTHETIC Demo Customer" },
  "emailid": { "kind": "path", "value": "event.data.emailid" },
  "phone": { "kind": "path", "value": "nodes.lookup.data.phone" }
}
```

The outbound body is `{ "table": ..., "idField": ..., "data": ... }`. The ID field must exist in data and hold a nonempty string or safe integer. Table/field names must be safe identifiers. Paths preserve complete values, rather than interpolating them into strings.

The **n8n-basic** credential reference resolves only on the server from `N8N_BASIC_USERNAME` and `N8N_BASIC_PASSWORD`. Bind these securely before starting the server; `.env` files are not loaded. Neither credential value nor Authorization header belongs in the editor, a definition, API response or run log. Credential/header keys and known credential values are rejected from saved definitions/customer data, including drafts. Capability responses expose configuration presence only.

Default bound POST URL:

```text
https://srilony.app.n8n.cloud/webhook-test/cdc-webhook
```

The editable node URL must match the credential reference's bound server URL. An operator can explicitly change that binding with `N8N_WEBHOOK_URL`; this does not happen automatically. HTTPS without embedded credentials, query or fragment is required. DNS is checked for public addresses and pinned for the request. Redirects are rejected to prevent forwarding credentials. No production URL fallback exists.

**Test flow sends a real CRM POST.** Only email is captured in test mode. Before an actual test, select **Listen for test event** in n8n and use a fresh synthetic customer ID. Each run/node is attempted at most once, including across restarts; failed, timed-out and interrupted database-writing requests are never automatically retried. A new manual test creates a new run and may write again. Check the n8n/database outcome before doing that.

Run history shows HTTP acceptance/status or a controlled error, never remote response bodies/headers that might reflect credentials. An HTTP 404 reports that the test webhook may not be registered and asks the operator to enable its listener. HTTP 2xx produces `outcome: "accepted", persistence: "unverified"`; it does **not** establish database persistence. Verify the customer row independently in the destination database or n8n execution evidence.

For one explicit live verification, securely bind the two credentials, start the n8n test listener, then run:

```sh
node scripts/verify-crm.mjs --listening
```

This uses the same authenticated CRM adapter, a temporary in-memory journal, a fresh numeric ID, and clearly labelled synthetic customer data. It makes one request, reports only safe outcome details, and never retries. It refuses to run without credentials/listener acknowledgement or against a different URL. Verification may leave the synthetic row in the destination database; it never changes the local application database.

`npm test` includes customer persistence, HTTP ingestion, typed event/previous-node mappings, authenticated transport, destination binding, hostile response redaction, deduplication, and failure/no-retry checks. `python3 test/customer_browser.py` launches its own in-memory app and exercises simulator → hub → visual editor → CRM → run history with a mocked external transport. It needs Python Playwright and Chromium (`CHROMIUM_PATH` optional), never sends a real webhook, and never touches `.data`.
