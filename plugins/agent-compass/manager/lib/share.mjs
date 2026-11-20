// Turns "use this skill in Claude Code / Codex" into a share plan for changes.mjs.
// Turning an app on links its skill folder to the copy the other app already has, so both
// read the same files. Turning an app off removes only that app's entries (into backups).
// When the entry being removed is the folder another app links to, that app gets its own
// copy first, so nothing it relies on breaks.
import fs from 'node:fs';
import path from 'node:path';
import { installOp, removeOp, planShareOps } from './changes.mjs';

export const APPS = {
  claude: { label: 'Claude Code', targets: { global: 'claude-global', project: 'claude-project' } },
  // Codex reads ~/.codex/skills and ~/.agents/skills. New links go to .agents, the shared standard.
  codex: { label: 'Codex', targets: { global: 'agents-global', project: 'agents-project' } },
};

const ROOT_APP = {
  'claude-global': 'claude',
  'claude-project': 'claude',
  'claude-plugins': 'claude',
  'codex-global': 'codex',
  'codex-system': 'codex',
  'codex-plugins': 'codex',
  'agents-global': 'codex',
  'agents-project': 'codex',
};

export function appOf(skill) {
  return ROOT_APP[skill.rootId] ?? (skill.host === 'claude' ? 'claude' : 'codex');
}

const isFixed = skill => skill.scope === 'plugin' || !!skill.readOnly;
const otherApp = app => (app === 'claude' ? 'codex' : 'claude');

// Every hop of a symlink chain, resolved to absolute paths.
function linkHops(p, max = 16) {
  const hops = [];
  let current = p;
  for (let i = 0; i < max; i++) {
    let st;
    try { st = fs.lstatSync(current); } catch { break; }
    if (!st.isSymbolicLink()) break;
    current = path.resolve(path.dirname(current), fs.readlinkSync(current));
    hops.push(current);
  }
  return hops;
}

const within = (p, dir) => p === dir || p.startsWith(dir + path.sep);

// Would removing `removed` break `kept`?
function dependsOn(kept, removed) {
  if (!kept.isSymlink) return false;
  if (!removed.isSymlink && kept.realPath && removed.realPath && within(kept.realPath, removed.realPath)) return true;
  return linkHops(kept.path).some(hop => within(hop, removed.path));
}

// Each app's state for one skill group, for the UI and CLI.
export function shareStatus(group, skillsById) {
  const entries = group.entries.map(id => skillsById.get(id)).filter(Boolean);
  const out = {};
  for (const app of Object.keys(APPS)) {
    const mine = entries.filter(e => appOf(e) === app && !e.broken);
    const others = entries.filter(e => appOf(e) !== app && !e.broken);
    out[app] = {
      on: mine.length > 0,
      fixed: mine.length > 0 && mine.every(isFixed),
      canTurnOn: mine.length === 0 && others.some(e => !isFixed(e)),
      canTurnOff: mine.some(e => !isFixed(e)),
    };
  }
  return out;
}

function pickSource(entries) {
  const usable = entries.filter(e => !e.broken && !isFixed(e) && e.realPath);
  return usable.find(e => e.scope === 'global') ?? usable[0] ?? null;
}

function turnOn(group, entries, app, roots, mode) {
  const label = APPS[app].label;
  if (entries.some(e => appOf(e) === app && !e.broken)) return { skip: `already in ${label}` };
  const others = entries.filter(e => appOf(e) !== app);
  const src = pickSource(others);
  if (!src) {
    const fixed = others.find(e => !e.broken && isFixed(e));
    if (fixed) return { skip: `comes from a ${APPS[appOf(fixed)].label} plugin. Install that plugin in ${label} instead` };
    return { skip: 'has no readable copy to share' };
  }
  const rootId = APPS[app].targets[src.scope] ?? APPS[app].targets.global;
  const root = roots.find(r => r.id === rootId);
  if (!root) return { skip: `has no ${label} location for ${src.scope} skills here` };
  const built = installOp({ src: src.realPath, name: src.folder, targetRoot: root, mode });
  const warnings = built.warnings.filter(w => !w.startsWith('Contains scripts'));
  if (mode === 'symlink') warnings.push(`${label} links to the same folder, so edits show up in both apps.`);
  return { ops: [built.op], warnings };
}

