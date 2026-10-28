import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommerceStore } from '../src/store.mjs';
import { WorkflowEngine } from '../src/workflows.mjs';

let serial = 0;
const pos = (x = 0, y = 0) => ({ x, y });
const node = (id, type, config, x = 0, y = 0) => ({ id, type, config, position: pos(x, y) });
const edge = (source, target, port = 'next') => ({ id: `edge-${source}-${port}-${target}`, source, target, port });
const eventConfig = () => ({ matches: [{ systemId: 'erp', table: 'orders', op: 'c' }], fields: [{ key: 'amount', path: 'event.after.amountCents' }, { key: 'orderId', path: 'event.after.orderId' }] });
const email = (id = 'email', delivery = 'outbox') => node(id, 'email', { delivery, to: 'operations@example.invalid', subject: 'Order {{vars.orderId}}', text: 'Amount {{vars.amount}}' }, 700, 100);
function flow(overrides = {}) {
  return { name: 'Order review', enabled: false,
    nodes: [node('trigger', 'event_trigger', eventConfig(), 40, 100), email()],
    edges: [edge('trigger', 'email')], ...overrides };
}
function ioStub({ limitCents = 15000, getError } = {}) {
  const calls = { gets: [], emails: [] };
  return {
    calls,
    capabilities: () => ({ email: { provider: 'resend', configured: true, senderConfigured: true }, httpGet: { timeoutMs: 10000 } }),
    outbox: () => ({ messages: [] }),
    async getJSON(url) {
      calls.gets.push(url);
      if (getError) throw new Error(getError);
      return { status: 200, data: { limitCents, eligible: false, zero: 0, teamEmail: 'operations@example.invalid' }, url };
    },
    async sendEmail(message, options) {
      calls.emails.push({ message, options });
      return { outboxId: `message-${calls.emails.length}`, delivery: options.mode === 'test' ? 'outbox' : message.delivery, status: options.mode === 'test' || message.delivery === 'outbox' ? 'demo' : 'submitted', messageId: null };
    },
  };
}
function fixture(t, { filename = ':memory:', clock, io = ioStub() } = {}) {
  const store = new CommerceStore(filename, { seed: false });
  const engine = new WorkflowEngine(store, { io, autoStart: false, ...(clock ? { clock } : {}) });
  t.after(async () => { await engine.close(); store.close(); });
  return { store, engine, io };
}
function publish(store, { systemId = 'erp', table = 'orders', amountCents = 20000, op = 'c', before = null, after, brandId = 'northstar' } = {}) {
  const index = ++serial;
  const occurredAt = new Date(Date.now() - 1000 + index).toISOString();
  const data = after ?? (table === 'orders'
    ? { orderId: `WORKFLOW-ORDER-${index}`, amountCents, currency: 'EUR', status: 'placed', placedAt: occurredAt }
    : { cartId: `WORKFLOW-CART-${index}`, amountCents, currency: 'EUR', status: 'abandoned', abandonedAt: occurredAt, nudgedAt: null });
  return store.ingest({ eventId: `workflow-event-${index}`, occurredAt, systemId, table, op, brandId, before, after: op === 'd' ? null : data }).event;
}
const runs = (engine, id) => engine.runs(id).runs;
const errorText = error => [error.message, ...(error.details ?? []).map(detail => detail.message)].join(' ');
function branchingFlow(right = { kind: 'path', value: 'nodes.lookup.data.limitCents' }) {
  return flow({
    nodes: [node('trigger', 'event_trigger', eventConfig()),
      node('lookup', 'http_get', { url: 'https://example.test/orders/{{vars.orderId}}' }, 250, 100),
      node('check', 'condition', { left: { kind: 'path', value: 'vars.amount' }, operator: 'gt', right }, 500, 100),
      node('high', 'email', { delivery: 'resend', to: '{{nodes.lookup.data.teamEmail}}', subject: 'Review {{vars.orderId}}', text: 'Event {{vars.amount}} exceeds {{nodes.lookup.data.limitCents}}' }, 750, 30),
      node('normal', 'email', { delivery: 'outbox', to: 'operations@example.invalid', subject: 'Normal {{vars.orderId}}', text: 'Within threshold' }, 750, 230)],
    edges: [edge('trigger', 'lookup'), edge('lookup', 'check'), edge('check', 'high', 'true'), edge('check', 'normal', 'false')],
  });
}

