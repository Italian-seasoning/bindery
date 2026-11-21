// Bindery manager UI. Vanilla, no build step. All untrusted text goes through textContent.
import { createMenu } from './menu.js';
import { createCommandMenu } from './command-menu.js';
import { openSettings } from './settings.js';
import { readoutEl, faceEl, animateFace } from './readout.js';

const VERSION = '0.2.0';
const VIEWS = [
  { id: 'libraries', label: 'Libraries' },
  { id: 'installed', label: 'Skills' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'packs', label: 'Packs' },
  { id: 'history', label: 'History' },
];

const params = new URLSearchParams(location.search);
const TOKEN = params.get('t') || sessionStorage.getItem('ac-token') || '';
try { sessionStorage.setItem('ac-token', TOKEN); } catch {}
if (params.has('t')) history.replaceState(null, '', location.pathname);

// The two apps a skill can be turned on for. Codex reads both ~/.codex/skills and ~/.agents/skills.
const APPS = [
  { id: 'claude', short: 'cc', label: 'Claude Code', key: 'c' },
  { id: 'codex', short: 'cx', label: 'Codex', key: 'x' },
];
const APP = Object.fromEntries(APPS.map((a) => [a.id, a]));
const appOn = (g, id) => !!g.apps?.[id]?.on;
// Which app reads each root. Codex reads ~/.agents as well as ~/.codex.
const ROOT_APP = {
  'claude-global': 'claude', 'claude-project': 'claude', 'claude-plugins': 'claude',
  'codex-global': 'codex', 'codex-system': 'codex', 'codex-plugins': 'codex', 'agents-global': 'codex', 'agents-project': 'codex',
};
const appOfEntry = (e) => ROOT_APP[e.rootId] || (e.host === 'claude' ? 'claude' : 'codex');
const isFixed = (e) => e.scope === 'plugin' || !!e.readOnly;

const state = {
  view: 'installed',
  q: '',
  facet: 'all',
  data: null,
  skillsById: new Map(),
  selected: null, // group name | pack id | tx id
  packs: null,
  packSel: new Map(), // packId -> Set(relPath)
  packTarget: 'claude-global',
  packMode: 'copy',
  history: null,
  lastTx: null,
  busy: false,
  source: new Map(), // skillId -> {skillMd, files}
  libraries: null,
  libSection: 'libraries', // libraries | links | want (the Libraries view rail)
  sources: null, // libraries fetched from a git link
  want: null, // "Want to try" links
  linkCheck: null, // {url, res} from the last "Check for updates"
  checking: null, // url being checked
  importSource: null, // {url, ref, subdir, commit} when the preview came from a link
  importBusy: false,
  diff: new Map(), // skill name -> diff result
  sort: 'name',
};

const $ = (s) => document.querySelector(s);
const els = {
  app: $('#app'), list: $('#list'), head: $('#list-head'), rail: $('#rail'), detail: $('#detail'),
  search: $('#search'), review: $('#review'), ops: $('#review-ops'), warns: $('#review-warnings'),
  apply: $('#review-apply'), applyLabel: $('#review-apply-label'), toast: $('#toast'), countInstalled: $('#count-installed'),
};

/* ---------- tiny DOM helper ---------- */
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
const glyph = (label) => h('span', { class: 'glyph', 'aria-hidden': 'true' }, label);
// Idle agent: the mark with its eyes closed, shown when nothing is selected.
const MARK_IDLE = '<rect class="mark-skirt" x="4" y="6" width="56" height="54" rx="13"/><rect class="mark-face" x="10" y="7" width="44" height="40" rx="9"/><rect class="mark-eye" x="20.5" y="27" width="7" height="3" rx="1.2"/><rect class="mark-eye" x="36.5" y="27" width="7" height="3" rx="1.2"/>';
const FOLDER_SVG = '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" fill="none" stroke="currentColor" stroke-width="1.3"/>';
function svg(viewBox, inner, cls) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', viewBox); el.setAttribute('aria-hidden', 'true'); if (cls) el.setAttribute('class', cls);
  el.innerHTML = inner; // static markup only, never user text
  return el;
}

/* ---------- API ---------- */
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-bindery-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 403) throw new Error('This window lost its session. Close it and run bindery again.');
    throw new Error(json?.error || `Request failed (${res.status}).`);
  }
  return json;
}

/* ---------- data shaping ---------- */
function setData(data) {
  state.data = data;
  state.skillsById = new Map((data.skills || []).map((s) => [s.id, s]));
  els.countInstalled.textContent = data.groups?.length ?? '';
}
function groupHosts(g) {
  const entries = g.entries.map((id) => state.skillsById.get(id)).filter(Boolean);
  const lit = new Set(), plug = new Set();
  for (const e of entries) (e.scope === 'plugin' || e.readOnly ? plug : lit).add(e.host);
  return { entries, lit, plug };
}
function groupFlags(g, entries) {
  return {
    broken: entries.some((e) => e.broken),
    conflict: !!g.conflict,
    scripts: entries.some((e) => e.hasScripts),
    project: entries.some((e) => e.scope === 'project'),
    plugin: entries.length > 0 && entries.every((e) => e.scope === 'plugin' || e.readOnly),
  };
}
function matches(text, q) { return !q || text.toLowerCase().includes(q); }

const FACETS = [
  { id: 'all', group: 'Used by', label: 'Everything', test: () => true },
  { id: 'both', group: 'Used by', label: 'Both apps', test: (g) => appOn(g, 'claude') && appOn(g, 'codex') },
  { id: 'only-claude', group: 'Used by', label: 'Only Claude Code', test: (g) => appOn(g, 'claude') && !appOn(g, 'codex'), shareTo: 'codex' },
  { id: 'only-codex', group: 'Used by', label: 'Only Codex', test: (g) => appOn(g, 'codex') && !appOn(g, 'claude'), shareTo: 'claude' },
  { id: 'mine', group: 'Comes from', label: 'Your folders', test: (g, f) => !f.plugin },
  { id: 'plugin', group: 'Comes from', label: 'Plugins', test: (g, f) => f.plugin },
  { id: 'project', group: 'Comes from', label: 'This project', test: (g, f) => f.project, hideEmpty: true },
  { id: 'conflict', group: 'Needs a look', label: 'Copies differ', test: (g, f) => f.conflict, dot: 'warn', hideEmpty: true },
  { id: 'broken', group: 'Needs a look', label: 'Broken links', test: (g, f) => f.broken, dot: 'bad', hideEmpty: true },
  { id: 'scripts', group: 'Needs a look', label: 'Runs scripts', test: (g, f) => f.scripts, dot: '', hideEmpty: true },
];

function installedRows() {
  const q = state.q.trim().toLowerCase();
  const facet = FACETS.find((f) => f.id === state.facet) || FACETS[0];
  const rows = [];
  const counts = Object.fromEntries(FACETS.map((f) => [f.id, 0]));
  for (const g of state.data?.groups || []) {
    const hs = groupHosts(g);
    const f = groupFlags(g, hs.entries);
    const hit = matches(g.name, q) || matches(g.description || '', q);
    if (!hit) continue;
    for (const fc of FACETS) if (fc.test(g, f, hs)) counts[fc.id]++;
    if (facet.test(g, f, hs)) rows.push({ g, hs, f });
  }
  const fileCount = (r) => r.hs.entries.reduce((n, e) => Math.max(n, e.fileCount || 0), 0);
  const changed = (r) => r.hs.entries.reduce((n, e) => Math.max(n, Date.parse(e.updatedAt) || 0), 0);
  if (state.sort === 'files') rows.sort((a, b) => fileCount(b) - fileCount(a) || a.g.name.localeCompare(b.g.name));
  else if (state.sort === 'changed') rows.sort((a, b) => changed(b) - changed(a) || a.g.name.localeCompare(b.g.name));
  return { rows, counts };
}

/* ---------- render: rail ---------- */
function renderRail(counts) {
  els.rail.replaceChildren();
  if (state.view === 'libraries') { renderLibraryRail(); return; }
  if (state.view === 'prompts') { els.rail.replaceChildren(...railNote()); return; }
  if (state.view !== 'installed') {
    const facets = state.view === 'packs' ? packFacets() : historyFacets();
    if (!facets.length) return;
    els.rail.append(h('h2', {}, state.view === 'packs' ? 'Topics' : 'Show'));
    for (const f of facets) {
      els.rail.append(h('button', {
        class: 'facet', type: 'button', 'aria-pressed': String(state.subFacet === f.id),
        onclick: () => { state.subFacet = f.id; state.selected = null; render(); },
      }, h('span', { class: 'facet-label' }, f.label), h('span', { class: 'facet-n' }, f.n)));
    }
    return;
  }
  const groups = [...new Set(FACETS.map((f) => f.group))].map((t) => [t, FACETS.filter((f) => f.group === t && !(f.hideEmpty && !counts[f.id] && state.facet !== f.id))]);
  for (const [title, list] of groups) {
    if (!list.length) continue;
    els.rail.append(h('h2', {}, title));
    for (const f of list) {
      els.rail.append(h('button', {
        class: 'facet', type: 'button', 'aria-pressed': String(state.facet === f.id),
        onclick: () => { state.facet = f.id; state.selected = null; state.pinned = false; render(); },
      }, f.dot != null ? h('span', { class: `dot ${f.dot}` }) : null, h('span', { class: 'facet-label' }, f.label), h('span', { class: 'facet-n' }, counts[f.id])));
    }
  }
}
function packFacets() {
  const packs = state.packs?.packs || [];
  const tags = new Map();
  for (const p of packs) for (const t of p.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
  return [{ id: 'all', label: 'All packs', n: packs.length },
    ...[...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, n]) => ({ id: `tag:${t}`, label: t[0].toUpperCase() + t.slice(1), n }))];
}
function historyFacets() {
  const items = state.history || [];
  const count = (st) => items.filter((t) => t.status === st).length;
  return [{ id: 'all', label: 'All changes', n: items.length }, { id: 'applied', label: 'Applied', n: count('applied') }, { id: 'undone', label: 'Undone', n: count('undone') }]
    .filter((f) => f.id === 'all' || f.n);
}
function tildify(p) {
  const home = state.data?.home;
  if (!p) return '';
  return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p;
}

