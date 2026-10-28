import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createWorkflowIO } from '../src/workflow-io.mjs';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const io = createWorkflowIO({ db, getOrigin: () => 'http://127.0.0.1:3000', lookup: publicLookup, env: {}, ...options });
  return { io, db };
}
const jsonResponse = (body, options) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...options });
const message = { delivery: 'resend', to: 'operations@example.invalid', subject: 'Order notice', text: 'Order ABC has been created.' };
const identity = { runId: 'run-001', nodeId: 'email-001', mode: 'live' };
const providerEnv = { WORKFLOW_EMAIL_API_KEY: 'unit-test-placeholder', WORKFLOW_EMAIL_FROM: 'Commerce Hub <demo@example.invalid>' };

test('HTTP Get returns JSON and status using GET with a bounded abort signal', async t => {
  const requests = [];
  const { io } = fixture(t, { fetchImpl: async (url, options) => { requests.push({ url, options }); return jsonResponse({ limitCents: 15000, active: true }); } });
  const result = await io.getJSON('https://public.example/reference?brand=northstar');
  assert.equal(result.status, 200);
  assert.equal(result.data.limitCents, 15000);
  assert.equal(result.url, 'https://public.example/reference?brand=northstar');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.redirect, 'manual');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
});

test('built-in reference requests work over actual HTTP while other local paths are blocked', async t => {
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.ok(req.url.startsWith('/api/workflow-demo/reference?brandId=northstar'));
    if (req.url.endsWith('&variant=error')) { res.writeHead(600); res.end('nonstandard remote failure'); return; }
    if (req.url.endsWith('&variant=gzip')) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(JSON.stringify({ compressed: true }))); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ brandId: 'northstar', limitCents: 15000 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { io } = fixture(t, { getOrigin: () => origin });
  const result = await io.getJSON('/api/workflow-demo/reference?brandId=northstar');
  assert.equal(result.data.brandId, 'northstar');
  assert.equal((await io.getJSON('/api/workflow-demo/reference?brandId=northstar&variant=gzip')).data.compressed, true);
  await assert.rejects(() => io.getJSON('/api/workflow-demo/reference?brandId=northstar&variant=error'), /HTTP 600/);
  await assert.rejects(() => io.getJSON('/api/workflows/outbox'), /relative URLs/);
  await assert.rejects(() => io.getJSON(origin + '/api/workflow-demo/reference'), /private or local/);
});

test('HTTP Get rejects credentials, invalid protocols, local/private IPs and mixed DNS answers before fetching', async t => {
  let fetched = 0;
  const { io } = fixture(t, { fetchImpl: async () => { fetched++; return jsonResponse({}); } });
  for (const url of [
    'file:///etc/passwd', 'https://user:password@public.example/a', 'http://localhost/a', 'http://127.0.0.1/a',
    'http://2130706433/a', 'http://10.0.0.2/a', 'http://169.254.169.254/a', 'http://172.16.0.1/a',
    'http://192.168.1.1/a', 'http://100.64.0.1/a', 'http://[::1]/a', 'http://[::ffff:127.0.0.1]/a',
    'http://[fe80::1]/a', 'http://[fc00::1]/a', 'http://[2::1]/a', 'http://[2001:0db8::1]/a',
  ]) await assert.rejects(() => io.getJSON(url));
  const blocked = fixture(t, { lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }], fetchImpl: async () => { fetched++; return jsonResponse({}); } }).io;
  await assert.rejects(() => blocked.getJSON('https://mixed.example/a'), /private or local/);
  assert.equal(fetched, 0);
});

test('HTTP Get validates redirect destinations and does not follow a redirect into a private network', async t => {
  let calls = 0;
  const { io } = fixture(t, { fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }); } });
  await assert.rejects(() => io.getJSON('https://public.example/start'), /private or local/);
  assert.equal(calls, 1);
  const redirected = fixture(t, { fetchImpl: async (url) => url.endsWith('/first') ? new Response(null, { status: 301, headers: { location: '/second' } }) : jsonResponse({ done: true }) }).io;
  assert.equal((await redirected.getJSON('https://public.example/first')).data.done, true);
});

test('HTTP Get enforces redirect, response-size and JSON limits with visible failures', async t => {
  const loop = fixture(t, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: '/again' } }) }).io;
  await assert.rejects(() => loop.getJSON('https://public.example/first'), /redirect limit/);
  const announced = fixture(t, { fetchImpl: async () => new Response('{}', { headers: { 'content-length': '2000000' } }) }).io;
  await assert.rejects(() => announced.getJSON('https://public.example/a'), /byte limit/);
  const streamed = fixture(t, { fetchImpl: async () => new Response('x'.repeat(1_048_577)) }).io;
  await assert.rejects(() => streamed.getJSON('https://public.example/a'), /byte limit/);
  const invalid = fixture(t, { fetchImpl: async () => new Response('<html>not JSON</html>') }).io;
  await assert.rejects(() => invalid.getJSON('https://public.example/a'), /invalid or empty JSON/);
  const unavailable = fixture(t, { fetchImpl: async () => new Response('unavailable', { status: 503 }) }).io;
  await assert.rejects(() => unavailable.getJSON('https://public.example/a'), /HTTP 503/);
});

