import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const LOCAL_PATHS = new Set(['/api/workflow-demo/reference', '/api/source-records']);
const EMAIL_ENDPOINT = 'https://api.resend.com/emails';
const safeError = message => Object.assign(new Error(message), { status: 400 });
const unwrapHost = host => host.replace(/^\[|\]$/g, '');

function publicAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    // Only globally routable unicast. Excludes mapped/compatible IPv4, local,
    // multicast, documentation, Teredo and 6to4 transition address ranges.
    const [first, second] = lower.split(':').map(part => parseInt(part || '0', 16));
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff &&
      !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8));
  }
  return false;
}

function waitWithAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function readJSON(response, signal, limit = MAX_RESPONSE_BYTES) {
  const announcedLength = Number(response.headers?.get('content-length'));
  if (Number.isFinite(announcedLength) && announcedLength > limit) {
    await response.body?.cancel().catch(() => {});
    throw safeError(`HTTP Get response exceeds the ${limit}-byte limit.`);
  }
  const chunks = [];
  let length = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await waitWithAbort(reader.read(), signal);
        if (done) break;
        length += value.byteLength;
        if (length > limit) throw safeError(`HTTP Get response exceeds the ${limit}-byte limit.`);
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw safeError('HTTP Get returned invalid or empty JSON.'); }
}

function singleEmail(value) {
  return typeof value === 'string' && value.length <= 320 && !/[\r\n]/.test(value) &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value);
}
function senderEmail(value) {
  if (typeof value !== 'string' || value.length > 500 || /[\r\n]/.test(value)) return false;
  if (singleEmail(value)) return true;
  const named = value.match(/^[^<>]+<([^<>]+)>$/);
  return !!named && singleEmail(named[1]);
}
function messageResult(row) {
  return { outboxId: row.id, status: row.status, delivery: row.delivery, messageId: row.provider_message_id ?? null };
}

/** IO adapters are deliberately separate from workflow evaluation. No real email
 * is sent in test mode, even if a node requests Resend delivery. */
