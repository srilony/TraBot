import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommerceStore, AppError } from './store.mjs';
import { WorkflowEngine } from './workflows.mjs';
import { createWorkflowIO } from './workflow-io.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/event-hub': ['index.html', 'text/html; charset=utf-8'],
  '/simulator': ['index.html', 'text/html; charset=utf-8'],
  '/workflows': ['workflows.html', 'text/html; charset=utf-8'],
  '/workflows.js': ['workflows.js', 'text/javascript; charset=utf-8'],
  '/workflows.css': ['workflows.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

async function body(req) {
  let content = '';
  for await (const chunk of req) {
    content += chunk;
    if (Buffer.byteLength(content) > 262_144) throw new AppError('Request body is too large.', 413);
  }
  try {
    const result = JSON.parse(content || '{}');
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new AppError('Body must be a JSON object.'); }
}

export function createApp(store) {
  const streams = new Set();
  let workflowIO, workflows;
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://local');
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true, mode: 'demo', database: 'sqlite', currency: 'EUR', schemaVersion: 2 });
      const filters = Object.fromEntries(url.searchParams);
      if (req.method === 'GET' && url.pathname === '/api/workflows/catalog') return json(200, workflows.catalog());
      if (req.method === 'GET' && url.pathname === '/api/workflows') return json(200, workflows.list());
      if (req.method === 'GET' && url.pathname === '/api/workflows/runs') return json(200, workflows.runs(filters.workflowId));
      if (req.method === 'GET' && url.pathname === '/api/workflows/outbox') return json(200, { messages: workflowIO.outbox() });
      if (req.method === 'GET' && url.pathname === '/api/workflows/capabilities') return json(200, workflowIO.capabilities());
      const workflowRoute = url.pathname.match(/^\/api\/workflows\/([a-zA-Z0-9-]+)(?:\/(runs|test))?$/);
      if (req.method === 'GET' && workflowRoute) return json(200, workflowRoute[2] === 'runs' ? workflows.runs(workflowRoute[1]) : { workflow: workflows.get(workflowRoute[1]) });
      if (req.method === 'GET' && url.pathname === '/api/workflow-demo/reference') {
        const brandId = filters.brandId || 'northstar';
        if (!store.catalog().brands.some(b => b.id === brandId)) throw new AppError('Unknown brandId.');
        return json(200, { brandId, limitCents: 15000, teamEmail: 'operations@example.invalid', currency: 'EUR', source: 'Demo HTTP reference' });
      }
      if (req.method === 'GET' && url.pathname === '/api/catalog') return json(200, store.catalog());
      if (req.method === 'GET' && url.pathname === '/api/subscriptions') return json(200, store.getSubscriptions());
      if (req.method === 'GET' && url.pathname === '/api/hub/events') return json(200, store.hubEvents(filters));
      if (req.method === 'GET' && url.pathname === '/api/source-records') return json(200, store.sourceRecords(filters));
      if (req.method === 'GET' && url.pathname === '/api/dashboard') return json(200, store.dashboard(url.searchParams.get('brandId') || 'all'));
      if (req.method === 'GET' && ['/api/stream', '/api/hub/stream'].includes(url.pathname)) {
        const brandId = url.searchParams.get('brandId') || 'all';
        const isHub = url.pathname === '/api/hub/stream';
        const snapshot = () => isHub ? store.hubEvents(filters) : store.dashboard(brandId);
        snapshot(); // Validate filters before opening a stream.
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const send = () => {
          if (res.destroyed) return;
          // Slow clients reconnect to a fresh authoritative snapshot rather than buffering indefinitely.
          if (res.writableLength > 1_000_000) { res.destroy(); return; }
          res.write(`event: ${isHub ? 'hub-snapshot' : 'snapshot'}\ndata: ${JSON.stringify(snapshot())}\n\n`);
        };
        const unsubscribe = store.subscribe(send);
        streams.add(res);
        const keepAlive = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15_000);
        res.on('close', () => { clearInterval(keepAlive); unsubscribe(); streams.delete(res); });
        send();
        return;
      }
      if (['POST', 'PUT', 'DELETE'].includes(req.method) && url.pathname.startsWith('/api/')) {
        // Local demo only. Block cross-origin browser writes even though this is not an authenticated product.
        if (req.headers.origin) {
          let origin;
          try { origin = new URL(req.headers.origin); } catch { throw new AppError('Invalid request origin.', 403); }
          if (origin.host !== req.headers.host) throw new AppError('Cross-origin writes are not supported.', 403);
        }
        if (req.method === 'DELETE' && workflowRoute && !workflowRoute[2]) return json(200, workflows.remove(workflowRoute[1]));
        if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new AppError('Use Content-Type: application/json.', 415);
        const input = await body(req);
        if (req.method === 'POST' && url.pathname === '/api/workflows') return json(201, { workflow: workflows.save(input) });
        if (req.method === 'PUT' && workflowRoute && !workflowRoute[2]) return json(200, { workflow: workflows.save(input, workflowRoute[1]) });
        if (req.method === 'POST' && workflowRoute?.[2] === 'test') return json(200, { run: await workflows.test(workflowRoute[1], input) });
        if (req.method === 'PUT' && url.pathname === '/api/subscriptions') return json(200, store.setSubscriptions(input.subscriptions));
        if (req.method !== 'POST') return json(404, { error: 'Not found.' });
        if (['/api/events', '/api/hub/events'].includes(url.pathname)) return json(200, store.ingest(input));
        if (url.pathname === '/api/simulator/preview') return json(200, store.simulatePreview(input));
        if (url.pathname === '/api/demo/reset') { store.resetDemo(); return json(200, { ok: true }); }
        const match = url.pathname.match(/^\/api\/demo\/(order|abandon|nudge|recover)$/);
        if (match) return json(200, store.simulate(match[1], input));
      }
      if (req.method === 'GET' && FILES[url.pathname]) {
        const [filename, type] = FILES[url.pathname];
        const data = await readFile(resolve(ROOT, 'public', filename));
        res.writeHead(200, { 'Content-Type': type }); res.end(data); return;
      }
      json(404, { error: 'Not found.' });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (!(error instanceof AppError)) console.error('Request failed:', error.message);
      json(error.status ?? 500, { error: error instanceof AppError ? error.message : 'The server could not complete this request.', ...(error.details ? { details: error.details } : {}) });
    }
  });
  server.requestTimeout = 30_000;
  workflowIO = createWorkflowIO({ db: store.db, getOrigin: () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new AppError('The HTTP server is not ready.');
    const host = address.family === 'IPv6' ? `[${address.address === '::' ? '::1' : address.address}]`
      : address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
    return `http://${host}:${address.port}`;
  } });
  workflows = new WorkflowEngine(store, { io: workflowIO });
  server.once('listening', () => workflows.start());
  return {
    server,
    workflows,
    async close() {
      await workflows.close();
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbFile = resolve(process.env.DATA_FILE || resolve(ROOT, '.data', 'commerce.sqlite'));
  await mkdir(dirname(dbFile), { recursive: true });
  const store = new CommerceStore(dbFile);
  const app = createApp(store);
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  app.server.listen(port, host, () => console.log(`Commerce Operations Hub listening on ${host}:${port} (fictional demo data; no authentication)`));
  app.server.on('error', error => { console.error(error.message); process.exitCode = 1; store.close(); });
  const stop = async () => { await app.close(); store.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
