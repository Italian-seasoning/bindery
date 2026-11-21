// Settings sheet: a right-side <dialog> built once, on first open. Vanilla, no build step.
// Imports cleanly in Node: the DOM and storage are touched only inside functions.

const THEME_KEY = 'ac-theme';
const THEMES = [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']];
const COPY_MS = 1500;

let sheet = null;
let radios = [];
let copyTimer = 0;
let opener = null;
const callbacks = { onThemeChange: null };

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

// theme.js (loaded before paint) owns the theme: it always sets data-theme to light or dark and
// follows the OS while the choice is "system". These wrappers fall back to storage only without it.
function readStoredTheme() {
  if (globalThis.acTheme) return globalThis.acTheme.get();
  try {
    const v = globalThis.localStorage?.getItem(THEME_KEY);
    return v === 'dark' || v === 'light' ? v : 'system';
  } catch {
    return 'system';
  }
}

function writeStoredTheme(value) {
  if (globalThis.acTheme) return; // acTheme.set in applyTheme stores it
  try { globalThis.localStorage?.setItem(THEME_KEY, value); } catch { /* storage blocked: the choice still applies */ }
}

function applyTheme(value) {
  if (globalThis.acTheme) { globalThis.acTheme.set(value); return; }
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (value === 'dark' || value === 'light') root.dataset.theme = value;
  else delete root.dataset.theme;
}

/** Call once at startup, before first paint if possible. */
export function applySavedTheme() {
  applyTheme(readStoredTheme());
}

function paintTheme(value) {
  for (const b of radios) {
    const on = b.dataset.value === value;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

function choose(value) {
  writeStoredTheme(value);
  applyTheme(value);
  paintTheme(value);
  callbacks.onThemeChange?.(value);
}

function onRadioKey(e) {
  const n = radios.length;
  const idx = radios.findIndex((b) => b.getAttribute('aria-checked') === 'true');
  let next = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % n;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + n) % n;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = n - 1;
  if (next == null) return;
  e.preventDefault();
  choose(THEMES[next][0]);
  radios[next].focus();
}

function section(title, key, ...kids) {
  const hid = `settings-${key}`;
  return h('section', { class: 'sheet-sec', 'aria-labelledby': hid }, h('h3', { id: hid }, title), ...kids);
}

function build({ stateDir = '', version = '', shortcuts = [] } = {}) {
  const titleId = 'settings-title';

  radios = THEMES.map(([value, text]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1', 'data-value': value,
    onclick: () => choose(value),
  }, text));

  const copyBtn = h('button', { type: 'button', class: 'btn btn-quiet btn-sm' }, 'Copy path');
  copyBtn.addEventListener('click', async () => {
    try {
      await globalThis.navigator.clipboard.writeText(stateDir);
      copyBtn.textContent = 'Copied';
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy path'; }, COPY_MS);
    } catch {
      // Clipboard unavailable: the path is on screen to select by hand.
    }
  });

  const dialog = h('dialog', { class: 'sheet', 'aria-labelledby': titleId });
  const closeBtn = h('button', {
    type: 'button', class: 'btn btn-quiet btn-sm', 'aria-label': 'Close settings', onclick: () => dialog.close(),
  }, 'Close');

  dialog.append(
    h('div', { class: 'sheet-head' }, h('h2', { id: titleId }, 'Settings'), closeBtn),
    section('Appearance', 'appearance',
      h('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': 'settings-appearance', onkeydown: onRadioKey }, radios)),
    section('Backups and history', 'backups',
      h('p', {}, 'Removed and replaced skills move here, and every change can be undone from History.'),
      h('div', { class: 'path-row' }, h('code', {}, stateDir), copyBtn)),
    section('Privacy', 'privacy',
      h('p', {}, 'Runs only on 127.0.0.1. No analytics. The network is used only when you fetch a pack.')),
    section('Keyboard', 'keyboard',
      h('dl', { class: 'shortcut-list' }, shortcuts.flatMap((s) => [
        h('dt', {}, (s.keys || []).map((k) => h('span', { class: 'glyph' }, k))),
        h('dd', {}, s.label),
      ]))),
    section('About', 'about',
      h('p', { class: 'about' }, `Version ${version}`)),
  );

  dialog.addEventListener('close', () => {
    const el = opener;
    opener = null;
    if (el && el.isConnected) el.focus({ preventScroll: true });
  });

  document.body.append(dialog);
  sheet = dialog;
}

/**
 * Opens the settings sheet. Content is built on the first call; later calls reuse it and only
 * refresh the theme choice and the change callback.
 */
export function openSettings({ stateDir, version, shortcuts, onThemeChange } = {}) {
  callbacks.onThemeChange = onThemeChange || null;
  if (!sheet) build({ stateDir, version, shortcuts });
  if (sheet.open) return sheet;
  opener = document.activeElement;
  paintTheme(readStoredTheme());
  sheet.showModal();
  return sheet;
}
