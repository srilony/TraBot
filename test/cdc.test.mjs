import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CommerceStore } from '../src/store.mjs';
import { createApp } from '../src/server.mjs';

let serial = 0;
const timestamp = () => new Date(Date.now() - 1000 + (++serial % 500)).toISOString();
const order = (orderId, amountCents = 10000) => ({ orderId, amountCents, currency: 'EUR', status: 'placed', placedAt: timestamp() });
const cart = (cartId, amountCents = 7500) => ({ cartId, amountCents, currency: 'EUR', status: 'abandoned', abandonedAt: timestamp(), nudgedAt: null });
const change = (after, extra = {}) => ({ eventId: `cdc-${++serial}`, occurredAt: timestamp(), systemId: 'erp', table: 'orders', op: 'c', brandId: 'northstar', before: null, after, ...extra });
const fixture = t => {
  const store = new CommerceStore(':memory:', { seed: false });
  t.after(() => store.close());
  return store;
};
const rules = (store, overrides = {}) => store.getSubscriptions().subscriptions.map(rule => ({ systemId: rule.systemId, table: rule.table, enabled: overrides[`${rule.systemId}.${rule.table}`] ?? rule.enabled }));
const value = store => store.dashboard().summary.currentMonthValueCents;

test('CDC journal preserves source, timestamps and before/after images through create, update and delete', t => {
  const store = fixture(t);
  const created = store.ingest(change(order('cdc-order'))).event;
  assert.equal(value(store), 10000);
  assert.equal(created.source.systemId, 'erp');
  assert.equal(created.source.table, 'orders');
  assert.ok(Number.isFinite(Date.parse(created.receivedAt)));
  assert.ok(Number.isFinite(Date.parse(created.occurredAt)));
  assert.equal(created.before, null);

  const updated = store.ingest(change({ ...created.after, amountCents: 16000 }, { op: 'u', before: created.after })).event;
  assert.equal(value(store), 16000, 'a row update replaces value instead of adding another order');
  assert.equal(store.dashboard().summary.currentMonthOrders, 1);
  assert.equal(updated.before.amountCents, 10000);
  assert.equal(updated.after.amountCents, 16000);
  assert.equal(updated.after.placedAt, created.after.placedAt, 'correction keeps the original order month');

  store.ingest(change(null, { op: 'd', before: updated.after }));
  assert.equal(value(store), 0);
  assert.equal(store.sourceRecords({ systemId: 'erp', table: 'orders' }).records.length, 0);
  const history = store.hubEvents({});
  assert.equal(history.total, 3);
  assert.deepEqual(history.events.map(event => event.op), ['d', 'u', 'c']);
  assert.equal(history.events[0].after, null);
  assert.equal(history.events[1].before.amountCents, 10000);
  assert.equal(history.events[2].after.amountCents, 10000, 'newer changes do not mutate the original journal entry');
});

test('source/table subscriptions route ERP orders and ecommerce carts while hub retains every source', t => {
  const store = fixture(t);
  store.ingest(change(order('erp-order')));
  store.ingest(change(order('ecommerce-order', 4000), { systemId: 'ecommerce' }));
  store.ingest(change(cart('ecommerce-cart'), { systemId: 'ecommerce', table: 'carts' }));
  assert.equal(store.hubEvents({}).total, 3);
  assert.equal(value(store), 10000, 'ecommerce order channel is off by default');
  assert.equal(store.dashboard().summary.openCartValueCents, 7500);
  assert.equal(store.dashboard().summary.totalEvents, 2);
  assert.ok(store.dashboard().recentEvents.every(event => !(event.systemId === 'ecommerce' && event.table === 'orders')));

  const beforeRevision = store.dashboard().revision;
  store.setSubscriptions(rules(store, { 'ecommerce.orders': true, 'erp.orders': false }));
  assert.ok(store.dashboard().revision > beforeRevision);
  assert.equal(value(store), 4000, 'enabling a channel includes its already-received history');
  assert.equal(store.dashboard().summary.openCartValueCents, 7500, 'cart subscription remains independent');
  assert.equal(store.hubEvents({}).total, 3, 'subscription settings never delete hub history');

  store.setSubscriptions(rules(store, { 'ecommerce.orders': false, 'ecommerce.carts': false, 'erp.orders': false }));
  assert.equal(value(store), 0);
  assert.equal(store.dashboard().summary.openCartValueCents, 0);
  assert.equal(store.dashboard().summary.totalEvents, 0);
});