/* ---------- render: list ---------- */
// One slot per app: lit = on, outline = from a plugin, amber = copies differ, red = broken.
// A line joins the two when both apps read the same folder.
function pairFor(g) {
  const entries = g.entries.map((id) => state.skillsById.get(id)).filter(Boolean);
  const words = [];
  const slots = APPS.map((a) => {
    const mine = entries.filter((e) => appOfEntry(e) === a.id);
    const st = g.apps?.[a.id] || {};
    let cls = '', word = 'off';
    if (mine.length && mine.every((e) => e.broken)) { cls = 'broken'; word = 'broken link'; }
    else if (st.on && st.fixed) { cls = 'plug'; word = 'on through a plugin'; }
    else if (st.on && g.conflict) { cls = 'differs'; word = 'on, different copy'; }
    else if (st.on) { cls = 'on'; word = 'on'; }
    words.push(`${a.label} ${word}`);
    return h('span', { class: `slot ${cls}` });
  });
  const tied = appOn(g, 'claude') && appOn(g, 'codex') && g.sameSource;
  if (tied) words.push('same folder');
  return h('span', { class: 'pair', role: 'img', 'aria-label': words.join(', ') }, slots[0], tied ? h('span', { class: 'tie' }) : null, slots[1]);
}
function pairForPack(installedIn = []) {
  const on = { claude: installedIn.some((r) => ROOT_APP[r] === 'claude'), codex: installedIn.some((r) => ROOT_APP[r] === 'codex') };
  return h('span', { class: 'pair', role: 'img', 'aria-label': APPS.map((a) => `${a.label} ${on[a.id] ? 'has it' : 'does not'}`).join(', ') },
    APPS.map((a) => h('span', { class: `slot ${on[a.id] ? 'on' : ''}` })));
}
const pairHead = () => h('span', { class: 'pair-head', 'aria-hidden': 'true' }, h('span', {}, 'Claude'), h('span', {}, 'Codex'));

function renderList() {
  els.list.replaceChildren();
  els.app.dataset.view = state.view;
  els.head.classList.toggle('want-head', state.view === 'libraries' && state.libSection === 'want');
  if (state.view === 'installed') return renderInstalledList();
  if (state.view === 'libraries') return renderLibraryList();
  if (state.view === 'prompts') return renderPromptList();
  if (state.view === 'packs') return renderPackList();
  return renderHistoryList();
}

function listOptions(items, render) {
  const frag = document.createDocumentFragment();
  items.forEach((it, i) => frag.append(render(it, i)));
  els.list.append(frag);
}

function rowEl(key, selected, onSelect, ...kids) {
  return h('div', {
    class: 'row', role: 'option', id: `opt-${cssId(key)}`, 'aria-selected': String(selected), 'data-key': key,
    onclick: () => onSelect(key),
    onmouseenter: () => { if (!isNarrow() && state.view === 'installed' && !state.pinned) preview(key); },
  }, ...kids);
}
function cssId(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); }
function isNarrow() { return matchMedia('(max-width: 860px)').matches; }

function renderInstalledList() {
  if (!state.data) { els.list.append(...Array.from({ length: 10 }, () => h('div', { class: 'skeleton' }))); return; }
  const { rows, counts } = installedRows();
  renderRail(counts);
  const shareTo = FACETS.find((f) => f.id === state.facet)?.shareTo;
  const shareable = shareTo ? rows.filter(({ g }) => g.apps?.[shareTo]?.canTurnOn).map(({ g }) => g.name) : [];
  els.head.replaceChildren(
    h('span', {}, h('strong', {}, rows.length), rows.length === 1 ? ' skill' : ' skills', state.q ? ` matching “${state.q}”` : ''),
    shareable.length
      ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => planShare(shareable.slice(0, 200), shareTo, true) },
        `Share ${shareable.length > 200 ? 'first 200' : plural(shareable.length, 'skill')} with ${APP[shareTo].label}`)
      : h('span', { class: 'head-actions' }, sortButton(), pairHead()),
  );
  if (!rows.length) {
    els.list.append(h('div', { class: 'empty' }, state.q ? `Nothing matches “${state.q}”.` : 'Nothing here.',
      h('p', {}, state.q ? 'Try a shorter word, or clear the search with esc.' : state.facet === 'all' ? 'Open Packs to add some skills.' : 'Choose Everything to see all your skills.')));
    return;
  }
  listOptions(rows, ({ g, f }) => rowEl(g.name, state.selected === g.name, select,
    h('div', {},
      h('div', { class: 'row-name' }, g.name, f.broken ? h('span', { class: 'row-flag bad' }, 'Broken link') : f.conflict ? h('span', { class: 'row-flag' }, 'Copies differ') : null),
      h('div', { class: 'row-sub' }, g.description || 'No description')),
    pairFor(g)));
  els.list.setAttribute('aria-activedescendant', state.selected ? `opt-${cssId(state.selected)}` : '');
}

function renderPackList() {
  renderRail({});
  if (!state.packs) { els.list.append(...Array.from({ length: 6 }, () => h('div', { class: 'skeleton' }))); return; }
  const q = state.q.trim().toLowerCase();
  const tag = state.subFacet?.startsWith('tag:') ? state.subFacet.slice(4) : null;
  const packs = state.packs.packs.filter((p) => (!tag || (p.tags || []).includes(tag)) && matches(`${p.title} ${p.publisher} ${p.summary} ${(p.tags || []).join(' ')}`, q));
  els.head.replaceChildren(h('span', {}, h('strong', {}, packs.length), ' free packs'), h('span', {}, `Sources checked ${state.packs.checked || ''}`));
  if (!packs.length) { els.list.append(h('div', { class: 'empty' }, `No packs match “${state.q}”.`)); return; }
  listOptions(packs, (p) => {
    const fetched = p.cached;
    return rowEl(p.id, state.selected === p.id, select,
      h('div', {},
        h('div', { class: 'row-name' }, p.title),
        h('div', { class: 'row-sub' }, p.publisher)),
      h('span', { class: `row-status ${fetched ? 'ok' : ''}` }, p.kind === 'plugin' ? 'Plugin' : fetched ? plural(fetched.skills.length, 'skill') : 'Not fetched'));
  });
}

function renderHistoryList() {
  renderRail({});
  if (!state.history) { els.list.append(...Array.from({ length: 4 }, () => h('div', { class: 'skeleton' }))); return; }
  const items = state.history.filter((t) => (state.subFacet === 'all' || !state.subFacet || t.status === state.subFacet) && matches(t.summary || '', state.q.trim().toLowerCase()));
  els.head.replaceChildren(h('span', {}, h('strong', {}, items.length), ' changes'));
  if (!items.length) { els.list.append(h('div', { class: 'empty' }, 'No changes yet.', h('p', {}, 'Installs and removals you make here will show up in this list.'))); return; }
  listOptions(items, (t) => rowEl(t.txId, state.selected === t.txId, select,
    h('div', {}, h('div', { class: 'row-name' }, t.summary || t.kind), h('div', { class: 'row-sub' }, fmtTime(t.createdAt))),
    h('span', { class: `tx-status ${t.status}` }, STATUS[t.status] || t.status)));
}
const STATUS = { applied: 'Applied', undone: 'Undone', failed: 'Rolled back', 'rolled-back': 'Rolled back' };

/* ---------- render: detail ---------- */
function blankDetail(text) {
  els.detail.replaceChildren(h('div', { class: 'detail-blank' }, svg('0 0 64 64', MARK_IDLE), h('div', {}, text)));
}
function backBtn() {
  return h('button', { class: 'btn btn-quiet back', type: 'button', onclick: () => { els.app.classList.remove('show-detail'); els.list.focus(); } }, '← Back');
}

// Popover menus live on <body>, so the ones built for a detail page are removed when it re-renders.
const detailMenus = [];
function trackMenu(m) { detailMenus.push(m); return m; }
// The detail pane animates in only when a different item opens, not when the same item re-renders
// (a checkbox, a loaded diff, a refresh). motion.css styles #detail > .enter.
let detailKey = null;
function renderDetail() {
  detailMenus.splice(0).forEach((m) => m.destroy());
  const key = `${state.view}:${state.previewing || state.selected || ''}`;
  if (state.view === 'installed') renderSkillDetail(state.previewing || state.selected);
  else if (state.view === 'libraries') renderLibraryDetail(state.selected);
  else if (state.view === 'prompts') renderPromptDetail(state.selected);
  else if (state.view === 'packs') renderPackDetail(state.selected);
  else renderTxDetail(state.selected);
  if (key !== detailKey) for (const el of els.detail.children) el.classList.add('enter');
  detailKey = key;
}

function rootLabel(rootId) { return state.data?.roots?.find((r) => r.id === rootId)?.label || rootId; }

function renderSkillDetail(name) {
  const g = state.data?.groups?.find((x) => x.name === name);
  if (!g) return blankDetail('Choose a skill to see where it lives and what it does.');
  const { entries } = groupHosts(g);
  const kids = [backBtn(), h('h1', {}, g.name), h('p', { class: 'lede' }, g.description || 'This skill has no description.')];
  kids.push(h('h2', {}, 'Use in'), useIn(g));
  const folders = folderMap(entries);
  kids.push(h('h2', {}, folders.length === 1 ? 'Where it lives' : `Where it lives: ${folders.length} folders`));
  if (g.conflict) {
    kids.push(h('div', { class: 'notice warn', style: 'margin:0 0 10px' }, h('strong', {}, 'These copies differ. '), 'Claude Code and Codex are reading different versions of this skill, so they may follow different instructions. Compare them, then keep the one you want for both apps.',
      h('div', { class: 'actions', style: 'margin-top:10px' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => loadDiff(g.name) }, state.diff.has(g.name) ? 'Compare again' : 'Compare copies'))));
    if (state.diff.has(g.name)) kids.push(diffEl(state.diff.get(g.name)));
  }
  const working = entries.filter((e) => !e.broken && e.realPath);
  kids.push(h('div', { class: 'map' }, folders.map((f) => folderEl(f, g.conflict && folders.length > 1, g, working))));
  const first = entries.find((e) => !e.broken);
  const removable = entries.filter((e) => !isFixed(e));
  if (first) {
    const src = state.source.get(first.id);
    kids.push(h('div', { class: 'actions' },
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => loadSource(first.id) }, src ? 'Reload SKILL.md' : 'Read SKILL.md'),
      addToLibraryButton('skill', g.name),
      removable.length > 1
        ? h('button', { class: 'btn btn-sm btn-quiet', type: 'button', onclick: () => planRemove(removable.map((e) => e.id)) },
          new Set(removable.map(appOfEntry)).size > 1 ? 'Remove from both apps' : 'Remove every copy')
        : null));
    if (src) {
      kids.push(h('pre', { class: 'source', tabindex: '0', 'aria-label': 'SKILL.md contents' }, src.skillMd));
      if (src.files?.length) kids.push(h('h2', {}, `Files (${src.files.length})`), h('div', { class: 'path' }, src.files.slice(0, 60).join('\n').replace(/\n/g, '  ·  ')));
    }
  }
  els.detail.replaceChildren(...kids);
}

