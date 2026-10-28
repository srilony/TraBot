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
  const get = async path => {
    const response = await fetch(base + path);
    return { response, data: await response.json() };
  };
  const send = async (path, data = {}, method = 'POST') => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    return { response, data: await response.json() };
  };
  return { base, app, get, send };
}

test('workflow HTTP API runs a saved event example through actual builtin GET, condition and Resend test capture', async t => {
  const { get, send } = await fixture(t);
  const catalog = await get('/api/workflows/catalog');
  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.data.eventOptions.length, 9);
  assert.equal(catalog.data.capabilities.email.provider, 'resend');
  const example = catalog.data.examples.find(flow => flow.nodes.some(node => node.type === 'event_trigger'));
  assert.ok(example.nodes.some(node => node.type === 'http_get'));
  const saved = await send('/api/workflows', example);
  assert.equal(saved.response.status, 201);
  assert.equal(saved.data.workflow.enabled, false);
  const workflowId = saved.data.workflow.id;
  const order = await send('/api/demo/order', { brandId: 'northstar', amountCents: 20000 });
  assert.equal(order.response.status, 200);
  const tested = await send(`/api/workflows/${workflowId}/test`, { eventId: order.data.event.eventId });
  assert.equal(tested.response.status, 200);
  const run = tested.data.run;
  assert.equal(run.status, 'succeeded');
  assert.equal(run.mode, 'test');
  assert.equal(run.context.nodes.lookup.data.limitCents, 15000, 'HTTP node used the local reference endpoint');
  assert.equal(run.context.nodes.check.result, true);
  assert.equal(run.context.event.eventId, order.data.event.eventId);
  assert.ok(run.steps.some(step => step.nodeType === 'http_get' && step.input.url.includes('brandId=northstar')));
  const captured = await get('/api/workflows/outbox');
  assert.equal(captured.response.status, 200);
  assert.equal(captured.data.messages.length, 1);
  assert.equal(captured.data.messages[0].status, 'demo');
  assert.equal(captured.data.messages[0].delivery, 'outbox', 'Resend-configured actions are never sent externally in a manual test');
  assert.ok(captured.data.messages[0].subject.includes(order.data.event.payload.orderId));
  const history = await get(`/api/workflows/${workflowId}/runs`);
  assert.equal(history.data.runs[0].id, run.id);
  const allHistory = await get(`/api/workflows/runs?workflowId=${workflowId}`);
  assert.equal(allHistory.data.runs.length, 1);
});

test('workflow draft CRUD validates activation, rejects stale edits and returns useful errors', async t => {
  const { get, send } = await fixture(t);
  const created = await send('/api/workflows', { name: 'Draft automation', enabled: false, nodes: [], edges: [] });
  assert.equal(created.response.status, 201);
  const draft = created.data.workflow;
  assert.equal(draft.validation.valid, false);
  const invalidEnable = await send(`/api/workflows/${draft.id}`, { ...draft, enabled: true }, 'PUT');
  assert.equal(invalidEnable.response.status, 400);
  assert.ok(invalidEnable.data.details.length);
  const updated = await send(`/api/workflows/${draft.id}`, { ...draft, name: 'Renamed automation' }, 'PUT');
  assert.equal(updated.response.status, 200);
  assert.ok(updated.data.workflow.revision > draft.revision);
  const stale = await send(`/api/workflows/${draft.id}`, { ...draft, name: 'Stale overwrite' }, 'PUT');
  assert.equal(stale.response.status, 409);
  assert.equal((await get(`/api/workflows/${draft.id}`)).data.workflow.name, 'Renamed automation');
  const listed = await get('/api/workflows');
  assert.equal(listed.data.workflows.length, 1);
  assert.equal((await send(`/api/workflows/${draft.id}/test`)).response.status, 400);
  const removed = await send(`/api/workflows/${draft.id}`, {}, 'DELETE');
  assert.equal(removed.response.status, 200);
  assert.equal((await get(`/api/workflows/${draft.id}`)).response.status, 404);
  assert.equal((await get('/api/workflows')).data.workflows.length, 0);
  assert.equal((await send('/api/workflows/missing-id/test')).response.status, 404);
  assert.equal((await send('/api/workflows', { name: 'Bad payload' })).response.status, 400);
});

test('enabled workflow HTTP subscriptions consume future hub events, deduplicate delivery and stop when disabled', async t => {
  const { app, get, send } = await fixture(t);
  const definition = {
    name: 'Live cart notification', enabled: true,
    nodes: [
      { id: 'event', type: 'event_trigger', position: { x: 40, y: 80 }, config: { matches: [{ systemId: 'ecommerce', table: 'orders', op: 'c' }], fields: [{ key: 'amount', path: 'event.after.amountCents' }] } },
      { id: 'email', type: 'email', position: { x: 300, y: 80 }, config: { delivery: 'outbox', to: 'operations@example.invalid', subject: 'Order {{event.after.orderId}}', text: 'Amount {{vars.amount}}' } },
    ],
    edges: [{ id: 'next', source: 'event', target: 'email', port: 'next' }],
  };
  const saved = await send('/api/workflows', definition);
  assert.equal(saved.response.status, 201);
  const workflowId = saved.data.workflow.id;
  const publish = async recordId => {
    const preview = await send('/api/simulator/preview', { systemId: 'ecommerce', table: 'orders', op: 'c', brandId: 'northstar', recordId, amountCents: 20000, status: 'placed' });
    assert.equal(preview.response.status, 200);
    const received = await send('/api/hub/events', preview.data.event);
    assert.equal(received.response.status, 200);
    await app.workflows.drain();
    return received.data.event;
  };
  const event = await publish('HTTP-WORKFLOW-001');
  const history = await get(`/api/workflows/${workflowId}/runs`);
  assert.equal(history.data.runs.length, 1);
  assert.equal(history.data.runs[0].status, 'succeeded');
  assert.equal(history.data.runs[0].mode, 'live');
  assert.equal((await get('/api/dashboard')).data.summary.currentMonthValueCents, 0, 'commerce can ignore this channel while workflows consume it');
  const duplicate = await send('/api/hub/events', event);
  assert.equal(duplicate.data.duplicate, true);
  await app.workflows.drain();
  assert.equal((await get(`/api/workflows/${workflowId}/runs`)).data.runs.length, 1);
  const current = (await get(`/api/workflows/${workflowId}`)).data.workflow;
  assert.equal((await send(`/api/workflows/${workflowId}`, { ...current, enabled: false }, 'PUT')).response.status, 200);
  await publish('HTTP-WORKFLOW-002');
  assert.equal((await get(`/api/workflows/${workflowId}/runs`)).data.runs.length, 1);
  assert.equal((await get('/api/workflows/outbox')).data.messages.length, 1);
});