test('subscribed CDC cart updates, linked ERP orders and deletions affect the commerce projection', t => {
  const store = fixture(t);
  const created = store.ingest(change(cart('linked-cart'), { systemId: 'ecommerce', table: 'carts' })).event;
  const updated = store.ingest(change({ ...created.after, amountCents: 8900 }, { systemId: 'ecommerce', table: 'carts', op: 'u', before: created.after })).event;
  assert.equal(store.dashboard().summary.openCartValueCents, 8900);
  const placed = store.ingest(change({ ...order('linked-order', 8900), cartId: 'linked-cart' })).event;
  assert.equal(store.dashboard().summary.openCartValueCents, 0);
  assert.equal(value(store), 8900);
  store.ingest(change({ ...placed.after, status: 'cancelled' }, { op: 'u', before: placed.after }));
  assert.equal(value(store), 0, 'cancelled order is excluded from current booked value');
  store.ingest(change(null, { systemId: 'ecommerce', table: 'carts', op: 'd', before: updated.after }));
  assert.equal(store.dashboard().summary.openCartValueCents, 0);
});

test('preview produces source-aware CDC without publishing or altering source state', t => {
  const store = fixture(t);
  const preview = store.simulatePreview({ systemId: 'erp', table: 'orders', op: 'c', brandId: 'northstar', recordId: 'preview-order', amountCents: 12345, status: 'placed' });
  assert.equal(preview.event.after.orderId, 'preview-order');
  assert.equal(preview.event.op, 'c');
  assert.equal(preview.event.before, null);
  assert.equal(store.hubEvents({}).total, 0);
  assert.equal(store.sourceRecords({ systemId: 'erp', table: 'orders' }).records.length, 0);
  store.ingest(preview.event);
  const edit = store.simulatePreview({ systemId: 'erp', table: 'orders', op: 'u', brandId: 'northstar', recordId: 'preview-order', amountCents: 22222, status: 'placed' });
  assert.equal(edit.event.before.amountCents, 12345);
  assert.equal(edit.event.after.amountCents, 22222);
  assert.equal(value(store), 12345);
  store.ingest(edit.event);
  assert.equal(value(store), 22222);
});

test('overlapping source records use the latest change once, with subscription fallback and delete tombstones', t => {
  const store = fixture(t);
  const start = Date.now() - 10000;
  const original = { ...order('shared-order'), placedAt: new Date(start).toISOString() };
  store.ingest(change(original, { occurredAt: new Date(start).toISOString() }));
  const ecommerce = store.ingest(change({ ...original, amountCents: 16000 }, { systemId: 'ecommerce', occurredAt: new Date(start + 1000).toISOString() })).event;
  store.setSubscriptions(rules(store, { 'ecommerce.orders': true }));
  assert.equal(value(store), 16000);
  assert.equal(store.dashboard().summary.currentMonthOrders, 1, 'one shared business order is not counted twice');
  store.setSubscriptions(rules(store, { 'ecommerce.orders': false }));
  assert.equal(value(store), 10000, 'disabling the newest source falls back to the other subscribed source');
  store.setSubscriptions(rules(store, { 'ecommerce.orders': true }));
  store.ingest(change(null, { systemId: 'ecommerce', op: 'd', before: ecommerce.after, occurredAt: new Date(start + 2000).toISOString() }));
  assert.equal(value(store), 0, 'a newer tombstone prevents an older source version from resurfacing');
  store.setSubscriptions(rules(store, { 'ecommerce.orders': false }));
  assert.equal(value(store), 10000);
});