function useIn(g) {
  const keys = h('div', { class: 'use-in', role: 'group', 'aria-label': 'Apps that can use this skill' });
  for (const a of APPS) {
    const st = g.apps?.[a.id] || {};
    const can = st.on ? st.canTurnOff : st.canTurnOn;
    const stateText = st.on && st.fixed ? 'On through a plugin'
      : st.on ? (can ? 'On. Press to turn off' : 'On')
        : can ? 'Off. Press to turn on' : 'Off';
    keys.append(h('button', {
      class: `cap switch${st.fixed ? ' is-plugin' : ''}`, type: 'button', 'data-key': a.key, 'aria-pressed': String(!!st.on), disabled: !can,
      'aria-keyshortcuts': a.key,
      onclick: () => planShare([g.name], a.id, !st.on),
    },
    h('span', { class: 'switch-top' }, h('span', { class: 'bump', 'aria-hidden': 'true' }), glyph(a.key)),
    h('span', { class: 'switch-name' }, a.label, h('span', { class: 'switch-state' }, stateText))));
  }
  return h('div', {}, keys, h('p', { class: 'use-note' }, useNote(g)));
}

function useNote(g) {
  const on = APPS.filter((a) => appOn(g, a.id));
  const off = APPS.filter((a) => !appOn(g, a.id));
  const plug = APPS.find((a) => g.apps?.[a.id]?.fixed);
  if (on.length === 2) {
    if (plug) return `${plug.label} gets this from a plugin. Turn the plugin off in ${plug.label} if you only want it in ${APPS.find((a) => a !== plug).label}.`;
    return g.sameSource ? 'Both apps read the same folder, so an edit shows up in both.' : 'Each app has its own copy. Editing one does not change the other.';
  }
  if (on.length === 1) {
    if (!g.apps?.[off[0].id]?.canTurnOn) return `Only ${on[0].label} has this, through a plugin. Install that plugin in ${off[0].label} to use it there too.`;
    return `Only ${on[0].label} can use this. Turning on ${off[0].label} links it to the same folder, so there is still one copy to edit.`;
  }
  return 'Neither app can load this right now. Check the folder below.';
}

// Group entries by the real folder they resolve to, so a link and its target show as one place.
function folderMap(entries) {
  const byFolder = new Map();
  for (const e of entries) {
    const key = e.broken ? `broken:${e.path}` : e.realPath || e.path;
    if (!byFolder.has(key)) byFolder.set(key, { path: e.broken ? (e.linkTarget || e.path) : key, broken: !!e.broken, readers: [] });
    byFolder.get(key).readers.push(e);
  }
  // Put the folder Claude Code reads first, then Codex, so the map reads in the same order as the switches.
  return [...byFolder.values()].sort((a, b) => APPS.findIndex((x) => x.id === appOfEntry(a.readers[0])) - APPS.findIndex((x) => x.id === appOfEntry(b.readers[0])));
}

function folderEl(f, differs, g, working = []) {
  const first = f.readers[0];
  const tags = [];
  if (f.broken) tags.push(h('span', { class: 'tag bad' }, 'Folder is missing'));
  if (!f.broken && first.fileCount != null) tags.push(h('span', { class: 'tag' }, plural(first.fileCount, 'file')));
  if (first.hasScripts) tags.push(h('span', { class: 'tag warn' }, 'Runs scripts'));
  const readers = h('ul', { class: 'readers' }, f.readers.map((e) => {
    const app = APP[appOfEntry(e)];
    const who = isFixed(e) ? `${app.label} plugin${e.pluginName ? ` ${e.pluginName}` : ''}` : app.label;
    const how = e.broken ? `${e.path} points here`
      : e.isSymlink ? `through a link at ${e.path}`
        : e.path === f.path ? `reads it directly (${rootLabel(e.rootId).split(' · ').pop()})` : e.path;
    return h('li', { class: 'reader' },
      h('span', { class: 'reader-who' }, who),
      h('span', { class: 'reader-how' }, how),
      isFixed(e)
        ? h('span', { class: 'readonly' }, 'Managed by plugin')
        : e.broken
          ? h('span', { class: 'reader-acts' },
            working.length ? h('button', { class: 'btn btn-text', type: 'button', onclick: () => planRepairLink(e.id, 'relink', working[0].id) }, 'Point at working copy') : null,
            h('button', { class: 'btn btn-text', type: 'button', onclick: () => planRepairLink(e.id, 'remove'), 'aria-label': `Remove the broken link at ${e.path}` }, 'Remove link'))
          : h('button', { class: 'btn btn-text', type: 'button', onclick: () => planRemove([e.id]), 'aria-label': `Remove ${e.path}` }, e.isSymlink ? 'Remove link' : 'Remove'));
  }));
  const keepable = differs && !f.broken && !f.readers.every(isFixed);
  return h('div', { class: `folder${f.broken ? ' broken' : differs ? ' differs' : ''}` },
    h('div', { class: 'folder-top' }, svg('0 0 16 16', FOLDER_SVG, 'folder-icon'), h('span', { class: 'folder-path' }, f.path)),
    tags.length ? h('div', { class: 'tags' }, tags) : null,
    readers,
    keepable ? h('div', { class: 'folder-acts' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => planKeep(g.name, first.id) }, 'Keep this copy for both apps')) : null);
}

async function planKeep(name, keepId) {
  try { openReview(await api('/api/plan', { kind: 'resolve', name, keepId }), 'Share'); }
  catch (err) { toast(err.message, { error: true }); }
}
async function planRepairLink(skillId, action, targetId) {
  try { openReview(await api('/api/plan', { kind: 'repair', skillId, action, targetId }), 'Share'); }
  catch (err) { toast(err.message, { error: true }); }
}
async function loadDiff(name) {
  try { state.diff.set(name, await api(`/api/diff?name=${encodeURIComponent(name)}`)); renderDetail(); }
  catch (err) { toast(err.message, { error: true }); }
}
function diffEl(d) {
  const kids = [h('div', { class: 'diff-head' }, h('span', { class: 'diff-a' }, tildify(d.a.path)), h('span', { class: 'diff-b' }, tildify(d.b.path)))];
  const changedFiles = d.files.filter((f) => f.status !== 'same');
  if (changedFiles.length) kids.push(h('ul', { class: 'diff-files' }, changedFiles.map((f) => h('li', {}, h('span', { class: `diff-st ${f.status}` }, { added: 'Only in second', removed: 'Only in first', changed: 'Changed' }[f.status] || f.status), h('code', {}, f.rel)))));
  const md = d.skillMd;
  if (md?.tooLarge) kids.push(h('p', { class: 'use-note' }, 'SKILL.md is too large to compare here.'));
  else if (md?.hunks) {
    const pre = h('pre', { class: 'diff', tabindex: '0', 'aria-label': 'Differences in SKILL.md' });
    for (const hk of md.hunks) {
      const lines = hk.type === 'eq' && hk.lines.length > 6 ? [...hk.lines.slice(0, 2), '…', ...hk.lines.slice(-2)] : hk.lines;
      for (const line of lines) pre.append(h('span', { class: `dl ${hk.type}` }, `${hk.type === 'add' ? '+ ' : hk.type === 'del' ? '- ' : '  '}${line}\n`));
    }
    kids.push(pre);
  }
  if (d.same) kids.push(h('p', { class: 'use-note' }, 'The files are identical. Keeping either copy changes nothing you can read.'));
  return h('div', { class: 'diff-wrap' }, ...kids);
}

async function planShare(names, app, on) {
  try { openReview(await api('/api/plan', { kind: 'share', names, app, on }), 'Share'); }
  catch (err) { toast(err.message, { error: true }); }
}

async function loadSource(id) {
  try { state.source.set(id, await api(`/api/skill?id=${encodeURIComponent(id)}`)); renderDetail(); }
  catch (err) { toast(err.message, { error: true }); }
}

function renderPackDetail(id) {
  const p = state.packs?.packs.find((x) => x.id === id);
  if (!p) return blankDetail('Choose a pack to see what is inside before you install anything.');
  const fetched = p.cached;
  const kids = [backBtn(), h('h1', {}, p.title), h('p', { class: 'lede' }, p.summary)];
  kids.push(h('div', { class: 'meta' },
    h('span', {}, p.publisher),
    h('a', { href: p.repo, target: '_blank', rel: 'noreferrer noopener' }, p.repo.replace(/^https:\/\//, '')),
    fetched?.license ? h('span', {}, `Licence: ${fetched.license.spdxGuess || fetched.license.file}`) : fetched ? h('span', {}, 'No licence file found') : null,
    fetched ? h('span', {}, `Commit ${String(fetched.commit).slice(0, 7)}`) : null));
  if (p.tags?.length) kids.push(h('div', { class: 'tags', style: 'margin-top:10px' }, p.tags.map((t) => h('span', { class: 'tag' }, t))));
  if (p.installNote) kids.push(h('div', { class: 'notice' }, h('strong', {}, 'Installs as a plugin. '), p.installNote));

  if (!fetched) {
    kids.push(h('div', { class: 'notice' }, h('strong', {}, 'Nothing has been downloaded. '), `Fetching runs git to copy this repository from ${new URL(p.repo).host} into Bindery's cache, so you can read every skill before installing. Nothing is installed yet.`));
    kids.push(h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', id: 'fetch-btn', onclick: () => fetchPack(p.id), 'aria-keyshortcuts': 'f' }, 'Fetch contents', glyph('f'))));
    return els.detail.replaceChildren(...kids);
  }

  const sel = state.packSel.get(p.id) || new Set();
  state.packSel.set(p.id, sel);
  kids.push(h('h2', {}, plural(fetched.skills.length, 'skill')));
  const list = h('div', {});
  for (const s of fetched.skills) {
    const idc = `ps-${cssId(p.id + s.relPath)}`;
    const inst = s.installedIn || [];
    list.append(h('div', { class: 'pack-skill' },
      h('input', { type: 'checkbox', id: idc, checked: sel.has(s.relPath), disabled: p.kind === 'plugin', onchange: (ev) => { ev.target.checked ? sel.add(s.relPath) : sel.delete(s.relPath); renderDetail(); } }),
      h('label', { for: idc },
        h('div', { class: 'nm' }, s.name, s.hasScripts ? h('span', { class: 'row-flag', title: 'Contains scripts' }, 'scripts') : null),
        h('div', { class: 'ds' }, s.description || 'No description.'),
        h('div', { class: 'path' }, s.relPath)),
      pairForPack(inst)));
  }
  kids.push(list);

  if (p.kind !== 'plugin') {
    const roots = (state.data?.roots || []).filter((r) => r.scope !== 'plugin' && r.writable);
    if (!roots.some((r) => r.id === state.packTarget) && roots[0]) state.packTarget = roots[0].id;
    const select = h('select', { id: 'pack-target', onchange: (e) => { state.packTarget = e.target.value; } },
      roots.map((r) => h('option', { value: r.id, selected: r.id === state.packTarget }, r.label + (r.exists ? '' : ' (will be created)'))));
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Install mode' },
      [['copy', 'Copy'], ['symlink', 'Link']].map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(state.packMode === v), onclick: () => { state.packMode = v; renderDetail(); } }, l)));
    kids.push(h('div', { class: 'install-bar' },
      h('div', { class: 'install-row' },
        h('label', { class: 'field', for: 'pack-target' }, 'Install into', select),
        h('div', { class: 'field' }, h('span', {}, state.packMode === 'copy' ? 'Copy: stays as installed' : 'Link: follows pack updates'), seg)),
      h('div', { class: 'install-row' },
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { fetched.skills.forEach((s) => sel.add(s.relPath)); renderDetail(); } }, 'Select all'),
        h('button', { class: 'btn btn-primary', type: 'button', disabled: !sel.size, onclick: () => planInstall(p.id, [...sel]) }, sel.size ? `Review ${plural(sel.size, 'install')}` : 'Choose skills to install'))));
  }
  els.detail.replaceChildren(...kids);
}

