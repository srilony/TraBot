import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommerceStore, rejectCredentials } from '../src/store.mjs';
import { WorkflowEngine } from '../src/workflows.mjs';
import { createWorkflowIO } from '../src/workflow-io.mjs';
import { createApp } from '../src/server.mjs';

const url = 'https://srilony.app.n8n.cloud/webhook-test/cdc-webhook';
const payload = () => ({ table: 'customers', idField: 'customerid', data: { customerid: 123, name: 'SYNTHETIC Demo Customer', emailid: 'demo@example.invalid', phone: '0000000000', nationality: 'Indian', documentID: 'DEMO-123', active: false, score: 0, optional: null } });
const definition = () => ({ name: 'Customer CRM integration', enabled: true, nodes: [
  { id: 'trigger', type: 'event_trigger', config: { matches: [{ systemId: 'custom', table: 'customers', op: 'c' }], fields: [{ key: 'customerId', path: 'event.data.customerid' }] } },
  { id: 'lookup', type: 'http_get', config: { url: 'https://example.com/reference' } },
  { id: 'crm', type: 'update_crm', config: { url, credentialRef: 'n8n-basic', table: 'customers', idField: 'customerid', fields: {
    customerid: { kind: 'path', value: 'vars.customerId' }, emailid: { kind: 'path', value: 'event.data.emailid' },
    name: { kind: 'constant', value: 'SYNTHETIC CRM Customer' }, active: { kind: 'path', value: 'event.data.active' },
    score: { kind: 'path', value: 'nodes.lookup.data.score' }, optional: { kind: 'constant', value: null },
  } } },
], edges: [{ id: 'a', source: 'trigger', target: 'lookup', port: 'next' }, { id: 'b', source: 'lookup', target: 'crm', port: 'next' }] });

test('credential guard accepts public account URLs and checks values rather than serialized keys', () => {
  const env = { N8N_BASIC_USERNAME: 'srilony', N8N_BASIC_PASSWORD: 'strong-private-password' };
  assert.doesNotThrow(() => rejectCredentials(definition(), env));
  assert.doesNotThrow(() => rejectCredentials({ enabled: true, nodes: [] }, { N8N_BASIC_USERNAME: 'nodes', N8N_BASIC_PASSWORD: 'true' }));
  const basic = Buffer.from(`${env.N8N_BASIC_USERNAME}:${env.N8N_BASIC_PASSWORD}`).toString('base64');
  for (const value of [env.N8N_BASIC_USERNAME, env.N8N_BASIC_PASSWORD, `prefix ${env.N8N_BASIC_PASSWORD}`, `Basic ${basic}`])
    assert.throws(() => rejectCredentials({ nested: { value } }, env), /Server credentials/);
});

test('workflows using a public account URL can be saved, tested and enabled', async t => {
  const original = process.env.N8N_BASIC_USERNAME;
  process.env.N8N_BASIC_USERNAME = 'srilony';
  t.after(() => { if (original === undefined) delete process.env.N8N_BASIC_USERNAME; else process.env.N8N_BASIC_USERNAME = original; });
  const { store, engine } = fixture(t);
  const draft = engine.save({ ...definition(), enabled: false });
  store.ingest(payload());
  assert.equal((await engine.test(draft.id)).status, 'succeeded');
  assert.equal(engine.save({ ...draft, enabled: true }, draft.id).enabled, true);
});

function fixture(t, responder = () => new Response('ok', { status: 202 }), filename = ':memory:') {
  const store = new CommerceStore(filename, { seed: false }), calls = [];
  const env = { N8N_BASIC_USERNAME: 'test-user-unique', N8N_BASIC_PASSWORD: 'test-password-unique' };
  const io = createWorkflowIO({ db: store.db, env, lookup: async () => [{ address: '8.8.8.8', family: 4 }], fetchImpl: async (target, options) => {
    if (options.method === 'GET') return Response.json({ score: 0 });
    calls.push({ target, options }); return responder(options);
  } });
  const engine = new WorkflowEngine(store, { io });
  t.after(async () => { await engine.close(); store.close(); });
  return { store, io, engine, calls, env };
}

