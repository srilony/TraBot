import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export const BRANDS = [
  { id: 'northstar', name: 'Northstar', category: 'Home & living', color: '#426d62', initials: 'N' },
  { id: 'atelier', name: 'Atelier', category: 'Apparel', color: '#c67a48', initials: 'A' },
  { id: 'fieldwork', name: 'Fieldwork', category: 'Outdoor', color: '#657aa2', initials: 'F' },
];
const TYPES = new Set(['order.placed', 'cart.abandoned', 'cart.nudge_requested']);
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const requiredId = (value, field) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value))
    throw new AppError(`${field} must contain 1–100 letters, numbers, dots, colons, underscores or hyphens.`);
  return value;
};

export function validateEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('An event object is required.');
  const { eventId, type, occurredAt, brandId, source, payload } = input;
  requiredId(eventId, 'eventId');
  if (!TYPES.has(type)) throw new AppError('Unsupported event type.');
  if (!BRANDS.some(b => b.id === brandId)) throw new AppError('Unknown brandId.');
  if (typeof occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt)))
    throw new AppError('occurredAt must be an ISO timestamp with a timezone.');
  if (Date.parse(occurredAt) > Date.now() + 300_000) throw new AppError('occurredAt cannot be more than five minutes in the future.');
  if (typeof source !== 'string' || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(source)) throw new AppError('A valid source is required.');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AppError('An event payload is required.');
  const cleaned = {};
  if (type === 'order.placed') cleaned.orderId = requiredId(payload.orderId, 'orderId');
  if (type !== 'order.placed' || payload.cartId !== undefined) cleaned.cartId = requiredId(payload.cartId, 'cartId');
  if (type !== 'cart.nudge_requested') {
    if (!Number.isSafeInteger(payload.amountCents) || payload.amountCents <= 0 || payload.amountCents > 100_000_000)
      throw new AppError('amountCents must be a positive integer, at most 100,000,000.');
    if (payload.currency !== 'EUR') throw new AppError('This demo supports EUR only; mixed currencies cannot be aggregated.');
    cleaned.amountCents = payload.amountCents;
    cleaned.currency = 'EUR';
  }
  return { eventId, type, occurredAt: new Date(occurredAt).toISOString(), brandId, source, payload: cleaned };
}

