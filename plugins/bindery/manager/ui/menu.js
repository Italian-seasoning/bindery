// Accessible popover menu: the WAI-ARIA menu button pattern. Vanilla, no build step.
// Imports cleanly in Node: the DOM is touched only inside functions. All text goes through textContent.

const TYPEAHEAD_MS = 500;
const GAP = 6; // space between the anchor and the menu
const EDGE = 8; // minimum distance from the viewport edge
const EXIT_MS = 100;

let seq = 0;

/** Next enabled index from `from` in direction `dir` (1 or -1), wrapping. -1 when nothing is enabled. */
export function nextIndex(items, from, dir) {
  const n = items?.length || 0;
  if (!n) return -1;
  const step = dir < 0 ? -1 : 1;
  let i = from < 0 || from >= n ? (step > 0 ? -1 : n) : from;
  for (let k = 0; k < n; k++) {
    i = (i + step + n) % n;
    if (!items[i].disabled) return i;
  }
  return -1;
}

/** First enabled item after `from` (wrapping) whose label starts with `text`, ignoring case. -1 when none. */
export function typeaheadIndex(items, from, text) {
  const q = String(text ?? '').toLowerCase();
  const n = items?.length || 0;
  if (!n || !q) return -1;
  const start = from < 0 || from >= n ? -1 : from;
  for (let k = 1; k <= n; k++) {
    const i = (start + k + n) % n;
    const item = items[i];
    if (!item.disabled && String(item.label ?? '').toLowerCase().startsWith(q)) return i;
  }
  return -1;
}

/* ---------- tiny DOM helper (same shape as app.js) ---------- */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/**
 * items: [{ id, label, run?, hint?, checked?, radio?, group?, danger?, disabled? }]
 * checked is a boolean => menuitemcheckbox, or menuitemradio when radio is true, with aria-checked.
 */
