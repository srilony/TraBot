import { randomUUID } from 'node:crypto';
import { AppError, SYSTEMS } from './store.mjs';

const TYPES = new Set(['event_trigger', 'schedule_trigger', 'condition', 'http_get', 'email']);
const UNITS = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 };
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']);
const clone = value => JSON.parse(JSON.stringify(value));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nodeId = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,49}$/.test(value) && !BAD_KEYS.has(value);
const iso = value => new Date(value).toISOString();
const dateValue = value => value instanceof Date ? value : new Date(value);

export function readPath(context, path, { optional = false } = {}) {
  if (typeof path !== 'string' || !/^(event|vars|nodes|schedule)(\.[A-Za-z0-9_-]+)*$/.test(path) || path.split('.').some(p => BAD_KEYS.has(p)))
    throw new AppError(`Invalid variable path: ${String(path).slice(0, 120)}`);
  let value = context;
  for (const key of path.split('.')) {
    if (value === null || value === undefined || !Object.hasOwn(Object(value), key)) {
      if (optional) return undefined;
      throw new AppError(`Variable is unavailable: ${path}`);
    }
    value = value[key];
  }
  return value;
}
export function renderTemplate(text, context, { encode = false } = {}) {
  if (typeof text !== 'string') throw new AppError('A text template is required.');
  const result = text.replace(/{{\s*([^{}]+?)\s*}}/g, (_, path) => {
    const value = readPath(context, path.trim());
    const formatted = value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return encode ? encodeURIComponent(formatted) : formatted;
  });
  if (/{{|}}/.test(result)) throw new AppError('Malformed variable template. Use {{event.after.orderId}} or another variable path.');
  if (result.length > 64000) throw new AppError('Expanded template exceeds the demo size limit.');
  return result;
}
function operand(value, context, optional = false) {
  if (!isObject(value)) throw new AppError('A comparison input is required.');
  if (value.kind === 'constant') return value.value;
  if (value.kind === 'path') return readPath(context, value.value, { optional });
  throw new AppError('Comparison input must be a variable path or constant.');
}
function compare(operator, left, right) {
  if (operator === 'exists') return left !== undefined && left !== null;
  if (operator === 'eq') return left === right;
  if (operator === 'neq') return left !== right;
  if (['gt', 'gte', 'lt', 'lte'].includes(operator)) {
    if (typeof left !== 'number' || typeof right !== 'number' || !Number.isFinite(left) || !Number.isFinite(right))
      throw new AppError('Ordered comparisons require two numbers. Choose a numeric constant or numeric response field.');
    return operator === 'gt' ? left > right : operator === 'gte' ? left >= right : operator === 'lt' ? left < right : left <= right;
  }
  if (operator === 'contains') {
    if (Array.isArray(left)) return left.includes(right);
    if (typeof left === 'string' && typeof right === 'string') return left.includes(right);
    throw new AppError('Contains requires a string/string or array/value comparison.');
  }
  throw new AppError('Unknown comparison operator.');
}
function scheduleInterval(config) { return Number(config.interval) * UNITS[config.unit]; }
function alignedNext(config, now) {
  const start = Date.parse(config.startAt), every = scheduleInterval(config);
  return iso(start >= now ? start : start + Math.ceil((now - start) / every) * every);
}
function eventMatches(config, event) {
  return config.matches.some(match => match.systemId === event.systemId && match.table === event.table && match.op === event.op);
}

