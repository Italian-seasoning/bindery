// Agent Compass manager UI. Vanilla, no build step. All untrusted text goes through textContent.

const params = new URLSearchParams(location.search);
const TOKEN = params.get('t') || sessionStorage.getItem('ac-token') || '';
try { sessionStorage.setItem('ac-token', TOKEN); } catch {}
if (params.has('t')) history.replaceState(null, '', location.pathname);

const HOSTS = [
  { id: 'claude', short: 'cc', label: 'Claude Code' },
  { id: 'codex', short: 'cx', label: 'Codex' },
  { id: 'agents', short: 'ag', label: 'Shared .agents' },
];
const HOST = Object.fromEntries(HOSTS.map((h) => [h.id, h]));
// The two apps a skill can be turned on for. Codex reads both ~/.codex/skills and ~/.agents/skills.
const APPS = [
  { id: 'claude', short: 'cc', label: 'Claude Code', key: 'c' },
  { id: 'codex', short: 'cx', label: 'Codex', key: 'x' },
];
const APP = Object.fromEntries(APPS.map((a) => [a.id, a]));
const appOn = (g, id) => !!g.apps?.[id]?.on;

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
const kc = (label, key, cls = '') => h('span', { class: `kc ${cls}`, 'data-key': key, 'aria-hidden': 'true' }, label);

/* ---------- API ---------- */
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-compass-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 403) throw new Error('This window lost its session. Close it and run agent-compass again.');
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
  { id: 'all', group: 'Where', label: 'Everything', test: () => true },
  ...HOSTS.map((x) => ({ id: x.id, group: 'Where', label: x.label, test: (g, f, hs) => hs.lit.has(x.id) })),
  { id: 'plugin', group: 'Where', label: 'From plugins', test: (g, f) => f.plugin },
  { id: 'project', group: 'Where', label: 'This project', test: (g, f) => f.project },
  { id: 'both', group: 'Used by', label: 'Both apps', test: (g) => appOn(g, 'claude') && appOn(g, 'codex') },
  { id: 'only-claude', group: 'Used by', label: 'Only Claude Code', test: (g) => appOn(g, 'claude') && !appOn(g, 'codex'), shareTo: 'codex' },
  { id: 'only-codex', group: 'Used by', label: 'Only Codex', test: (g) => appOn(g, 'codex') && !appOn(g, 'claude'), shareTo: 'claude' },
  { id: 'scripts', group: 'Check', label: 'Runs scripts', test: (g, f) => f.scripts, dot: '' },
  { id: 'conflict', group: 'Check', label: 'Different copies', test: (g, f) => f.conflict, dot: 'warn' },
  { id: 'broken', group: 'Check', label: 'Broken links', test: (g, f) => f.broken, dot: 'bad' },
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
  return { rows, counts };
}

/* ---------- render: rail ---------- */
function renderRail(counts) {
  els.rail.replaceChildren();
  if (state.view !== 'installed') {
    const msg = state.view === 'packs'
      ? 'Packs are fetched from their public repositories only when you ask. A known publisher is not a safety review: read a skill before you rely on it.'
      : 'Every install and removal is recorded here. Undo puts things back exactly; nothing is ever deleted, only moved into backups.';
    els.rail.append(h('p', { class: 'rail-note' }, msg));
    return;
  }
  const groups = [...new Set(FACETS.map((f) => f.group))].map((t) => [t, FACETS.filter((f) => f.group === t)]);
  for (const [title, list] of groups) {
    els.rail.append(h('h2', {}, title));
    for (const f of list) {
      if (['conflict', 'broken', 'project'].includes(f.id) && !counts[f.id] && state.facet !== f.id) continue;
      els.rail.append(h('button', {
        class: 'facet', type: 'button', 'aria-pressed': String(state.facet === f.id),
        onclick: () => { state.facet = f.id; state.selected = null; render(); },
      }, f.dot != null ? h('span', { class: `dot ${f.dot}` }) : null, h('span', { class: 'facet-label' }, f.label), h('span', { class: 'facet-n' }, counts[f.id])));
    }
  }
  const sd = state.data?.stateDir;
  if (sd) els.rail.append(h('p', { class: 'rail-note' }, 'Backups and history live in ', h('code', {}, sd), '.'));
}

/* ---------- render: list ---------- */
function leds(lit, plug) {
  return h('span', { class: 'leds', 'aria-hidden': 'true' }, HOSTS.map((x) =>
    h('span', { class: `led ${lit.has(x.id) ? 'on' : plug.has(x.id) ? 'plug' : ''}`, title: x.label }, x.short)));
}
function hostSummary(lit, plug) {
  const a = HOSTS.filter((x) => lit.has(x.id)).map((x) => x.label);
  const b = HOSTS.filter((x) => plug.has(x.id) && !lit.has(x.id)).map((x) => `${x.label} plugin`);
  return [...a, ...b].join(', ') || 'Not installed';
}

