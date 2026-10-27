import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommerceStore } from '../src/store.mjs';
import { createApp } from '../src/server.mjs';

async function fixture(t) {
  const store = new CommerceStore(':memory:', { seed: false });
  const app = createApp(store);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, data = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  return { base, post };
}

async function subscriber(url) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  return {
    close: () => controller.abort(),
    async next() {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (block.startsWith('event: snapshot\n')) return JSON.parse(block.slice(block.indexOf('data: ') + 6));
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('Stream ended before a snapshot.');
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}

test('two subscribers receive a published order; reconnect restores the latest snapshot', { timeout: 10000 }, async t => {
  const { base, post } = await fixture(t);
  const first = await subscriber(base + '/api/stream');
  const second = await subscriber(base + '/api/stream?brandId=atelier');
  t.after(() => { first.close(); second.close(); });
  assert.equal((await first.next()).summary.currentMonthValueCents, 0);
  await second.next();
  assert.equal((await post('/api/demo/order', { brandId: 'atelier', amountCents: 10000 })).status, 200);
  assert.equal((await first.next()).summary.currentMonthValueCents, 10000);
  assert.equal((await second.next()).summary.currentMonthValueCents, 10000);
  first.close();
  const reconnected = await subscriber(base + '/api/stream');
  t.after(() => reconnected.close());
  assert.equal((await reconnected.next()).summary.currentMonthValueCents, 10000);
});

test('simulator HTTP endpoints complete abandonment, mock nudge and checkout', async t => {
  const { base, post } = await fixture(t);
  const abandoned = await (await post('/api/demo/abandon', { brandId: 'fieldwork', amountCents: 7500 })).json();
  const { cartId } = abandoned.event.payload;
  assert.equal((await post('/api/demo/nudge', { cartId })).status, 200);
  let dashboard = await (await fetch(base + '/api/dashboard')).json();
  assert.equal(dashboard.summary.openCartValueCents, 7500);
  assert.equal(dashboard.summary.currentMonthValueCents, 0);
  assert.equal((await post('/api/demo/recover', { cartId })).status, 200);
  dashboard = await (await fetch(base + '/api/dashboard')).json();
  assert.equal(dashboard.summary.openCartValueCents, 0);
  assert.equal(dashboard.summary.currentMonthValueCents, 7500);
  assert.equal((await post('/api/demo/recover', { cartId })).status, 409);
});

test('external event ingestion validates JSON and rejects invalid routes and origins', async t => {
  const { base, post } = await fixture(t);
  assert.equal((await post('/api/events', { type: 'anything' })).status, 400);
  assert.equal((await fetch(base + '/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(base + '/api/events', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(base + '/api/dashboard?brandId=bad')).status, 400);
  assert.equal((await fetch(base + '/api/stream?brandId=bad')).status, 400);
  assert.equal((await fetch(base + '/api/missing')).status, 404);
  const event = { eventId: 'external-1', type: 'order.placed', occurredAt: new Date().toISOString(), brandId: 'northstar', source: 'external-demo', payload: { orderId: 'external-order-1', amountCents: 10000, currency: 'EUR' } };
  assert.equal((await post('/api/events', event)).status, 200);
  assert.equal((await (await post('/api/events', event)).json()).duplicate, true);
  assert.equal((await fetch(base + '/api/demo/order', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://unrelated.example' }, body: '{}' })).status, 403);
});
