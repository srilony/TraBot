/* Source changes flow through the event hub. The commerce view is a subscriber. */
const $ = id => document.getElementById(id);
const view = location.pathname.replace(/\/$/, '') === '/event-hub' ? 'hub' : location.pathname.replace(/\/$/, '') === '/simulator' ? 'simulator' : 'commerce';
const state = { catalog: null, data: null, hub: null, stream: null, epoch: 0, brandId: 'all', offset: 0, limit: 25, preview: null, records: [], recordsEpoch: 0, dirty: false, busy: false, toastTimer: null, rules: [] };
const money = (cents, digits = 2) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: digits, minimumFractionDigits: digits }).format((Number(cents) || 0) / 100);
const count = value => new Intl.NumberFormat('en-IE').format(Number(value) || 0);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeColor = color => /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#426d62';
const opName = op => ({ c: 'Create', u: 'Update', d: 'Delete' }[op] || op);
const systemName = id => state.catalog?.systems.find(s => s.id === id)?.name || id;
const brandName = id => state.catalog?.brands.find(b => b.id === id)?.name || id;
const tableName = table => table === 'orders' ? 'Orders' : table === 'carts' ? 'Carts' : table;
const ruleKey = rule => `${rule.systemId}.${rule.table}`;
const timestamp = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 23)}` : '—';
};
const recordId = event => event.after?.orderId || event.after?.cartId || event.before?.orderId || event.before?.cartId || event.payload?.orderId || event.payload?.cartId || '—';
function notify(message, error = false) {
  clearTimeout(state.toastTimer); $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 8000 : 4500);
}
function showError(message) { $('errorBanner').textContent = message; $('errorBanner').hidden = false; }
function setConnection(connected) {
  ['streamDot', 'sidebarStatusDot'].forEach(id => { $(id).classList.toggle('connected', connected); $(id).classList.toggle('disconnected', !connected); });
  $('streamStatus').textContent = connected ? 'Event hub connected' : 'Reconnecting to event hub…';
  $('sidebarStatus').textContent = connected ? 'Live event stream' : 'Reconnecting to hub';
}
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  let data; try { data = await response.json(); } catch { throw new Error('The server returned an unreadable response.'); }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function updated(value = new Date().toISOString()) { $('lastUpdated').textContent = `Updated ${timestamp(value)} UTC`; }
async function perform(button, action) {
  if (state.busy) return;
  state.busy = true; button.disabled = true; button.setAttribute('aria-busy', 'true');
  try { await action(); } catch (error) { notify(error.message, true); }
  finally { state.busy = false; button.disabled = false; button.removeAttribute('aria-busy'); syncSimulatorButtons(); }
}
function applyColors() {
  document.querySelectorAll('[data-avatar-color]').forEach(e => { e.style.color = e.dataset.avatarColor; e.style.backgroundColor = `${e.dataset.avatarColor}14`; });
  document.querySelectorAll('[data-bar-color]').forEach(e => { e.style.backgroundColor = e.dataset.barColor; if (e.dataset.fill !== undefined) e.style.width = `${e.dataset.fill}%`; });
}
function brandAvatar(brand, small = false) {
  return `<span class="brand-avatar${small ? ' small' : ''}" data-avatar-color="${safeColor(brand?.color)}">${escape(brand?.initials || '?')}</span>`;
}
function relativeTime(value) {
  const seconds = Math.max(0, Math.floor((new Date(state.data?.asOf || Date.now()) - new Date(value)) / 1000));
  if (!Number.isFinite(seconds)) return 'Unknown time';
  return seconds < 60 ? 'Just now' : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
}
function renderChart(monthly) {
  const width = Math.max(300, $('revenueChart').clientWidth || 600), height = 220, left = 49, right = 25, top = 21, bottom = 35;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const max = Math.max(...monthly.map((m) => m.grossOrderValueCents), 10000) * 1.15;
  const points = monthly.map((month, index) => ({ x: left + (monthly.length <= 1 ? plotWidth / 2 : index * plotWidth / (monthly.length - 1)), y: top + plotHeight * (1 - month.grossOrderValueCents / max), ...month }));
  const axisMoney = (value) => value >= 100000 ? `€${(value / 100000).toFixed(value >= 1000000 ? 0 : 1).replace(/\.0$/, '')}k` : money(value, 0);
  const grid = [0, 1, 2, 3, 4].map((tick) => {
    const y = top + plotHeight * tick / 4;
    return `<line class="chart-grid-line" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text class="chart-axis" text-anchor="end" x="${left - 11}" y="${y + 3}">${axisMoney(max * (1 - tick / 4))}</text>`;
  }).join('');
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
  const area = points.length ? `${line} L${points.at(-1).x},${top + plotHeight} L${points[0].x},${top + plotHeight} Z` : '';
  $('revenueChart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chartTitle chartDescription"><title id="chartTitle">Monthly gross order value</title><desc id="chartDescription">${escape(monthly.map((month) => `${month.label}: ${money(month.grossOrderValueCents, 2)} from ${count(month.orderCount)} orders`).join('. '))}. Values are booked sales, not collected cash.</desc><defs><linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#739a7c" stop-opacity=".18"/><stop offset="100%" stop-color="#739a7c" stop-opacity=".015"/></linearGradient></defs>${grid}<path d="${area}" fill="url(#revenueFill)"/><path class="chart-line" d="${line}"/>${points.map((point) => `<circle class="chart-point" cx="${point.x}" cy="${point.y}" r="3.5"><title>${escape(point.label)}: ${money(point.grossOrderValueCents, 2)} · ${count(point.orderCount)} orders</title></circle><text class="chart-axis" text-anchor="middle" x="${point.x}" y="${height - 10}">${escape(point.label)}</text>`).join('')}</svg>`;
  $('monthlyTable').innerHTML = monthly.map((month) => `<tr><th scope="row">${escape(month.month)}</th><td>${count(month.orderCount)}</td><td>${money(month.grossOrderValueCents, 2)}</td></tr>`).join('');
}