function renderTxDetail(id) {
  const t = state.history?.find((x) => x.txId === id);
  if (!t) return blankDetail('Choose a change to see it or undo it.');
  const kids = [backBtn(), h('h1', {}, t.summary || t.kind), h('div', { class: 'meta' }, h('span', {}, fmtTime(t.createdAt)), h('span', { class: `tx-status ${t.status}` }, STATUS[t.status] || t.status), h('code', {}, t.txId))];
  if (t.status === 'applied') kids.push(h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => undo(t.txId), 'aria-keyshortcuts': 'u' }, 'Undo this change')));
  else kids.push(h('p', { class: 'lede', style: 'margin-top:16px' }, t.status === 'undone' ? 'This change was undone. Whatever it added was moved into backups, not deleted.' : 'This change did not complete and was rolled back.'));
  els.detail.replaceChildren(...kids);
}

/* ---------- libraries ---------- */
// A library is a shareable folder of skills and prompts, each with a short "best for" note.
const IMPORT_KEY = '__import';
const NEW_KEY = '__new';
const LEVEL_TEXT = { clean: 'No findings', info: 'Notes only', medium: 'Read before using', high: 'Risky: read first' };
const LEVEL_TAG = { clean: '', info: '', medium: 'warn', high: 'bad' };
const PROMPT_SVG = '<path d="M5.5 13 10.5 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>';

async function loadLibraries() {
  state.libraries = await api('/api/libraries');
  await Promise.all([loadWant(), loadSources()].map((p) => p.catch(() => {})));
}
const libById = (id) => state.libraries?.libraries.find((l) => l.id === id);

function itemIcon(type) { return svg('0 0 16 16', type === 'prompt' ? PROMPT_SVG : FOLDER_SVG, `item-icon ${type}`); }

function renderLibraryList() {
  renderRail({});
  if (state.libSection === 'links') return renderSourceList();
  if (state.libSection === 'want') return renderWantList();
  if (!state.libraries) { els.list.append(...Array.from({ length: 4 }, () => h('div', { class: 'skeleton' }))); return; }
  const q = state.q.trim().toLowerCase();
  const libs = state.libraries.libraries.filter((l) => matches(`${l.name} ${l.description} ${l.items.map((i) => `${i.name} ${i.bestFor}`).join(' ')}`, q));
  els.head.replaceChildren(
    h('span', {}, h('strong', {}, libs.length), libs.length === 1 ? ' library' : ' libraries'),
    h('span', { class: 'head-actions' },
      h('button', { class: 'btn btn-sm btn-quiet', type: 'button', onclick: () => select(IMPORT_KEY) }, 'Import'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => select(NEW_KEY) }, 'New library')));
  if (!libs.length) {
    els.list.append(h('div', { class: 'empty' }, state.q ? `No library matches “${state.q}”.` : 'No libraries yet.',
      h('p', {}, state.q ? 'Try a shorter word.' : 'A library is a set of skills and prompts you can hand to someone else. Start one from skills you already use.'),
      state.q ? null : h('div', { class: 'actions', style: 'justify-content:center' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => select(NEW_KEY) }, 'Start a library'),
        h('button', { class: 'btn', type: 'button', onclick: () => select(IMPORT_KEY) }, 'Import one'))));
    return;
  }
  listOptions(libs, (l) => rowEl(l.id, state.selected === l.id, select,
    h('div', {},
      h('div', { class: 'row-name' }, l.name),
      h('div', { class: 'row-sub' }, l.description || l.items.map((i) => i.name).slice(0, 4).join(', ') || 'Empty')),
    h('span', { class: 'row-status' }, plural(l.items.length, 'item'))));
}

function renderLibraryDetail(key) {
  if (key === IMPORT_KEY) return renderImport();
  if (key === NEW_KEY) return renderNewLibrary();
  if (!key && state.libSection === 'links') return blankDetail('Choose a library you imported from a link to see where it came from and check it for updates.');
  if (!key && state.libSection === 'want') return blankDetail('Choose a saved link, or paste one above to save it.');
  if (key?.startsWith('src:')) return renderSourceDetail(key);
  if (key?.startsWith('want:')) return renderWantDetail(key);
  const lib = libById(key);
  if (!lib) return blankDetail('Choose a library, or start one from skills you already use.');
  const skills = lib.items.filter((i) => i.type === 'skill').length;
  const prompts = lib.items.length - skills;
  const kids = [backBtn(),
    h('h1', {}, lib.name),
    h('p', { class: 'lede' }, lib.description || 'No description yet. Say who this library is for and what it helps with.'),
    h('div', { class: 'meta' },
      h('span', {}, [plural(skills, 'skill'), prompts ? plural(prompts, 'prompt') : null].filter(Boolean).join(' and ')),
      lib.updatedAt ? h('span', {}, `Changed ${fmtTime(lib.updatedAt)}`) : null,
      h('code', { class: 'one-line', title: tildify(lib.dir) }, tildify(lib.dir)))];

  kids.push(h('div', { class: 'section-head' }, h('h2', {}, 'In this library'), addMenuButton(lib)));
  if (!lib.items.length) {
    kids.push(h('div', { class: 'notice' }, h('strong', {}, 'Empty. '), 'Add skills or prompts you already have. Each one is copied into the library, so later edits to your installed copy do not change what you share.'));
  } else {
    kids.push(h('ul', { class: 'lib-items' }, lib.items.map((item) => libItemEl(lib, item))));
  }

  kids.push(h('h2', {}, 'Share it'));
  const dest = h('input', { class: 'text-input', id: 'export-dest', value: state.exportDest || '~/Desktop', spellcheck: 'false', autocomplete: 'off', oninput: (e) => { state.exportDest = e.target.value; } });
  kids.push(h('p', { class: 'use-note' }, 'Export writes a folder with library.json and a README. Send it as a zip or push it to a git repository. Others open Libraries, choose Import and pick the folder.'),
    h('div', { class: 'inline-form' },
      h('label', { class: 'field grow', for: 'export-dest' }, 'Export into', dest),
      h('button', { class: 'btn btn-primary', type: 'button', disabled: !lib.items.length, onclick: () => exportLib(lib.id, dest.value) }, 'Export folder')));
  els.detail.replaceChildren(...kids);
}

function libItemEl(lib, item) {
  const note = h('input', {
    class: 'bestfor', value: item.bestFor || '', maxlength: '200', placeholder: 'Best for…', spellcheck: 'true',
    'aria-label': `What ${item.name} is best for`,
    onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.value = item.bestFor || ''; e.target.blur(); e.stopPropagation(); } },
    onchange: (e) => libItem(lib.id, item, { bestFor: e.target.value.trim() }),
  });
  const chips = h('span', { class: 'chips', role: 'group', 'aria-label': `Apps for ${item.name}` }, APPS.map((a) => {
    const on = item.apps.includes(a.id);
    return h('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(on), title: on ? `Made for ${a.label}` : `Not marked for ${a.label}`,
      disabled: on && item.apps.length === 1,
      onclick: () => libItem(lib.id, item, { apps: on ? item.apps.filter((x) => x !== a.id) : [...item.apps, a.id] }),
    }, a.id === 'claude' ? 'Claude' : 'Codex');
  }));
  const more = h('button', { class: 'btn btn-text', type: 'button', 'aria-label': `More for ${item.name}` }, '•••');
  trackMenu(createMenu({ anchor: more, label: `${item.name} actions`, align: 'end', items: [
    { label: 'Remove from library', danger: true, run: () => libItem(lib.id, item, { remove: true }) },
  ] }));
  return h('li', { class: 'lib-item' },
    itemIcon(item.type),
    h('div', { class: 'lib-item-name' }, item.name, item.type === 'prompt' ? h('span', { class: 'tag' }, 'Prompt') : null),
    chips, more, note);
}

function addMenuButton(lib) {
  const btn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Add skills or prompts');
  btn.addEventListener('click', () => openPicker(lib));
  return btn;
}