function renderList() {
  els.list.replaceChildren();
  els.app.dataset.view = state.view;
  if (state.view === 'installed') return renderInstalledList();
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
      : h('span', { class: 'legend', 'aria-hidden': 'true' }, HOSTS.map((x) => h('span', {}, h('span', { class: 'led on' }, x.short), x.label.replace('Shared ', '')))),
  );
  if (!rows.length) {
    els.list.append(h('div', { class: 'empty' }, state.q ? `Nothing matches “${state.q}”.` : 'No skills here yet.',
      h('p', {}, state.q ? 'Try a shorter word, or clear the filter.' : 'Open Packs to add some.')));
    return;
  }
  listOptions(rows, ({ g, hs, f }) => rowEl(g.name, state.selected === g.name, select,
    h('div', {},
      h('div', { class: 'row-name' }, g.name, f.broken ? h('span', { class: 'row-flag bad' }, 'broken') : f.conflict ? h('span', { class: 'row-flag' }, 'differs') : null),
      h('div', { class: 'row-sub' }, hostSummary(hs.lit, hs.plug))),
    leds(hs.lit, hs.plug)));
  els.list.setAttribute('aria-activedescendant', state.selected ? `opt-${cssId(state.selected)}` : '');
}

function renderPackList() {
  renderRail({});
  if (!state.packs) { els.list.append(...Array.from({ length: 6 }, () => h('div', { class: 'skeleton' }))); return; }
  const q = state.q.trim().toLowerCase();
  const packs = state.packs.packs.filter((p) => matches(`${p.title} ${p.publisher} ${p.summary} ${(p.tags || []).join(' ')}`, q));
  els.head.replaceChildren(h('span', {}, h('strong', {}, packs.length), ' free packs'), h('span', {}, `Sources checked ${state.packs.checked || ''}`));
  if (!packs.length) { els.list.append(h('div', { class: 'empty' }, `No packs match “${state.q}”.`)); return; }
  listOptions(packs, (p) => {
    const fetched = p.cached;
    return rowEl(p.id, state.selected === p.id, select,
      h('div', {},
        h('div', { class: 'row-name' }, p.title),
        h('div', { class: 'row-sub' }, `${p.publisher} · ${p.kind === 'plugin' ? 'plugin' : fetched ? plural(fetched.skills.length, 'skill') : 'not fetched yet'}`)),
      fetched ? h('span', { class: 'led on', title: 'Fetched' }, 'ok') : h('span', { class: 'led', title: 'Not fetched' }, '··'));
  });
}

function renderHistoryList() {
  renderRail({});
  if (!state.history) { els.list.append(...Array.from({ length: 4 }, () => h('div', { class: 'skeleton' }))); return; }
  const items = state.history.filter((t) => matches(t.summary || '', state.q.trim().toLowerCase()));
  els.head.replaceChildren(h('span', {}, h('strong', {}, items.length), ' changes'));
  if (!items.length) { els.list.append(h('div', { class: 'empty' }, 'No changes yet.', h('p', {}, 'Installs and removals you make here will show up in this list.'))); return; }
  listOptions(items, (t) => rowEl(t.txId, state.selected === t.txId, select,
    h('div', {}, h('div', { class: 'row-name' }, t.summary || t.kind), h('div', { class: 'row-sub' }, fmtTime(t.createdAt))),
    h('span', { class: `tx-status ${t.status}` }, t.status)));
}

/* ---------- render: detail ---------- */
function blankDetail(text) {
  els.detail.replaceChildren(h('div', { class: 'detail-blank' },
    h('div', { class: 'bigkeys', 'aria-hidden': 'true' }, kc('↑', 'ArrowUp'), kc('↓', 'ArrowDown')),
    h('div', {}, text)));
}
function backBtn() {
  return h('button', { class: 'btn btn-quiet back', type: 'button', onclick: () => { els.app.classList.remove('show-detail'); els.list.focus(); } }, '← Back');
}

function renderDetail() {
  if (state.view === 'installed') return renderSkillDetail(state.previewing || state.selected);
  if (state.view === 'packs') return renderPackDetail(state.selected);
  return renderTxDetail(state.selected);
}

function rootLabel(rootId) { return state.data?.roots?.find((r) => r.id === rootId)?.label || rootId; }