export function validateWorkflow(definition) {
  const errors = [], error = (message, id) => errors.push({ ...(id ? { nodeId: id } : {}), message });
  if (!isObject(definition)) return { valid: false, errors: [{ message: 'A workflow definition is required.' }] };
  if (typeof definition.name !== 'string' || !definition.name.trim() || definition.name.length > 100) error('Give this workflow a name of at most 100 characters.');
  if (!Array.isArray(definition.nodes) || definition.nodes.length > 25) error('Use at most 25 nodes.');
  if (!Array.isArray(definition.edges) || definition.edges.length > 50) error('Use at most 50 connections.');
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : [], edges = Array.isArray(definition.edges) ? definition.edges : [];
  const ids = new Set(), byId = new Map();
  for (const node of nodes) {
    if (!isObject(node) || !nodeId(node.id) || ids.has(node.id)) { error('Node IDs must be unique safe identifiers.'); continue; }
    ids.add(node.id); byId.set(node.id, node);
    if (!TYPES.has(node.type)) { error('Unsupported block type.', node.id); continue; }
    const c = node.config;
    if (!isObject(c)) { error('Configure this block.', node.id); continue; }
    if (node.type === 'event_trigger') {
      if (!Array.isArray(c.matches) || !c.matches.length || c.matches.length > 9 || c.matches.some(m => !isObject(m) || !SYSTEMS.some(s => s.id === m.systemId && s.tables.includes(m.table)) || !['c', 'u', 'd'].includes(m.op))) error('Select one or more source/event types.', node.id);
      const fields = c.fields ?? [], names = new Set();
      if (!Array.isArray(fields) || fields.length > 30) error('Select at most 30 named event fields.', node.id);
      else for (const field of fields) {
        if (!isObject(field) || !nodeId(field.key) || names.has(field.key) || typeof field.path !== 'string' || !/^event(?:\.[A-Za-z0-9_-]+)*$/.test(field.path) || field.path.split('.').some(p => BAD_KEYS.has(p))) error('Field aliases must be unique and map to safe event paths.', node.id);
        else names.add(field.key);
      }
    }
    if (node.type === 'schedule_trigger') {
      if (typeof c.startAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(c.startAt) || !Number.isFinite(Date.parse(c.startAt))) error('Set a start date/time with a timezone.', node.id);
      if (!Number.isSafeInteger(c.interval) || c.interval < 1 || !UNITS[c.unit] || scheduleInterval(c) > 366 * UNITS.days) error('Choose an interval from one second to 366 days.', node.id);
    }
    if (node.type === 'condition') {
      if (!OPERATORS.has(c.operator)) error('Choose a comparison operator.', node.id);
      for (const input of c.operator === 'exists' ? [c.left] : [c.left, c.right]) {
        if (!isObject(input) || !['path', 'constant'].includes(input.kind)) error('Choose a variable or a constant for each comparison input.', node.id);
        else if (input.kind === 'path') {
          try { readPath({}, input.value, { optional: true }); } catch { error('Use a safe variable path for the comparison.', node.id); }
        } else if (!(input.value === null || ['string', 'boolean'].includes(typeof input.value) || typeof input.value === 'number' && Number.isFinite(input.value))) error('Constants must be text, numbers, booleans or null.', node.id);
      }
    }
    if (node.type === 'http_get' && (typeof c.url !== 'string' || !c.url.trim() || c.url.length > 4096)) error('Enter an HTTP GET URL.', node.id);
    if (node.type === 'email') {
      if (!['resend', 'outbox'].includes(c.delivery)) error('Choose Resend or demo outbox delivery.', node.id);
      if (typeof c.to !== 'string' || !c.to.trim() || typeof c.subject !== 'string' || !c.subject.trim() || typeof c.text !== 'string' || !c.text.trim()) error('Enter recipient, subject and message text.', node.id);
    }
    for (const text of node.type === 'http_get' ? [c.url] : node.type === 'email' ? [c.to, c.subject, c.text] : []) {
      if (typeof text !== 'string') continue;
      for (const match of text.matchAll(/{{\s*([^{}]+?)\s*}}/g)) {
        try { readPath({}, match[1].trim(), { optional: true }); } catch { error('A template contains an invalid variable path.', node.id); }
      }
      if (/{{|}}/.test(text.replace(/{{\s*[^{}]+?\s*}}/g, ''))) error('A variable template is malformed.', node.id);
    }
  }
  const triggers = nodes.filter(n => n && ['event_trigger', 'schedule_trigger'].includes(n.type));
  if (triggers.length !== 1) error('Use exactly one event or schedule trigger per workflow.');
  const incoming = new Map(), outgoing = new Map(), edgeIds = new Set();
  for (const edge of edges) {
    if (!isObject(edge) || typeof edge.id !== 'string' || edgeIds.has(edge.id) || !byId.has(edge.source) || !byId.has(edge.target)) { error('Connections need unique IDs and existing blocks.'); continue; }
    edgeIds.add(edge.id);
    const source = byId.get(edge.source), target = byId.get(edge.target);
    if (!['next', 'true', 'false'].includes(edge.port) || (source.type === 'condition' ? !['true', 'false'].includes(edge.port) : edge.port !== 'next')) error('Connect the correct output port.', edge.source);
    if (target.type.endsWith('_trigger')) error('A trigger cannot have an incoming connection.', edge.target);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    const outputKey = `${edge.source}:${edge.port}`;
    if (outgoing.has(outputKey)) error('Each output port can connect to one next block.', edge.source);
    outgoing.set(outputKey, edge);
  }
  for (const [id, n] of incoming) if (n > 1) error('Use one incoming connection per block; branch joins are not supported.', id);
  const visited = new Set(), active = new Set();
  function visit(id) {
    if (active.has(id)) { error('Cycles are not supported.'); return; }
    if (visited.has(id)) return;
    active.add(id);
    for (const edge of edges.filter(e => e?.source === id && byId.has(e.target))) visit(edge.target);
    active.delete(id); visited.add(id);
  }
  for (const id of ids) visit(id);
  if (triggers.length === 1) {
    const reachable = new Set();
    const walk = id => { if (reachable.has(id)) return; reachable.add(id); for (const edge of edges.filter(e => e?.source === id && byId.has(e.target))) walk(edge.target); };
    walk(triggers[0].id);
    for (const id of ids) if (!reachable.has(id)) error('Connect this block to the trigger.', id);
    if (nodes.length === 1) error('Add at least one condition, HTTP GET or email block after the trigger.');
  }
  return { valid: !errors.length, errors };
}