// Sheet with a filterable checklist of installed skills and prompts.
function openPicker(lib) {
  const have = new Set(lib.items.map((i) => `${i.type}:${i.name}`));
  const pool = [
    ...(state.data?.groups || []).map((g) => ({ type: 'skill', name: g.name, desc: g.description })),
    ...(state.data?.prompts?.groups || []).map((g) => ({ type: 'prompt', name: g.name, desc: (state.data.prompts.prompts.find((p) => p.name === g.name && !p.broken) || {}).description })),
  ].filter((x) => !have.has(`${x.type}:${x.name}`));
  const picked = new Set();
  const dlg = h('dialog', { class: 'sheet picker', 'aria-labelledby': 'picker-title' });
  const list = h('div', { class: 'picker-list', role: 'group', 'aria-label': 'Installed skills and prompts' });
  const go = h('button', { class: 'cap cap-primary', type: 'button', disabled: true, onclick: async () => { dlg.close(); await addToLibrary(lib.id, picked); } }, 'Add');
  const draw = (q = '') => {
    const rows = pool.filter((x) => matches(`${x.name} ${x.desc || ''}`, q.toLowerCase()));
    list.replaceChildren(...(rows.length ? rows.map((x) => {
      const key = `${x.type}:${x.name}`;
      const id = `pk-${cssId(key)}`;
      return h('div', { class: 'pack-skill' },
        h('input', { type: 'checkbox', id, checked: picked.has(key), onchange: (e) => { e.target.checked ? picked.add(key) : picked.delete(key); go.disabled = !picked.size; go.textContent = picked.size ? `Add ${picked.size}` : 'Add'; } }),
        h('label', { for: id }, h('div', { class: 'nm' }, x.name, x.type === 'prompt' ? h('span', { class: 'tag' }, 'Prompt') : null), h('div', { class: 'ds' }, x.desc || 'No description.')),
        h('span'));
    }) : [h('div', { class: 'empty' }, pool.length ? 'Nothing matches.' : 'Everything you have is already in this library.')]));
  };
  const search = h('input', { class: 'text-input', type: 'search', placeholder: 'Filter', 'aria-label': 'Filter skills and prompts', oninput: (e) => draw(e.target.value) });
  dlg.append(
    h('div', { class: 'sheet-head' }, h('h2', { id: 'picker-title' }, `Add to ${lib.name}`), h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => dlg.close() }, 'Cancel', glyph('esc'))),
    search, list,
    h('div', { class: 'review-actions' }, go));
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('keydown', (e) => e.stopPropagation());
  document.body.append(dlg);
  draw();
  dlg.showModal();
  search.focus();
}

async function libPost(path, body, done) {
  try {
    const res = await api(path, body);
    state.libraries = { ...state.libraries, libraries: res.libraries };
    if (done) done(res.result);
    render();
    return res.result;
  } catch (err) { toast(err.message, { error: true }); return null; }
}
const libItem = (libraryId, item, patch) => libPost('/api/libraries/item', { libraryId, type: item.type, name: item.name, ...patch },
  () => { if (patch.remove) toast(`Removed ${item.name} from the library. The files are in backups.`); });
async function addToLibrary(libraryId, picked) {
  const skills = [], prompts = [];
  for (const key of picked) { const [type, ...rest] = key.split(':'); (type === 'skill' ? skills : prompts).push(rest.join(':')); }
  await libPost('/api/libraries/add', { libraryId, skills, prompts }, () => toast(`Added ${plural(picked.size, 'item')}. Edit the best-for notes so others know when to use each one.`));
}
async function exportLib(libraryId, dest) {
  await libPost('/api/libraries/export', { libraryId, dest }, (r) => toast(`Exported to ${tildify(r.dir)}.`));
}

function renderNewLibrary() {
  const name = h('input', { class: 'text-input', id: 'lib-name', maxlength: '80', placeholder: 'UI kit', autocomplete: 'off' });
  const desc = h('textarea', { class: 'text-input', id: 'lib-desc', maxlength: '600', rows: '3', placeholder: 'Skills I use for layout, motion and polish.' });
  const preset = state.newLibSeed ? [...state.newLibSeed] : [];
  const create = async () => {
    if (!name.value.trim()) { name.focus(); toast('Give the library a name.', { error: true }); return; }
    const lib = await libPost('/api/libraries/create', { name: name.value, description: desc.value.trim() });
    if (!lib) return;
    if (preset.length) await addToLibrary(lib.id, new Set(preset));
    state.newLibSeed = null;
    select(lib.id);
  };
  els.detail.replaceChildren(backBtn(),
    h('h1', {}, 'New library'),
    h('p', { class: 'lede' }, 'Group the skills and prompts that work well together, add a line on what each is best for, and share the folder.'),
    h('div', { class: 'form' },
      h('label', { class: 'field', for: 'lib-name' }, 'Name', name),
      h('label', { class: 'field', for: 'lib-desc' }, 'Who it is for and what it helps with', desc),
      preset.length ? h('p', { class: 'use-note' }, `Starts with ${preset.map((k) => k.split(':').slice(1).join(':')).join(', ')}.`) : null,
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: create }, 'Create library'))));
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  name.focus();
}

/* ---------- libraries from git links, "Check for updates", and "Want to try" ---------- */
const LIB_SECTIONS = [
  { id: 'libraries', label: 'Libraries', search: 'Search libraries' },
  { id: 'links', label: 'From links', search: 'Search libraries from links' },
  { id: 'want', label: 'Want to try', search: 'Search saved links' },
];
const SOURCE_LABEL = { instagram: 'Instagram', github: 'GitHub', web: 'Web' };
const STATUS_OPTS = [['saved', 'Saved'], ['reviewed', 'Reviewed'], ['added', 'Added'], ['dismissed', 'Dismissed']];
const STATUS_LABEL = Object.fromEntries(STATUS_OPTS);
const shortSha = (c) => (c ? String(c).slice(0, 7) : '');
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
const isPathLike = (v) => /^[/~.]/.test(v);
const importLabel = (v) => { const t = (v || '').trim(); return !t || isPathLike(t) ? 'Read folder' : 'Fetch library'; };
// The saved url is the bare repo, so the branch and folder are put back to rebuild the link it came from.
function linkOf(src) {
  const base = String(src.url).replace(/\.git$/, '');
  return src.ref ? `${base}/tree/${src.ref}${src.subdir ? `/${src.subdir}` : ''}` : base;
}
async function loadWant() { state.want = (await api('/api/want')).items || []; }
async function loadSources() { const r = await api('/api/libraries/sources'); state.sources = Array.isArray(r) ? r : r.sources || []; }
function setPreview(res, source) {
  state.importPreview = res;
  state.importSource = source || null;
  state.importPicks = new Map(res.items.map((i) => [`${i.type}:${i.name}`, i.safety.level !== 'high']));
}

function renderLibraryRail() {
  const counts = { libraries: state.libraries?.libraries.length, links: state.sources?.length, want: state.want?.length };
  const facet = (s) => h('button', {
    class: 'facet', type: 'button', 'aria-pressed': String(state.libSection === s.id), onclick: () => setLibSection(s.id),
  }, h('span', { class: 'facet-label' }, s.label), h('span', { class: 'facet-n' }, counts[s.id] ?? ''));
  els.rail.replaceChildren(h('h2', {}, 'Libraries'), facet(LIB_SECTIONS[0]), facet(LIB_SECTIONS[1]), h('h2', {}, 'Later'), facet(LIB_SECTIONS[2]));
}
function setLibSection(id) {
  state.libSection = id; state.selected = null; state.previewing = null; state.pinned = false;
  els.app.classList.remove('show-detail');
  els.search.placeholder = LIB_SECTIONS.find((s) => s.id === id).search;
  render();
  const load = id === 'links' ? loadSources : id === 'want' ? loadWant : null;
  if (load) load().then(render, (err) => toast(err.message, { error: true }));
}

function renderSourceList() {
  if (!state.sources) { els.head.replaceChildren(); els.list.append(...Array.from({ length: 3 }, () => h('div', { class: 'skeleton' }))); return; }
  const q = state.q.trim().toLowerCase();
  const srcs = state.sources.filter((s) => matches(`${s.name || ''} ${s.url}`, q));
  els.head.replaceChildren(h('span', {}, h('strong', {}, srcs.length), srcs.length === 1 ? ' linked library' : ' linked libraries'));
  if (!srcs.length) {
    els.list.append(h('div', { class: 'empty' }, state.q ? `No linked library matches “${state.q}”.` : 'No libraries from links yet.',
      h('p', {}, state.q ? 'Try a shorter word.' : 'Import a library from a git link. It shows up here, so you can check it for updates.')));
    return;
  }
  listOptions(srcs, (s) => rowEl(`src:${s.url}`, state.selected === `src:${s.url}`, select,
    h('div', {}, h('div', { class: 'row-name' }, s.name || s.url),
      h('div', { class: 'row-sub' }, [shortSha(s.commit), s.fetchedAt ? `fetched ${fmtTime(s.fetchedAt)}` : ''].filter(Boolean).join(' · ')))));
}

function renderSourceDetail(key) {
  const url = key.slice(4);
  const src = (state.sources || []).find((s) => s.url === url);
  if (!src) return blankDetail('Choose a library you imported from a link to see where it came from and check it for updates.');
  const busy = state.checking === src.url;
  const check = state.linkCheck?.url === src.url ? state.linkCheck.res : null;
  const kids = [backBtn(), h('h1', {}, src.name || 'Library from a link'),
    h('div', { class: 'meta' },
      src.commit ? h('span', {}, `Commit ${shortSha(src.commit)}`) : null,
      src.ref ? h('span', {}, `Branch or tag ${src.ref}`) : null,
      src.subdir ? h('span', {}, `Folder ${src.subdir}`) : null,
      src.fetchedAt ? h('span', {}, `Fetched ${fmtTime(src.fetchedAt)}`) : null,
      h('code', { class: 'one-line', title: linkOf(src) }, linkOf(src))),
    h('p', { class: 'use-note' }, 'Kept in Bindery’s cache on this computer. Nothing is installed until you review it and apply.'),
    h('div', { class: 'path' }, tildify(src.dir)),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', disabled: busy, onclick: () => checkUpdates(src) }, busy ? 'Checking…' : 'Check for updates'))];
  if (check) kids.push(h('h2', {}, 'Changes since the last copy'), changesEl(check),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => reviewFetched(check) }, 'Review changes')));
  els.detail.replaceChildren(...kids);
}

async function checkUpdates(src) {
  state.checking = src.url; state.linkCheck = null; renderDetail();
  try {
    const res = await api('/api/libraries/fetch', { url: linkOf(src) });
    state.linkCheck = { url: src.url, res };
  } catch (err) { toast(err.message, { error: true }); }
  finally { state.checking = null; }
  await loadSources().catch(() => {});
  renderList(); renderDetail();
}
function changesEl(res) {
  const c = res.changes;
  if (!c) return h('p', { class: 'use-note' }, 'No earlier copy to compare with.');
  const groups = [
    ['Added', c.added.map((i) => `${i.name} (${i.type})`)],
    ['Changed', c.changed.map((i) => `${i.name} (${i.parts.join(' and ')})`)],
    ['Removed', c.removed.map((i) => `${i.name} (${i.type})`)],
  ].filter(([, list]) => list.length);
  if (!groups.length) return h('p', { class: 'use-note' }, 'Up to date.');
  return h('div', { class: 'changes' }, groups.map(([label, list]) => h('div', {},
    h('h3', { class: 'changes-label' }, label), h('ul', { class: 'changes-list' }, list.map((t) => h('li', {}, t))))));
}
function reviewFetched(res) {
  setPreview(res, res.source);
  state.importDir = linkOf(res.source);
  select(IMPORT_KEY);
}

