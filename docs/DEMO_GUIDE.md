# Investor walkthrough: three views, one event flow

**Story:** Source systems publish changes to a shared hub. Commerce chooses the channels that matter, and its portfolio view updates automatically.

## Prepare

Run `npm ci`, `npm test`, then `npm start`. Open the application through your local/hosted setup. Use three browser tabs: **Commerce hub**, **Event hub**, and **Event simulator**. The cloud onboarding interface itself has no public app preview.

In commerce, save the default subscriptions: ERP orders on, e-commerce carts on, e-commerce orders off. For a clean presentation, reset the **disposable demo database** from the simulator; reset clears added CDC/source data and retains subscription settings. All brands and events are fictional.

## Present

1. **A source publishes an order.** In the simulator choose ERP → Orders → Create, a brand and €100. Preview the event. Point to `op: c`, `before: null` and the new order in `after`. The preview changes no data. Publish it.
2. **The hub receives it.** The event appears automatically in the event hub. Inspect source system, record ID, receipt time, event time and before/after JSON. The commerce tab's monthly booked order value increases by €100 without refresh.
3. **Prove subscription routing.** Publish an e-commerce order worth €40 with a distinct ID. It appears in the hub but does not change commerce while that channel is off. Enable E-commerce / Orders in commerce and save. Retained history is included, so the €40 appears immediately. Disable it to remove its contribution; the hub still retains the event.
4. **Show change data capture.** In the simulator choose ERP → Orders → Update and select the €100 order. Change its value to €150. Preview shows old/new images. Publish; the graph increases by €50, not €150. Choose Delete for the same order, preview and publish. Its current booked value disappears, but the hub retains create, update and delete records.
5. **Show cart opportunity.** Create an e-commerce abandoned cart worth €75. Open-cart value increases by €75 while booked order value stays unchanged. Update its value or mark it converted to show changes in current opportunity. To demonstrate linked recovery, create an ERP order with that cart's ID; the subscribed order closes its opportunity and contributes order value once.
6. **Show the durable picture.** Filter the hub by system/table/operation, inspect older pages, then reload a tab. Subscriptions and data survive reload and server restart.

## Explain boundaries honestly

The system performs real persistence, ingestion validation, in-process pub-sub, live browser subscriptions and source-filtered projections. CDC events and source systems are simulated; there is no real ERP/e-commerce database connector, no email delivery, no cloud-managed broker and no production authentication. Current order value is not payment-reconciled revenue. Cart value is opportunity, not a forecast. A linked purchase is not evidence that a nudge caused conversion.

Simulator changes use current source images and reject stale previews with 409. Refresh/select the record and preview again if another tab changed it. Reset is shared and intentional. Changing subscriptions is also shared across demo windows and rebuilds from retained history.
