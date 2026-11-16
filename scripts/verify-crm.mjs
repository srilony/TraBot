// One explicitly requested, authenticated call. Uses no application database.
import { randomInt, randomUUID } from 'node:crypto';
import { CommerceStore } from '../src/store.mjs';
import { createWorkflowIO } from '../src/workflow-io.mjs';
const url = 'https://srilony.app.n8n.cloud/webhook-test/cdc-webhook';
if (!process.env.N8N_BASIC_USERNAME || !process.env.N8N_BASIC_PASSWORD) {
  console.error('Verification not attempted: bind N8N_BASIC_USERNAME and N8N_BASIC_PASSWORD securely in the process environment.');
  process.exitCode = 1;
} else if (!process.argv.includes('--listening')) {
  console.error('Verification not attempted: select Listen for test event in n8n, then run with --listening.');
  process.exitCode = 1;
} else if (process.env.N8N_WEBHOOK_URL && process.env.N8N_WEBHOOK_URL !== url) {
  console.error('Verification not attempted: N8N_WEBHOOK_URL must match the requested test webhook.');
  process.exitCode = 1;
} else {
  const store = new CommerceStore(':memory:', { seed: false });
  const io = createWorkflowIO({ db: store.db });
  const customerid = Date.now() * 1000 + randomInt(1000);
  const payload = { table: 'customers', idField: 'customerid', data: {
    customerid, name: 'SYNTHETIC TraBot integration verification', emailid: `synthetic-${customerid}@example.invalid`,
    phone: '0000000000', nationality: 'Indian', documentID: `DEMO-${customerid}`,
  } };
  try {
    const result = await io.updateCRM({ url, credentialRef: 'n8n-basic' }, payload, { runId: randomUUID(), nodeId: 'verify' });
    console.log(JSON.stringify({ customerid, synthetic: true, httpStatus: result.status, httpAcceptance: true, databasePersistence: 'unverified' }));
  } catch (error) {
    // Adapter errors are controlled text; remote bodies/headers are never printed.
    console.error(JSON.stringify({ customerid, synthetic: true, error: error.message, databasePersistence: 'unverified', automaticRetry: false }));
    process.exitCode = 1;
  } finally { store.close(); }
}
