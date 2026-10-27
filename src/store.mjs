import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export const BRANDS = [
  { id: 'northstar', name: 'Northstar', category: 'Home & living', color: '#426d62', initials: 'N' },
  { id: 'atelier', name: 'Atelier', category: 'Apparel', color: '#c67a48', initials: 'A' },
  { id: 'fieldwork', name: 'Fieldwork', category: 'Outdoor', color: '#657aa2', initials: 'F' },
];
export const SYSTEMS = [
  { id: 'erp', name: 'ERP', tables: ['orders'] },
  { id: 'ecommerce', name: 'E-commerce platform', tables: ['orders', 'carts'] },
];
const DEFAULT_RULES = [
  { systemId: 'erp', table: 'orders', enabled: true },
  { systemId: 'ecommerce', table: 'orders', enabled: false },
  { systemId: 'ecommerce', table: 'carts', enabled: true },
];
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value, field) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value))
    throw new AppError(`${field} must contain 1–100 letters, numbers, dots, colons, underscores or hyphens.`);
  return value;
};
function timestamp(value, field = 'occurredAt') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new AppError(`${field} must be an ISO timestamp with a timezone.`);
  if (Date.parse(value) > Date.now() + 300_000) throw new AppError(`${field} cannot be more than five minutes in the future.`);
  return new Date(value).toISOString();
}
function channel(systemId, table) {
  if (!SYSTEMS.some(system => system.id === systemId && system.tables.includes(table)))
    throw new AppError('Unknown system of record or unsupported source table.');
}
function brand(brandId) {
  if (!BRANDS.some(b => b.id === brandId)) throw new AppError('Unknown brandId.');
}
function money(amountCents, currency) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 100_000_000)
    throw new AppError('amountCents must be a positive integer, at most 100,000,000.');
  if (currency !== 'EUR') throw new AppError('This demo supports EUR only; mixed currencies cannot be aggregated.');
}
function record(table, data, time) {
  if (!object(data)) throw new AppError('CDC record images must be objects.');
  money(data.amountCents, data.currency);
  if (table === 'orders') {
    if (!['placed', 'cancelled'].includes(data.status)) throw new AppError('Order status must be placed or cancelled.');
    const result = { orderId: id(data.orderId, 'orderId'), amountCents: data.amountCents, currency: 'EUR', status: data.status, placedAt: timestamp(data.placedAt ?? time, 'placedAt') };
    if (data.cartId !== undefined && data.cartId !== '') result.cartId = id(data.cartId, 'cartId');
    return result;
  }
  if (!['active', 'abandoned', 'converted'].includes(data.status)) throw new AppError('Cart status must be active, abandoned or converted.');
  return { cartId: id(data.cartId, 'cartId'), amountCents: data.amountCents, currency: 'EUR', status: data.status,
    abandonedAt: data.abandonedAt ? timestamp(data.abandonedAt, 'abandonedAt') : data.status === 'abandoned' ? time : null,
    nudgedAt: data.nudgedAt ? timestamp(data.nudgedAt, 'nudgedAt') : null };
}
const recordId = (table, data) => data[table === 'orders' ? 'orderId' : 'cartId'];
function validateCDC(input) {
  if (!object(input)) throw new AppError('A CDC event object is required.');
  const systemId = input.systemId ?? input.source?.systemId;
  const table = input.table ?? input.source?.table;
  channel(systemId, table); brand(input.brandId);
  const occurredAt = timestamp(input.occurredAt);
  if (!['c', 'u', 'd'].includes(input.op)) throw new AppError('CDC op must be c (create), u (update) or d (delete).');
  if (input.op === 'c' && input.before !== null) throw new AppError('Create requires before: null.');
  if (input.op === 'd' && input.after !== null) throw new AppError('Delete requires after: null.');
  const before = input.op === 'c' ? null : record(table, input.before, occurredAt);
  const after = input.op === 'd' ? null : record(table, input.after, occurredAt);
  if (before && after && recordId(table, before) !== recordId(table, after)) throw new AppError('An update cannot change the record ID.');
  return { eventId: id(input.eventId, 'eventId'), occurredAt, systemId, table, op: input.op, brandId: input.brandId, before, after };
}