function renderSubscriptions(rules) {
  state.rules = rules;
  const enabled = rules.filter(r => r.enabled);
  $('subscriptionCount').textContent = `${enabled.length} of ${rules.length} channels subscribed`;
  $('activeSubscriptions').innerHTML = enabled.length ? enabled.map(r => `<span class="subscription-chip">${escape(systemName(r.systemId))} <i aria-hidden="true">/</i> ${escape(tableName(r.table))}</span>`).join('') : '<span class="no-subscriptions">No subscriptions enabled. Commerce metrics are empty.</span>';
  if (!state.dirty) {
    $('subscriptionChoices').innerHTML = rules.map(r => `<label class="subscription-choice"><input type="checkbox" name="channel" value="${escape(ruleKey(r))}" ${r.enabled ? 'checked' : ''}><span><strong>${escape(systemName(r.systemId))}</strong><span>${escape(tableName(r.table))}</span></span><span class="channel-code">${escape(ruleKey(r))}</span></label>`).join('');
    $('saveSubscriptions').disabled = true;
    $('subscriptionNote').textContent = 'Saved choices are active. The event hub continues to receive every source.';
  }
}
function renderCommerce(data) {
  if (Number.isFinite(state.data?.revision) && data.revision < state.data.revision) return;
  state.data = data; const summary = data.summary; const brands = new Map(data.brands.map(b => [b.id, b]));
  $('metrics').setAttribute('aria-busy', 'false');
  $('monthRevenue').textContent = money(summary.currentMonthValueCents);
  $('revenueDetail').textContent = `${count(summary.currentMonthOrders)} active orders this month`;
  $('cartValue').textContent = money(summary.openCartValueCents);
  $('cartDetail').textContent = `${count(summary.openCartCount)} open carts · ${count(summary.nudgedCartCount)} nudges recorded`;
  $('recoveredValue').textContent = money(summary.recoveredValueCents);
  $('recoveredDetail').textContent = `${count(summary.recoveredCartCount)} linked cart checkouts`;
  $('totalEvents').textContent = count(summary.totalEvents);
  $('hubDetail').textContent = 'From your selected source channels';
  $('sixMonthRevenue').textContent = money(summary.grossOrderValueCents);
  $('opportunityTotal').textContent = money(summary.openCartValueCents);
  $('opportunitySubtitle').textContent = `${count(summary.openCartCount)} unconverted carts awaiting action`;
  $('brandsCount').textContent = `${data.brandPerformance.length} brand${data.brandPerformance.length === 1 ? '' : 's'}`;
  renderChart(data.monthly);
  const max = Math.max(...data.brandPerformance.map(b => b.openCartValueCents), 1);
  $('opportunityBars').innerHTML = data.brandPerformance.map(b => `<div><div class="bar-heading"><span class="bar-brand"><i class="brand-dot" data-bar-color="${safeColor(b.color)}"></i>${escape(b.name)}</span><span class="bar-amount">${money(b.openCartValueCents)}</span></div><div class="bar-track" role="img" aria-label="${escape(b.name)}: ${money(b.openCartValueCents)} opportunity"><div class="bar-fill" data-bar-color="${safeColor(b.color)}" data-fill="${b.openCartValueCents / max * 100}"></div></div></div>`).join('');
  $('brandTable').innerHTML = data.brandPerformance.map(b => `<tr><th scope="row"><span class="brand-cell">${brandAvatar(b)}<span><strong>${escape(b.name)}</strong><span class="category">${escape(b.category)}</span></span></span></th><td>${money(b.grossOrderValueCents)}</td><td>${count(b.orderCount)}</td><td>${money(b.openCartValueCents)} <span class="column-note">${count(b.openCartCount)} carts</span></td></tr>`).join('');
  $('cartsCount').textContent = count(summary.openCartCount);
  $('cartList').innerHTML = data.carts.length ? data.carts.map(c => `<article class="cart-item subscribed-cart"><div class="cart-main">${brandAvatar(brands.get(c.brandId), true)}<div><div class="cart-title">${escape(c.brandName || brandName(c.brandId))}${c.nudgedAt ? '<span class="nudge-tag">Nudge recorded</span>' : ''}</div><div class="cart-meta">${escape(c.cartId)} · Abandoned ${escape(relativeTime(c.abandonedAt))}</div></div></div><div class="cart-amount">${money(c.amountCents)}</div></article>`).join('') : '<p class="empty-state">No subscribed open carts.<br>Check subscriptions or publish an abandoned cart in the simulator.</p>';
  $('eventList').innerHTML = data.recentEvents.length ? data.recentEvents.map(e => `<article class="event-item"><span class="event-type-icon ${e.table === 'carts' ? 'cart' : ''}" aria-hidden="true">${e.op === 'd' ? '−' : e.op === 'u' ? '↻' : '+'}</span><div><div class="event-title">${escape(opName(e.op))} ${escape(e.table || e.type)}${e.payload?.amountCents !== undefined ? ` <span class="event-amount">· ${money(e.payload.amountCents)}</span>` : ''}</div><div class="event-description">${escape(e.source?.name || systemName(e.systemId))} · ${escape(brandName(e.brandId))}</div><span class="event-source">${escape(recordId(e))}</span></div><time class="event-timestamp" datetime="${escape(e.occurredAt)}" title="${escape(timestamp(e.occurredAt))} UTC">${escape(relativeTime(e.occurredAt))}</time></article>`).join('') : '<p class="empty-state">No events match your saved subscriptions.</p>';
  renderSubscriptions(data.subscriptions || state.catalog.subscriptions); applyColors(); updated(data.asOf); $('errorBanner').hidden = true;
}
function hubQuery() { return new URLSearchParams({ systemId: $('hubSystem').value, table: $('hubTable').value, op: $('hubOp').value, brandId: $('hubBrand').value, limit: state.limit, offset: state.offset }); }
function renderHub(data) {
  if (Number.isFinite(state.hub?.revision) && data.revision < state.hub.revision) return;
  state.hub = data; $('hubTotal').textContent = count(data.total); $('hubSystemCount').textContent = count(data.systems?.length || state.catalog.systems.length);
  $('hubTotalDescription').textContent = 'Accepted changes matching your filters';
  $('hubRows').innerHTML = data.events.length ? data.events.map(e => `<tr><td><time datetime="${escape(e.receivedAt)}">${escape(timestamp(e.receivedAt))}</time><span class="cell-note">Receipt #${count(e.sequence)}</span></td><td><strong>${escape(e.source?.name || systemName(e.systemId))}</strong><span class="cell-note">${escape(e.table)}</span></td><td><span class="op-badge op-${escape(e.op)}">${escape(opName(e.op))}</span></td><td><code>${escape(recordId(e))}</code><span class="cell-note">${escape(brandName(e.brandId))}</span></td><td><time datetime="${escape(e.occurredAt)}">${escape(timestamp(e.occurredAt))}</time></td><td><button class="inspect-button" data-event-id="${escape(e.eventId)}" aria-label="Inspect CDC event ${escape(e.eventId)}">Before / After →</button></td></tr>`).join('') : '<tr><td colspan="6" class="empty-state">No source changes match these filters.</td></tr>';
  const first = data.total ? data.offset + 1 : 0; const last = Math.min(data.total, data.offset + data.events.length);
  $('hubPageInfo').textContent = `${count(first)}–${count(last)} of ${count(data.total)} accepted changes`;
  $('hubNewer').disabled = state.offset <= 0; $('hubOlder').disabled = state.offset + state.limit >= data.total;
  updated(); $('errorBanner').hidden = true;
}
function connect() {
  state.stream?.close(); const epoch = ++state.epoch; setConnection(false);
  const hubMode = view === 'hub' || view === 'simulator';
  const query = view === 'hub' ? hubQuery() : new URLSearchParams(view === 'commerce' ? { brandId: state.brandId } : { limit: 1, offset: 0 });
  const endpoint = hubMode ? '/api/hub/events?' : '/api/dashboard?';
  api(endpoint + query).then(data => { if (epoch !== state.epoch) return; if (view === 'commerce') renderCommerce(data); else if (view === 'hub') renderHub(data); else updated(); }).catch(error => { if (epoch === state.epoch) showError(error.message); });
  const stream = new EventSource(`${hubMode ? '/api/hub/stream?' : '/api/stream?'}${query}`); state.stream = stream;
  stream.onopen = () => { if (epoch === state.epoch) setConnection(true); };
  stream.onerror = () => { if (epoch === state.epoch) setConnection(false); };
  stream.addEventListener(hubMode ? 'hub-snapshot' : 'snapshot', message => {
    if (epoch !== state.epoch) return;
    try { const data = JSON.parse(message.data); if (view === 'commerce') renderCommerce(data); else if (view === 'hub') renderHub(data); else updated(); setConnection(true); }
    catch { notify('An event update could not be read. Reload to reconnect.', true); }
  });
}
function inspectEvent(event) {
  $('eventDialogTitle').textContent = `${opName(event.op)} ${event.table} · ${recordId(event)}`;
  $('eventMetadata').innerHTML = `<span><strong>Source</strong>${escape(event.source?.name || systemName(event.systemId))} / ${escape(event.table)}</span><span><strong>Brand</strong>${escape(brandName(event.brandId))}</span><span><strong>Received at · UTC</strong>${escape(timestamp(event.receivedAt))}</span><span><strong>Event time · UTC</strong>${escape(timestamp(event.occurredAt))}</span>`;
  $('eventBefore').textContent = JSON.stringify(event.before, null, 2); $('eventAfter').textContent = JSON.stringify(event.after, null, 2); $('eventEnvelope').textContent = JSON.stringify(event, null, 2); $('eventDialog').showModal();
}
function invalidatePreview() {
  state.preview = null; $('publishEvent').disabled = true; $('previewBadge').textContent = 'CDC';
  $('eventPreview').textContent = 'Preview required.\n\nChoose the source and record change, then select “Preview CDC event”.';
  $('previewDescription').textContent = 'Your exact event envelope will appear here.';
  $('publishStatus').textContent = 'No unpublished preview. Changing fields requires a new preview.';
}
function syncSimulatorButtons() {
  if (view !== 'simulator') return;
  $('publishEvent').disabled = !state.preview || state.busy;
  $('previewEvent').disabled = state.busy || ($('simOp').value !== 'c' && !$('simExisting').value);
}
function populateRecord() {
  const selected = state.records.find(r => r.recordId === $('simExisting').value);
  if (selected) {
    $('simAmount').value = (selected.data.amountCents / 100).toFixed(2);
    $('simStatus').value = selected.data.status;
    $('simCartId').value = selected.data.cartId || '';
  }
  syncSimulatorButtons();
}
async function loadSourceRecords() {
  const epoch = ++state.recordsEpoch; $('simExisting').innerHTML = '<option value="">Loading records…</option>'; syncSimulatorButtons();
  try {
    const query = new URLSearchParams({ systemId: $('simSystem').value, table: $('simTable').value, brandId: $('simBrand').value });
    const data = await api('/api/source-records?' + query); if (epoch !== state.recordsEpoch) return;
    state.records = data.records;
    $('simExisting').innerHTML = data.records.length ? data.records.map(r => `<option value="${escape(r.recordId)}">${escape(r.recordId)} · ${money(r.data.amountCents)} · ${escape(r.data.status)}</option>`).join('') : '<option value="">No source records for this selection</option>';
    $('recordHelp').textContent = data.records.length ? 'The current source image becomes the event’s before image.' : 'Create a record in this source and brand before updating or deleting it.';
    populateRecord();
  } catch (error) { if (epoch === state.recordsEpoch) { state.records = []; $('simExisting').innerHTML = '<option value="">Records unavailable</option>'; notify(error.message, true); syncSimulatorButtons(); } }
}
async function configureSimulator({ sourceChanged = false, tableChanged = false } = {}) {
  invalidatePreview();
  if (sourceChanged) {
    const system = state.catalog.systems.find(s => s.id === $('simSystem').value);
    const before = $('simTable').value;
    $('simTable').innerHTML = system.tables.map(t => `<option value="${escape(t)}">${escape(tableName(t))}</option>`).join('');
    if (system.tables.includes(before)) $('simTable').value = before;
    tableChanged = true;
  }
  const order = $('simTable').value === 'orders';
  if (tableChanged) {
    $('simStatus').innerHTML = order ? '<option value="placed">Placed</option><option value="cancelled">Cancelled</option>' : '<option value="abandoned">Abandoned</option><option value="active">Active</option><option value="converted">Converted</option>';
    $('simCartId').value = '';
  }
  const op = $('simOp').value;
  $('existingRecordLabel').hidden = op === 'c'; $('simExisting').required = op !== 'c'; $('simExisting').disabled = op === 'c';
  $('recordIdLabel').hidden = op !== 'c'; $('simRecordId').disabled = op !== 'c';
  $('recordFields').disabled = op === 'd'; $('deleteNotice').hidden = op !== 'd'; $('linkedCartLabel').hidden = !order;
  $('previewEvent').textContent = op === 'd' ? 'Preview delete event →' : 'Preview CDC event →';
  if (op !== 'c') await loadSourceRecords(); else { ++state.recordsEpoch; syncSimulatorButtons(); }
}
function simulatorInput() {
  const input = { systemId: $('simSystem').value, table: $('simTable').value, op: $('simOp').value, brandId: $('simBrand').value };
  const id = (input.op === 'c' ? $('simRecordId').value : $('simExisting').value).trim(); if (id) input.recordId = id;
  if (input.op !== 'd') {
    input.amountCents = Math.round(Number($('simAmount').value) * 100); input.status = $('simStatus').value;
    if (input.table === 'orders') input.cartId = $('simCartId').value.trim();
  }
  return input;
}
async function initialize() {
  const titles = { commerce: ['Commerce hub', 'THE BIG PICTURE', 'Your portfolio, in focus.', 'Commerce outcomes, powered by the sources you subscribe to.'], hub: ['Event hub', 'THE SHARED EVENT JOURNAL', 'Every source. Every change.', 'Inspect the events your systems of record send, before commerce subscribes.'], simulator: ['Event simulator', 'MAKE THE SIGNAL REAL', 'Bring a source change to life.', 'Choose a system of record, preview its CDC message, and publish to the hub.'] };
  const [label, eyebrow, title, description] = titles[view]; document.title = `${label} · Commerce Operations Hub`;
  $('breadcrumb').textContent = label; $('pageEyebrow').textContent = eyebrow; $('page-title').textContent = title; $('pageDescription').textContent = description;
  document.querySelectorAll('[data-view]').forEach(el => { el.hidden = el.dataset.view !== view; });
  document.querySelectorAll('[data-nav]').forEach(el => { el.classList.toggle('active', el.dataset.nav === view); if (el.dataset.nav === view) el.setAttribute('aria-current', 'page'); });
  document.querySelectorAll('.commerce-only').forEach(el => { el.hidden = view !== 'commerce'; }); document.querySelectorAll('.simulator-only').forEach(el => { el.hidden = view !== 'simulator'; });
  try {
    state.catalog = await api('/api/catalog');
    const brands = state.catalog.brands.map(b => `<option value="${escape(b.id)}">${escape(b.name)}</option>`).join('');
    const systems = state.catalog.systems.map(s => `<option value="${escape(s.id)}">${escape(s.name)}</option>`).join('');
    $('brandFilter').innerHTML = '<option value="all">All brands</option>' + brands; $('hubBrand').innerHTML = '<option value="all">All brands</option>' + brands; $('simBrand').innerHTML = brands;
    $('hubSystem').innerHTML = '<option value="all">All systems</option>' + systems; $('simSystem').innerHTML = systems;
    if (view === 'commerce') renderSubscriptions(state.catalog.subscriptions);
    if (view === 'simulator') await configureSimulator({ sourceChanged: true });
    connect();
  } catch (error) { showError(`The workspace could not load: ${error.message} Reload after the server is available.`); setConnection(false); }
}
$('brandFilter').addEventListener('change', () => { state.brandId = $('brandFilter').value; connect(); });
$('subscriptionChoices').addEventListener('change', () => { state.dirty = true; $('saveSubscriptions').disabled = false; $('subscriptionNote').textContent = 'You have unsaved subscription choices. Save to update the commerce view.'; });
$('subscriptionsForm').addEventListener('submit', event => {
  event.preventDefault(); perform($('saveSubscriptions'), async () => {
    const selected = new Set([...$('subscriptionChoices').querySelectorAll('input:checked')].map(input => input.value));
    const subscriptions = state.rules.map(rule => ({ systemId: rule.systemId, table: rule.table, enabled: selected.has(ruleKey(rule)) }));
    const result = await api('/api/subscriptions', { method: 'PUT', body: { subscriptions } }); state.dirty = false; renderSubscriptions(result.subscriptions || subscriptions);
    renderCommerce(await api('/api/dashboard?brandId=' + encodeURIComponent(state.brandId))); notify('Subscriptions saved. Commerce rebuilt from retained hub history.');
  }).then(() => { if (!state.dirty) $('saveSubscriptions').disabled = true; });
});
$('hubFilters').addEventListener('change', () => { state.offset = 0; connect(); }); $('hubFilters').addEventListener('submit', e => e.preventDefault());
$('clearHubFilters').addEventListener('click', () => { ['hubSystem', 'hubTable', 'hubOp', 'hubBrand'].forEach(id => { $(id).value = 'all'; }); state.offset = 0; connect(); });
$('hubOlder').addEventListener('click', () => { state.offset += state.limit; connect(); }); $('hubNewer').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); connect(); });
$('hubRows').addEventListener('click', event => { const button = event.target.closest('[data-event-id]'); if (button) { const record = state.hub.events.find(e => e.eventId === button.dataset.eventId); if (record) inspectEvent(record); } });
$('closeEventDialog').addEventListener('click', () => $('eventDialog').close());
$('simSystem').addEventListener('change', () => configureSimulator({ sourceChanged: true })); $('simTable').addEventListener('change', () => configureSimulator({ tableChanged: true }));
$('simOp').addEventListener('change', () => configureSimulator()); $('simBrand').addEventListener('change', () => configureSimulator());
$('simExisting').addEventListener('change', () => { invalidatePreview(); populateRecord(); });
['simRecordId', 'simAmount', 'simStatus', 'simCartId'].forEach(id => $(id).addEventListener('input', invalidatePreview));
$('simulatorForm').addEventListener('submit', event => {
  event.preventDefault(); if (!$('simulatorForm').reportValidity()) return;
  perform($('previewEvent'), async () => {
    const result = await api('/api/simulator/preview', { method: 'POST', body: simulatorInput() }); state.preview = result.event;
    $('eventPreview').textContent = JSON.stringify(result.event, null, 2); $('previewBadge').textContent = opName(result.event.op); $('previewBadge').className = `op-badge op-${result.event.op}`;
    $('previewDescription').textContent = 'This exact envelope will be sent to the event hub.'; $('publishStatus').textContent = 'Preview ready. Nothing has been published yet.';
  });
});
$('publishEvent').addEventListener('click', () => {
  if (!state.preview) return;
  perform($('publishEvent'), async () => {
    const result = await api('/api/hub/events', { method: 'POST', body: state.preview });
    $('eventPreview').textContent = JSON.stringify(result.event || state.preview, null, 2); $('publishStatus').textContent = result.duplicate ? 'This event was already received. No duplicate count was added.' : 'Published. The event hub received this change; enabled commerce subscribers are updated.';
    $('previewDescription').textContent = 'Received event envelope'; state.preview = null; notify('CDC event published to the event hub.');
    if ($('simOp').value === 'c') $('simRecordId').value = ''; else await loadSourceRecords();
  });
});
$('resetDemo').addEventListener('click', () => {
  if (!confirm('Reset the demo? This deletes added source changes and restores fictional source history for all windows. Subscription choices are kept.')) return;
  perform($('resetDemo'), async () => { await api('/api/demo/reset', { method: 'POST', body: {} }); invalidatePreview(); if ($('simOp').value !== 'c') await loadSourceRecords(); notify('Demo source history restored. Subscription choices were kept.'); });
});
window.addEventListener('beforeunload', () => state.stream?.close());
let resizeTimer; window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (view === 'commerce' && state.data) renderChart(state.data.monthly); }, 120); });
initialize();