test('event values remain typed, HTTP data feeds a condition, and only its true email branch executes', async t => {
  const { engine, store, io } = fixture(t);
  const saved = engine.save(branchingFlow());
  const event = publish(store);
  const run = await engine.test(saved.id, { eventId: event.eventId });
  assert.equal(run.status, 'succeeded');
  assert.equal(run.mode, 'test');
  assert.equal(run.context.event.eventId, event.eventId);
  assert.deepEqual(run.context.event.after, event.after, 'the complete triggering event is retained');
  assert.equal(run.context.vars.amount, 20000);
  assert.equal(typeof run.context.vars.amount, 'number');
  assert.equal(run.context.nodes.lookup.data.limitCents, 15000);
  assert.equal(run.context.nodes.check.result, true);
  assert.deepEqual(io.calls.gets, [`https://example.test/orders/${event.after.orderId}`]);
  assert.equal(io.calls.emails.length, 1);
  assert.equal(io.calls.emails[0].message.to, 'operations@example.invalid');
  assert.equal(io.calls.emails[0].message.text, 'Event 20000 exceeds 15000');
  assert.equal(io.calls.emails[0].options.mode, 'test', 'manual tests cannot send live messages');
  assert.ok(run.steps.some(step => step.nodeId === 'high' && step.status === 'succeeded'));
  assert.ok(!run.steps.some(step => step.nodeId === 'normal' && step.status === 'succeeded'));
  assert.equal(runs(engine, saved.id)[0].id, run.id);
});

test('if-then-else false branch compares against a configurable typed constant', async t => {
  const { engine, store, io } = fixture(t);
  const saved = engine.save(branchingFlow({ kind: 'constant', value: 50000 }));
  const event = publish(store, { amountCents: 10000 });
  const run = await engine.test(saved.id, { eventId: event.eventId });
  assert.equal(run.status, 'succeeded');
  assert.equal(run.context.nodes.check.result, false);
  assert.equal(io.calls.emails.length, 1);
  assert.equal(io.calls.emails[0].message.subject, `Normal ${event.after.orderId}`);
  assert.ok(!run.steps.some(step => step.nodeId === 'high' && step.status === 'succeeded'));
});

test('a condition can compare two received values without converting zero or false into missing values', async t => {
  const { engine, store, io } = fixture(t);
  const definition = branchingFlow({ kind: 'constant', value: false });
  definition.nodes.find(n => n.id === 'check').config = { left: { kind: 'path', value: 'nodes.lookup.data.eligible' }, operator: 'eq', right: { kind: 'constant', value: false } };
  definition.nodes.find(n => n.id === 'high').config.text = 'Zero {{nodes.lookup.data.zero}} / eligible {{nodes.lookup.data.eligible}}';
  const saved = engine.save(definition);
  const event = publish(store);
  const run = await engine.test(saved.id, { eventId: event.eventId });
  assert.equal(run.status, 'succeeded');
  assert.equal(run.context.nodes.check.result, true);
  assert.equal(io.calls.emails[0].message.text, 'Zero 0 / eligible false');
});

test('enabled event triggers match one or more event types independently from commerce subscriptions', async t => {
  const { engine, store, io } = fixture(t);
  const definition = flow({ enabled: true });
  definition.nodes[0].config = {
    matches: [{ systemId: 'ecommerce', table: 'orders', op: 'c' }, { systemId: 'ecommerce', table: 'carts', op: 'c' }],
    fields: [{ key: 'amount', path: 'event.after.amountCents' }],
  };
  definition.nodes[1].config.subject = '{{event.table}} received';
  const saved = engine.save(definition);
  engine.start();
  const erp = publish(store);
  const ecommerce = publish(store, { systemId: 'ecommerce' });
  publish(store, { systemId: 'ecommerce', table: 'carts' });
  await engine.drain();
  const history = runs(engine, saved.id);
  assert.equal(history.length, 2);
  assert.ok(history.every(run => run.status === 'succeeded' && run.mode === 'live'));
  assert.ok(history.every(run => run.context.event.eventId !== erp.eventId));
  assert.equal(io.calls.emails.length, 2);
  assert.equal(store.dashboard().summary.currentMonthValueCents, erp.after.amountCents, 'ecommerce orders remain unsubscribed in commerce');
  store.ingest(ecommerce);
  await engine.drain();
  assert.equal(runs(engine, saved.id).length, 2, 'replayed hub delivery cannot trigger another run');
});