// The original normalized-event API remains supported; it is adapted into CDC.
export function validateEvent(input) {
  if (!object(input)) throw new AppError('An event object is required.');
  const { eventId, type, brandId, source, payload } = input;
  id(eventId, 'eventId'); brand(brandId);
  if (!['order.placed', 'cart.abandoned', 'cart.nudge_requested'].includes(type)) throw new AppError('Unsupported event type.');
  if (typeof source !== 'string' || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(source)) throw new AppError('A valid source is required.');
  if (!object(payload)) throw new AppError('An event payload is required.');
  const cleaned = {};
  if (type === 'order.placed') cleaned.orderId = id(payload.orderId, 'orderId');
  if (type !== 'order.placed' || payload.cartId !== undefined) cleaned.cartId = id(payload.cartId, 'cartId');
  if (type !== 'cart.nudge_requested') { money(payload.amountCents, payload.currency); cleaned.amountCents = payload.amountCents; cleaned.currency = 'EUR'; }
  return { eventId, type, occurredAt: timestamp(input.occurredAt), brandId, source, payload: cleaned };
}

export class CommerceStore {
  constructor(filename = ':memory:', { seed = true } = {}) {
    this.db = new DatabaseSync(filename);
    this.hub = new EventEmitter(); this.hub.setMaxListeners(0);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cdc_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
        occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, system_id TEXT NOT NULL,
        entity_table TEXT NOT NULL, brand_id TEXT NOT NULL, record_id TEXT NOT NULL,
        op TEXT NOT NULL, before_json TEXT, after_json TEXT, capture_mode TEXT NOT NULL, legacy_json TEXT
      );
      CREATE TABLE IF NOT EXISTS cdc_records (
        system_id TEXT NOT NULL, entity_table TEXT NOT NULL, brand_id TEXT NOT NULL,
        record_id TEXT NOT NULL, data_json TEXT, occurred_at TEXT NOT NULL, sequence INTEGER NOT NULL,
        PRIMARY KEY (system_id, entity_table, brand_id, record_id)
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        system_id TEXT NOT NULL, entity_table TEXT NOT NULL, enabled INTEGER NOT NULL,
        PRIMARY KEY (system_id, entity_table)
      );
      INSERT OR IGNORE INTO metadata (key,value) VALUES ('cdc_revision','0');
    `);
    for (const rule of DEFAULT_RULES) this.db.prepare('INSERT OR IGNORE INTO subscriptions VALUES (?,?,?)').run(rule.systemId, rule.table, Number(rule.enabled));
    this.migrateLegacy();
    if (seed && !this.db.prepare("SELECT value FROM metadata WHERE key='initialized'").get()) {
      if (this.db.prepare('SELECT COUNT(*) AS n FROM cdc_events').get().n) this.db.prepare("INSERT INTO metadata VALUES ('initialized','true')").run();
      else this.resetDemo();
    }
  }
  transaction(fn) {
    const own = !this.db.isTransaction;
    if (own) this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); if (own) this.db.exec('COMMIT'); return result; }
    catch (error) { if (own) this.db.exec('ROLLBACK'); throw error; }
  }
  bumpRevision() { this.db.prepare("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='cdc_revision'").run(); }
  revision() { return Number(this.db.prepare("SELECT value FROM metadata WHERE key='cdc_revision'").get().value); }
  subscribe(listener) { this.hub.on('commerce.event', listener); return () => this.hub.off('commerce.event', listener); }
  getSubscriptions() {
    const rows = this.db.prepare('SELECT * FROM subscriptions').all();
    return { subscriptions: DEFAULT_RULES.map(rule => ({ ...rule, enabled: !!rows.find(r => r.system_id === rule.systemId && r.entity_table === rule.table).enabled })) };
  }
  setSubscriptions(rules) {
    if (!Array.isArray(rules) || rules.length !== DEFAULT_RULES.length) throw new AppError('Supply all three subscription rules.');
    const seen = new Set();
    for (const rule of rules) {
      if (!object(rule)) throw new AppError('Invalid subscription rule.');
      channel(rule.systemId, rule.table);
      const key = `${rule.systemId}.${rule.table}`;
      if (seen.has(key) || typeof rule.enabled !== 'boolean') throw new AppError('Subscription rules must be unique with boolean enabled values.');
      seen.add(key);
    }
    const before = this.getSubscriptions();
    this.transaction(() => {
      for (const rule of rules) this.db.prepare('UPDATE subscriptions SET enabled=? WHERE system_id=? AND entity_table=?').run(Number(rule.enabled), rule.systemId, rule.table);
      if (JSON.stringify(before) !== JSON.stringify(this.getSubscriptions())) this.bumpRevision();
    });
    this.hub.emit('commerce.event', { type: 'subscriptions.changed' });
    return this.getSubscriptions();
  }
  catalog() { return { brands: BRANDS, systems: SYSTEMS, tables: ['orders', 'carts'], ...this.getSubscriptions() }; }
  rawRecord(systemId, table, brandId, key) {
    return this.db.prepare('SELECT * FROM cdc_records WHERE system_id=? AND entity_table=? AND brand_id=? AND record_id=?').get(systemId, table, brandId, key);
  }
  decodeEvent(row) {
    const before = row.before_json ? JSON.parse(row.before_json) : null;
    const after = row.after_json ? JSON.parse(row.after_json) : null;
    const data = after ?? before;
    let type;
    if (row.entity_table === 'orders') type = row.op === 'd' ? 'order.deleted' : after.status === 'cancelled' ? 'order.cancelled' : row.op === 'c' ? 'order.placed' : 'order.updated';
    else type = row.op === 'd' ? 'cart.deleted' : after.nudgedAt && after.nudgedAt !== before?.nudgedAt ? 'cart.nudge_requested' : after.status === 'abandoned' && before?.status !== 'abandoned' ? 'cart.abandoned' : after.status === 'converted' ? 'cart.converted' : row.op === 'c' ? 'cart.created' : 'cart.updated';
    return { sequence: row.sequence, eventId: row.event_id, occurredAt: row.occurred_at, receivedAt: row.received_at,
      systemId: row.system_id, table: row.entity_table, op: row.op, brandId: row.brand_id, before, after,
      source: { systemId: row.system_id, name: SYSTEMS.find(s => s.id === row.system_id).name, table: row.entity_table, captureMode: row.capture_mode },
      type, payload: data, brandName: BRANDS.find(b => b.id === row.brand_id).name };
  }
  ingest(input, options = {}) {
    if (input?.type && !input?.op) return this.ingestLegacy(input, options);
    const event = validateCDC(input);
    const existing = this.db.prepare('SELECT * FROM cdc_events WHERE event_id=?').get(event.eventId);
    if (existing) {
      const old = validateCDC(this.decodeEvent(existing));
      if (JSON.stringify(old) !== JSON.stringify(event)) throw new AppError('eventId already exists with different content.', 409);
      return { ok: true, duplicate: true, event: this.decodeEvent(existing) };
    }
    const key = recordId(event.table, event.after ?? event.before);
    const previous = this.rawRecord(event.systemId, event.table, event.brandId, key);
    const previousData = previous?.data_json ? JSON.parse(previous.data_json) : null;
    // Version one accepted out-of-order timestamps. Preserve its receipt-ordered
    // state during the one-time migration; new CDC writes still reject stale changes.
    if (previous && event.occurredAt < previous.occurred_at && options.captureMode !== 'legacy-migration')
      throw new AppError('Stale CDC timestamp: refresh the source record before publishing.', 409);
    if (event.op === 'c' && previousData) {
      if (JSON.stringify(event.after) === JSON.stringify(previousData)) return { ok: true, duplicate: true, event: this.decodeEvent(this.db.prepare('SELECT * FROM cdc_events WHERE sequence=?').get(previous.sequence)) };
      throw new AppError('Record already exists. Use an update operation.', 409);
    }
    if (event.op !== 'c' && (!previousData || JSON.stringify(previousData) !== JSON.stringify(event.before)))
      throw new AppError('CDC before image does not match the current source record. Refresh and preview again.', 409);
    const captureMode = options.captureMode ?? (input.source?.captureMode === 'simulated-cdc' ? 'simulated-cdc' : 'external-cdc');
    let saved;
    this.transaction(() => {
      const result = this.db.prepare(`INSERT INTO cdc_events (event_id,occurred_at,received_at,system_id,entity_table,brand_id,record_id,op,before_json,after_json,capture_mode,legacy_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(event.eventId, event.occurredAt, new Date().toISOString(), event.systemId, event.table, event.brandId, key, event.op,
          event.before ? JSON.stringify(event.before) : null, event.after ? JSON.stringify(event.after) : null, captureMode, options.legacy ? JSON.stringify(options.legacy) : null);
      this.db.prepare(`INSERT INTO cdc_records VALUES (?,?,?,?,?,?,?) ON CONFLICT (system_id,entity_table,brand_id,record_id) DO UPDATE SET data_json=excluded.data_json,occurred_at=excluded.occurred_at,sequence=excluded.sequence`)
        .run(event.systemId, event.table, event.brandId, key, event.after ? JSON.stringify(event.after) : null, event.occurredAt, result.lastInsertRowid);
      this.bumpRevision();
      saved = this.decodeEvent(this.db.prepare('SELECT * FROM cdc_events WHERE event_id=?').get(event.eventId));
    });
    if (options.notify !== false) this.hub.emit('commerce.event', saved);
    return { ok: true, duplicate: false, event: saved };
  }
  ingestLegacy(input, options = {}) {
    const event = validateEvent(input), p = event.payload;
    const existing = this.db.prepare('SELECT * FROM cdc_events WHERE event_id=?').get(event.eventId);
    if (existing) {
      if (existing.legacy_json !== JSON.stringify(event)) throw new AppError('eventId already exists with different content.', 409);
      return { ok: true, duplicate: true, event: this.decodeEvent(existing) };
    }
    const systemId = event.type === 'order.placed' ? 'erp' : 'ecommerce';
    const table = event.type === 'order.placed' ? 'orders' : 'carts';
    const key = p.orderId ?? p.cartId;
    const current = this.rawRecord(systemId, table, event.brandId, key);
    const before = current?.data_json ? JSON.parse(current.data_json) : null;
    let after, op = 'c';
    if (event.type === 'order.placed') {
      if (before) {
        if (before.amountCents !== p.amountCents || (before.cartId ?? null) !== (p.cartId ?? null)) throw new AppError('orderId already exists with different business data.', 409);
        return { ok: true, duplicate: true, event: this.decodeEvent(this.db.prepare('SELECT * FROM cdc_events WHERE sequence=?').get(current.sequence)) };
      }
      after = { ...p, status: 'placed', placedAt: event.occurredAt };
    } else if (event.type === 'cart.abandoned') {
      if (before) {
        if (before.amountCents !== p.amountCents) throw new AppError('cartId already exists with a different value.', 409);
        return { ok: true, duplicate: true, event: this.decodeEvent(this.db.prepare('SELECT * FROM cdc_events WHERE sequence=?').get(current.sequence)) };
      }
      after = { ...p, status: 'abandoned', abandonedAt: event.occurredAt, nudgedAt: null };
    } else {
      const cart = this.findCart(p.cartId, event.brandId);
      if (cart.converted_at) throw new AppError('Converted carts cannot be nudged.', 409);
      if (cart.nudged_at) return { ok: true, duplicate: true, event };
      op = 'u'; after = { ...before, nudgedAt: event.occurredAt };
    }
    return this.ingest({ eventId: event.eventId, occurredAt: event.occurredAt, systemId, table, op, brandId: event.brandId, before: op === 'c' ? null : before, after },
      { ...options, legacy: event, captureMode: options.captureMode ?? (event.source === 'demo-history' ? 'simulated-cdc' : 'normalized-event') });
  }
  sourceRecords({ systemId, table, brandId = 'all' } = {}) {
    channel(systemId, table); if (brandId !== 'all') brand(brandId);
    const rows = this.db.prepare('SELECT * FROM cdc_records WHERE system_id=? AND entity_table=? AND data_json IS NOT NULL ORDER BY sequence DESC').all(systemId, table)
      .filter(r => brandId === 'all' || r.brand_id === brandId);
    return { records: rows.map(r => ({ recordId: r.record_id, brandId: r.brand_id, data: JSON.parse(r.data_json), occurredAt: r.occurred_at })), systemId, table, revision: this.revision() };
  }
  simulatePreview(input) {
    if (!object(input)) throw new AppError('A simulator configuration is required.');
    const { systemId, table, op, brandId } = input;
    channel(systemId, table); brand(brandId);
    if (!['c', 'u', 'd'].includes(op)) throw new AppError('Choose a create, update or delete operation.');
    const key = input.recordId ? id(input.recordId, 'recordId') : op === 'c' ? `${table === 'orders' ? 'ORD' : 'CART'}-${randomUUID().slice(0, 8)}` : id(input.recordId, 'recordId');
    const stored = this.rawRecord(systemId, table, brandId, key);
    const before = stored?.data_json ? JSON.parse(stored.data_json) : null;
    if (op === 'c' && before) throw new AppError('Record already exists. Select update or choose a new ID.', 409);
    if (op !== 'c' && !before) throw new AppError('Select an existing source record.', 404);
    const occurredAt = new Date().toISOString();
    let after = null;
    if (op !== 'd') {
      const data = { ...before, amountCents: input.amountCents ?? before?.amountCents ?? 14900, currency: 'EUR', status: input.status ?? before?.status ?? (table === 'orders' ? 'placed' : 'abandoned') };
      if (table === 'orders') {
        data.orderId = key; data.placedAt = before?.placedAt ?? occurredAt;
        if (input.cartId !== undefined) { if (input.cartId === '') delete data.cartId; else data.cartId = input.cartId; }
      } else {
        data.cartId = key;
        data.abandonedAt = before?.abandonedAt ?? (data.status === 'abandoned' ? occurredAt : null);
        data.nudgedAt = before?.nudgedAt ?? null;
      }
      after = record(table, data, occurredAt);
    }
    const event = validateCDC({ eventId: randomUUID(), occurredAt, systemId, table, op, brandId, before: op === 'c' ? null : before, after });
    return { event: { ...event, source: { systemId, name: SYSTEMS.find(s => s.id === systemId).name, table, captureMode: 'simulated-cdc' } } };
  }
  hubEvents(filters = {}) {
    const { systemId = 'all', table = 'all', op = 'all', brandId = 'all' } = filters;
    if (systemId !== 'all' && !SYSTEMS.some(s => s.id === systemId)) throw new AppError('Unknown source system.');
    if (table !== 'all' && !['orders', 'carts'].includes(table)) throw new AppError('Unknown source table.');
    if (op !== 'all' && !['c', 'u', 'd'].includes(op)) throw new AppError('Unknown CDC operation.');
    if (brandId !== 'all') brand(brandId);
    const limit = Number(filters.limit ?? 50), offset = Number(filters.offset ?? 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new AppError('Use limit 1–100 and a nonnegative integer offset.');
    const conditions = [], values = [];
    for (const [column, value] of [['system_id', systemId], ['entity_table', table], ['op', op], ['brand_id', brandId]]) {
      if (value !== 'all') { conditions.push(`${column}=?`); values.push(value); }
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const total = this.db.prepare('SELECT COUNT(*) AS count FROM cdc_events' + where).get(...values).count;
    const events = this.db.prepare('SELECT * FROM cdc_events' + where + ' ORDER BY sequence DESC LIMIT ? OFFSET ?').all(...values, limit, offset).map(r => this.decodeEvent(r));
    return { events, total, limit, offset, revision: this.revision(), systems: SYSTEMS, brands: BRANDS };
  }
  selectedRecords() {
    const rules = this.getSubscriptions().subscriptions;
    const canonical = new Map();
    const rows = this.db.prepare('SELECT * FROM cdc_records ORDER BY occurred_at,sequence').all();
    for (const row of rows) {
      if (!rules.some(r => r.enabled && r.systemId === row.system_id && r.table === row.entity_table)) continue;
      canonical.set(`${row.entity_table}:${row.brand_id}:${row.record_id}`, row);
    }
    return [...canonical.values()].filter(r => r.data_json).map(r => ({ ...r, data: JSON.parse(r.data_json) }));
  }
  dashboard(brandId = 'all', now = new Date()) {
    if (brandId !== 'all') brand(brandId);
    const selected = this.selectedRecords().filter(r => brandId === 'all' || r.brand_id === brandId);
    const orders = selected.filter(r => r.entity_table === 'orders' && r.data.status === 'placed');
    const carts = selected.filter(r => r.entity_table === 'carts');
    const linkedOrder = c => orders.find(o => o.brand_id === c.brand_id && o.data.cartId === c.record_id);
    const open = carts.filter(c => c.data.status === 'abandoned' && !linkedOrder(c));
    const recovered = carts.map(c => ({ cart: c, order: linkedOrder(c) })).filter(r => r.order && r.cart.data.abandonedAt && r.cart.data.abandonedAt <= r.order.data.placedAt);
    const sum = rows => rows.reduce((total, r) => total + r.data.amountCents, 0);
    const monthKey = date => date.toISOString().slice(0, 7);
    const monthly = Array.from({ length: 6 }, (_, index) => {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + index, 1));
      const month = monthKey(date), rows = orders.filter(o => o.data.placedAt.startsWith(month));
      return { month, label: date.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }), grossOrderValueCents: sum(rows), orderCount: rows.length };
    });
    const end = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
    const visible = orders.filter(o => o.data.placedAt >= monthly[0].month && o.data.placedAt < end);
    const rules = this.getSubscriptions().subscriptions;
    const events = this.db.prepare('SELECT * FROM cdc_events ORDER BY sequence DESC').all().filter(e => (brandId === 'all' || e.brand_id === brandId) && rules.some(r => r.enabled && r.systemId === e.system_id && r.table === e.entity_table));
    return { demo: true, currency: 'EUR', timezone: 'UTC', asOf: now.toISOString(), brands: BRANDS, systems: SYSTEMS, subscriptions: rules, revision: this.revision(),
      summary: { grossOrderValueCents: sum(visible), currentMonthValueCents: monthly.at(-1).grossOrderValueCents,
        previousMonthValueCents: monthly.at(-2).grossOrderValueCents, currentMonthOrders: monthly.at(-1).orderCount,
        openCartValueCents: sum(open), openCartCount: open.length, nudgedCartCount: open.filter(c => c.data.nudgedAt).length,
        recoveredValueCents: recovered.reduce((total, r) => total + r.order.data.amountCents, 0), recoveredCartCount: recovered.length, totalEvents: events.length },
      monthly,
      brandPerformance: BRANDS.filter(b => brandId === 'all' || b.id === brandId).map(b => ({ ...b, grossOrderValueCents: sum(visible.filter(o => o.brand_id === b.id)), orderCount: visible.filter(o => o.brand_id === b.id).length,
        openCartValueCents: sum(open.filter(c => c.brand_id === b.id)), openCartCount: open.filter(c => c.brand_id === b.id).length })),
      carts: open.sort((a, b) => b.data.amountCents - a.data.amountCents).map(c => ({ cartId: c.record_id, brandId: c.brand_id, brandName: BRANDS.find(b => b.id === c.brand_id).name,
        systemId: c.system_id, amountCents: c.data.amountCents, currency: 'EUR', abandonedAt: c.data.abandonedAt, nudgedAt: c.data.nudgedAt, status: c.data.nudgedAt ? 'nudged' : 'open' })),
      recentEvents: events.slice(0, 24).map(r => this.decodeEvent(r)),
      hub: { subscriberCount: this.hub.listenerCount('commerce.event'), latestEventId: events[0]?.event_id ?? null, totalEvents: this.db.prepare('SELECT COUNT(*) AS n FROM cdc_events').get().n },
    };
  }
  findCart(cartId, brandId) {
    const rows = this.sourceRecords({ systemId: 'ecommerce', table: 'carts', brandId: brandId ?? 'all' }).records.filter(r => r.recordId === cartId);
    if (!rows.length) throw new AppError('Cart not found.', 404);
    if (rows.length > 1) throw new AppError('Specify brandId for this cart.', 409);
    const cart = rows[0];
    const order = this.db.prepare("SELECT * FROM cdc_records WHERE entity_table='orders' AND data_json IS NOT NULL").all()
      .map(r => ({ ...r, data: JSON.parse(r.data_json) })).find(o => o.brand_id === cart.brandId && o.data.cartId === cartId && o.data.status === 'placed');
    return { brand_id: cart.brandId, cart_id: cartId, amount_cents: cart.data.amountCents, abandoned_at: cart.data.abandonedAt, nudged_at: cart.data.nudgedAt,
      converted_at: cart.data.status === 'converted' ? cart.occurredAt : order?.data.placedAt ?? null, order_id: order?.data.orderId ?? null };
  }
  simulate(action, input = {}) {
    const brandId = input.brandId ?? BRANDS[0].id;
    const common = { eventId: randomUUID(), occurredAt: new Date().toISOString(), brandId, source: 'demo-simulator' };
    if (action === 'order') return this.ingest({ ...common, type: 'order.placed', payload: { orderId: `ORD-${randomUUID().slice(0, 8)}`, amountCents: input.amountCents ?? 24900, currency: 'EUR' } });
    if (action === 'abandon') return this.ingest({ ...common, type: 'cart.abandoned', payload: { cartId: `CART-${randomUUID().slice(0, 8)}`, amountCents: input.amountCents ?? 17900, currency: 'EUR' } });
    if (action === 'nudge' || action === 'recover') {
      id(input.cartId, 'cartId'); const cart = this.findCart(input.cartId, input.brandId);
      if (cart.converted_at) throw new AppError('This cart has already checked out.', 409);
      if (action === 'nudge') return this.ingest({ ...common, brandId: cart.brand_id, type: 'cart.nudge_requested', payload: { cartId: cart.cart_id } });
      return this.ingest({ ...common, brandId: cart.brand_id, type: 'order.placed', payload: { orderId: `ORD-${randomUUID().slice(0, 8)}`, cartId: cart.cart_id, amountCents: cart.amount_cents, currency: 'EUR' } });
    }
    throw new AppError('Unknown simulator action.', 404);
  }
  migrateLegacy() {
    if (this.db.prepare("SELECT value FROM metadata WHERE key='cdc_migrated'").get()) return;
    this.transaction(() => {
      if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get()) {
        for (const row of this.db.prepare('SELECT * FROM events ORDER BY sequence').all())
          this.ingestLegacy({ eventId: row.event_id, type: row.type, occurredAt: row.occurred_at, brandId: row.brand_id, source: row.source, payload: JSON.parse(row.payload) }, { notify: false, captureMode: 'legacy-migration' });
      }
      this.db.prepare("INSERT INTO metadata VALUES ('cdc_migrated','true')").run();
    });
  }
  resetDemo() {
    this.transaction(() => {
      this.db.exec('DELETE FROM cdc_events; DELETE FROM cdc_records;');
      const now = new Date();
      for (let m = 5; m >= 0; m--) for (let b = 0; b < BRANDS.length; b++) for (let i = 0; i < 8; i++) {
        const day = Math.min(2 + i * 3, m === 0 ? now.getUTCDate() : 26);
        this.ingest({ eventId: `seed-order-${m}-${b}-${i}`, type: 'order.placed', occurredAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, day, 0)).toISOString(),
          brandId: BRANDS[b].id, source: 'demo-history', payload: { orderId: `DEMO-${m}-${b}-${i}`, amountCents: 65000 + (5 - m) * 12000 + b * 16000 + i * 7300, currency: 'EUR' } }, { notify: false });
      }
      for (let i = 0; i < 7; i++) this.ingest({ eventId: `seed-cart-${i}`, type: 'cart.abandoned', occurredAt: new Date(now.getTime() - (i * 7 + 2) * 3600_000).toISOString(), brandId: BRANDS[i % 3].id, source: 'demo-history',
        payload: { cartId: `CART-DEMO-${1001 + i}`, amountCents: [42900, 18900, 32500, 89500, 24900, 15900, 57900][i], currency: 'EUR' } }, { notify: false });
      this.ingest({ eventId: 'seed-nudge', type: 'cart.nudge_requested', occurredAt: new Date(now.getTime() - 3600_000).toISOString(), brandId: 'northstar', source: 'demo-history', payload: { cartId: 'CART-DEMO-1001' } }, { notify: false });
      this.db.prepare("INSERT OR REPLACE INTO metadata VALUES ('initialized','true')").run();
    });
    this.hub.emit('commerce.event', { type: 'demo.reset' });
  }
  close() { this.hub.removeAllListeners(); this.db.close(); }
}
