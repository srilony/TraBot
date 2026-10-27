import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommerceStore, AppError } from './store.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };

async function body(req) {
  let content = '';
  for await (const chunk of req) {
    content += chunk;
    if (Buffer.byteLength(content) > 16_384) throw new AppError('Request body is too large.', 413);
  }
  try {
    const result = JSON.parse(content || '{}');
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new AppError('Body must be a JSON object.'); }
}

export function createApp(store) {
  const streams = new Set();
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://local');
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true, mode: 'demo', database: 'sqlite', currency: 'EUR' });
      if (req.method === 'GET' && url.pathname === '/api/dashboard') return json(200, store.dashboard(url.searchParams.get('brandId') || 'all'));
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        const brandId = url.searchParams.get('brandId') || 'all';
        store.dashboard(brandId); // Validate filter before opening a stream.
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const send = () => {
          if (res.destroyed) return;
          // Slow clients reconnect to a fresh authoritative snapshot rather than buffering indefinitely.
          if (res.writableLength > 1_000_000) { res.destroy(); return; }
          res.write(`event: snapshot\ndata: ${JSON.stringify(store.dashboard(brandId))}\n\n`);
        };
        const unsubscribe = store.subscribe(send);
        streams.add(res);
        const keepAlive = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15_000);
        res.on('close', () => { clearInterval(keepAlive); unsubscribe(); streams.delete(res); });
        send();
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        // Local demo only. Block cross-origin browser writes even though this is not an authenticated product.
        if (req.headers.origin) {
          let origin;
          try { origin = new URL(req.headers.origin); } catch { throw new AppError('Invalid request origin.', 403); }
          if (origin.host !== req.headers.host) throw new AppError('Cross-origin writes are not supported.', 403);
        }
        if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new AppError('Use Content-Type: application/json.', 415);
        const input = await body(req);
        if (url.pathname === '/api/events') return json(200, store.ingest(input));
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
      json(error.status ?? 500, { error: error instanceof AppError ? error.message : 'The server could not complete this request.' });
    }
  });
  server.requestTimeout = 30_000;
  return {
    server,
    async close() {
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