function turnOff(group, entries, app, roots, mode) {
  const label = APPS[app].label;
  const mine = entries.filter(e => appOf(e) === app);
  if (!mine.some(e => !e.broken)) return { skip: `is not in ${label}` };
  const removable = mine.filter(e => !isFixed(e));
  if (!removable.length) return { skip: `comes from a ${label} plugin. Turn the plugin off in ${label} instead` };
  const kept = entries.filter(e => !removable.includes(e) && !e.broken);
  const rootOf = e => roots.find(r => r.id === e.rootId);
  const ops = [];
  const warnings = [];
  const handled = new Set();

  for (const r of removable) {
    for (const k of kept) {
      if (!r.isSymlink && !k.isSymlink && k.realPath && k.realPath === r.realPath) {
        return { skip: `is read by both apps from one folder (a linked parent folder), so it cannot be turned off for one app` };
      }
      if (handled.has(k.path) || !dependsOn(k, r)) continue;
      if (isFixed(k)) return { skip: `is used by a plugin through ${r.path}` };
      // A link through a removed link can point straight at the final folder; a link to the
      // removed folder itself needs its own copy.
      const keepLinked = r.isSymlink && k.realPath && !within(k.realPath, r.path);
      const built = installOp({
        src: keepLinked ? k.realPath : r.path,
        name: path.basename(k.path),
        targetRoot: rootOf(k),
        mode: keepLinked ? 'symlink' : 'copy',
      });
      ops.push(built.op);
      handled.add(k.path);
      warnings.push(keepLinked
        ? `${APPS[appOf(k)].label}'s link is pointed straight at the original folder.`
        : `${APPS[appOf(k)].label} linked to the ${label} folder, so it gets its own copy first.`);
    }
  }
  for (const r of removable) {
    const built = removeOp({ skillPath: r.path, root: rootOf(r) });
    ops.push(built.op);
    warnings.push(...built.warnings);
  }
  if (mine.some(isFixed)) warnings.push(`A ${label} plugin also ships ${group.name}, so ${label} can still load it.`);
  return { ops, warnings };
}

// names: skill names (case-insensitive). app: 'claude' | 'codex'. on: true to add, false to remove.
// Returns { plan, skipped: [{ name, reason }] }. plan is null when nothing would change.
export function planShare({ scan, names, app, on, mode = 'symlink' }) {
  if (!APPS[app]) throw new Error('Choose Claude Code or Codex.');
  if (mode !== 'symlink' && mode !== 'copy') throw new Error('Choose either a link or a copy.');
  if (!Array.isArray(names) || names.length === 0) throw new Error('Choose at least one skill.');
  const skillsById = new Map(scan.skills.map(s => [s.id, s]));
  const groups = new Map(scan.groups.map(g => [g.name.toLowerCase(), g]));
  const ops = [];
  const warnings = [];
  const skipped = [];
  const changed = [];
  const dests = new Set();

  for (const raw of [...new Set(names.map(n => String(n)))]) {
    const group = groups.get(raw.toLowerCase());
    if (!group) { skipped.push({ name: raw, reason: 'is not installed' }); continue; }
    const entries = group.entries.map(id => skillsById.get(id)).filter(Boolean);
    let result;
    try {
      result = on ? turnOn(group, entries, app, scan.roots, mode) : turnOff(group, entries, app, scan.roots, mode);
    } catch (err) {
      result = { skip: err.message.replace(/\.$/, '') };
    }
    if (result.skip) { skipped.push({ name: group.name, reason: result.skip }); continue; }
    if (result.ops.some(op => dests.has(op.dest))) {
      skipped.push({ name: group.name, reason: 'uses the same folder name as another skill in this change' });
      continue;
    }
    result.ops.forEach(op => dests.add(op.dest));
    ops.push(...result.ops);
    warnings.push(...result.warnings);
    changed.push(group.name);
  }

  if (!ops.length) return { plan: null, skipped };
  const label = APPS[app].label;
  const what = changed.length === 1 ? changed[0] : `${changed.length} skills`;
  const summary = on ? `Shared ${what} with ${label}` : `Turned off ${what} in ${label}`;
  if (skipped.length) warnings.push(`${skipped.length} skipped: ${skipped.slice(0, 3).map(s => `${s.name} ${s.reason}`).join('; ')}${skipped.length > 3 ? '; …' : ''}.`);
  const plan = planShareOps({ ops, warnings, label, summary });
  plan.share = { app, on, names: changed };
  plan.title = on ? `Share ${what} with ${label}` : `Turn off ${what} in ${label}`;
  return { plan, skipped };
}

export { otherApp };
