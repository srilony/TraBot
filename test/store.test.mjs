import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommerceStore } from '../src/store.mjs';

const now = () => new Date().toISOString();
const event = (type, payload, extra = {}) => ({ eventId: 'event-1', type, occurredAt: now(), brandId: 'northstar', source: 'test', payload, ...extra });
const order = (extra = {}, payload = {}) => event('order.placed', { orderId: 'order-1', amountCents: 10000, currency: 'EUR', ...payload }, extra);
const cart = (extra = {}) => event('cart.abandoned', { cartId: 'cart-1', amountCents: 7500, currency: 'EUR' }, extra);
const emptyStore = t => { const store = new CommerceStore(':memory:', { seed: false }); t.after(() => store.close()); return store; };

test('an order updates exactly its month and brand using integer cents', t => {
  const store = emptyStore(t);
  store.ingest(order());
  assert.equal(store.dashboard().summary.currentMonthValueCents, 10000);
  assert.equal(store.dashboard().monthly.at(-1).orderCount, 1);
  assert.equal(store.dashboard('northstar').summary.currentMonthValueCents, 10000);
  assert.equal(store.dashboard('atelier').summary.currentMonthValueCents, 0);
});

test('replayed event and a new delivery ID for the same order cannot inflate sales', t => {
  const store = emptyStore(t), input = order();
  store.ingest(input);
  assert.equal(store.ingest(input).duplicate, true);
  assert.equal(store.ingest({ ...input, eventId: 'another-delivery' }).duplicate, true);
  assert.equal(store.dashboard().summary.currentMonthValueCents, 10000);
  assert.equal(store.dashboard().summary.totalEvents, 1);
  assert.throws(() => store.ingest({ ...input, payload: { ...input.payload, amountCents: 20000 } }), /different content/);
});

test('abandoned cart, mock nudge and checkout move opportunity into orders once', t => {
  const store = emptyStore(t);
  store.ingest(cart());
  assert.equal(store.dashboard().summary.openCartValueCents, 7500);
  store.simulate('nudge', { cartId: 'cart-1' });
  assert.equal(store.dashboard().summary.nudgedCartCount, 1);
  assert.equal(store.dashboard().summary.currentMonthValueCents, 0, 'a nudge is not a sale');
  store.simulate('recover', { cartId: 'cart-1' });
  const summary = store.dashboard().summary;
  assert.equal(summary.openCartValueCents, 0);
  assert.equal(summary.currentMonthValueCents, 7500);
  assert.equal(summary.recoveredValueCents, 7500);
  assert.throws(() => store.simulate('recover', { cartId: 'cart-1' }), /already checked out/);
  assert.throws(() => store.simulate('nudge', { cartId: 'cart-1' }), /already checked out/);
});

test('late abandonment cannot reopen a cart already converted', t => {
  const store = emptyStore(t);
  store.ingest(order({}, { cartId: 'cart-1', amountCents: 7500 }));
  store.ingest(cart({ eventId: 'late-abandonment', occurredAt: new Date(Date.now() - 3600_000).toISOString() }));
  assert.equal(store.dashboard().summary.openCartValueCents, 0);
  assert.equal(store.dashboard().summary.currentMonthValueCents, 7500);
  assert.equal(store.dashboard().summary.recoveredCartCount, 1);
});

test('new delivery IDs cannot duplicate an abandoned cart or its nudge', t => {
  const store = emptyStore(t);
  store.ingest(cart());
  assert.equal(store.ingest(cart({ eventId: 'cart-again' })).duplicate, true);
  store.simulate('nudge', { cartId: 'cart-1' });
  assert.equal(store.simulate('nudge', { cartId: 'cart-1' }).duplicate, true);
  assert.equal(store.dashboard().summary.openCartCount, 1);
});

test('bad values, mixed currencies, unknown brands and invalid events fail without a write', t => {
  const store = emptyStore(t);
  for (const input of [order({}, { amountCents: -1 }), order({}, { amountCents: 1.5 }), order({}, { currency: 'USD' }), order({ brandId: 'unknown' }), order({ occurredAt: 'yesterday' }), order({ occurredAt: '2099-01-01T00:00:00Z' }), event('bad', {})]) {
    assert.throws(() => store.ingest(input));
  }
  assert.equal(store.dashboard().summary.totalEvents, 0);
});

test('UTC event timestamps select the correct calendar month', t => {
  const store = emptyStore(t);
  const date = new Date();
  const previous = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0, 23, 30));
  store.ingest(order({ occurredAt: previous.toISOString() }));
  assert.equal(store.dashboard().monthly.at(-2).grossOrderValueCents, 10000);
  assert.equal(store.dashboard().monthly.at(-1).grossOrderValueCents, 0);
});

test('SQLite journal and dashboard survive closing and reopening the process', t => {
  const dir = mkdtempSync(join(tmpdir(), 'commerce-hub-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new CommerceStore(join(dir, 'test.sqlite'), { seed: false });
  store.ingest(order()); store.close();
  store = new CommerceStore(join(dir, 'test.sqlite'), { seed: false });
  assert.equal(store.dashboard().summary.currentMonthValueCents, 10000);
  assert.equal(store.dashboard().recentEvents[0].payload.orderId, 'order-1');
  store.close();
});

test('reset restores a predictable demo dataset and publishes one refresh', t => {
  const store = new CommerceStore();
  t.after(() => store.close());
  const before = store.dashboard().summary;
  assert.equal(before.currentMonthOrders, 24);
  assert.equal(before.openCartCount, 7);
  store.simulate('order');
  let refreshes = 0;
  const unsubscribe = store.subscribe(() => refreshes++);
  store.resetDemo(); unsubscribe();
  assert.equal(refreshes, 1);
  assert.deepEqual(store.dashboard().summary, before);
});