export function createWorkflowIO({ db, getOrigin, fetchImpl, lookup = dnsLookup, env = process.env } = {}) {
  if (!db) throw new Error('Workflow IO requires a SQLite database.');
  const providerFetch = fetchImpl ?? globalThis.fetch;
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_outbox (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
    to_address TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL,
    delivery TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
    provider_message_id TEXT, error TEXT, UNIQUE(run_id,node_id)
  )`);

  const credentials = () => ({ key: env.WORKFLOW_EMAIL_API_KEY || env.RESEND_API_KEY || '', sender: env.WORKFLOW_EMAIL_FROM || '' });
  function capabilities() {
    const { key, sender } = credentials();
    return {
      email: { provider: 'resend', configured: !!key && senderEmail(sender), keyConfigured: !!key, senderConfigured: senderEmail(sender) },
      httpGet: { timeoutMs: TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES },
    };
  }

  async function resolveTarget(url, allowLocal) {
    if (!['http:', 'https:'].includes(url.protocol)) throw safeError('HTTP Get supports only http:// and https:// URLs.');
    if (url.username || url.password) throw safeError('Credentials in HTTP Get URLs are not supported.');
    const host = unwrapHost(url.hostname);
    if (allowLocal) return null;
    if (!host || host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost'))
      throw safeError('HTTP Get cannot access private or local network addresses.');
    let addresses;
    try {
      addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
    } catch { throw safeError('HTTP Get could not resolve the destination hostname.'); }
    if (!Array.isArray(addresses)) addresses = [addresses];
    if (!addresses.length || addresses.some(result => !result || !publicAddress(result.address)))
      throw safeError('HTTP Get cannot access private or local network addresses.');
    return addresses.map(result => ({ address: result.address, family: isIP(result.address) }));
  }

  function pinnedGet(url, addresses, signal) {
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'GET', headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' }, signal,
        ...(addresses ? { lookup: (_host, options, callback) => {
          if (options?.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        } } : {}),
      }, incoming => {
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) value.forEach(entry => headers.append(name, entry));
            else if (value !== undefined) headers.set(name, value);
          }
          const noBody = [204, 205, 304].includes(incoming.statusCode);
          let stream = incoming;
          const decoder = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[headers.get('content-encoding')?.toLowerCase()];
          if (!noBody && decoder) {
            stream = decoder();
            incoming.once('error', error => stream.destroy(error));
            stream.once('close', () => incoming.destroy());
            incoming.pipe(stream);
          }
          if (noBody) incoming.resume();
          // Nonstandard remote status codes still produce a controlled failure.
          resolve({ status: incoming.statusCode, ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
            headers, body: noBody ? null : Readable.toWeb(stream) });
        } catch (error) { incoming.destroy(); reject(error); }
      });
      request.once('error', reject);
      request.end();
    });
  }

  async function getJSON(input) {
    if (typeof input !== 'string' || !input.trim() || input.length > 4096) throw safeError('Provide an HTTP Get URL of at most 4096 characters.');
    const relative = input.startsWith('/') && !input.startsWith('//');
    let origin, target;
    try {
      if (relative) origin = new URL(getOrigin());
      target = new URL(input, relative ? origin : undefined);
    } catch { throw safeError('HTTP Get URL is invalid or the application is not listening yet.'); }
    if (relative && !LOCAL_PATHS.has(target.pathname)) throw safeError('Only built-in reference and source-record endpoints are available as relative URLs.');
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        const internal = relative && target.origin === origin.origin && LOCAL_PATHS.has(target.pathname);
        const addresses = await waitWithAbort(resolveTarget(target, internal), signal);
        const response = await waitWithAbort(fetchImpl
          ? fetchImpl(target.href, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', signal })
          : pinnedGet(target, addresses, signal), signal);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel().catch(() => {});
          if (!location || redirects === 3) throw safeError('HTTP Get exceeded the redirect limit or received a redirect without a destination.');
          try { target = new URL(location, target); } catch { throw safeError('HTTP Get returned an invalid redirect destination.'); }
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw safeError(`HTTP Get failed with HTTP ${response.status}.`);
        }
        const data = await readJSON(response, signal);
        return { status: response.status, data, url: target.href };
      }
    } catch (error) {
      if (error.status) throw error;
      throw safeError(signal.aborted ? 'HTTP Get timed out after 10 seconds.' : 'HTTP Get could not complete the request.');
    }
  }

  async function sendEmail(message, { runId, nodeId, mode = 'live' } = {}) {
    if (!message || typeof message !== 'object') throw safeError('Email action requires a message.');
    if (!singleEmail(message.to)) throw safeError('Email recipient must be one valid email address without line breaks.');
    if (typeof message.subject !== 'string' || !message.subject.trim() || message.subject.length > 200 || /[\r\n]/.test(message.subject))
      throw safeError('Email subject must contain 1–200 characters without line breaks.');
    if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 100_000)
      throw safeError('Email text must contain 1–100,000 characters.');
    if (![runId, nodeId].every(value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value))) throw safeError('Email action requires valid run and node IDs.');
    if (!['outbox', 'resend'].includes(message.delivery)) throw safeError('Choose outbox or resend email delivery.');
    const delivery = mode === 'test' ? 'outbox' : message.delivery;
    const existing = db.prepare('SELECT * FROM workflow_outbox WHERE run_id=? AND node_id=?').get(runId, nodeId);
    if (existing) {
      if (existing.to_address !== message.to || existing.subject !== message.subject || existing.text !== message.text || existing.delivery !== delivery)
        throw safeError('This run/node email action already exists with different content. No duplicate send was attempted.');
      if (['demo', 'submitted'].includes(existing.status)) return messageResult(existing);
      throw safeError(existing.status === 'failed' ? existing.error || 'The prior email attempt failed; no duplicate send was attempted.'
        : 'Email delivery is pending or uncertain; no duplicate send was attempted.');
    }
    const row = { id: randomUUID(), run_id: runId, node_id: nodeId, to_address: message.to, subject: message.subject, text: message.text,
      delivery, status: delivery === 'outbox' ? 'demo' : 'pending', created_at: new Date().toISOString(), provider_message_id: null };
    db.prepare('INSERT INTO workflow_outbox (id,run_id,node_id,to_address,subject,text,delivery,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.run_id, row.node_id, row.to_address, row.subject, row.text, row.delivery, row.status, row.created_at);
    if (delivery === 'outbox') return messageResult(row);
    const update = (status, error = null, providerId = null) => {
      row.status = status; row.provider_message_id = providerId;
      db.prepare('UPDATE workflow_outbox SET status=?,error=?,provider_message_id=? WHERE id=?').run(status, error, providerId, row.id);
    };
    const { key, sender } = credentials();
    if (!key || !senderEmail(sender)) {
      const reason = 'Configure WORKFLOW_EMAIL_API_KEY and a valid verified sender in WORKFLOW_EMAIL_FROM before sending real email.';
      update('failed', reason); throw safeError(reason);
    }
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let response;
    try {
      response = await waitWithAbort(providerFetch(EMAIL_ENDPOINT, {
        method: 'POST', signal, redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
          'Idempotency-Key': `workflow-${createHash('sha256').update(`${runId}:${nodeId}`).digest('hex')}` },
        body: JSON.stringify({ from: sender, to: [message.to], subject: message.subject, text: message.text }),
      }), signal);
    } catch {
      const reason = 'The email provider request failed or timed out; delivery is uncertain. No automatic resend was attempted.';
      update('unknown', reason); throw safeError(reason);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const reason = `Resend rejected the email (HTTP ${response.status}). Check provider credentials and the verified sender.`;
      update('failed', reason); throw safeError(reason);
    }
    try {
      const result = await readJSON(response, signal, 65_536);
      if (typeof result?.id !== 'string' || !result.id || result.id.length > 200) throw new Error();
      update('submitted', null, result.id);
      return messageResult(row);
    } catch {
      const reason = 'Resend accepted the request without a readable message ID; delivery is uncertain. No automatic resend was attempted.';
      update('unknown', reason); throw safeError(reason);
    }
  }

  function outbox(limit = 100) {
    if (!Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 500) throw safeError('Outbox limit must be an integer from 1 to 500.');
    return db.prepare('SELECT * FROM workflow_outbox ORDER BY created_at DESC,rowid DESC LIMIT ?').all(Number(limit)).map(row => ({
      id: row.id, runId: row.run_id, nodeId: row.node_id, to: row.to_address, subject: row.subject, text: row.text,
      delivery: row.delivery, status: row.status, createdAt: row.created_at, providerMessageId: row.provider_message_id, error: row.error,
    }));
  }
  return { getJSON, sendEmail, capabilities, outbox };
}