function renderWantList() {
  if (!state.want) { els.head.replaceChildren(); els.list.append(...Array.from({ length: 3 }, () => h('div', { class: 'skeleton' }))); return; }
  const q = state.q.trim().toLowerCase();
  const items = state.want.filter((it) => matches(`${it.title} ${it.creator} ${it.note} ${it.url}`, q));
  const form = h('form', { class: 'want-add', novalidate: true, onsubmit: addLink },
    h('label', { class: 'visually-hidden', for: 'want-url' }, 'Link to save'),
    h('input', { class: 'text-input', id: 'want-url', type: 'url', placeholder: 'Paste a link to a Reel, repo or post', autocomplete: 'off', spellcheck: 'false' }),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'));
  els.head.replaceChildren(h('span', {}, h('strong', {}, items.length), items.length === 1 ? ' saved link' : ' saved links'), form);
  if (!items.length) {
    els.list.append(h('div', { class: 'empty' }, state.q ? `Nothing matches “${state.q}”.` : 'Nothing saved yet.',
      h('p', {}, state.q ? 'Try a shorter word.' : 'Paste a link to a Reel, repo or post you want to try later. It stays on this computer.')));
    return;
  }
  listOptions(items, (it) => rowEl(`want:${it.id}`, state.selected === `want:${it.id}`, select,
    h('div', {}, h('div', { class: 'row-name' }, it.title || it.url),
      h('div', { class: 'row-sub' }, `${SOURCE_LABEL[it.source] || 'Web'} · ${STATUS_LABEL[it.status] || it.status}`))));
}

async function addLink(e) {
  e.preventDefault();
  const input = document.getElementById('want-url');
  const url = input.value.trim();
  if (!url) { input.focus(); toast('Paste a link first.', { error: true }); return; }
  try {
    const r = await api('/api/want/add', { url });
    state.want = r.items;
    render();
    select(`want:${r.item.id}`);
    document.getElementById('want-url')?.focus();
    toast('Saved to Want to try.');
  } catch (err) { toast(err.message, { error: true }); }
}

function renderWantDetail(key) {
  const it = (state.want || []).find((x) => `want:${x.id}` === key);
  if (!it) return blankDetail('Choose a saved link, or paste one above to save it.');
  const h1 = h('h1', {}, it.title || it.url);
  const titleIn = h('input', { class: 'text-input', id: 'w-title', value: it.title || '', maxlength: '120', autocomplete: 'off' });
  const creatorIn = h('input', { class: 'text-input', id: 'w-creator', value: it.creator || '', maxlength: '80', autocomplete: 'off' });
  const repoIn = h('input', { class: 'text-input', id: 'w-repo', value: it.repo || '', maxlength: '2048', placeholder: 'owner/repo or https://…', spellcheck: 'false', autocomplete: 'off' });
  const noteIn = h('textarea', { class: 'text-input', id: 'w-note', rows: '4', maxlength: '1000', placeholder: 'Why you saved it, or what to try first' });
  noteIn.value = it.note || '';
  // Saves on blur or change. The detail is not rebuilt, so the field being typed in keeps its focus.
  const save = async (patch) => {
    try {
      const r = await api('/api/want/update', { id: it.id, ...patch });
      state.want = r.items;
      h1.textContent = r.item.title || r.item.url;
      titleIn.value = r.item.title || '';
      renderList();
      toast('Saved');
    } catch (err) { toast(err.message, { error: true }); renderDetail(); }
  };
  const segBtns = STATUS_OPTS.map(([v, l]) => h('button', {
    type: 'button', 'aria-pressed': String(it.status === v),
    onclick: () => { segBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(STATUS_OPTS[i][0] === v))); save({ status: v }); },
  }, l));
  const host = hostOf(it.url) || it.url;
  const link = /^https?:\/\//i.test(it.url)
    ? h('a', { href: it.url, target: '_blank', rel: 'noopener noreferrer' }, host)
    : h('span', {}, host);
  els.detail.replaceChildren(backBtn(), h1,
    h('div', { class: 'meta' }, link, h('span', {}, SOURCE_LABEL[it.source] || 'Web'), h('span', {}, `Saved ${fmtTime(it.createdAt)}`),
      h('code', { class: 'one-line', title: it.url }, it.url)),
    h('div', { class: 'form' },
      h('label', { class: 'field', for: 'w-title' }, 'Title', titleIn),
      h('label', { class: 'field', for: 'w-creator' }, 'Creator', creatorIn),
      h('label', { class: 'field', for: 'w-repo' }, 'Source repo', repoIn),
      h('label', { class: 'field', for: 'w-note' }, 'Note', noteIn),
      h('div', { class: 'field' }, h('span', {}, 'Status'), h('div', { class: 'seg', role: 'group', 'aria-label': 'Status' }, segBtns))),
    h('div', { class: 'actions' },
      // A GitHub link is itself a repository, so it can be imported without filling Source repo.
      (it.repo || it.source === 'github') ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => importFromRepo(it.repo || it.url) }, 'Import repo') : null,
      h('button', { class: 'btn', type: 'button', onclick: copyList }, 'Copy list as Markdown'),
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => removeLink(it) }, 'Remove')));
  titleIn.addEventListener('change', () => save({ title: titleIn.value.trim() }));
  creatorIn.addEventListener('change', () => save({ creator: creatorIn.value.trim() }));
  repoIn.addEventListener('change', () => save({ repo: repoIn.value.trim() }));
  noteIn.addEventListener('change', () => save({ note: noteIn.value.trim() }));
}

function importFromRepo(repo) {
  state.importDir = repo; state.importPreview = null; state.importSource = null;
  select(IMPORT_KEY);
  fetchLink(repo);
}
async function copyList() {
  let markdown;
  try { ({ markdown } = await api('/api/want/export')); }
  catch (err) { toast(err.message, { error: true }); return; }
  try { await navigator.clipboard.writeText(markdown); toast('Copied'); }
  catch { toast('Could not reach the clipboard. Select the list text by hand.', { error: true }); }
}
async function removeLink(it) {
  try {
    const r = await api('/api/want/remove', { id: it.id });
    state.want = r.items; state.selected = null; state.previewing = null;
    render();
    toast('Removed. A copy is kept in backups.');
  } catch (err) { toast(err.message, { error: true }); }
}

/* import: read a folder or fetch a git link, show items with safety findings, then install through a reviewed plan */
async function readFolder(p) {
  try { setPreview(await api(`/api/libraries/preview?dir=${encodeURIComponent(p)}`), null); }
  catch (err) { state.importPreview = null; toast(err.message, { error: true }); }
  renderDetail();
}
// While a git fetch runs, the agent face looks left and right in the button.
function busyFace(btn) {
  if (!btn) return () => {};
  const face = faceEl(document, 'look-left', { size: 'sm', label: '' });
  btn.disabled = true;
  btn.replaceChildren(face, 'Fetching…');
  return animateFace(face, ['look-left', 'look-right']);
}
async function fetchLink(url) {
  state.importBusy = true;
  const stop = busyFace(document.getElementById('import-go'));
  try { const res = await api('/api/libraries/fetch', { url }); setPreview(res, res.source); }
  catch (err) { state.importPreview = null; toast(err.message, { error: true }); }
  finally { stop(); state.importBusy = false; renderDetail(); }
}
// The import's safety result as a readout: CLEAN, 2 MEDIUM or 1 HIGH, coloured by the worst level.
function safetyReadout(imp) {
  const count = (lvl) => imp.items.filter((i) => i.safety.level === lvl).length;
  const high = count('high'), medium = count('medium');
  const [text, tone] = high ? [`${high} HIGH`, 'red'] : medium ? [`${medium} MEDIUM`, 'amber'] : ['CLEAN', 'signal'];
  const el = readoutEl(document, text, { size: 'md', tone, label: `Safety: ${LEVEL_TEXT[imp.level] || text}` });
  el.classList.add('import-readout');
  return el;
}
function renderImport() {
  const imp = state.importPreview;
  const dir = h('input', { class: 'text-input', id: 'import-dir', value: state.importDir || '', placeholder: 'owner/repo or ~/Downloads/ui-kit', spellcheck: 'false', autocomplete: 'off', oninput: (e) => {
    state.importDir = e.target.value;
    const b = document.getElementById('import-go');
    if (b && !state.importBusy) b.textContent = importLabel(e.target.value);
  } });
  const go = () => {
    if (state.importBusy) return;
    const v = dir.value.trim();
    if (!v || isPathLike(v)) readFolder(v); else fetchLink(v);
  };
  dir.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  const kids = [backBtn(), h('h1', {}, 'Import a library'),
    h('p', { class: 'lede' }, 'Pick a library folder someone shared with you, or paste a git link to one. Bindery reads it and checks every file before anything is installed. Nothing runs during the check.'),
    h('div', { class: 'inline-form' }, h('label', { class: 'field grow', for: 'import-dir' }, 'Library folder or link', dir),
      h('button', { class: 'btn', type: 'button', id: 'import-go', disabled: state.importBusy, onclick: go }, importLabel(state.importDir)))];
  if (imp) {
    const m = imp.manifest;
    kids.push(h('div', { class: 'import-card' },
      h('div', { class: 'import-title' }, h('strong', {}, m.name), m.author ? h('span', {}, ` by ${m.author}`) : null, safetyReadout(imp)),
      m.description ? h('p', {}, m.description) : null,
      h('div', { class: 'meta' }, h('span', {}, `Version ${m.version}`), h('span', {}, imp.license ? `Licence: ${imp.license}` : 'No licence given'))));
    if (state.importSource) kids.push(h('p', { class: 'use-note' }, `From ${linkOf(state.importSource)}${shortSha(state.importSource.commit) ? ` at ${shortSha(state.importSource.commit)}` : ''}`));
    if (imp.problems?.length) kids.push(h('div', { class: 'notice warn' }, h('strong', {}, 'This folder is incomplete. '), imp.problems.join(' ')));
    const picks = state.importPicks;
    kids.push(h('h2', {}, plural(imp.items.length, 'item')));
    kids.push(h('div', {}, imp.items.map((item) => {
      const key = `${item.type}:${item.name}`;
      const id = `im-${cssId(key)}`;
      const f = item.safety.findings;
      return h('div', { class: 'pack-skill' },
        h('input', { type: 'checkbox', id, checked: !!picks.get(key), onchange: (e) => { picks.set(key, e.target.checked); renderDetail(); } }),
        h('label', { for: id },
          h('div', { class: 'nm' }, item.name, item.type === 'prompt' ? h('span', { class: 'tag' }, 'Prompt') : null, item.safety.level !== 'clean' ? h('span', { class: `tag ${LEVEL_TAG[item.safety.level]}` }, LEVEL_TEXT[item.safety.level]) : null),
          h('div', { class: 'ds' }, item.bestFor || 'No best-for note.'),
          f.length ? h('details', { class: 'findings' }, h('summary', {}, plural(f.length, 'finding')),
            h('ul', {}, f.slice(0, 20).map((x) => h('li', {}, h('span', { class: `dot ${LEVEL_TAG[x.level] || ''}` }), `${x.message} `, x.file ? h('code', {}, `${x.file}${x.line ? `:${x.line}` : ''}`) : null, x.excerpt ? h('div', { class: 'path' }, x.excerpt) : null)))) : null),
        h('span', { class: 'chips' }, item.apps.map((a) => h('span', { class: 'chip', 'aria-pressed': 'true' }, a === 'claude' ? 'Claude' : 'Codex'))));
    })));
    const chosen = imp.items.filter((i) => picks.get(`${i.type}:${i.name}`));
    kids.push(h('div', { class: 'install-bar' }, h('div', { class: 'install-row' },
      h('span', { class: 'use-note' }, 'Each item is copied into the apps it is made for. You review every file change before it happens, and can undo it from History.'),
      h('button', { class: 'btn btn-primary', type: 'button', disabled: !chosen.length, onclick: () => planLibrary(imp.dir, chosen) }, chosen.length ? `Review ${plural(chosen.length, 'install')}` : 'Choose items'))));
  }
  els.detail.replaceChildren(...kids);
  if (!imp) dir.focus();
}
async function planLibrary(dir, items) {
  try { openReview(await api('/api/plan', { kind: 'library', dir, picks: items.map((i) => ({ type: i.type, name: i.name })) }), 'Share'); }
  catch (err) { toast(err.message, { error: true }); }
}