export function createMenu({ anchor, label, items = [], align = 'start' } = {}) {
  const id = `ac-menu-${++seq}`;
  const host = anchor.closest('dialog[open]') || document.body;
  const menu = h('div', { id, class: 'menu', role: 'menu', 'aria-label': label, hidden: true });
  host.append(menu);

  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'false');
  anchor.setAttribute('aria-controls', id);

  let list = items;
  let itemEls = [];
  let open = false;
  let active = -1;
  let buffer = '';
  let bufferAt = 0;
  let exitTimer = 0;

  function itemEl(item, i) {
    const checkable = typeof item.checked === 'boolean';
    const role = !checkable ? 'menuitem' : item.radio ? 'menuitemradio' : 'menuitemcheckbox';
    return h('div', {
      class: item.danger ? 'menu-item danger' : 'menu-item',
      role,
      tabindex: '-1',
      'aria-disabled': item.disabled ? 'true' : null,
      'aria-checked': checkable ? String(item.checked) : null,
      onclick: () => activate(i),
      onmouseenter: () => { if (!item.disabled) focusItem(i); },
    },
    h('span', { class: 'menu-check', 'aria-hidden': 'true' }),
    h('span', { class: 'menu-label' }, item.label),
    item.hint ? h('span', { class: 'glyph' }, item.hint) : null);
  }

  function render() {
    itemEls = [];
    const nodes = [];
    let prevGroup;
    list.forEach((item, i) => {
      if (item.group !== prevGroup) {
        if (nodes.length) nodes.push(h('div', { class: 'menu-sep', role: 'separator' }));
        if (item.group) nodes.push(h('div', { class: 'menu-group', role: 'presentation' }, item.group));
      }
      prevGroup = item.group;
      const el = itemEl(item, i);
      itemEls[i] = el;
      nodes.push(el);
    });
    menu.replaceChildren(...nodes);
  }

  function focusItem(i) {
    if (i < 0 || !itemEls[i]) return;
    active = i;
    itemEls[i].focus({ preventScroll: true });
  }

  function place() {
    const r = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = align === 'end' ? r.right - mw : r.left;
    left = Math.min(Math.max(left, EDGE), Math.max(EDGE, vw - mw - EDGE));
    let top = r.bottom + GAP;
    let above = false;
    if (top + mh > vh - EDGE && r.top - GAP - mh >= EDGE) {
      top = r.top - GAP - mh;
      above = true;
    }
    top = Math.min(Math.max(top, EDGE), Math.max(EDGE, vh - mh - EDGE));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.transformOrigin = `${align === 'end' ? 'right' : 'left'} ${above ? 'bottom' : 'top'}`;
  }

  function onOutside(e) {
    if (menu.contains(e.target) || anchor.contains(e.target)) return;
    close({ returnFocus: false });
  }

  function openMenu(where = 'first') {
    if (open || !list.length) return;
    open = true;
    anchor.setAttribute('aria-expanded', 'true');
    clearTimeout(exitTimer);
    menu.hidden = false;
    place();
    void menu.offsetHeight; // commit the closed state so the open transition runs
    menu.classList.add('is-open');
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    focusItem(where === 'last' ? nextIndex(list, list.length, -1) : nextIndex(list, -1, 1));
  }

  function close({ returnFocus = true } = {}) {
    if (!open) return;
    open = false;
    active = -1;
    buffer = '';
    menu.classList.remove('is-open');
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    clearTimeout(exitTimer);
    exitTimer = setTimeout(() => { if (!open) menu.hidden = true; }, EXIT_MS);
    if (returnFocus) anchor.focus({ preventScroll: true });
  }

  function activate(i) {
    const item = list[i];
    if (!item || item.disabled) return;
    close();
    item.run?.(item);
  }

  function onAnchorClick() {
    if (open) close();
    else openMenu();
  }

  function onAnchorKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) openMenu(e.key === 'ArrowUp' ? 'last' : 'first');
    } else if ((e.key === 'Enter' || e.key === ' ') && anchor.tagName !== 'BUTTON') {
      // A native button already turns Enter and Space into a click; other elements need this.
      e.preventDefault();
      if (open) close();
      else openMenu();
    }
  }

  function onMenuKey(e) {
    if (!open) return;
    const k = e.key;
    if (k === 'ArrowDown') focusItem(nextIndex(list, active, 1));
    else if (k === 'ArrowUp') focusItem(nextIndex(list, active, -1));
    else if (k === 'Home') focusItem(nextIndex(list, -1, 1));
    else if (k === 'End') focusItem(nextIndex(list, list.length, -1));
    else if (k === 'Enter' || k === ' ') activate(active);
    else if (k === 'Escape') close();
    else if (k === 'Tab') { close(); return; } // focus returns to the anchor; Tab then moves on from there
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      buffer = now - bufferAt > TYPEAHEAD_MS ? k : buffer + k;
      bufferAt = now;
      const q = /^(.)\1+$/.test(buffer) ? buffer[0] : buffer; // "aaa" cycles through the a-items
      focusItem(typeaheadIndex(list, active, q));
    } else return;
    e.preventDefault();
  }

  render();
  anchor.addEventListener('click', onAnchorClick);
  anchor.addEventListener('keydown', onAnchorKey);
  menu.addEventListener('keydown', onMenuKey);

  return {
    open: () => openMenu(),
    close: () => close(),
    setItems(next) {
      list = next || [];
      render();
      if (!open) return;
      if (!list.length) { close({ returnFocus: false }); return; }
      if (active < 0 || active >= list.length || list[active].disabled) focusItem(nextIndex(list, -1, 1));
      else focusItem(active);
      place();
    },
    destroy() {
      close({ returnFocus: false });
      clearTimeout(exitTimer);
      anchor.removeEventListener('click', onAnchorClick);
      anchor.removeEventListener('keydown', onAnchorKey);
      anchor.removeAttribute('aria-haspopup');
      anchor.removeAttribute('aria-expanded');
      anchor.removeAttribute('aria-controls');
      menu.remove();
    },
  };
}