test('activation listens to future events only; disabling prevents new runs', async t => {
  const { engine, store, io } = fixture(t);
  publish(store);
  engine.start();
  const saved = engine.save(flow({ enabled: true }));
  await engine.drain();
  assert.equal(runs(engine, saved.id).length, 0, 'activating does not replay retained source history');
  publish(store);
  await engine.drain();
  assert.equal(io.calls.emails.length, 1);
  const current = engine.get(saved.id);
  engine.save({ ...current, enabled: false }, saved.id);
  publish(store);
  await engine.drain();
  assert.equal(runs(engine, saved.id).length, 1);
});

test('drafts can save incomplete graphs while activation and testing require valid connected nodes', async t => {
  const { engine } = fixture(t);
  const draft = engine.save({ name: 'Draft in progress', enabled: false, nodes: [], edges: [] });
  assert.equal(draft.validation.valid, false);
  assert.equal(engine.list().workflows.length, 1);
  assert.throws(() => engine.save({ ...draft, enabled: true }, draft.id));
  await assert.rejects(() => engine.test(draft.id));
  const cyclic = flow({ enabled: true });
  cyclic.edges.push(edge('email', 'trigger'));
  assert.throws(() => engine.save(cyclic), error => /cycle|trigger|incoming|graph|invalid/i.test(errorText(error)));
  const orphan = flow({ enabled: true });
  orphan.nodes.push(node('unconnected', 'http_get', { url: 'https://example.test' }));
  assert.throws(() => engine.save(orphan), error => /connect|reach|graph|invalid/i.test(errorText(error)));
});

test('missing input references fail visibly and prevent downstream email actions', async t => {
  const { engine, store, io } = fixture(t);
  const definition = branchingFlow({ kind: 'path', value: 'nodes.lookup.data.missingLimit' });
  const saved = engine.save(definition);
  const event = publish(store);
  const run = await engine.test(saved.id, { eventId: event.eventId });
  assert.equal(run.status, 'failed');
  assert.match(run.error, /missing|reference|path|undefined/i);
  assert.equal(io.calls.emails.length, 0);
  assert.ok(run.steps.some(step => step.nodeId === 'check' && step.status === 'failed'));
});

test('HTTP node failure is persisted and prevents dependent conditions and email', async t => {
  const io = ioStub({ getError: 'Upstream system timed out' });
  const { engine, store } = fixture(t, { io });
  const saved = engine.save(branchingFlow());
  const event = publish(store);
  const run = await engine.test(saved.id, { eventId: event.eventId });
  assert.equal(run.status, 'failed');
  assert.match(run.error, /timed out/);
  assert.equal(io.calls.emails.length, 0);
  assert.equal(runs(engine, saved.id)[0].status, 'failed');
  assert.ok(run.steps.some(step => step.nodeId === 'lookup' && step.status === 'failed'));
});

test('prototype references cannot read constructor or prototype properties', async t => {
  const { engine, store, io } = fixture(t);
  const definition = flow();
  definition.nodes[1].config.text = '{{event.constructor.name}}';
  let saved;
  try { saved = engine.save(definition); }
  catch (error) { assert.match(errorText(error), /prototype|constructor|reference|path|invalid/i); assert.equal(io.calls.emails.length, 0); return; }
  const event = publish(store);
  let run;
  try { run = await engine.test(saved.id, { eventId: event.eventId }); }
  catch (error) { assert.match(errorText(error), /prototype|constructor|reference|path|invalid/i); return; }
  assert.equal(run.status, 'failed');
  assert.equal(io.calls.emails.length, 0);
});