function renderSkillDetail(name) {
  const g = state.data?.groups?.find((x) => x.name === name);
  if (!g) return blankDetail('Choose a skill to see where it lives and what it does.');
  const { entries } = groupHosts(g);
  const kids = [backBtn(), h('h1', {}, g.name), h('p', { class: 'lede' }, g.description || 'This skill has no description.')];
  kids.push(h('h2', {}, 'Use in'), useIn(g));
  if (g.conflict) kids.push(h('div', { class: 'notice' }, h('strong', {}, 'These copies differ. '), 'Each location holds a different version of this skill. Your hosts may behave differently depending on which one they load.'));
  kids.push(h('h2', {}, entries.length === 1 ? 'Location' : `${entries.length} locations`));
  for (const e of entries) {
    const tags = [];
    if (e.isSymlink && !e.broken) tags.push(h('span', { class: 'tag' }, 'linked'));
    if (e.broken) tags.push(h('span', { class: 'tag bad' }, 'broken link'));
    if (e.hasScripts) tags.push(h('span', { class: 'tag warn' }, 'runs scripts'));
    if (e.fileCount != null) tags.push(h('span', { class: 'tag' }, `${e.fileCount} files`));
    const writable = !(e.scope === 'plugin' || e.readOnly);
    kids.push(h('div', { class: 'loc' },
      h('div', { class: 'loc-top' },
        h('span', { class: 'leds', 'aria-hidden': 'true' }, h('span', { class: `led ${writable ? 'on' : 'plug'}` }, HOST[e.host]?.short || '··')),
        h('span', { class: 'loc-label' }, rootLabel(e.rootId), e.pluginName ? ` · ${e.pluginName}` : ''),
        writable
          ? h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => planRemove([e.id]) }, 'Remove')
          : h('span', { class: 'readonly' }, 'Managed by plugin')),
      h('div', { class: 'path' }, e.path),
      e.isSymlink && e.linkTarget ? h('div', { class: 'path' }, `→ ${e.linkTarget}`) : null,
      tags.length ? h('div', { class: 'tags' }, tags) : null));
  }
  const first = entries.find((e) => !e.broken);
  if (first) {
    const src = state.source.get(first.id);
    kids.push(h('div', { class: 'actions' },
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => loadSource(first.id) }, src ? 'Reload SKILL.md' : 'Read SKILL.md'),
      entries.filter((e) => e.scope !== 'plugin' && !e.readOnly).length > 1
        ? h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => planRemove(entries.filter((e) => e.scope !== 'plugin' && !e.readOnly).map((e) => e.id)) }, 'Remove everywhere')
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
    const why = st.on && st.fixed ? `${a.label} gets this from a plugin. Manage it in ${a.label}.`
      : !st.on && !can ? 'Only a plugin has this skill, so it cannot be shared from here.' : null;
    keys.append(h('button', {
      class: 'app-key', type: 'button', 'aria-pressed': String(!!st.on), disabled: !can, title: why,
      'aria-label': `${a.label}: ${st.on ? 'on' : 'off'}${can ? `. Press to turn ${st.on ? 'off' : 'on'}.` : ''}`,
      onclick: () => planShare([g.name], a.id, !st.on),
    }, h('span', { class: `led ${st.on ? (st.fixed ? 'plug' : 'on') : ''}`, 'aria-hidden': 'true' }, a.short),
    h('span', { class: 'app-name' }, a.label),
    h('span', { class: 'app-state' }, st.on ? (st.fixed ? 'Plugin' : 'On') : 'Off'),
    kc(a.key, a.key)));
  }
  const on = APPS.filter((a) => appOn(g, a.id));
  const fixed = APPS.find((a) => g.apps?.[a.id]?.fixed || (!appOn(g, a.id) && !g.apps?.[a.id]?.canTurnOn));
  const note = on.length === 2
    ? (g.sameSource ? 'Both apps read the same folder, so an edit shows up in both.' : 'Each app has its own copy. Editing one does not change the other.')
    : on.length === 1
      ? `Only ${on[0].label} can use this.${fixed ? '' : ` Turning on ${APPS.find((a) => a !== on[0]).label} links it to the same folder.`}`
      : 'Neither app can use this right now.';
  return h('div', {}, keys, h('p', { class: 'use-note' }, note));
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
    kids.push(h('div', { class: 'notice' }, h('strong', {}, 'Nothing has been downloaded. '), `Fetching runs git to copy this repository from ${new URL(p.repo).host} into Agent Compass's cache, so you can read every skill before installing. Nothing is installed yet.`));
    kids.push(h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', id: 'fetch-btn', onclick: () => fetchPack(p.id) }, kc('f', 'f', 'kc-on-primary'), 'Fetch contents')));
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
      h('span', { class: 'leds', 'aria-label': inst.length ? `Installed in ${inst.map(rootLabel).join(', ')}` : 'Not installed' },
        HOSTS.map((x) => h('span', { class: `led ${inst.some((r) => r.startsWith(x.id)) ? 'on' : ''}` }, x.short)))));
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
        h('button', { class: 'btn btn-primary', type: 'button', disabled: !sel.size, onclick: () => planInstall(p.id, [...sel]) }, kc('enter', 'Enter', 'kc-wide kc-on-primary'), sel.size ? `Review ${sel.size} install${sel.size > 1 ? 's' : ''}` : 'Choose skills to install'))));
  }
  els.detail.replaceChildren(...kids);
}

