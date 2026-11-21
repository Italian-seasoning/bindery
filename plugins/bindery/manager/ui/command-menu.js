// Bindery command menu: one fuzzy-search dialog for skills and actions. Vanilla, no build step.
// Scoring and ranking are pure, so this module imports cleanly in Node. The DOM is only touched
// inside functions. All text goes through textContent.

const SEPARATORS = ' -_/.';
// Tier bases sit far apart, so the length tie-break can never reorder two tiers.
const TIER = { exact: 50000, prefix: 40000, word: 30000, substring: 20000, subsequence: 10000 };
const KEYWORD_PENALTY = 2500;
const LENGTH_CAP = 1000;

function isWordStart(text, q) {
  for (let i = text.indexOf(q, 1); i !== -1; i = text.indexOf(q, i + 1)) {
    if (SEPARATORS.includes(text[i - 1])) return true;
  }
  return false;
}

function isSubsequence(q, text) {
  let j = 0;
  for (let i = 0; i < text.length && j < q.length; i++) if (text[i] === q[j]) j++;
  return j === q.length;
}

// Tier base for one lowercased text, or null when the query does not match it at all.
function tierBase(q, text) {
  if (text === q) return TIER.exact;
  if (text.startsWith(q)) return TIER.prefix;
  if (isWordStart(text, q)) return TIER.word;
  if (text.includes(q)) return TIER.substring;
  if (isSubsequence(q, text)) return TIER.subsequence;
  return null;
}

export function scoreItem(query, item) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return 0;
  const label = String(item.label ?? '').toLowerCase();
  let best = tierBase(q, label);
  for (const kw of item.keywords ?? []) {
    const base = tierBase(q, String(kw).toLowerCase());
    if (base != null && (best == null || base - KEYWORD_PENALTY > best)) best = base - KEYWORD_PENALTY;
  }
  return best == null ? null : best - Math.min(label.length, LENGTH_CAP);
}

export function rankItems(query, items, limit = 50) {
  const scored = [];
  (items || []).forEach((item, index) => {
    const score = scoreItem(query, item);
    if (score != null) scored.push({ item, score, index });
  });
  // Higher score first. Ties keep the given order.
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, Math.max(0, limit)).map((s) => s.item);
}

/* ---------- DOM ---------- */
let instances = 0;

// Same helper style as app.js h(): attributes first, then children. Strings become text nodes.
function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    node.setAttribute(k, v === true ? '' : String(v));
  }
  node.append(...kids.filter((k) => k != null && k !== false)
    .map((k) => (k instanceof Node ? k : document.createTextNode(String(k)))));
  return node;
}

function restoreFocus(node) {
  if (node && node.isConnected && typeof node.focus === 'function') node.focus();
}