test('test-mode email always captures into the outbox without using provider credentials or network', async t => {
  let requests = 0;
  const { io } = fixture(t, { fetchImpl: async () => { requests++; throw new Error('must not contact provider'); } });
  const result = await io.sendEmail(message, { ...identity, mode: 'test' });
  assert.equal(result.status, 'demo');
  assert.equal(result.delivery, 'outbox');
  assert.equal(result.messageId, null);
  assert.equal(requests, 0);
  const rows = io.outbox();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].to, message.to);
  assert.equal(rows[0].text, message.text);
  assert.equal(rows[0].runId, identity.runId);
  assert.deepEqual(await io.sendEmail(message, { ...identity, mode: 'test' }), result);
  assert.equal(io.outbox().length, 1);
});

test('real email requires both a key and valid sender and never silently switches to outbox', async t => {
  const { io } = fixture(t);
  const capabilities = io.capabilities();
  assert.equal(capabilities.email.configured, false);
  assert.equal(capabilities.email.senderConfigured, false);
  assert.ok(!JSON.stringify(capabilities).includes('unit-test-placeholder'));
  await assert.rejects(() => io.sendEmail(message, identity), /WORKFLOW_EMAIL_API_KEY/);
  assert.equal(io.outbox()[0].status, 'failed');
  assert.equal(io.outbox()[0].delivery, 'resend');
  const invalid = fixture(t, { env: { ...providerEnv, WORKFLOW_EMAIL_FROM: 'not a sender' } }).io;
  assert.equal(invalid.capabilities().email.configured, false);
  await assert.rejects(() => invalid.sendEmail(message, identity), /valid verified sender/);
});

test('mocked real-provider email is submitted once with idempotency and a persisted provider ID', async t => {
  const requests = [];
  const { io } = fixture(t, { env: providerEnv, fetchImpl: async (url, options) => { requests.push({ url, options }); return jsonResponse({ id: 'provider-message-123' }); } });
  assert.equal(io.capabilities().email.configured, true);
  const sent = await io.sendEmail(message, identity);
  assert.equal(sent.status, 'submitted');
  assert.equal(sent.delivery, 'resend');
  assert.equal(sent.messageId, 'provider-message-123');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
  assert.equal(requests[0].options.method, 'POST');
  assert.match(requests[0].options.headers['Idempotency-Key'], /^workflow-[a-f0-9]{64}$/);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer unit-test-placeholder');
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body.to, [message.to]);
  assert.equal(body.from, providerEnv.WORKFLOW_EMAIL_FROM);
  assert.deepEqual(await io.sendEmail(message, identity), sent);
  assert.equal(requests.length, 1);
  assert.equal(io.outbox()[0].providerMessageId, 'provider-message-123');
  await assert.rejects(() => io.sendEmail({ ...message, subject: 'Different message' }, identity), /different content/);
  assert.equal(requests.length, 1);
});

test('provider failures and uncertain requests are visible and do not automatically resend', async t => {
  let rejectedCalls = 0;
  const rejected = fixture(t, { env: providerEnv, fetchImpl: async () => { rejectedCalls++; return jsonResponse({ message: 'invalid' }, { status: 403 }); } }).io;
  await assert.rejects(() => rejected.sendEmail(message, identity), /HTTP 403/);
  assert.equal(rejected.outbox()[0].status, 'failed');
  await assert.rejects(() => rejected.sendEmail(message, identity), /HTTP 403/);
  assert.equal(rejectedCalls, 1);
  let uncertainCalls = 0;
  const uncertain = fixture(t, { env: providerEnv, fetchImpl: async () => { uncertainCalls++; throw new Error('network disconnected'); } }).io;
  await assert.rejects(() => uncertain.sendEmail(message, identity), /delivery is uncertain/);
  assert.equal(uncertain.outbox()[0].status, 'unknown');
  await assert.rejects(() => uncertain.sendEmail(message, identity), /pending or uncertain/);
  assert.equal(uncertainCalls, 1);
});

test('email address/subject validation blocks line injection and invalid actions before persistence', async t => {
  const { io } = fixture(t);
  for (const change of [
    { to: 'bad address' }, { to: 'a@example.invalid\r\nBcc: b@example.invalid' }, { subject: 'Alert\nInjected header' },
    { subject: '' }, { text: '' }, { delivery: 'smtp' },
  ]) await assert.rejects(() => io.sendEmail({ ...message, ...change }, identity));
  assert.equal(io.outbox().length, 0);
});
