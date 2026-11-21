// Custom slash-command prompts for Claude Code and Codex.
// A prompt is one markdown file (optionally with YAML frontmatter) in one of:
//   ~/.claude/commands/<name>.md, <project>/.claude/commands/<name>.md, ~/.codex/prompts/<name>.md
// Plans go through changes.mjs, so applyPlan and undo handle them like skill folders.
// Nothing is deleted: displaced files are moved into <stateDir>/backups/<txId>/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter } from './skill.mjs';
import { removeOp, planShareOps } from './changes.mjs';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const DESC_MAX = 140;

export const PROMPT_APPS = {
  claude: { label: 'Claude Code', globalRoot: 'claude-commands' },
  codex: { label: 'Codex', globalRoot: 'codex-prompts' },
};

const fail = message => new Error(message);

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// An existing folder must be writable; a missing one must be creatable (nearest existing ancestor writable).
function isWritable(p, exists) {
  let target = p;
  if (!exists) {
    let current = p;
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    target = current;
  }
  try { fs.accessSync(target, fs.constants.W_OK); return true; } catch { return false; }
}

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

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

const reasonOf = err => String(err.message || err).replace(/\.$/, '');

export function promptRoots({ home = os.homedir(), cwd = home } = {}) {
  const defs = [
    { id: 'claude-commands', app: 'claude', scope: 'global', label: 'Claude Code · commands', path: path.join(home, '.claude', 'commands') },
  ];
  if (path.resolve(cwd) !== path.resolve(home)) {
    defs.push({ id: 'claude-project-commands', app: 'claude', scope: 'project', label: 'Claude Code · project commands', path: path.join(cwd, '.claude', 'commands') });
  }
  defs.push({ id: 'codex-prompts', app: 'codex', scope: 'global', label: 'Codex · prompts', path: path.join(home, '.codex', 'prompts') });
  return defs.map(def => {
    const exists = isDir(def.path);
    return { ...def, exists, writable: isWritable(def.path, exists) };
  });
}

// First non-empty line that is not a heading, or the frontmatter description when present.
export function describePrompt(text) {
  const { data, body } = parseFrontmatter(text);
  if (typeof data.description === 'string' && data.description.trim()) {
    return data.description.replace(/\s+/g, ' ').trim().slice(0, DESC_MAX);
  }
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#')) return t.slice(0, DESC_MAX);
  }
  return '';
}

// Top-level *.md files and symlinks to them. Broken links are kept so they can be shown and replaced.
export function scanPrompts({ home = os.homedir(), cwd = home } = {}) {
  const roots = promptRoots({ home, cwd });
  const prompts = [];
  const texts = new Map();

  for (const root of roots) {
    if (!root.exists) continue;
    let entries;
    try { entries = fs.readdirSync(root.path, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;
      const name = entry.name.slice(0, -3);
      if (!name) continue;
      const full = path.join(root.path, entry.name);
      const lst = lstatOrNull(full);
      if (!lst) continue;
      const isSymlink = lst.isSymbolicLink();
      if (!isSymlink && !lst.isFile()) continue;
      const id = `${root.id}:${name}`;
      const base = { id, name, rootId: root.id, app: root.app, scope: root.scope, path: full, isSymlink };

      let realPath;
      let st;
      try {
        realPath = fs.realpathSync(full);
        st = fs.statSync(realPath);
      } catch {
        prompts.push({ ...base, realPath: null, broken: true, description: '', bytes: 0 });
        continue;
      }
      if (!st.isFile()) continue;
      let text = '';
      try { text = fs.readFileSync(realPath, 'utf8'); } catch { /* unreadable: keep with empty metadata */ }
      texts.set(id, text);
      prompts.push({ ...base, realPath, broken: false, description: describePrompt(text), bytes: st.size });
    }
  }

  const byName = new Map();
  for (const p of prompts) {
    const key = p.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(p);
  }

  const groups = [...byName.values()].map(list => {
    const live = list.filter(p => !p.broken);
    const sources = new Set(live.map(p => p.realPath));
    const contents = new Set(live.map(p => texts.get(p.id)));
    return {
      name: list[0].name,
      entries: list.map(p => p.id),
      apps: {
        claude: live.some(p => p.app === 'claude'),
        codex: live.some(p => p.app === 'codex'),
      },
      sameSource: sources.size === 1,
      differs: sources.size > 1 && contents.size > 1,
    };
  });

  return { roots, prompts, groups };
}

// One markdown file placed at <targetRoot.path>/<name>.md. Missing folders are created by applyPlan.
export function promptOp({ src, name, targetRoot, mode = 'symlink' } = {}) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw fail(`"${name}" is not a valid prompt name. Use letters, numbers, dots, dashes and underscores (100 characters at most).`);
  }
  if (mode !== 'copy' && mode !== 'symlink') throw fail('Install mode must be "copy" or "symlink".');
  if (!targetRoot || typeof targetRoot !== 'object' || typeof targetRoot.path !== 'string' || !path.isAbsolute(targetRoot.path)) {
    throw fail('Choose a valid prompt location.');
  }
  const label = targetRoot.label || 'That location';
  if (targetRoot.scope === 'plugin' || targetRoot.readOnly) throw fail(`${label} is managed by a plugin and is read-only.`);
  if (targetRoot.writable === false) throw fail(`${label} is not writable.`);
  if (typeof src !== 'string' || !path.isAbsolute(src)) throw fail('The prompt source must be an absolute file path.');

  let real;
  try { real = fs.realpathSync(src); } catch { throw fail(`Prompt source file was not found: ${path.basename(src)}.`); }
  if (!fs.statSync(real).isFile() || path.extname(real).toLowerCase() !== '.md') {
    throw fail(`${path.basename(src)} is not a markdown prompt file.`);
  }

  const root = path.resolve(targetRoot.path);
  const dest = path.join(root, `${name}.md`);
  if (dest === real || dest === path.resolve(src)) throw fail('That prompt is already in this location.');

  const existing = lstatOrNull(dest);
  const info = existing
    ? { isSymlink: existing.isSymbolicLink(), linkTarget: existing.isSymbolicLink() ? fs.readlinkSync(dest) : null }
    : null;
  const warnings = [];
  if (info) warnings.push(`Replaces existing ${name}.md in ${label}. The current copy is kept as a backup.`);
  return {
    op: { op: info ? 'replace' : 'create', dest, src: real, mode, existing: info, root, file: true },
    warnings,
    label,
  };
}

