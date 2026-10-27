# Three-minute investor demo

**Story:** Across brands, commerce signals become one operational view. Managers see outcomes and open opportunities, then coordinate a response.

## Prepare

From the repository run `npm ci --ignore-scripts`, `npm test`, and `npm start`. Open through your chosen local/hosted setup; the cloud onboarding interface has no public app preview. Reset the demo to restore the fictional baseline. Reset deletes all events in the active demo database. Keep the demo-data label visible. Optionally use a second browser window to show subscriptions updating together.

## Present

1. **Portfolio (30 seconds).** Show monthly gross order value and brand comparison. Explain that these are placed orders, not reconciled cash. Filter a brand, then return to all brands.
2. **An order arrives (30 seconds).** Publish a €100 order in the simulator. The current-month metric, chart and event feed update without refresh, including in a second window.
3. **Opportunity (30 seconds).** Publish a €75 abandoned cart. Open-cart value rises; booked order value does not. Explain that opportunity is not guaranteed revenue.
4. **Action and outcome (45 seconds).** Record a mock nudge. No message is sent and no sale is generated. Separately simulate checkout for the same cart. Open opportunity falls and booked sales rise; the feed records the steps. Do not claim measured conversion lift.
5. **Vision (30 seconds).** Connect this working flow to the pitch's wider inventory, service, finance and workflow ambition. Those are future capabilities, not implemented features.

## Honest boundaries

Event ingestion, persistence, pub-sub, graph updates and filtering work. Brands, data, nudges and checkout are fictional/presenter-controlled. There is no live store, message delivery, authentication or independent durable broker. No public hosting deployment has been performed.

During server restart the dashboard shows reconnection and restores the current snapshot afterward. SQLite preserves state. Reload if needed; reset restores the presentation baseline. Without hosted access, run the same app on a local Node 24 machine and screen-share it.