export class WorkflowEngine {
  constructor(store, { io, autoStart = false, clock = () => new Date() } = {}) {
    this.store = store; this.db = store.db; this.io = io; this.clock = clock; this.started = false; this.closed = false; this.processing = null;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_definitions (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL, revision INTEGER NOT NULL,
        definition_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        next_run_at TEXT, enabled_after_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL,
        trigger_key TEXT NOT NULL, trigger_type TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
        definition_json TEXT NOT NULL, context_json TEXT NOT NULL, steps_json TEXT NOT NULL,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT,
        UNIQUE (workflow_id, trigger_key)
      );
    `);
    this.db.prepare("INSERT OR IGNORE INTO metadata (key,value) VALUES ('workflow_cursor',?)").run(String(this.maxSequence()));
    this.db.prepare("UPDATE workflow_runs SET status='interrupted',finished_at=?,error='The server stopped during this run. Actions were not automatically retried.' WHERE status='running'").run(this.now());
    if (autoStart) this.start();
  }
  now() { return dateValue(this.clock()).toISOString(); }
  maxSequence() { return this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM cdc_events').get().n; }
  get(id) {
    const row = this.db.prepare('SELECT * FROM workflow_definitions WHERE id=?').get(id);
    if (!row) throw new AppError('Workflow not found.', 404);
    return { ...JSON.parse(row.definition_json), id: row.id, name: row.name, enabled: !!row.enabled, revision: row.revision,
      createdAt: row.created_at, updatedAt: row.updated_at, nextRunAt: row.next_run_at, validation: validateWorkflow(JSON.parse(row.definition_json)) };
  }
  list() { return { workflows: this.db.prepare('SELECT id FROM workflow_definitions ORDER BY updated_at DESC,id').all().map(row => this.get(row.id)) }; }
  save(input, requestedId) {
    if (!isObject(input) || JSON.stringify(input).length > 128000 || !Array.isArray(input.nodes) || !Array.isArray(input.edges) || input.nodes.length > 25 || input.edges.length > 50)
      throw new AppError('A workflow needs arrays of at most 25 nodes and 50 edges.');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw new AppError('Give the workflow a name of at most 100 characters.');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new AppError('enabled must be true or false.');
    for (const node of input.nodes) if (!isObject(node) || !nodeId(node.id) || !TYPES.has(node.type) || !isObject(node.config)) throw new AppError('Every block needs a safe ID, supported type and configuration object.');
    const id = requestedId ?? (input.id && this.db.prepare('SELECT id FROM workflow_definitions WHERE id=?').get(input.id) ? input.id : randomUUID());
    const old = this.db.prepare('SELECT * FROM workflow_definitions WHERE id=?').get(id);
    if (requestedId && !old) throw new AppError('Workflow not found.', 404);
    if (old && input.revision !== undefined && input.revision !== old.revision) throw new AppError('This workflow changed in another window. Reload before saving.', 409);
    const definition = { id, name: input.name.trim(), enabled: input.enabled ?? false, nodes: clone(input.nodes), edges: clone(input.edges) };
    const validation = validateWorkflow(definition);
    if (definition.enabled && !validation.valid) { const e = new AppError(`Invalid workflow graph: ${validation.errors[0].message}`, 400); e.details = validation.errors; throw e; }
    if (definition.enabled && definition.nodes.some(n => n.type === 'email' && n.config.delivery === 'resend')) {
      const capability = this.io.capabilities().email;
      if (!capability.configured || !capability.senderConfigured) throw new AppError('Configure WORKFLOW_EMAIL_API_KEY and a Resend-verified WORKFLOW_EMAIL_FROM before enabling real email delivery.');
    }
    const trigger = definition.nodes.find(n => n.type.endsWith('_trigger'));
    let next = null;
    if (definition.enabled && trigger?.type === 'schedule_trigger') {
      const oldDefinition = old ? JSON.parse(old.definition_json) : null;
      const oldTrigger = oldDefinition?.nodes.find(n => n.type === 'schedule_trigger');
      next = old?.enabled && oldTrigger && JSON.stringify(oldTrigger.config) === JSON.stringify(trigger.config) ? old.next_run_at : alignedNext(trigger.config, dateValue(this.clock()).getTime());
    }
    const now = this.now();
    this.db.prepare(`INSERT INTO workflow_definitions VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,revision=excluded.revision,definition_json=excluded.definition_json,updated_at=excluded.updated_at,next_run_at=excluded.next_run_at,enabled_after_sequence=excluded.enabled_after_sequence`)
      .run(id, definition.name, Number(definition.enabled), (old?.revision ?? 0) + 1, JSON.stringify(definition), old?.created_at ?? now, now, next, this.maxSequence());
    return this.get(id);
  }
  remove(id) {
    this.get(id);
    this.db.prepare('DELETE FROM workflow_definitions WHERE id=?').run(id);
    this.db.prepare("UPDATE workflow_runs SET status='interrupted',error='Workflow deleted before execution.',finished_at=? WHERE workflow_id=? AND status='queued'").run(this.now(), id);
    return { ok: true };
  }
  decodeRun(row) {
    return { id: row.id, workflowId: row.workflow_id, workflowName: row.workflow_name, triggerKey: row.trigger_key, triggerType: row.trigger_type,
      mode: row.mode, status: row.status, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
      error: row.error, context: JSON.parse(row.context_json), steps: JSON.parse(row.steps_json) };
  }
  getRun(id) {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE id=?').get(id);
    if (!row) throw new AppError('Workflow run not found.', 404);
    return this.decodeRun(row);
  }
  runs(workflowId) {
    const rows = workflowId ? this.db.prepare('SELECT * FROM workflow_runs WHERE workflow_id=? ORDER BY rowid DESC LIMIT 50').all(workflowId)
      : this.db.prepare('SELECT * FROM workflow_runs ORDER BY rowid DESC LIMIT 50').all();
    return { runs: rows.map(row => this.decodeRun(row)) };
  }
  enqueue(workflow, { event = null, schedule = null, mode = 'live', key }) {
    const trigger = workflow.nodes.find(n => n.type.endsWith('_trigger'));
    const id = randomUUID(), context = { event, schedule, vars: {}, nodes: {} };
    const result = this.db.prepare(`INSERT OR IGNORE INTO workflow_runs (id,workflow_id,workflow_name,trigger_key,trigger_type,mode,status,definition_json,context_json,steps_json,created_at) VALUES (?,?,?,?,?,?,'queued',?,?,?,?)`)
      .run(id, workflow.id, workflow.name, key, trigger.type === 'event_trigger' ? 'event' : 'schedule', mode, JSON.stringify(workflow), JSON.stringify(context), '[]', this.now());
    return result.changes ? id : this.db.prepare('SELECT id FROM workflow_runs WHERE workflow_id=? AND trigger_key=?').get(workflow.id, key).id;
  }
  receiveEvents() {
    const cursor = Number(this.db.prepare("SELECT value FROM metadata WHERE key='workflow_cursor'").get().value);
    const rows = this.db.prepare('SELECT * FROM cdc_events WHERE sequence>? ORDER BY sequence').all(cursor);
    if (!rows.length) return;
    this.store.transaction(() => {
      const definitions = this.db.prepare('SELECT * FROM workflow_definitions WHERE enabled=1').all();
      for (const row of rows) {
        const event = this.store.decodeEvent(row);
        for (const saved of definitions) {
          const definition = JSON.parse(saved.definition_json), trigger = definition.nodes.find(n => n.type === 'event_trigger');
          if (trigger && row.sequence > saved.enabled_after_sequence && eventMatches(trigger.config, event)) this.enqueue({ ...definition, revision: saved.revision }, { event, key: `event:${event.eventId}` });
        }
        this.db.prepare("UPDATE metadata SET value=? WHERE key='workflow_cursor'").run(String(row.sequence));
      }
    });
  }
  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.unsubscribe = this.store.subscribe(event => {
      try {
        if (event.type === 'demo.reset') this.db.prepare("UPDATE metadata SET value=? WHERE key='workflow_cursor'").run(String(this.maxSequence()));
        else this.receiveEvents();
        queueMicrotask(() => this.drain().catch(error => console.error('Workflow runner:', error.message)));
      } catch (error) { console.error('Workflow trigger:', error.message); }
    });
    this.receiveEvents();
    this.timer = setInterval(() => this.tick().catch(error => console.error('Workflow scheduler:', error.message)), 1000);
    this.timer.unref();
    this.tick().catch(error => console.error('Workflow scheduler:', error.message));
  }
  async tick(value = this.clock()) {
    if (this.closed) return;
    const now = dateValue(value).getTime();
    this.store.transaction(() => {
      const rows = this.db.prepare('SELECT * FROM workflow_definitions WHERE enabled=1 AND next_run_at IS NOT NULL').all();
      for (const row of rows) {
        if (Date.parse(row.next_run_at) > now) continue;
        const definition = JSON.parse(row.definition_json), trigger = definition.nodes.find(n => n.type === 'schedule_trigger');
        const interval = scheduleInterval(trigger.config), start = Date.parse(trigger.config.startAt);
        const scheduled = start + Math.floor((now - start) / interval) * interval;
        const scheduledAt = iso(scheduled), missedIntervals = Math.max(0, Math.floor((scheduled - Date.parse(row.next_run_at)) / interval));
        this.enqueue({ ...definition, revision: row.revision }, { schedule: { scheduledAt, startedAt: this.now(), missedIntervals }, key: `schedule:${scheduledAt}` });
        this.db.prepare('UPDATE workflow_definitions SET next_run_at=? WHERE id=?').run(iso(scheduled + interval), row.id);
      }
    });
    await this.drain();
  }
  async test(id, { eventId } = {}) {
    const workflow = this.get(id), validation = validateWorkflow(workflow);
    if (!validation.valid) { const error = new AppError(`Invalid workflow: ${validation.errors[0].message}`); error.details = validation.errors; throw error; }
    const trigger = workflow.nodes.find(n => n.type.endsWith('_trigger'));
    let event = null, schedule = null;
    if (trigger.type === 'event_trigger') {
      const rows = eventId ? this.db.prepare('SELECT * FROM cdc_events WHERE event_id=?').all(eventId) : this.db.prepare('SELECT * FROM cdc_events ORDER BY sequence DESC').all();
      event = rows.map(row => this.store.decodeEvent(row)).find(e => eventMatches(trigger.config, e));
      if (!event) throw new AppError('No matching hub event is available. Publish a matching event in the simulator first.');
    } else schedule = { scheduledAt: this.now(), startedAt: this.now(), missedIntervals: 0 };
    const runId = this.enqueue(workflow, { event, schedule, mode: 'test', key: `test:${randomUUID()}` });
    await this.drain();
    return this.getRun(runId);
  }
  async drain() {
    while (!this.closed) {
      const active = this.processing;
      if (active) {
        await active;
        if (this.processing === active) this.processing = null;
        continue; // Events may have arrived while an earlier drain was settling.
      }
      if (!this.db.prepare("SELECT id FROM workflow_runs WHERE status='queued' LIMIT 1").get()) return;
      const work = (async () => {
        while (!this.closed) {
          const row = this.db.prepare("SELECT * FROM workflow_runs WHERE status='queued' ORDER BY rowid LIMIT 1").get();
          if (!row) break;
          await this.execute(row);
        }
      })();
      this.processing = work;
      try { await work; } finally { if (this.processing === work) this.processing = null; }
    }
  }
  async execute(row) {
    const definition = JSON.parse(row.definition_json), context = JSON.parse(row.context_json), steps = [];
    const startedAt = this.now();
    this.db.prepare("UPDATE workflow_runs SET status='running',started_at=? WHERE id=?").run(startedAt, row.id);
    let current = definition.nodes.find(n => n.type.endsWith('_trigger'));
    try {
      for (let count = 0; current; count++) {
        if (count >= 25) throw new AppError('Workflow exceeded its execution limit.');
        const step = { nodeId: current.id, nodeType: current.type, status: 'running', startedAt: this.now(), finishedAt: null, input: null, output: null, error: null };
        steps.push(step);
        let port = 'next';
        try {
          const c = current.config;
          if (current.type === 'event_trigger') {
            const selected = {};
            for (const field of c.fields ?? []) selected[field.key] = readPath(context, field.path);
            context.vars = selected; step.input = context.event; step.output = { event: context.event, selected };
          } else if (current.type === 'schedule_trigger') {
            step.input = context.schedule; step.output = context.schedule;
          } else if (current.type === 'condition') {
            const left = operand(c.left, context, c.operator === 'exists'), right = c.operator === 'exists' ? null : operand(c.right, context);
            const result = compare(c.operator, left, right);
            step.input = { left: left ?? null, operator: c.operator, right };
            step.output = { result, left: left ?? null, right }; port = result ? 'true' : 'false';
          } else if (current.type === 'http_get') {
            const url = renderTemplate(c.url, context, { encode: true }); step.input = { url };
            step.output = await this.io.getJSON(url);
          } else if (current.type === 'email') {
            const message = { delivery: c.delivery, to: renderTemplate(c.to, context), subject: renderTemplate(c.subject, context), text: renderTemplate(c.text, context) };
            step.input = { ...message, testCapture: row.mode === 'test' };
            step.output = await this.io.sendEmail(message, { runId: row.id, nodeId: current.id, mode: row.mode });
          }
          context.nodes[current.id] = step.output;
          if (JSON.stringify(context).length > 2_000_000) throw new AppError('Workflow context exceeds the two-megabyte demo limit.');
          step.status = 'succeeded'; step.finishedAt = this.now();
        } catch (error) { step.status = 'failed'; step.error = error.message; step.finishedAt = this.now(); throw error; }
        this.db.prepare('UPDATE workflow_runs SET context_json=?,steps_json=? WHERE id=?').run(JSON.stringify(context), JSON.stringify(steps), row.id);
        const next = definition.edges.find(e => e.source === current.id && e.port === port);
        current = next ? definition.nodes.find(n => n.id === next.target) : null;
      }
      this.db.prepare("UPDATE workflow_runs SET status='succeeded',finished_at=?,context_json=?,steps_json=? WHERE id=?").run(this.now(), JSON.stringify(context), JSON.stringify(steps), row.id);
    } catch (error) {
      this.db.prepare("UPDATE workflow_runs SET status='failed',finished_at=?,error=?,context_json=?,steps_json=? WHERE id=?").run(this.now(), error.message, JSON.stringify(context), JSON.stringify(steps), row.id);
    }
  }
  catalog() {
    const eventOptions = SYSTEMS.flatMap(s => s.tables.flatMap(table => ['c', 'u', 'd'].map(op => ({ id: `${s.id}:${table}:${op}`, systemId: s.id, table, op, label: `${s.name} · ${table === 'orders' ? 'Order' : 'Cart'} ${op === 'c' ? 'created' : op === 'u' ? 'updated' : 'deleted'}` }))));
    const eventExample = { name: 'Order threshold alert', enabled: false, nodes: [
      { id: 'trigger', type: 'event_trigger', position: { x: 80, y: 150 }, config: { matches: [{ systemId: 'erp', table: 'orders', op: 'c' }], fields: [{ key: 'amount', path: 'event.after.amountCents' }, { key: 'orderId', path: 'event.after.orderId' }] } },
      { id: 'lookup', type: 'http_get', position: { x: 350, y: 150 }, config: { url: '/api/workflow-demo/reference?brandId={{event.brandId}}' } },
      { id: 'check', type: 'condition', position: { x: 620, y: 150 }, config: { left: { kind: 'path', value: 'vars.amount' }, operator: 'gt', right: { kind: 'path', value: 'nodes.lookup.data.limitCents' } } },
      { id: 'alert', type: 'email', position: { x: 900, y: 50 }, config: { delivery: 'resend', to: 'operations@example.invalid', subject: 'Review order {{vars.orderId}}', text: 'Order {{vars.orderId}} has value {{vars.amount}} EUR cents. The reference limit is {{nodes.lookup.data.limitCents}} EUR cents.' } },
      { id: 'routine', type: 'email', position: { x: 900, y: 280 }, config: { delivery: 'resend', to: 'operations@example.invalid', subject: 'Order {{vars.orderId}} received', text: 'Order value is within the configured reference limit.' } },
    ], edges: [
      { id: 'e1', source: 'trigger', target: 'lookup', port: 'next' }, { id: 'e2', source: 'lookup', target: 'check', port: 'next' },
      { id: 'e3', source: 'check', target: 'alert', port: 'true' }, { id: 'e4', source: 'check', target: 'routine', port: 'false' },
    ] };
    const scheduleExample = { name: 'Scheduled portfolio check', enabled: false, nodes: [
      { id: 'schedule', type: 'schedule_trigger', position: { x: 80, y: 130 }, config: { startAt: iso(dateValue(this.clock()).getTime() + 60000), interval: 1, unit: 'hours' } },
      { id: 'lookup', type: 'http_get', position: { x: 350, y: 130 }, config: { url: '/api/workflow-demo/reference?brandId=northstar' } },
      { id: 'email', type: 'email', position: { x: 620, y: 130 }, config: { delivery: 'resend', to: 'operations@example.invalid', subject: 'Scheduled commerce check', text: 'Scheduled at {{schedule.scheduledAt}}. Reference limit: {{nodes.lookup.data.limitCents}} EUR cents.' } },
    ], edges: [{ id: 's1', source: 'schedule', target: 'lookup', port: 'next' }, { id: 's2', source: 'lookup', target: 'email', port: 'next' }] };
    return { eventOptions, examples: [eventExample, scheduleExample], variablePaths: ['event.eventId', 'event.sequence', 'event.brandId', 'event.systemId', 'event.table', 'event.op', 'event.occurredAt', 'event.receivedAt', 'event.source.name', 'event.source.captureMode', 'event.after.orderId', 'event.after.cartId', 'event.after.amountCents', 'event.after.currency', 'event.after.status', 'event.before.amountCents', 'event.payload.amountCents', 'event.payload.orderId', 'event.payload.cartId', 'event.payload.status', 'schedule.scheduledAt', 'schedule.missedIntervals'], capabilities: this.io.capabilities(), limits: { maxNodes: 25, maxEdges: 50 } };
  }
  async close() {
    this.closed = true; clearInterval(this.timer); this.unsubscribe?.();
    if (this.processing) await this.processing;
  }
}