test('CDC duplicates and stale before images cannot inflate or corrupt metrics', t => {
  const store = fixture(t);
  const input = change(order('duplicate-order'));
  const created = store.ingest(input).event;
  assert.equal(store.ingest(input).duplicate, true);
  assert.equal(store.ingest({ ...input, eventId: 'another-delivery' }).duplicate, true);
  assert.equal(value(store), 10000);
  assert.equal(store.hubEvents({}).total, 1);
  assert.throws(() => store.ingest({ ...input, after: { ...input.after, amountCents: 20000 } }), error => error.status === 409);
  const updated = store.ingest(change({ ...created.after, amountCents: 15000 }, { op: 'u', before: created.after })).event;
  assert.throws(() => store.ingest(change({ ...created.after, amountCents: 25000 }, { op: 'u', before: created.after })), error => error.status === 409);
  assert.throws(() => store.ingest(change({ ...updated.after, amountCents: 25000 }, {
    op: 'u', before: updated.after, occurredAt: new Date(Date.parse(created.occurredAt) - 1000).toISOString(),
    source: { systemId: 'erp', table: 'orders', captureMode: 'legacy-migration' },
  })), error => error.status === 409, 'client capture metadata cannot bypass stale-change checks');
  assert.equal(value(store), 15000);
  assert.equal(store.hubEvents({}).total, 2);
});

test('hub pagination and source/table/operation filters expose history beyond the recent feed', t => {
  const store = fixture(t);
  for (let index = 0; index < 31; index++) store.ingest(change(order(`history-${index}`), { systemId: index % 2 ? 'ecommerce' : 'erp' }));
  const first = store.hubEvents({ limit: 10, offset: 0 });
  const second = store.hubEvents({ limit: 10, offset: 10 });
  const last = store.hubEvents({ limit: 10, offset: 30 });
  assert.equal(first.total, 31);
  assert.equal(first.events.length, 10);
  assert.equal(last.events.length, 1);
  assert.equal(new Set([...first.events, ...second.events, ...last.events].map(event => event.eventId)).size, 21);
  assert.ok(first.events[0].sequence > second.events[0].sequence);
  const erp = store.hubEvents({ systemId: 'erp', table: 'orders', op: 'c', brandId: 'northstar' });
  assert.equal(erp.total, 16);
  assert.ok(erp.events.every(event => event.systemId === 'erp' && event.table === 'orders' && event.op === 'c'));
});

test('invalid subscriptions fail atomically and valid disabled channels persist after restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'commerce-cdc-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'events.sqlite');
  let store = new CommerceStore(filename, { seed: false });
  const original = store.getSubscriptions().subscriptions;
  assert.throws(() => store.setSubscriptions([]));
  assert.throws(() => store.setSubscriptions([{ systemId: 'unknown', table: 'orders', enabled: true }]));
  assert.throws(() => store.setSubscriptions(rules(store).map((rule, index) => index ? rule : { ...rule, enabled: 'yes' })));
  assert.deepEqual(store.getSubscriptions().subscriptions, original);
  store.ingest(change(order('persistent-order')));
  store.setSubscriptions(rules(store, { 'erp.orders': false }));
  store.close();
  store = new CommerceStore(filename, { seed: false });
  try {
    assert.equal(store.getSubscriptions().subscriptions.find(rule => rule.systemId === 'erp' && rule.table === 'orders').enabled, false);
    assert.equal(value(store), 0);
    assert.equal(store.hubEvents({}).total, 1);
    store.setSubscriptions(rules(store, { 'erp.orders': true }));
    assert.equal(value(store), 10000);
  } finally { store.close(); }
});