function renderTxDetail(id) {
  const t = state.history?.find((x) => x.txId === id);
  if (!t) return blankDetail('Choose a change to see it or undo it.');
  const kids = [backBtn(), h('h1', {}, t.summary || t.kind), h('div', { class: 'meta' }, h('span', {}, fmtTime(t.createdAt)), h('span', { class: `tx-status ${t.status}` }, t.status), h('code', {}, t.txId))];
  if (t.status === 'applied') kids.push(h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => undo(t.txId) }, kc('u', 'u', 'kc-on-primary'), 'Undo this change')));
  else kids.push(h('p', { class: 'lede', style: 'margin-top:16px' }, t.status === 'undone' ? 'This change was undone. Whatever it added was moved into backups, not deleted.' : 'This change did not complete and was rolled back.'));
  els.detail.replaceChildren(...kids);
}

/* ---------- actions ---------- */
function select(key) {
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
  const roots = state.data?.roots || [];
  els.ops.replaceChildren(...(plan.ops || []).map((op) => {
    const kind = op.op === 'remove' ? 'remove' : op.op === 'replace' ? 'replace' : op.mode === 'symlink' ? 'link' : 'add';
    const name = (op.dest || '').split(/[\\/]/).pop();
    const where = roots.find((r) => r.path === op.root)?.label || plan.label || '';
    return h('li', { class: 'op' }, h('span', { class: `op-verb ${kind}` }, kind), h('span', { class: 'op-what' }, name, where ? h('span', { style: 'font-weight:450;color:var(--text-3)' }, ` · ${where}`) : null),
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
    toast(plan.summary ? `${plan.summary}.` : `${plan.kind === 'remove' ? 'Removed' : 'Installed'} ${n === 1 ? '1 skill' : `${n} skills`}.`, { undo: res.txId });
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
    toast('Undone. Everything is back where it was.');
  } catch (err) { toast(err.message, { error: true }); }
}

let toastTimer;
function toast(msg, { undo: tx, error } = {}) {
  clearTimeout(toastTimer);
  els.toast.className = `toast${error ? ' error' : ''}`;
  els.toast.replaceChildren(h('span', {}, msg), tx ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { els.toast.hidden = true; undo(tx); } }, kc('u', 'u'), 'Undo') : null);
  els.toast.hidden = false;
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, error ? 9000 : 7000);
}

/* ---------- loading ---------- */
async function loadState() { setData(await api('/api/state')); }
async function loadPacks() { state.packs = await api('/api/packs'); }
async function loadHistory() { const r = await api('/api/history'); state.history = Array.isArray(r) ? r : r.changes || r.history || []; }

async function switchView(view) {
  if (state.view === view) return;
  state.view = view; state.selected = null; state.previewing = null; state.pinned = false;
  els.app.classList.remove('show-detail');
  for (const b of document.querySelectorAll('.view-tab')) b.toggleAttribute('aria-current', b.dataset.view === view) || b.removeAttribute('aria-current');
  document.querySelectorAll('.view-tab').forEach((b) => b.dataset.view === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  els.search.placeholder = view === 'packs' ? 'Search packs' : view === 'history' ? 'Search changes' : 'Search names and descriptions';
  render();
  try {
    if (view === 'packs' && !state.packs) await loadPacks();
    if (view === 'history') await loadHistory();
    render();
  } catch (err) { toast(err.message, { error: true }); }
}

function render() { renderList(); renderDetail(); }

/* ---------- keyboard: every shortcut presses its keycap ---------- */
function pressKey(key) {
  for (const el of document.querySelectorAll(`.kc[data-key="${CSS.escape(key)}"]`)) {
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
  else if (['1', '2', '3'].includes(e.key)) { pressKey(e.key); switchView(['installed', 'packs', 'history'][+e.key - 1]); }
  else if (e.key === 'u') { pressKey('u'); undo(); }
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
document.querySelectorAll('.keys .kc').forEach((k) => k.addEventListener('click', () => {
  const key = k.dataset.key;
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}));

addEventListener('pagehide', () => {
  try { fetch('/api/bye', { method: 'POST', keepalive: true, headers: { 'x-compass-token': TOKEN } }); } catch {}
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
  try { await loadState(); render(); els.list.focus(); }
  catch (err) {
    els.list.replaceChildren(h('div', { class: 'empty' }, 'Agent Compass could not read your skills.', h('p', {}, err.message)));
  }
})();