test('customer event to enabled workflow to authenticated CRM POST preserves types and redacts hostile response', async t => {
  const { store, engine, calls, env } = fixture(t, options => new Response(options.headers.Authorization + ' test-password-unique', { status: 202 }));
  const saved = engine.save(definition());
  const preview = store.simulatePreview(payload()).event;
  assert.equal(store.hubEvents().total, 0);
  const accepted = store.ingest(preview);
  engine.receiveEvents(); await engine.drain();
  const run = engine.runs(saved.id).runs[0];
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.context.event.data, payload().data);
  assert.equal(run.context.vars.customerId, 123);
  assert.deepEqual(run.context.nodes.crm, { status: 202, outcome: 'accepted', persistence: 'unverified' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.Authorization, `Basic ${Buffer.from(`${env.N8N_BASIC_USERNAME}:${env.N8N_BASIC_PASSWORD}`).toString('base64')}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { table: 'customers', idField: 'customerid', data: { customerid: 123, emailid: 'demo@example.invalid', name: 'SYNTHETIC CRM Customer', active: false, score: 0, optional: null } });
  assert.ok(!JSON.stringify(engine.runs()).includes(env.N8N_BASIC_PASSWORD));
  assert.ok(!JSON.stringify(run).includes('Authorization'));
  assert.equal(store.ingest(preview).duplicate, true);
  engine.receiveEvents(); await engine.drain();
  assert.equal(calls.length, 1);
  assert.equal(store.hubEvents({ systemId: 'custom', table: 'customers' }).total, 1);
  assert.equal(store.selectedRecords().length, 0, 'customer events do not project into commerce records');
  assert.equal(accepted.event.data.customerid, 123);
});

for (const status of [401, 404, 500, 302]) test(`CRM HTTP ${status} fails visibly without retry or reflected secrets`, async t => {
  const { store, engine, io, calls } = fixture(t, () => new Response('Authorization: test-password-unique', { status }));
  const saved = engine.save(definition()); store.ingest(payload()); engine.receiveEvents(); await engine.drain();
  const run = engine.runs(saved.id).runs[0];
  assert.equal(run.status, 'failed'); assert.match(run.error, new RegExp(`HTTP ${status}`));
  if (status === 404) assert.match(run.error, /Listen for test event/);
  assert.ok(!JSON.stringify(run).includes('test-password-unique'));
  await assert.rejects(io.updateCRM(definition().nodes[2].config, payload(), { runId: run.id, nodeId: 'crm' }), /already attempted/);
  assert.equal(calls.length, 1);
});

test('network failure is uncertain, credentials are destination-bound and missing credentials never fetch', async t => {
  const { io, calls } = fixture(t, () => { throw new Error('test-password-unique'); });
  await assert.rejects(io.updateCRM(definition().nodes[2].config, payload(), { runId: 'run', nodeId: 'crm' }), /persistence is unknown/);
  await assert.rejects(io.updateCRM({ ...definition().nodes[2].config, url: 'https://attacker.example/' }, payload(), { runId: 'other', nodeId: 'crm' }), /bound/);
  const store = new CommerceStore(':memory:', { seed: false }); t.after(() => store.close());
  const missing = createWorkflowIO({ db: store.db, env: {}, fetchImpl: () => { throw new Error('must not fetch'); } });
  await assert.rejects(missing.updateCRM(definition().nodes[2].config, payload(), { runId: 'r', nodeId: 'c' }), /Configure N8N_BASIC/);
  assert.equal(calls.length, 1);
});

test('credentials are rejected even in drafts and nested custom data; invalid payloads never enter journal', t => {
  const { store, engine } = fixture(t);
  for (const key of ['password', 'Authorization', 'headers', 'username']) {
    const flow = definition(); flow.enabled = false; flow.nodes[2].config[key] = 'do-not-store';
    assert.throws(() => engine.save(flow), /credential|authentication/i);
    const event = payload(); event.data.nested = { [key]: 'do-not-store' };
    assert.throws(() => store.ingest(event), /credential|authentication/i);
  }
  for (const data of [{}, { customerid: null }, { customerid: {} }]) assert.throws(() => store.ingest({ ...payload(), data }));
  assert.equal(store.hubEvents().total, 0); assert.equal(engine.list().workflows.length, 0);
});

test('customer journal survives reopen and HTTP preview/publish/filter expose full payload', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'trabot-customer-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'test.sqlite');
  let store = new CommerceStore(filename, { seed: false }); store.ingest(payload()); store.close();
  store = new CommerceStore(filename, { seed: false });
  const app = createApp(store); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const send = async (path, body) => { const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status, 200); return response.json(); };
  const preview = await send('/api/simulator/preview', { ...payload(), data: { ...payload().data, customerid: 456 } });
  assert.equal(store.hubEvents().total, 1);
  await send('/api/hub/events', preview.event);
  const response = await fetch(base + '/api/hub/events?systemId=custom&table=customers'); const journal = await response.json();
  assert.equal(journal.total, 2); assert.equal(journal.events[0].data.customerid, 456);
  assert.deepEqual(journal.events[1].data, payload().data);
});

test('uncertain CRM attempt remains blocked after the database is reopened', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'trabot-crm-attempt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'test.sqlite');
  const env = { N8N_BASIC_USERNAME: 'restart-user', N8N_BASIC_PASSWORD: 'restart-password' };
  let store = new CommerceStore(filename, { seed: false }), calls = 0;
  const options = { env, lookup: async () => [{ address: '8.8.8.8', family: 4 }], fetchImpl: async () => { calls++; throw new Error('network failed'); } };
  let io = createWorkflowIO({ db: store.db, ...options });
  await assert.rejects(io.updateCRM(definition().nodes[2].config, payload(), { runId: 'persisted-run', nodeId: 'crm' }), /persistence is unknown/);
  store.close();
  store = new CommerceStore(filename, { seed: false }); t.after(() => store.close());
  io = createWorkflowIO({ db: store.db, ...options });
  await assert.rejects(io.updateCRM(definition().nodes[2].config, payload(), { runId: 'persisted-run', nodeId: 'crm' }), /already attempted/);
  assert.equal(calls, 1);
});

test('invalid CRM bindings never expose URL credentials and missing input stops the POST', async t => {
  const { store, engine, calls } = fixture(t);
  const unsafe = definition(); unsafe.enabled = false; unsafe.nodes[2].config.url = 'https://user:do-not-store@example.com/path';
  assert.throws(() => engine.save(unsafe), /embedded credentials/);
  const io = createWorkflowIO({ db: store.db, env: { N8N_WEBHOOK_URL: unsafe.nodes[2].config.url } });
  assert.equal(io.capabilities().crm.url, ''); assert.equal(io.capabilities().crm.configured, false);
  const flow = definition(); flow.nodes[2].config.fields.emailid.value = 'event.data.missing';
  const saved = engine.save(flow); store.ingest(payload()); engine.receiveEvents(); await engine.drain();
  assert.match(engine.runs(saved.id).runs[0].error, /Variable is unavailable/); assert.equal(calls.length, 0);
});
