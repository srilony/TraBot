/* Shared presentation localisation. Raw records, JSON, identifiers and user inputs stay intact. */
(() => {
  const supported = ['nl-NL', 'en-GB'];
  let locale = 'nl-NL';
  try { const saved = localStorage.getItem('commerce.locale'); if (supported.includes(saved)) locale = saved; } catch {}
  const dictionary = window.DUTCH_MESSAGES;
  const sources = new WeakMap();
  const attrs = new WeakMap();
  const patterns = [
    [/^(.+) of (.+) channels subscribed$/, '$1 van $2 kanalen geabonneerd'],
    [/^(.+) active orders this month$/, '$1 actieve orders deze maand'],
    [/^(.+) open carts · (.+) nudges recorded$/, '$1 open winkelwagens · $2 herinneringen vastgelegd'],
    [/^(.+) linked cart checkouts$/, '$1 gekoppelde winkelwagenaankopen'],
    [/^(.+) unconverted carts awaiting action$/, '$1 niet-afgeronde winkelwagens die op actie wachten'],
    [/^(.+) brands?$/, (_, value) => value + (value === '1' ? ' merk' : ' merken')], [/^(.+) carts$/, '$1 winkelwagens'],
    [/^(.+)–(.+) of (.+) accepted changes$/, '$1–$2 van $3 geaccepteerde wijzigingen'],
    [/^Receipt #(.+)$/, 'Ontvangst #$1'], [/^Updated (.+) UTC$/, 'Bijgewerkt $1 UTC'],
    [/^(.+) blocks · (.+) connections$/, '$1 blokken · $2 verbindingen'],
    [/^Block ID: (.+)$/, 'Blok-ID: $1'], [/^Add (.+) block$/, 'Blok $1 toevoegen'],
    [/^Inspect CDC event (.+)$/, 'CDC-event $1 bekijken'],
    [/^Next scheduled run: (.+)\. Server must be running\.$/, 'Volgende geplande uitvoering: $1. De server moet actief zijn.'],
    [/^Your browser’s timezone: (.+)\. Saved as an absolute UTC timestamp\.$/, 'Tijdzone van je browser: $1. Opgeslagen als absoluut UTC-tijdstip.'],
    [/^(\d+)m ago$/, '$1 min. geleden'], [/^(\d+)h ago$/, '$1 uur geleden'], [/^(\d+)d ago$/, '$1 dagen geleden'],
    [/^Abandoned (.+)$/, (_, value) => 'Verlaten ' + text(value)], [/^Remove selected field (.+)$/, 'Geselecteerd veld $1 verwijderen'],
    [/^(.+) opportunity$/, '$1 potentiële waarde'],
    [/^(\d+) event types?$/, '$1 eventtypen'], [/^(\d+) selected values$/, '$1 geselecteerde waarden'],
    [/^Every (.+) (seconds|minutes|hours|days)$/, (_, count, unit) => 'Elke ' + count + ' ' + text(unit)],
    [/^Connect input of (.+)$/, 'Invoer van $1 verbinden'],
    [/^Connect (true |false )?output of (.+)$/, (_, branch, id) => 'Uitvoer ' + (branch ? text(branch.trim()) + ' ' : '') + 'van ' + id + ' verbinden'],
    [/^(.+) block (.+)$/, (_, type, id) => text(type) + ' blok ' + id],
    [/^Connection from (.+) (.+) to (.+)\. Select then press Delete to remove\.$/, 'Verbinding van $1 $2 naar $3. Selecteer en druk op Delete om te verwijderen.'],
    [/^Focus a URL or email field first, or type (.+) in the field\.$/, 'Selecteer eerst een URL- of e-mailveld of typ $1 in het veld.'],
    [/^Invalid variable path: (.+)$/, 'Ongeldig variabelepad: $1'],
    [/^Variable is unavailable: (.+)$/, 'Variabele niet beschikbaar: $1'],
    [/^Invalid workflow(?: graph)?: (.+)$/, (_, message) => 'Ongeldige workflow: ' + text(message)],
    [/^(.+) must contain 1–100 letters, numbers, dots, colons, underscores or hyphens\.$/, '$1 moet 1–100 letters, cijfers, punten, dubbele punten, underscores of koppeltekens bevatten.'],
    [/^(.+) must be an ISO timestamp with a timezone\.$/, '$1 moet een ISO-tijdstip met een tijdzone zijn.'],
    [/^(.+) cannot be more than five minutes in the future\.$/, '$1 mag niet meer dan vijf minuten in de toekomst liggen.'],
    [/^Request failed \((.+)\)\.$/, 'Verzoek mislukt ($1).'],
    [/^Event choices could not load: (.+)$/, 'Eventkeuzes konden niet worden geladen: $1'],
    [/^Workflow automation could not load: (.+)$/, 'Workflowautomatisering kon niet worden geladen: $1'],
    [/^The workspace could not load: (.+) Reload after the server is available\.$/, 'De werkruimte kon niet worden geladen: $1 Vernieuw zodra de server beschikbaar is.'],
  ];
  function text(value) {
    const original = String(value ?? '');
    if (locale === 'en-GB') return original;
    const trimmed = original.trim();
    let translated = dictionary[trimmed];
    if (translated === undefined) {
      for (const [pattern, replacement] of patterns) {
        if (pattern.test(trimmed)) { translated = trimmed.replace(pattern, replacement); break; }
      }
    }
    // Separators join independently translated UI labels, never record identifiers.
    if (translated === undefined && trimmed.includes(': ')) { const index = trimmed.indexOf(': '); const suffix = trimmed.slice(index + 2); if (dictionary[suffix] !== undefined) translated = trimmed.slice(0, index + 2) + text(suffix); }
    if (translated === undefined && trimmed.includes(' · ')) translated = trimmed.split(' · ').map(text).join(' · ');
    return translated === undefined ? original : original.replace(trimmed, translated);
  }
  function number(value, options = {}) { return new Intl.NumberFormat(locale, options).format(Number(value) || 0); }
  function date(value, options = {}) {
    if (value === null || value === undefined || value === '') return '—';
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC', ...options }).format(d) : '—';
  }
  function relative(value, now = Date.now()) {
    const seconds = Math.max(0, Math.floor((new Date(now) - new Date(value)) / 1000));
    if (!Number.isFinite(seconds)) return text('Unknown time');
    if (seconds < 60) return text('Just now');
    const [amount, unit] = seconds < 3600 ? [Math.floor(seconds / 60), 'minute'] : seconds < 86400 ? [Math.floor(seconds / 3600), 'hour'] : [Math.floor(seconds / 86400), 'day'];
    return new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'short' }).format(-amount, unit);
  }
  const excluded = 'script,style,pre:not(#eventPreview),code,textarea,input,[data-no-i18n],#workflowName,#messageTitle,#runDialogTitle';
  function translateNode(node) {
    if (node.nodeType === 3) {
      if (!node.parentElement || node.parentElement.closest(excluded)) return;
      const previous = sources.get(node);
      const source = previous && node.data === previous.rendered ? previous.source : node.data;
      const rendered = node.parentElement.closest('#eventPreview') && dictionary[source.trim()] === undefined ? source : text(source);
      sources.set(node, { source, rendered });
      if (node.data !== rendered) node.data = rendered;
    } else if (node.nodeType === 1) {
      for (const name of ['aria-label', 'placeholder', 'title']) {
        if (!node.hasAttribute(name)) continue;
        let saved = attrs.get(node); if (!saved) { saved = {}; attrs.set(node, saved); }
        const value = node.getAttribute(name), previous = saved[name];
        const source = previous && value === previous.rendered ? previous.source : value;
        const rendered = text(source); saved[name] = { source, rendered };
        if (value !== rendered) node.setAttribute(name, rendered);
      }
      if (node.matches(excluded)) return;
      for (const child of node.childNodes) translateNode(child);
    }
  }
  let observer;
  function translate(root = document.documentElement) {
    observer?.disconnect(); translateNode(root);
    observer?.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'placeholder', 'title'] });
  }
  function setLocale(value, persist = true) {
    if (!supported.includes(value)) return;
    locale = value;
    document.documentElement.lang = locale;
    if (persist) try { localStorage.setItem('commerce.locale', locale); } catch {}
    const picker = document.getElementById('languageSelect'); if (picker) picker.value = locale;
    document.dispatchEvent(new CustomEvent('localechange', { detail: { locale } }));
    translate();
  }
  window.I18n = { get locale() { return locale; }, text, number, date, relative, setLocale, translate };
  document.documentElement.lang = locale;
  // Native prompts are presentation too; never translate the underlying form values.
  const nativeConfirm = window.confirm.bind(window);
  window.confirm = message => nativeConfirm(text(message));
  document.addEventListener('DOMContentLoaded', () => {
    const picker = document.getElementById('languageSelect');
    picker.value = locale; picker.addEventListener('change', () => setLocale(picker.value));
    observer = new MutationObserver(records => {
      observer.disconnect();
      for (const record of records) {
        if (record.type === 'childList') for (const node of record.addedNodes) translateNode(node);
        else translateNode(record.target);
      }
      observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'placeholder', 'title'] });
    });
    translate(); document.documentElement.classList.add('locale-ready');
  });
})();
