import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const messages = readFileSync(new URL('../public/messages.js', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');
function setup(saved, blocked = false) {
  const storage = new Map(saved ? [['commerce.locale', saved]] : []);
  const document = { documentElement: {}, addEventListener() {}, dispatchEvent() {}, getElementById() { return null; } };
  const window = { confirm: value => value };
  const context = { window, document, Intl, Date, CustomEvent: class {}, localStorage: { getItem(key) { if (blocked) throw Error(); return storage.get(key); }, setItem(key, value) { if (blocked) throw Error(); storage.set(key, value); } } };
  runInNewContext(messages, context); runInNewContext(script, context);
  return { i18n: window.I18n, document, storage, window };
}
test('Dutch is the default even with unavailable storage or unsupported saved locales', () => {
  for (const args of [[], ['fr-FR'], [null, true]]) {
    const { i18n, document } = setup(...args);
    assert.equal(i18n.locale, 'nl-NL'); assert.equal(document.documentElement.lang, 'nl-NL');
    assert.equal(i18n.text('Save workflow'), 'Workflow opslaan');
  }
});
test('language choice persists and UK English restores source messages', () => {
  const { i18n, storage, document } = setup('en-GB');
  assert.equal(i18n.text('Save workflow'), 'Save workflow');
  i18n.setLocale('nl-NL'); assert.equal(storage.get('commerce.locale'), 'nl-NL');
  assert.equal(document.documentElement.lang, 'nl-NL');
  i18n.setLocale('invalid'); assert.equal(i18n.locale, 'nl-NL');
});
test('currency, grouping, decimals and UTC dates follow the selected locale', () => {
  const { i18n } = setup();
  assert.equal(i18n.number(12345.67), '12.345,67');
  assert.equal(i18n.number(12345.67, { style: 'currency', currency: 'EUR' }), new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(12345.67));
  assert.equal(i18n.date('2026-11-17T23:30:00Z'), new Intl.DateTimeFormat('nl-NL', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }).format(new Date('2026-11-17T23:30:00Z')));
  i18n.setLocale('en-GB'); assert.equal(i18n.number(12345.67), '12,345.67');
  assert.equal(i18n.date('invalid'), '—'); assert.equal(i18n.date(null), '—');
});
test('dynamic UI messages translate without changing identifiers or raw unknown values', () => {
  const { i18n, window } = setup();
  assert.equal(i18n.text('2 of 3 channels subscribed'), '2 van 3 kanalen geabonneerd');
  assert.equal(i18n.text('CART-123 · Abandoned 23h ago'), 'CART-123 · Verlaten 23 uur geleden');
  assert.equal(i18n.text('Create carts'), 'Winkelwagens aangemaakt');
  assert.equal(i18n.text('ERP · Order created'), 'ERP · Order aangemaakt');
  assert.equal(i18n.text('5 blocks · 4 connections'), '5 blokken · 4 verbindingen');
  assert.equal(i18n.text('event.after.amountCents'), 'event.after.amountCents');
  assert.equal(window.confirm('Discard unsaved workflow changes?'), 'Niet-opgeslagen workflowwijzigingen weggooien?');
});
