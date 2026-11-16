// Disposable browser fixture: real app and CRM adapter, mocked external transport.
import assert from 'node:assert/strict';
import { CommerceStore } from '../../src/store.mjs';
import { createApp } from '../../src/server.mjs';
import { createWorkflowIO } from '../../src/workflow-io.mjs';
const store = new CommerceStore(':memory:');
const app = createApp(store);
const mock = createWorkflowIO({ db: store.db,
  env: { N8N_BASIC_USERNAME: 'browser-fake-user', N8N_BASIC_PASSWORD: 'browser-fake-password' },
  lookup: async () => [{ address: '8.8.8.8', family: 4 }],
  fetchImpl: async (_url, options) => {
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from('browser-fake-user:browser-fake-password').toString('base64')}`);
    const body = JSON.parse(options.body);
    assert.equal(typeof body.data.customerid, 'number');
    assert.equal(body.data.emailid, 'browser@example.invalid');
    return new Response(options.headers.Authorization, { status: body.data.name.includes('FAIL') ? 404 : 202 });
  },
});
app.workflows.io.updateCRM = mock.updateCRM;
const capabilities = app.workflows.io.capabilities;
app.workflows.io.capabilities = () => ({ ...capabilities(), crm: mock.capabilities().crm });
app.server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${app.server.address().port}`));
process.on('SIGTERM', async () => { await app.close(); store.close(); });