export function createCommandMenu({ getItems, placeholder = 'Search skills and actions' } = {}) {
  let dialog = null;
  let input = null;
  let listbox = null;
  let emptyLine = null;
  let baseId = '';
  let results = []; // items in display order; index matches optionEls
  let optionEls = [];
  let active = -1;
  let returnTo = null; // the element that had focus before the menu opened

  function build() {
    instances += 1;
    baseId = `cmdk-${instances}`;
    const listId = `${baseId}-list`;
    input = el('input', {
      type: 'text', class: 'cmdk-input', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId,
      'aria-autocomplete': 'list', 'aria-label': placeholder, placeholder, autocomplete: 'off',
      autocapitalize: 'off', spellcheck: 'false',
    });
    listbox = el('div', { class: 'cmdk-list', role: 'listbox', id: listId, 'aria-label': 'Commands' });
    emptyLine = el('p', { class: 'cmdk-empty', role: 'status' }, 'No matches. Try fewer letters.');
    dialog = el('dialog', { class: 'cmdk', 'aria-label': 'Command menu' }, input, listbox, emptyLine);
    document.body.append(dialog);

    input.addEventListener('input', () => { active = 0; render(); });
    dialog.addEventListener('keydown', onKeydown);
    // Keep focus in the input when a row is pressed.
    listbox.addEventListener('mousedown', (e) => e.preventDefault());
    // A click on the backdrop lands on the dialog itself, since its padding is zero.
    dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
    dialog.addEventListener('close', () => {
      // Native Escape closes the dialog without close(); give focus back here too.
      if (dialog.open || !returnTo) return;
      const back = returnTo;
      returnTo = null;
      restoreFocus(back);
    });
  }

  function optionNode(item, i) {
    const opt = el('div', {
      class: 'cmdk-option', role: 'option', id: `${baseId}-o${i}`, 'aria-keyshortcuts': item.shortcut,
    },
    el('span', { class: 'cmdk-label' }, item.label),
    item.hint ? el('span', { class: 'cmdk-hint' }, item.hint) : null,
    item.shortcut ? el('span', { class: 'glyph', 'aria-hidden': 'true' }, item.shortcut) : null);
    opt.addEventListener('mousemove', () => { if (active !== i) setActive(i); });
    opt.addEventListener('click', () => runItem(results[i]));
    return opt;
  }

  function render() {
    const items = (typeof getItems === 'function' ? getItems() : []) || [];
    const ranked = rankItems(input.value, items);
    // Groups appear in the order of their best match. Items keep their rank inside a group.
    const order = [];
    const buckets = new Map();
    for (const item of ranked) {
      const g = item.group ?? '';
      if (!buckets.has(g)) { buckets.set(g, []); order.push(g); }
      buckets.get(g).push(item);
    }
    results = order.flatMap((g) => buckets.get(g));
    if (!results.length) active = -1;
    else if (active < 0 || active >= results.length) active = 0;

    const nodes = [];
    optionEls = [];
    for (const g of order) {
      if (g) nodes.push(el('div', { class: 'cmdk-group', role: 'presentation' }, g));
      for (const item of buckets.get(g)) {
        const opt = optionNode(item, optionEls.length);
        optionEls.push(opt);
        nodes.push(opt);
      }
    }
    listbox.replaceChildren(...nodes);
    listbox.hidden = !results.length;
    emptyLine.hidden = results.length > 0;
    setActive(active);
  }

  function setActive(i, scroll = false) {
    active = i;
    optionEls.forEach((o, k) => o.setAttribute('aria-selected', String(k === i)));
    if (i >= 0 && optionEls[i]) {
      input.setAttribute('aria-activedescendant', optionEls[i].id);
      if (scroll) optionEls[i].scrollIntoView?.({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function move(delta) {
    if (!results.length) return;
    setActive((active + delta + results.length) % results.length, true);
  }

  // Close first, then run, so the item can open its own dialog or move focus.
  function runItem(item) {
    if (!item) return;
    close();
    item.run();
  }

  function onKeydown(e) {
    if (e.isComposing) return;
    switch (e.key) {
      case 'ArrowDown': move(1); break;
      case 'ArrowUp': move(-1); break;
      case 'Home': if (results.length) setActive(0, true); break;
      case 'End': if (results.length) setActive(results.length - 1, true); break;
      case 'Enter': runItem(results[active]); break;
      case 'Escape': close(); break;
      case 'Tab': break; // handled below: the input is the only focus stop
      default: return;
    }
    // Keys the menu handles stop here, so the page's own shortcuts do not also fire.
    e.preventDefault();
    e.stopPropagation();
  }

  function open(query = '') {
    if (!dialog) build();
    if (!dialog.open) {
      const prev = document.activeElement;
      returnTo = prev && prev !== document.body && prev !== document.documentElement ? prev : null;
    }
    const q = String(query ?? '');
    input.value = q;
    active = 0;
    render();
    if (!dialog.open) dialog.showModal();
    input.focus();
    input.setSelectionRange(q.length, q.length);
  }

  function close() {
    if (!dialog || !dialog.open) return;
    const back = returnTo;
    returnTo = null;
    dialog.close();
    restoreFocus(back);
  }

  return {
    open,
    close,
    isOpen: () => !!dialog && dialog.open,
  };
}