function scheduledFlow(startAt, overrides = {}) {
  return flow({ name: 'Scheduled report', enabled: true,
    nodes: [node('schedule', 'schedule_trigger', { startAt, interval: 1, unit: 'minutes' }),
      node('email', 'email', { delivery: 'outbox', to: 'operations@example.invalid', subject: 'Scheduled {{schedule.scheduledAt}}', text: 'A scheduled run' })],
    edges: [edge('schedule', 'email')], ...overrides });
}

test('scheduled runs stay anchored to the start date, coalesce missed intervals and deduplicate a due slot', async t => {
  let current = new Date('2030-01-01T09:59:50.000Z');
  const { engine, io } = fixture(t, { clock: () => current });
  const saved = engine.save(scheduledFlow('2030-01-01T10:00:00.000Z'));
  assert.equal(engine.get(saved.id).nextRunAt, '2030-01-01T10:00:00.000Z');
  await engine.tick(current); await engine.drain();
  assert.equal(io.calls.emails.length, 0);
  current = new Date('2030-01-01T10:00:00.000Z');
  await engine.tick(current); await engine.drain();
  assert.equal(io.calls.emails.length, 1);
  assert.equal(runs(engine, saved.id)[0].context.schedule.scheduledAt, '2030-01-01T10:00:00.000Z');
  await engine.tick(current); await engine.drain();
  assert.equal(io.calls.emails.length, 1);
  current = new Date('2030-01-01T10:03:20.000Z');
  await engine.tick(current); await engine.drain();
  assert.equal(io.calls.emails.length, 2, 'missed slots are coalesced into one run instead of bursting');
  assert.equal(runs(engine, saved.id)[0].context.schedule.scheduledAt, '2030-01-01T10:03:00.000Z');
  assert.equal(engine.get(saved.id).nextRunAt, '2030-01-01T10:04:00.000Z');
});

test('a past start date schedules the next aligned future slot when a workflow is activated', async t => {
  let current = new Date('2030-01-01T10:02:20.000Z');
  const { engine, io } = fixture(t, { clock: () => current });
  const saved = engine.save(scheduledFlow('2030-01-01T10:00:00.000Z'));
  assert.equal(engine.get(saved.id).nextRunAt, '2030-01-01T10:03:00.000Z');
  await engine.tick(current); await engine.drain();
  assert.equal(io.calls.emails.length, 0);
  current = new Date('2030-01-01T10:03:00.000Z');
  await engine.tick(current); await engine.drain();
  assert.equal(io.calls.emails.length, 1);
});

test('definitions, run history and due schedule state persist across engine and database restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'commerce-workflows-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'workflows.sqlite');
  let current = new Date('2030-01-01T09:59:50.000Z');
  let store = new CommerceStore(filename, { seed: false });
  let engine = new WorkflowEngine(store, { io: ioStub(), autoStart: false, clock: () => current });
  const saved = engine.save(scheduledFlow('2030-01-01T10:00:00.000Z'));
  current = new Date('2030-01-01T10:00:00.000Z');
  await engine.tick(current); await engine.drain();
  assert.equal(runs(engine, saved.id).length, 1);
  await engine.close(); store.close();
  const io = ioStub();
  store = new CommerceStore(filename, { seed: false });
  engine = new WorkflowEngine(store, { io, autoStart: false, clock: () => current });
  try {
    assert.equal(engine.get(saved.id).name, 'Scheduled report');
    assert.equal(engine.get(saved.id).enabled, true);
    assert.equal(engine.get(saved.id).nextRunAt, '2030-01-01T10:01:00.000Z');
    assert.equal(runs(engine, saved.id).length, 1);
    await engine.tick(current); await engine.drain();
    assert.equal(io.calls.emails.length, 0, 'restarting cannot repeat an already-run slot');
    current = new Date('2030-01-01T10:01:00.000Z');
    await engine.tick(current); await engine.drain();
    assert.equal(io.calls.emails.length, 1);
    assert.equal(runs(engine, saved.id).length, 2);
  } finally { await engine.close(); store.close(); }
});