test('existing version-one SQLite events are retained and normalized into source-aware CDC', t => {
  const directory = mkdtempSync(join(tmpdir(), 'commerce-v1-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'legacy.sqlite');
  const db = new DatabaseSync(filename);
  db.exec(`
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL,type TEXT NOT NULL,occurred_at TEXT NOT NULL,brand_id TEXT NOT NULL,source TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE orders (brand_id TEXT NOT NULL,order_id TEXT NOT NULL,cart_id TEXT,amount_cents INTEGER NOT NULL,occurred_at TEXT NOT NULL,PRIMARY KEY(brand_id,order_id));
    CREATE TABLE carts (brand_id TEXT NOT NULL,cart_id TEXT NOT NULL,amount_cents INTEGER NOT NULL,abandoned_at TEXT,nudged_at TEXT,converted_at TEXT,order_id TEXT,PRIMARY KEY(brand_id,cart_id));
    CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO metadata VALUES ('initialized','true');
  `);
  const occurredAt = timestamp();
  db.prepare('INSERT INTO events(event_id,type,occurred_at,brand_id,source,payload) VALUES(?,?,?,?,?,?)').run('legacy-order-event', 'order.placed', occurredAt, 'northstar', 'demo-simulator', JSON.stringify({ orderId: 'legacy-order', amountCents: 32100, currency: 'EUR' }));
  db.prepare('INSERT INTO orders(brand_id,order_id,amount_cents,occurred_at) VALUES(?,?,?,?)').run('northstar', 'legacy-order', 32100, occurredAt);
  db.close();
  const store = new CommerceStore(filename);
  t.after(() => store.close());
  assert.equal(value(store), 32100);
  assert.equal(store.hubEvents({}).total, 1);
  assert.equal(store.hubEvents({}).events[0].eventId, 'legacy-order-event');
  assert.equal(store.hubEvents({}).events[0].systemId, 'erp');
  assert.equal(store.hubEvents({}).events[0].after.orderId, 'legacy-order');
});

test('version-one backdated nudge events migrate with original timestamps and receipt state intact', t => {
  const directory = mkdtempSync(join(tmpdir(), 'commerce-v1-late-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'legacy.sqlite');
  const db = new DatabaseSync(filename);
  db.exec(`
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL,type TEXT NOT NULL,occurred_at TEXT NOT NULL,brand_id TEXT NOT NULL,source TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE orders (brand_id TEXT NOT NULL,order_id TEXT NOT NULL,cart_id TEXT,amount_cents INTEGER NOT NULL,occurred_at TEXT NOT NULL,PRIMARY KEY(brand_id,order_id));
    CREATE TABLE carts (brand_id TEXT NOT NULL,cart_id TEXT NOT NULL,amount_cents INTEGER NOT NULL,abandoned_at TEXT,nudged_at TEXT,converted_at TEXT,order_id TEXT,PRIMARY KEY(brand_id,cart_id));
    CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO metadata VALUES ('initialized','true');
  `);
  const abandonedAt = new Date(Date.now() - 10000).toISOString();
  const nudgedAt = new Date(Date.now() - 20000).toISOString();
  const insert = db.prepare('INSERT INTO events(event_id,type,occurred_at,brand_id,source,payload) VALUES(?,?,?,?,?,?)');
  insert.run('legacy-cart-event', 'cart.abandoned', abandonedAt, 'northstar', 'external-demo', JSON.stringify({ cartId: 'legacy-cart', amountCents: 1000, currency: 'EUR' }));
  insert.run('legacy-backdated-nudge', 'cart.nudge_requested', nudgedAt, 'northstar', 'external-demo', JSON.stringify({ cartId: 'legacy-cart' }));
  db.prepare('INSERT INTO carts(brand_id,cart_id,amount_cents,abandoned_at,nudged_at) VALUES(?,?,?,?,?)').run('northstar', 'legacy-cart', 1000, abandonedAt, nudgedAt);
  db.close();
  const store = new CommerceStore(filename);
  t.after(() => store.close());
  assert.equal(store.hubEvents({}).total, 2);
  assert.equal(store.dashboard().summary.openCartValueCents, 1000);
  assert.equal(store.dashboard().summary.nudgedCartCount, 1);
  const history = store.hubEvents({}).events;
  assert.deepEqual(history.map(event => event.eventId), ['legacy-backdated-nudge', 'legacy-cart-event']);
  assert.equal(history[0].occurredAt, nudgedAt);
  assert.equal(history[1].occurredAt, abandonedAt);
  assert.equal(store.sourceRecords({ systemId: 'ecommerce', table: 'carts' }).records[0].data.nudgedAt, nudgedAt);
});

async function httpFixture(t) {
  const store = new CommerceStore(':memory:', { seed: false });
  const app = createApp(store);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const send = (path, data, method = 'POST') => fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  return { base, send };
}

async function stream(url, name) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  return {
    close: () => controller.abort(),
    async next() {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (block.startsWith(`event: ${name}\n`)) return JSON.parse(block.slice(block.indexOf('data: ') + 6));
          continue;
        }
        const { value: chunk, done } = await reader.read();
        if (done) throw new Error('Stream closed before the expected message.');
        buffer += decoder.decode(chunk, { stream: true });
      }
    },
  };
}

test('HTTP simulator preview, hub ingestion, records, filters and subscription routing complete one flow', async t => {
  const { base, send } = await httpFixture(t);
  const catalog = await (await fetch(base + '/api/catalog')).json();
  assert.equal(catalog.systems.length, 2);
  const preview = await (await send('/api/simulator/preview', { systemId: 'ecommerce', table: 'orders', op: 'c', brandId: 'northstar', recordId: 'http-order', amountCents: 4500, status: 'placed' })).json();
  assert.equal((await (await fetch(base + '/api/hub/events')).json()).total, 0);
  assert.equal((await send('/api/hub/events', preview.event)).status, 200);
  assert.equal((await (await fetch(base + '/api/hub/events?systemId=ecommerce&table=orders&op=c')).json()).total, 1);
  assert.equal((await (await fetch(base + '/api/dashboard')).json()).summary.currentMonthValueCents, 0);
  const records = await (await fetch(base + '/api/source-records?systemId=ecommerce&table=orders&brandId=northstar')).json();
  assert.equal(records.records[0].recordId, 'http-order');
  const current = await (await fetch(base + '/api/subscriptions')).json();
  const subscriptions = current.subscriptions.map(rule => ({ systemId: rule.systemId, table: rule.table, enabled: rule.systemId === 'ecommerce' && rule.table === 'orders' ? true : rule.enabled }));
  assert.equal((await send('/api/subscriptions', { subscriptions }, 'PUT')).status, 200);
  assert.equal((await (await fetch(base + '/api/dashboard')).json()).summary.currentMonthValueCents, 4500);
  assert.equal((await send('/api/subscriptions', { subscriptions: [] }, 'PUT')).status, 400);
  assert.equal((await fetch(base + '/api/hub/events?op=invalid')).status, 400);
  assert.equal((await fetch(base + '/event-hub')).status, 200);
  assert.equal((await fetch(base + '/simulator')).status, 200);
});

test('hub and commerce SSE stay live while subscriptions determine which data reaches commerce', { timeout: 10000 }, async t => {
  const { base, send } = await httpFixture(t);
  const hub = await stream(base + '/api/hub/stream', 'hub-snapshot');
  const commerce = await stream(base + '/api/stream', 'snapshot');
  t.after(() => { hub.close(); commerce.close(); });
  await hub.next(); await commerce.next();
  await send('/api/hub/events', change(order('stream-order', 5600), { systemId: 'ecommerce' }));
  assert.equal((await hub.next()).total, 1);
  assert.equal((await commerce.next()).summary.currentMonthValueCents, 0);
  const settings = await (await fetch(base + '/api/subscriptions')).json();
  const subscriptions = settings.subscriptions.map(rule => ({ systemId: rule.systemId, table: rule.table, enabled: rule.systemId === 'ecommerce' && rule.table === 'orders' ? true : rule.enabled }));
  await send('/api/subscriptions', { subscriptions }, 'PUT');
  assert.equal((await commerce.next()).summary.currentMonthValueCents, 5600);
});