export class CommerceStore {
  constructor(filename = ':memory:', { seed = true } = {}) {
    this.db = new DatabaseSync(filename);
    this.hub = new EventEmitter();
    this.hub.setMaxListeners(0);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL, occurred_at TEXT NOT NULL, brand_id TEXT NOT NULL,
        source TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders (
        brand_id TEXT NOT NULL, order_id TEXT NOT NULL, cart_id TEXT,
        amount_cents INTEGER NOT NULL, occurred_at TEXT NOT NULL,
        PRIMARY KEY (brand_id, order_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_order_per_cart ON orders (brand_id, cart_id) WHERE cart_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS carts (
        brand_id TEXT NOT NULL, cart_id TEXT NOT NULL, amount_cents INTEGER NOT NULL,
        abandoned_at TEXT, nudged_at TEXT, converted_at TEXT, order_id TEXT,
        PRIMARY KEY (brand_id, cart_id)
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    if (seed && !this.db.prepare("SELECT value FROM metadata WHERE key='initialized'").get()) this.resetDemo();
  }

  subscribe(listener) {
    this.hub.on('commerce.event', listener);
    return () => this.hub.off('commerce.event', listener);
  }

  ingest(input, { notify = true } = {}) {
    const event = validateEvent(input);
    const p = event.payload;
    const existing = this.db.prepare('SELECT * FROM events WHERE event_id=?').get(event.eventId);
    if (existing) {
      if (JSON.stringify(this.decodeEvent(existing)) !== JSON.stringify(event))
        throw new AppError('eventId already exists with different content.', 409);
      return { ok: true, duplicate: true, event };
    }
    if (event.type === 'order.placed') {
      const order = this.db.prepare('SELECT * FROM orders WHERE brand_id=? AND order_id=?').get(event.brandId, p.orderId);
      if (order) {
        if (order.amount_cents !== p.amountCents || (order.cart_id ?? null) !== (p.cartId ?? null))
          throw new AppError('orderId already exists with different business data.', 409);
        return { ok: true, duplicate: true, event };
      }
      if (p.cartId && this.db.prepare('SELECT order_id FROM orders WHERE brand_id=? AND cart_id=?').get(event.brandId, p.cartId))
        throw new AppError('This cart has already checked out.', 409);
    }
    if (event.type === 'cart.abandoned') {
      const cart = this.db.prepare('SELECT * FROM carts WHERE brand_id=? AND cart_id=?').get(event.brandId, p.cartId);
      if (cart?.abandoned_at) {
        if (cart.amount_cents !== p.amountCents && !cart.converted_at) throw new AppError('cartId already exists with a different value.', 409);
        return { ok: true, duplicate: true, event };
      }
    }
    if (event.type === 'cart.nudge_requested') {
      const cart = this.findCart(p.cartId, event.brandId);
      if (cart.converted_at) throw new AppError('Converted carts cannot be nudged.', 409);
      if (cart.nudged_at) return { ok: true, duplicate: true, event };
    }
    const ownTransaction = !this.db.isTransaction;
    if (ownTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO events (event_id,type,occurred_at,brand_id,source,payload) VALUES (?,?,?,?,?,?)')
        .run(event.eventId, event.type, event.occurredAt, event.brandId, event.source, JSON.stringify(p));
      if (event.type === 'order.placed') {
        this.db.prepare('INSERT INTO orders (brand_id,order_id,cart_id,amount_cents,occurred_at) VALUES (?,?,?,?,?)')
          .run(event.brandId, p.orderId, p.cartId ?? null, p.amountCents, event.occurredAt);
        if (p.cartId) this.db.prepare(`INSERT INTO carts (brand_id,cart_id,amount_cents,converted_at,order_id) VALUES (?,?,?,?,?)
          ON CONFLICT (brand_id,cart_id) DO UPDATE SET converted_at=excluded.converted_at,order_id=excluded.order_id`)
          .run(event.brandId, p.cartId, p.amountCents, event.occurredAt, p.orderId);
      } else if (event.type === 'cart.abandoned') {
        this.db.prepare(`INSERT INTO carts (brand_id,cart_id,amount_cents,abandoned_at) VALUES (?,?,?,?)
          ON CONFLICT (brand_id,cart_id) DO UPDATE SET abandoned_at=excluded.abandoned_at`)
          .run(event.brandId, p.cartId, p.amountCents, event.occurredAt);
      } else {
        this.db.prepare('UPDATE carts SET nudged_at=? WHERE brand_id=? AND cart_id=?').run(event.occurredAt, event.brandId, p.cartId);
      }
      if (ownTransaction) this.db.exec('COMMIT');
    } catch (error) { if (ownTransaction) this.db.exec('ROLLBACK'); throw error; }
    if (notify) this.hub.emit('commerce.event', event);
    return { ok: true, duplicate: false, event };
  }

  decodeEvent(row) {
    return { eventId: row.event_id, type: row.type, occurredAt: row.occurred_at, brandId: row.brand_id, source: row.source, payload: JSON.parse(row.payload) };
  }

  findCart(cartId, brandId) {
    const carts = brandId ? this.db.prepare('SELECT * FROM carts WHERE cart_id=? AND brand_id=?').all(cartId, brandId)
      : this.db.prepare('SELECT * FROM carts WHERE cart_id=?').all(cartId);
    if (!carts.length) throw new AppError('Cart not found.', 404);
    if (carts.length > 1) throw new AppError('Specify brandId for this cart.', 409);
    return carts[0];
  }

  simulate(action, input = {}) {
    const brandId = input.brandId ?? BRANDS[0].id;
    const common = { eventId: randomUUID(), occurredAt: new Date().toISOString(), brandId, source: 'demo-simulator' };
    if (action === 'order') return this.ingest({ ...common, type: 'order.placed', payload: { orderId: `ORD-${randomUUID().slice(0, 8)}`, amountCents: input.amountCents ?? 24900, currency: 'EUR' } });
    if (action === 'abandon') return this.ingest({ ...common, type: 'cart.abandoned', payload: { cartId: `CART-${randomUUID().slice(0, 8)}`, amountCents: input.amountCents ?? 17900, currency: 'EUR' } });
    if (action === 'nudge' || action === 'recover') {
      requiredId(input.cartId, 'cartId');
      const cart = this.findCart(input.cartId, input.brandId);
      if (cart.converted_at) throw new AppError('This cart has already checked out.', 409);
      if (action === 'nudge') return this.ingest({ ...common, brandId: cart.brand_id, type: 'cart.nudge_requested', payload: { cartId: cart.cart_id } });
      return this.ingest({ ...common, brandId: cart.brand_id, type: 'order.placed', payload: { orderId: `ORD-${randomUUID().slice(0, 8)}`, cartId: cart.cart_id, amountCents: cart.amount_cents, currency: 'EUR' } });
    }
    throw new AppError('Unknown simulator action.', 404);
  }

  dashboard(brandId = 'all', now = new Date()) {
    if (brandId !== 'all' && !BRANDS.some(b => b.id === brandId)) throw new AppError('Unknown brandId.');
    const orders = this.db.prepare('SELECT * FROM orders ORDER BY occurred_at').all().filter(o => brandId === 'all' || o.brand_id === brandId);
    const allCarts = this.db.prepare('SELECT * FROM carts').all().filter(c => brandId === 'all' || c.brand_id === brandId);
    const open = allCarts.filter(c => c.abandoned_at && !c.converted_at);
    const recovered = allCarts.filter(c => c.abandoned_at && c.converted_at && c.abandoned_at <= c.converted_at);
    const sum = (rows, key = 'amount_cents') => rows.reduce((total, r) => total + r[key], 0);
    const monthKey = d => d.toISOString().slice(0, 7);
    const monthly = Array.from({ length: 6 }, (_, i) => {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + i, 1));
      const month = monthKey(date);
      const rows = orders.filter(o => o.occurred_at.startsWith(month));
      return { month, label: date.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }), grossOrderValueCents: sum(rows), orderCount: rows.length };
    });
    const visible = orders.filter(o => o.occurred_at >= monthly[0].month && o.occurred_at < monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))));
    const current = monthly.at(-1), previous = monthly.at(-2);
    const recentEvents = this.db.prepare('SELECT * FROM events ORDER BY sequence DESC').all()
      .filter(e => brandId === 'all' || e.brand_id === brandId).slice(0, 24)
      .map(row => ({ ...this.decodeEvent(row), brandName: BRANDS.find(b => b.id === row.brand_id).name }));
    const totalEvents = brandId === 'all' ? this.db.prepare('SELECT COUNT(*) AS count FROM events').get().count
      : this.db.prepare('SELECT COUNT(*) AS count FROM events WHERE brand_id=?').get(brandId).count;
    return {
      demo: true, currency: 'EUR', timezone: 'UTC', asOf: now.toISOString(), brands: BRANDS,
      revision: this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS revision FROM events').get().revision,
      summary: {
        grossOrderValueCents: sum(visible), currentMonthValueCents: current.grossOrderValueCents,
        previousMonthValueCents: previous.grossOrderValueCents, currentMonthOrders: current.orderCount,
        openCartValueCents: sum(open), openCartCount: open.length, nudgedCartCount: open.filter(c => c.nudged_at).length,
        recoveredValueCents: sum(orders.filter(o => recovered.some(c => c.brand_id === o.brand_id && c.order_id === o.order_id))),
        recoveredCartCount: recovered.length, totalEvents,
      },
      monthly,
      brandPerformance: BRANDS.filter(b => brandId === 'all' || b.id === brandId).map(b => ({ ...b,
        grossOrderValueCents: sum(visible.filter(o => o.brand_id === b.id)), orderCount: visible.filter(o => o.brand_id === b.id).length,
        openCartValueCents: sum(open.filter(c => c.brand_id === b.id)), openCartCount: open.filter(c => c.brand_id === b.id).length,
      })),
      carts: open.sort((a, b) => b.amount_cents - a.amount_cents).map(c => ({ cartId: c.cart_id, brandId: c.brand_id,
        brandName: BRANDS.find(b => b.id === c.brand_id).name, amountCents: c.amount_cents, currency: 'EUR', abandonedAt: c.abandoned_at,
        nudgedAt: c.nudged_at, status: c.nudged_at ? 'nudged' : 'open',
      })),
      recentEvents, hub: { subscriberCount: this.hub.listenerCount('commerce.event'), latestEventId: recentEvents[0]?.eventId ?? null },
    };
  }

  resetDemo() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM events; DELETE FROM orders; DELETE FROM carts;');
      const now = new Date();
      for (let m = 5; m >= 0; m--) {
        for (let b = 0; b < BRANDS.length; b++) {
          for (let i = 0; i < 8; i++) {
            const day = Math.min(2 + i * 3, m === 0 ? now.getUTCDate() : 26);
            const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, day, 0));
            this.ingest({ eventId: `seed-order-${m}-${b}-${i}`, type: 'order.placed', occurredAt: date.toISOString(),
              brandId: BRANDS[b].id, source: 'demo-history', payload: { orderId: `DEMO-${m}-${b}-${i}`, amountCents: 65000 + (5 - m) * 12000 + b * 16000 + i * 7300, currency: 'EUR' } }, { notify: false });
          }
        }
      }
      for (let i = 0; i < 7; i++) {
        const occurredAt = new Date(now.getTime() - (i * 7 + 2) * 3600_000).toISOString();
        this.ingest({ eventId: `seed-cart-${i}`, type: 'cart.abandoned', occurredAt, brandId: BRANDS[i % 3].id, source: 'demo-history',
          payload: { cartId: `CART-DEMO-${1001 + i}`, amountCents: [42900, 18900, 32500, 89500, 24900, 15900, 57900][i], currency: 'EUR' } }, { notify: false });
      }
      this.ingest({ eventId: 'seed-nudge', type: 'cart.nudge_requested', occurredAt: new Date(now.getTime() - 3600_000).toISOString(),
        brandId: 'northstar', source: 'demo-history', payload: { cartId: 'CART-DEMO-1001' } }, { notify: false });
      this.db.prepare("INSERT OR REPLACE INTO metadata (key,value) VALUES ('initialized','true')").run();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.hub.emit('commerce.event', { type: 'demo.reset' });
  }

  close() { this.hub.removeAllListeners(); this.db.close(); }
}