// Turning an app on links (or copies) the prompt into that app's global folder, from the
// other app's copy (global preferred). Turning it off removes the app's file(s). When the other
// app links to a file being removed, it first gets its own copy, or a link straight to the original.
export function planSharePrompt({ home = os.homedir(), cwd = home, name, app, on, mode = 'symlink' } = {}) {
  if (!PROMPT_APPS[app]) throw fail('Choose Claude Code or Codex.');
  if (mode !== 'symlink' && mode !== 'copy') throw fail('Choose either a link or a copy.');
  if (typeof name !== 'string' || !name) throw fail('Choose a prompt.');

  const { roots, prompts, groups } = scanPrompts({ home, cwd });
  const group = groups.find(g => g.name.toLowerCase() === name.toLowerCase());
  if (!group) return { plan: null, reason: `${name} is not installed` };

  const entries = prompts.filter(p => group.entries.includes(p.id));
  const label = PROMPT_APPS[app].label;
  const live = entries.filter(p => !p.broken);
  const mine = live.filter(p => p.app === app);
  const others = live.filter(p => p.app !== app);
  const ops = [];
  const warnings = [];
  let title;
  let summary;

  if (on) {
    if (mine.length) return { plan: null, reason: `${group.name} is already in ${label}` };
    const src = others.find(p => p.scope === 'global') ?? others[0];
    if (!src) return { plan: null, reason: `${group.name} has no readable copy to share` };
    const globalRoot = roots.find(r => r.id === PROMPT_APPS[app].globalRoot);
    try {
      const built = promptOp({ src: src.realPath, name: src.name, targetRoot: globalRoot, mode });
      ops.push(built.op);
      warnings.push(...built.warnings);
    } catch (err) {
      return { plan: null, reason: `${group.name} ${reasonOf(err)}` };
    }
    if (mode === 'symlink') warnings.push(`${label} links to the same file, so edits show up in both apps.`);
    summary = `Shared ${group.name} with ${label}`;
    title = `Share ${group.name} with ${label}`;
  } else {
    if (!mine.length) return { plan: null, reason: `${group.name} is not in ${label}` };
    const handled = new Set();
    for (const r of mine) {
      for (const k of others) {
        if (handled.has(k.id) || !k.isSymlink) continue;
        if (!linkHops(k.path).includes(path.resolve(r.path))) continue;
        // A link through a removed link can point straight at the final file; a link to a removed
        // file needs its own copy before the removal runs (ops execute in order).
        const linked = r.isSymlink && !!r.realPath;
        try {
          const built = promptOp({
            src: linked ? r.realPath : r.path,
            name: k.name,
            targetRoot: roots.find(x => x.id === k.rootId),
            mode: linked ? 'symlink' : 'copy',
          });
          ops.push(built.op);
        } catch (err) {
          return { plan: null, reason: `${group.name} ${reasonOf(err)}` };
        }
        handled.add(k.id);
        warnings.push(linked
          ? `${PROMPT_APPS[k.app].label}'s link now points straight at the original file.`
          : `${PROMPT_APPS[k.app].label} linked to the ${label} file, so it gets its own copy first.`);
      }
    }
    for (const r of mine) {
      try {
        const built = removeOp({ skillPath: r.path, root: roots.find(x => x.id === r.rootId) });
        ops.push(built.op);
      } catch (err) {
        return { plan: null, reason: `${group.name} ${reasonOf(err)}` };
      }
      warnings.push(r.isSymlink
        ? 'Only the link is removed. The file it points to is not touched.'
        : 'The file is moved to a backup, so this can be undone.');
    }
    summary = `Turned off ${group.name} in ${label}`;
    title = `Turn off ${group.name} in ${label}`;
  }

  const plan = planShareOps({ ops, warnings, label, summary });
  plan.share = { app, on, names: [group.name] };
  plan.title = title;
  return { plan };
}
