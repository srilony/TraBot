/* The browser is a subscriber. Portfolio state is always computed by the event hub. */
const $ = (id) => document.getElementById(id);
const state = { data: null, brandId: 'all', stream: null, revision: 0, toastTimer: null, busy: false };
const money = (cents, digits = 2) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: digits, minimumFractionDigits: digits }).format((Number(cents) || 0) / 100);
const count = (value) => new Intl.NumberFormat('en-IE').format(Number(value) || 0);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const safeColor = (color) => /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#426d62';
const eventNames = { 'order.placed': 'Order placed', 'cart.abandoned': 'Cart abandoned', 'cart.nudge_requested': 'Nudge recorded' };

function notify(message, isError = false) {
  clearTimeout(state.toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', isError);
  $('toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, isError ? 8000 : 4500);
}

function setConnection(status) {
  const connected = status === 'connected';
  for (const id of ['streamDot', 'sidebarStatusDot']) {
    $(id).classList.toggle('connected', connected);
    $(id).classList.toggle('disconnected', !connected);
  }
  $('streamStatus').textContent = connected ? 'Event hub connected' : 'Reconnecting to event hub…';
  $('sidebarStatus').textContent = connected ? 'Live event stream' : 'Reconnecting to hub';
}

function relativeTime(value, now = state.data?.asOf || new Date().toISOString()) {
  const seconds = Math.max(0, Math.floor((new Date(now) - new Date(value)) / 1000));
  if (!Number.isFinite(seconds)) return 'Unknown time';
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function brandAvatar(brand, small = false) {
  const color = safeColor(brand?.color);
  return `<span class="brand-avatar${small ? ' small' : ''}" data-avatar-color="${color}">${escape(brand?.initials || brand?.name?.[0] || '?')}</span>`;
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

function render(data) {
  if (Number.isFinite(data.revision) && Number.isFinite(state.data?.revision) && data.revision < state.data.revision) return;
  state.data = data;
  const summary = data.summary;
  const brands = new Map(data.brands.map((brand) => [brand.id, brand]));
  if ($('brandFilter').options.length !== data.brands.length + 1) {
    $('brandFilter').innerHTML = '<option value="all">All brands</option>' + data.brands.map((brand) => `<option value="${escape(brand.id)}">${escape(brand.name)}</option>`).join('');
    $('brandFilter').value = state.brandId;
    $('simBrand').innerHTML = data.brands.map((brand) => `<option value="${escape(brand.id)}">${escape(brand.name)}</option>`).join('');
    if (state.brandId !== 'all') $('simBrand').value = state.brandId;
  }
  $('metrics').setAttribute('aria-busy', 'false');
  $('monthRevenue').textContent = money(summary.currentMonthValueCents);
  $('revenueDetail').textContent = `${count(summary.currentMonthOrders)} orders this month`;
  $('cartValue').textContent = money(summary.openCartValueCents);
  $('cartDetail').textContent = `${count(summary.openCartCount)} open carts · ${count(summary.nudgedCartCount)} nudges recorded`;
  $('recoveredValue').textContent = money(summary.recoveredValueCents);
  $('recoveredDetail').textContent = `${count(summary.recoveredCartCount)} cart${summary.recoveredCartCount === 1 ? '' : 's'} converted to orders`;
  $('totalEvents').textContent = count(summary.totalEvents);
  $('hubDetail').textContent = 'Accepted by the event hub';
  $('navCartCount').textContent = count(summary.openCartCount);
  $('sixMonthRevenue').textContent = money(summary.grossOrderValueCents);
  $('opportunityTotal').textContent = money(summary.openCartValueCents);
  $('opportunitySubtitle').textContent = `${count(summary.openCartCount)} unconverted carts awaiting action`;
  $('brandsCount').textContent = `${data.brandPerformance.length} connected brand${data.brandPerformance.length === 1 ? '' : 's'}`;
  $('lastUpdated').textContent = `Updated ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' }).format(new Date(data.asOf))} UTC`;
  $('dashboardDate').textContent = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(data.asOf)) + ' · EUR';
  renderChart(data.monthly);
  const maxOpportunity = Math.max(...data.brandPerformance.map((brand) => brand.openCartValueCents), 1);
  $('opportunityBars').innerHTML = data.brandPerformance.map((brand) => `<div><div class="bar-heading"><span class="bar-brand"><i class="brand-dot" data-bar-color="${safeColor(brand.color)}"></i>${escape(brand.name)}</span><span class="bar-amount">${money(brand.openCartValueCents)}</span></div><div class="bar-track" role="img" aria-label="${escape(brand.name)}: ${money(brand.openCartValueCents, 2)} open cart value"><div class="bar-fill" data-bar-color="${safeColor(brand.color)}" data-fill="${brand.openCartValueCents / maxOpportunity * 100}"></div></div></div>`).join('');
  $('brandTable').innerHTML = data.brandPerformance.map((brand) => `<tr><th scope="row"><span class="brand-cell">${brandAvatar(brand)}<span><strong>${escape(brand.name)}</strong><span class="category">${escape(brand.category)}</span></span></span></th><td>${money(brand.grossOrderValueCents, 2)}</td><td>${count(brand.orderCount)}</td><td>${money(brand.openCartValueCents, 2)} <span class="column-note">${count(brand.openCartCount)} carts</span></td><td><span class="connection-tag"><i></i>Demo source</span></td></tr>`).join('');
  $('cartsCount').textContent = count(summary.openCartCount);
  $('cartList').innerHTML = data.carts.length ? data.carts.map((cart) => {
    const brand = brands.get(cart.brandId);
    const nudged = !!cart.nudgedAt || cart.status === 'nudged';
    return `<article class="cart-item"><div class="cart-main">${brandAvatar(brand, true)}<div><div class="cart-title">${escape(cart.brandName || brand?.name)} <span class="cart-id">#${escape(cart.cartId.slice(-6))}</span>${nudged ? '<span class="nudge-tag">Nudge recorded</span>' : ''}</div><div class="cart-meta">Abandoned ${escape(relativeTime(cart.abandonedAt))}</div></div></div><div class="cart-amount">${money(cart.amountCents, 2)}</div><div class="cart-actions"><button class="cart-action" data-action="nudge" data-cart="${escape(cart.cartId)}" data-brand="${escape(cart.brandId)}" ${nudged ? 'disabled' : ''} aria-label="${nudged ? 'Nudge already recorded for' : 'Record nudge for'} cart ${escape(cart.cartId)}">${nudged ? '✓ Nudge recorded' : 'Record nudge'}</button><button class="cart-action checkout" data-action="recover" data-cart="${escape(cart.cartId)}" data-brand="${escape(cart.brandId)}" aria-label="Simulate checkout for cart ${escape(cart.cartId)}">Simulate checkout <span aria-hidden="true">→</span></button></div></article>`;
  }).join('') : '<p class="empty-state">No open carts right now.<br>Abandon a cart in the simulator to create an opportunity.</p>';
  $('eventList').innerHTML = data.recentEvents.length ? data.recentEvents.map((event) => {
    const kind = event.type === 'cart.abandoned' ? 'cart' : event.type === 'cart.nudge_requested' ? 'nudge' : '';
    const amount = event.payload?.amountCents;
    return `<article class="event-item"><span class="event-type-icon ${kind}" aria-hidden="true">${kind === 'cart' ? '⌁' : kind === 'nudge' ? '→' : '✓'}</span><div><div class="event-title">${escape(eventNames[event.type] || event.type)}${amount !== undefined ? ` <span class="event-amount">· ${money(amount, 2)}</span>` : ''}</div><div class="event-description">${escape(event.brandName || brands.get(event.brandId)?.name)} · <span>${escape(event.type)}</span></div><span class="event-source">${escape(event.source || 'simulator')}</span></div><time class="event-timestamp" datetime="${escape(event.occurredAt)}" title="${escape(event.occurredAt)}">${escape(relativeTime(event.occurredAt))}</time></article>`;
  }).join('') : '<p class="empty-state">Your hub is ready for its first event.</p>';
  $('subscriberCount').textContent = count(data.hub.subscriberCount);
  // Individual style properties remain CSP-compatible; no inline style attributes are injected.
  document.querySelectorAll('[data-avatar-color]').forEach((element) => {
    element.style.color = element.dataset.avatarColor;
    element.style.backgroundColor = `${element.dataset.avatarColor}14`;
  });
  document.querySelectorAll('[data-bar-color]').forEach((element) => {
    element.style.backgroundColor = element.dataset.barColor;
    if (element.dataset.fill !== undefined) element.style.width = `${element.dataset.fill}%`;
  });
  $('errorBanner').hidden = true;
}

async function loadDashboard(revision = state.revision) {
  try {
    const response = await fetch(`/api/dashboard?brandId=${encodeURIComponent(state.brandId)}`);
    if (!response.ok) throw new Error('Portfolio data could not be loaded. Check the server and try again.');
    const data = await response.json();
    if (revision === state.revision) render(data);
  } catch (error) {
    if (revision !== state.revision) return;
    $('errorBanner').textContent = error.message;
    $('errorBanner').hidden = false;
  }
}

function connect() {
  state.stream?.close();
  const revision = ++state.revision;
  setConnection('connecting');
  loadDashboard(revision);
  if (!window.EventSource) {
    $('streamStatus').textContent = 'Live updates unavailable in this browser';
    return;
  }
  const stream = new EventSource(`/api/stream?brandId=${encodeURIComponent(state.brandId)}`);
  state.stream = stream;
  stream.onopen = () => { if (revision === state.revision) setConnection('connected'); };
  stream.onerror = () => { if (revision === state.revision) setConnection('reconnecting'); };
  stream.addEventListener('snapshot', (event) => {
    if (revision !== state.revision) return;
    try { render(JSON.parse(event.data)); setConnection('connected'); }
    catch { notify('The hub sent an unreadable update. Reconnecting…', true); stream.close(); setTimeout(connect, 1500); }
  });
}

async function publish(path, payload) {
  const response = await fetch(`/api/demo/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The event could not be published. Please try again.');
  await loadDashboard();
  return result;
}

async function perform(button, action) {
  if (state.busy) return;
  state.busy = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try { await action(); }
  catch (error) { notify(error.message || 'The request failed. Check your connection and try again.', true); }
  finally { state.busy = false; button.disabled = false; button.removeAttribute('aria-busy'); }
}

$('brandFilter').addEventListener('change', (event) => {
  state.brandId = event.target.value;
  if (state.brandId !== 'all') $('simBrand').value = state.brandId;
  connect();
});

$('simulatorForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const button = event.submitter;
  if (!button || !$('simulatorForm').reportValidity()) return;
  const amountCents = Math.round(Number($('simAmount').value) * 100);
  if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 100000000) return notify('Enter an amount between €0.01 and €1,000,000.', true);
  const scenario = button.value;
  perform(button, async () => {
    await publish(scenario === 'order' ? 'order' : 'abandon', { brandId: $('simBrand').value, amountCents });
    notify(scenario === 'order' ? 'Order event published. Booked sales updated across the hub.' : 'Cart event published. A new opportunity is ready to act on.');
  });
});

$('cartList').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-cart]');
  if (!button || button.disabled) return;
  perform(button, async () => {
    await publish(button.dataset.action, { cartId: button.dataset.cart, brandId: button.dataset.brand });
    notify(button.dataset.action === 'nudge' ? 'Nudge recorded in the hub. No message was sent.' : 'Checkout simulated. Cart value moved into booked sales.');
  });
});

$('resetDemo').addEventListener('click', (event) => {
  if (!confirm('Reset the demo? This removes events and actions you added and restores the illustrative starting data for every connected dashboard.')) return;
  perform(event.currentTarget, async () => { await publish('reset', {}); notify('Demo restored. Your portfolio is ready for a new story.'); });
});

document.querySelectorAll('.navigation a').forEach((link) => link.addEventListener('click', () => {
  document.querySelectorAll('.navigation a').forEach((item) => item.classList.toggle('active', item === link));
}));

window.addEventListener('beforeunload', () => state.stream?.close());
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.data) renderChart(state.data.monthly); }, 120);
});
connect();