// "Add to library" from a skill or prompt detail page.
function addToLibraryButton(type, name) {
  const btn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Add to library');
  const items = () => [
    ...(state.libraries?.libraries || []).map((l) => ({ label: l.name, disabled: l.items.some((i) => i.type === type && i.name === name), run: () => addToLibrary(l.id, new Set([`${type}:${name}`])) })),
    { label: 'New library…', run: () => { state.newLibSeed = [`${type}:${name}`]; switchView('libraries').then(() => select(NEW_KEY)); } },
  ];
  const menu = trackMenu(createMenu({ anchor: btn, label: 'Add to library', items: items() }));
  btn.addEventListener('pointerdown', () => menu.setItems(items()), { capture: true });
  btn.addEventListener('keydown', () => menu.setItems(items()), { capture: true });
  return btn;
}

/* ---------- prompts ---------- */
function promptGroups() { return state.data?.prompts?.groups || []; }
function promptEntries(g) { const all = state.data?.prompts?.prompts || []; return g.entries.map((id) => all.find((p) => p.id === id)).filter(Boolean); }
function promptPair(g) {
  const tied = g.apps.claude && g.apps.codex && g.sameSource;
  return h('span', { class: 'pair', role: 'img', 'aria-label': APPS.map((a) => `${a.label} ${g.apps[a.id] ? 'on' : 'off'}`).join(', ') + (tied ? ', same file' : '') },
    h('span', { class: `slot ${g.apps.claude ? (g.differs ? 'differs' : 'on') : ''}` }), tied ? h('span', { class: 'tie' }) : null, h('span', { class: `slot ${g.apps.codex ? (g.differs ? 'differs' : 'on') : ''}` }));
}
function renderPromptList() {
  renderRail({});
  if (!state.data) return;
  const q = state.q.trim().toLowerCase();
  const all = promptGroups();
  const rows = all.filter((g) => matches(`${g.name} ${promptEntries(g).map((p) => p.description).join(' ')}`, q));
  els.head.replaceChildren(h('span', {}, h('strong', {}, rows.length), rows.length === 1 ? ' prompt' : ' prompts'), pairHead());
  if (!rows.length) {
    els.list.append(h('div', { class: 'empty' }, state.q ? `Nothing matches “${state.q}”.` : 'No saved prompts yet.',
      h('p', {}, 'Prompts are the slash commands in ~/.claude/commands and ~/.codex/prompts. Any you add there show up here.')));
    return;
  }
  listOptions(rows, (g) => rowEl(`p:${g.name}`, state.selected === `p:${g.name}`, select,
    h('div', {}, h('div', { class: 'row-name' }, `/${g.name}`), h('div', { class: 'row-sub' }, promptEntries(g).find((p) => p.description)?.description || 'No description')),
    promptPair(g)));
}
function renderPromptDetail(key) {
  const g = promptGroups().find((x) => `p:${x.name}` === key);
  if (!g) return blankDetail('Choose a prompt to see where it lives and share it with the other app.');
  const entries = promptEntries(g);
  const desc = entries.find((p) => p.description)?.description;
  const keys = h('div', { class: 'use-in', role: 'group', 'aria-label': 'Apps that can use this prompt' }, APPS.map((a) => {
    const on = !!g.apps[a.id];
    const other = APPS.find((x) => x !== a);
    const can = on ? entries.some((p) => p.app === a.id && p.scope === 'global') : !!g.apps[other.id];
    return h('button', { class: 'cap switch', type: 'button', 'data-key': a.key, 'aria-pressed': String(on), disabled: !can, 'aria-keyshortcuts': a.key, onclick: () => planPromptShare(g.name, a.id, !on) },
      h('span', { class: 'switch-top' }, h('span', { class: 'bump', 'aria-hidden': 'true' }), glyph(a.key)),
      h('span', { class: 'switch-name' }, a.label, h('span', { class: 'switch-state' }, on ? (can ? 'On. Press to turn off' : 'On') : can ? 'Off. Press to turn on' : 'Off')));
  }));
  els.detail.replaceChildren(backBtn(),
    h('h1', {}, `/${g.name}`),
    h('p', { class: 'lede' }, desc || 'This prompt has no description.'),
    h('h2', {}, 'Use in'), keys,
    h('p', { class: 'use-note' }, g.apps.claude && g.apps.codex ? (g.sameSource ? 'Both apps read the same file.' : g.differs ? 'The two apps have different versions of this prompt.' : 'Each app has its own copy.') : 'Turning on the other app links it to this file, so there is one copy to edit.'),
    h('h2', {}, 'Where it lives'),
    h('ul', { class: 'readers flat' }, entries.map((p) => h('li', { class: 'reader' }, h('span', { class: 'reader-who' }, APP[p.app].label), h('span', { class: 'reader-how' }, p.broken ? `${tildify(p.path)} (missing)` : p.isSymlink ? `${tildify(p.path)} links to ${tildify(p.realPath)}` : tildify(p.path))))),
    h('div', { class: 'actions' }, addToLibraryButton('prompt', g.name)));
}
async function planPromptShare(name, app, on) {
  try { openReview(await api('/api/plan', { kind: 'prompt-share', name, app, on }), 'Share'); }
  catch (err) { toast(err.message, { error: true }); }
}


/* ---------- sort, rail note, settings, command menu ---------- */
const SORTS = [['name', 'Name'], ['changed', 'Recently changed'], ['files', 'Most files']];
let sortMenu = null;
function sortButton() {
  const btn = h('button', { class: 'btn btn-text sort-btn', type: 'button' }, `Sort: ${SORTS.find((s) => s[0] === state.sort)[1]}`);
  sortMenu?.destroy();
  sortMenu = createMenu({ anchor: btn, label: 'Sort skills', items: SORTS.map(([id, label]) => ({ label, radio: true, checked: state.sort === id, run: () => { state.sort = id; renderList(); } })) });
  return btn;
}
function railNote() {
  return [h('h2', {}, 'Prompts'), h('p', { class: 'rail-text' }, 'Saved slash commands. Turn one on for the other app to use it there too.')];
}
const SHORTCUTS = [
  { keys: ['⌘', 'K'], label: 'Commands and search' },
  { keys: ['/'], label: 'Search this view' },
  { keys: ['1', '–', '5'], label: 'Switch view' },
  { keys: ['↑', '↓'], label: 'Move through the list' },
  { keys: ['c'], label: 'Turn Claude Code on or off for the selected item' },
  { keys: ['x'], label: 'Turn Codex on or off for the selected item' },
  { keys: ['n'], label: 'New library' },
  { keys: ['u'], label: 'Undo the last change' },
  { keys: [','], label: 'Settings' },
];
function showSettings() {
  openSettings({ stateDir: tildify(state.data?.stateDir || ''), version: VERSION, shortcuts: SHORTCUTS });
}
const commandMenu = createCommandMenu({
  placeholder: 'Jump to a skill, prompt, library or action',
  getItems: () => [
    ...VIEWS.map((v, i) => ({ id: `view:${v.id}`, group: 'Go to', label: v.label, shortcut: String(i + 1), run: () => switchView(v.id) })),
    { id: 'act:new', group: 'Actions', label: 'New library', keywords: 'create collection', shortcut: 'n', run: () => switchView('libraries').then(() => select(NEW_KEY)) },
    { id: 'act:import', group: 'Actions', label: 'Import a library', keywords: 'folder share', run: () => switchView('libraries').then(() => select(IMPORT_KEY)) },
    { id: 'act:undo', group: 'Actions', label: 'Undo the last change', shortcut: 'u', run: () => undo() },
    { id: 'act:settings', group: 'Actions', label: 'Settings', keywords: 'theme backups privacy', shortcut: ',', run: showSettings },
    ...['system', 'light', 'dark'].map((t) => ({ id: `theme:${t}`, group: 'Theme', label: `Theme: ${t[0].toUpperCase()}${t.slice(1)}`, keywords: 'appearance mode', run: () => globalThis.acTheme?.set(t) })),
    ...(state.libraries?.libraries || []).map((l) => ({ id: `lib:${l.id}`, group: 'Libraries', label: l.name, hint: plural(l.items.length, 'item'), keywords: l.items.map((i) => i.name).join(' '), run: () => switchView('libraries').then(() => select(l.id)) })),
    ...(state.data?.groups || []).map((g) => ({ id: `skill:${g.name}`, group: 'Skills', label: g.name, hint: g.description, run: () => switchView('installed').then(() => select(g.name)) })),
    ...promptGroups().map((g) => ({ id: `prompt:${g.name}`, group: 'Prompts', label: `/${g.name}`, keywords: g.name, run: () => switchView('prompts').then(() => select(`p:${g.name}`)) })),
  ],
});

/* ---------- actions ---------- */
function select(key) {
  // Import and New library live in the Libraries section only, so opening them from elsewhere switches back.
  if ((key === IMPORT_KEY || key === NEW_KEY) && state.view === 'libraries' && state.libSection !== 'libraries') {
    state.libSection = 'libraries';
    renderList();
  }
  state.selected = key;
  state.previewing = null;
  state.pinned = true;
  for (const el of els.list.querySelectorAll('.row')) el.setAttribute('aria-selected', String(el.dataset.key === key));
  els.list.setAttribute('aria-activedescendant', `opt-${cssId(key)}`);
  document.getElementById(`opt-${cssId(key)}`)?.scrollIntoView({ block: 'nearest' });
  renderDetail();
  if (isNarrow()) els.app.classList.add('show-detail');
}
function preview(key) { if (state.selected && key !== state.selected) return; state.previewing = key; renderDetail(); }

async function fetchPack(id) {
  const btn = document.getElementById('fetch-btn');
  if (btn) { btn.disabled = true; btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Fetching…'); }
  try {
    const res = await api(`/api/packs/${encodeURIComponent(id)}/fetch`, {});
    const p = state.packs.packs.find((x) => x.id === id);
    p.cached = res.cached || res;
    renderList(); renderDetail();
  } catch (err) { toast(err.message, { error: true }); renderDetail(); }
}

let currentPlan = null;
async function planRemove(skillIds) {
  try { openReview(await api('/api/plan', { kind: 'remove', skillIds }), 'Remove'); }
  catch (err) { toast(err.message, { error: true }); }
}
async function planInstall(packId, skills) {
  try { openReview(await api('/api/plan', { kind: 'install', packId, skills, rootId: state.packTarget, mode: state.packMode }), 'Install'); }
  catch (err) { toast(err.message, { error: true }); }
}

function openReview(plan, verb) {
  currentPlan = plan;
  const roots = [...(state.data?.roots || []), ...(state.data?.prompts?.roots || [])];
  els.ops.replaceChildren(...(plan.ops || []).map((op) => {
    const kind = op.op === 'remove' ? 'remove' : op.op === 'replace' ? 'replace' : op.mode === 'symlink' ? 'link' : 'add';
    const name = (op.dest || '').split(/[\\/]/).pop();
    const where = roots.find((r) => r.path === op.root)?.label || plan.label || '';
    return h('li', { class: 'op' }, h('span', { class: `op-verb ${kind}` }, kind[0].toUpperCase() + kind.slice(1)), h('span', { class: 'op-what' }, name, where ? h('span', { class: 'op-where' }, `  in ${where}`) : null),
      h('span', { class: 'path' }, op.dest),
      op.src ? h('span', { class: 'path' }, op.mode === 'symlink' ? `→ ${op.src}` : `copy of ${op.src}`) : null);
  }));
  els.warns.replaceChildren(...(plan.warnings || []).map((w) => h('li', {}, w)));
  const n = plan.ops?.length || 0;
  els.applyLabel.textContent = verb === 'Share' ? `Apply ${plural(n, 'change')}` : `${verb} ${n === 1 ? '1 skill' : `${n} skills`}`;
  document.getElementById('review-title').textContent = verb === 'Share' ? (plan.title || 'Review sharing') : verb === 'Remove' ? 'Review removal' : 'Review install';
  els.review.showModal();
  els.apply.focus();
}

els.review.addEventListener('close', async () => {
  if (els.review.returnValue !== 'apply' || !currentPlan) return;
  const plan = currentPlan; currentPlan = null;
  try {
    const res = await api('/api/apply', { planId: plan.id });
    state.lastTx = res.txId;
    if (res.state) setData(res.state);
    state.history = null;
    state.source.clear();
    if (state.view === 'packs') await loadPacks();
    render();
    const n = res.applied ?? plan.ops?.length;
    toast(plan.summary ? `${plan.summary}.` : `${plan.kind === 'remove' ? 'Removed' : 'Installed'} ${n === 1 ? '1 skill' : `${n} skills`}.`, { undo: res.txId, readout: 'DONE' });
  } catch (err) { toast(err.message, { error: true }); }
});

async function undo(txId) {
  txId = txId || state.lastTx || state.history?.find((t) => t.status === 'applied')?.txId;
  if (!txId) { toast('There is nothing to undo yet.'); return; }
  try {
    const res = await api('/api/undo', { txId });
    if (res.state) setData(res.state);
    state.lastTx = null;
    state.history = null;
    if (state.view === 'history') await loadHistory();
    if (state.view === 'packs') await loadPacks();
    render();
    toast('Undone. Everything is back where it was.', { readout: 'UNDONE' });
  } catch (err) { toast(err.message, { error: true }); }
}

let toastTimer;
function toast(msg, { undo: tx, error, readout } = {}) {
  clearTimeout(toastTimer);
  els.toast.className = `toast${error ? ' error' : ''}`;
  els.toast.replaceChildren(...[readout ? readoutEl(document, readout, { size: 'md', label: '' }) : null, h('span', {}, msg), tx ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { els.toast.hidden = true; undo(tx); } }, 'Undo', glyph('u')) : null].filter(Boolean));
  els.toast.hidden = false;
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, error ? 9000 : 7000);
}

/* ---------- loading ---------- */
async function loadState() { setData(await api('/api/state')); }
async function loadPacks() { state.packs = await api('/api/packs'); }
async function loadHistory() { const r = await api('/api/history'); state.history = Array.isArray(r) ? r : r.changes || r.history || []; }

async function switchView(view) {
  if (state.view === view) return;
  state.view = view; state.selected = null; state.previewing = null; state.pinned = false; state.subFacet = 'all';
  els.app.classList.remove('show-detail');
  for (const b of document.querySelectorAll('.view-tab')) b.toggleAttribute('aria-current', b.dataset.view === view) || b.removeAttribute('aria-current');
  document.querySelectorAll('.view-tab').forEach((b) => b.dataset.view === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  els.search.placeholder = { packs: 'Search packs', history: 'Search changes', libraries: 'Search libraries', prompts: 'Search prompts' }[view] || 'Search names and descriptions';
  render();
  try {
    if (view === 'packs' && !state.packs) await loadPacks();
    if (view === 'libraries') await loadLibraries();
    if (view === 'history') await loadHistory();
    render();
  } catch (err) { toast(err.message, { error: true }); }
}

function render() { renderList(); renderDetail(); }

/* ---------- keyboard: every shortcut presses its keycap ---------- */
// Only real keycaps (the two switches and Apply) move when their shortcut is pressed.
function pressKey(key) {
  for (const el of document.querySelectorAll(`.cap[data-key="${CSS.escape(key)}"]`)) {
    el.classList.add('is-pressed');
    setTimeout(() => el.classList.remove('is-pressed'), 140);
  }
}
function moveSelection(delta) {
  const rows = [...els.list.querySelectorAll('.row')];
  if (!rows.length) return;
  const i = rows.findIndex((r) => r.dataset.key === state.selected);
  const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + delta))];
  select(next.dataset.key);
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); commandMenu.isOpen() ? commandMenu.close() : commandMenu.open(); return; }
  if (document.querySelector('dialog[open]:not(#review)')) return;
  if (els.review.open) { if (e.key === 'Enter' || e.key === 'Escape') pressKey(e.key); return; }
  const inField = e.target.matches('input, select, textarea');
  if (e.key === 'Escape') {
    pressKey('Escape');
    if (els.app.classList.contains('show-detail')) { els.app.classList.remove('show-detail'); return; }
    if (state.q) { state.q = ''; els.search.value = ''; render(); }
    els.search.blur(); els.list.focus();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (inField && e.target !== els.search) return;
    e.preventDefault(); pressKey(e.key); moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    if (e.target === els.search) els.list.focus();
    return;
  }
  if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); pressKey('/'); els.search.focus(); els.search.select(); }
  else if (e.key === 'j' || e.key === 'k') { pressKey(e.key === 'j' ? 'ArrowDown' : 'ArrowUp'); moveSelection(e.key === 'j' ? 1 : -1); }
  else if (/^[1-5]$/.test(e.key)) { switchView(VIEWS[+e.key - 1].id); }
  else if (e.key === ',') { showSettings(); }
  else if (e.key === 'n') { switchView('libraries').then(() => select(NEW_KEY)); }
  else if (e.key === 'u') { pressKey('u'); undo(); }
  else if ((e.key === 'c' || e.key === 'x') && state.view === 'prompts') {
    const btn = document.querySelector(`#detail .cap.switch[data-key="${e.key}"]`);
    if (btn && !btn.disabled) { pressKey(e.key); btn.click(); }
  }
  else if ((e.key === 'c' || e.key === 'x') && state.view === 'installed') {
    const g = state.data?.groups?.find((x) => x.name === state.selected);
    const a = APPS.find((x) => x.key === e.key);
    const st = g?.apps?.[a.id];
    if (st && (st.on ? st.canTurnOff : st.canTurnOn)) { pressKey(e.key); planShare([g.name], a.id, !st.on); }
  }
  else if (e.key === 'f' && state.view === 'packs') { const b = document.getElementById('fetch-btn'); if (b && !b.disabled) { pressKey('f'); b.click(); } }
});

let searchTimer;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = els.search.value; state.previewing = null; renderList(); if (!state.selected) renderDetail(); }, 60);
});
els.list.addEventListener('mouseleave', () => { if (state.previewing) { state.previewing = null; renderDetail(); } });
document.querySelectorAll('.view-tab').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
document.getElementById('open-commands')?.addEventListener('click', () => commandMenu.open());
document.getElementById('open-settings')?.addEventListener('click', showSettings);
document.querySelectorAll('.keys [data-send]').forEach((k) => k.addEventListener('click', () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k.dataset.send, bubbles: true }));
}));

addEventListener('pagehide', () => {
  try { fetch('/api/bye', { method: 'POST', keepalive: true, headers: { 'x-bindery-token': TOKEN } }); } catch {}
});

function plural(n, w) { return `${n} ${w}${n === 1 ? '' : 's'}`; }

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/* ---------- boot ---------- */
(async () => {
  render();
  try {
    await Promise.all([loadState(), loadLibraries().catch(() => {})]);
    if (state.libraries?.libraries.length) await switchView('libraries');
    render(); els.list.focus();
  }
  catch (err) {
    els.list.replaceChildren(h('div', { class: 'empty' }, 'Bindery could not read your skills.', h('p', {}, err.message)));
  }
})();
