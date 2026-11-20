import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// An existing root must be writable; a missing one must be creatable (parent exists and is writable).
function isWritable(p, exists) {
  try {
    if (exists) {
      fs.accessSync(p, fs.constants.W_OK);
      return true;
    }
    const parent = path.dirname(p);
    if (!isDir(parent)) return false;
    fs.accessSync(parent, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function subdirs(p) {
  let entries;
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => !e.name.startsWith('.'))
    .filter(e => e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(p, e.name))))
    .map(e => e.name)
    .sort();
}

function hasSkillFile(dir) {
  return ['SKILL.md', 'skill.md'].some(name => {
    try {
      return fs.statSync(path.join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
}

function mtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// Skill folder roots, in display order. The Codex `.system` folder is scanned as a
// separate plugin-scope root by scan.mjs, not listed here.
export function listRoots({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const defs = [
    { id: 'claude-global', host: 'claude', scope: 'global', label: 'Claude Code · global', path: path.join(home, '.claude', 'skills') },
    { id: 'codex-global', host: 'codex', scope: 'global', label: 'Codex · global', path: path.join(home, '.codex', 'skills') },
    { id: 'agents-global', host: 'agents', scope: 'global', label: 'Shared .agents · global', path: path.join(home, '.agents', 'skills') },
  ];
  if (path.resolve(cwd) !== path.resolve(home)) {
    defs.push(
      { id: 'claude-project', host: 'claude', scope: 'project', label: 'Claude Code · project', path: path.join(cwd, '.claude', 'skills') },
      { id: 'agents-project', host: 'agents', scope: 'project', label: 'Shared .agents · project', path: path.join(cwd, '.agents', 'skills') },
    );
  }
  return defs.map(def => {
    const exists = isDir(def.path);
    return { ...def, exists, writable: isWritable(def.path, exists) };
  });
}

// Skill folders shipped by Claude Code and Codex plugins. Only the newest version of each
// plugin (by directory mtime) is listed. Bounded readdir walk with a fixed shape.
export function listPluginSkillDirs({ home = os.homedir() } = {}) {
  const sources = [
    { base: path.join(home, '.claude', 'plugins', 'cache'), rootId: 'claude-plugins', host: 'claude' },
    { base: path.join(home, '.codex', 'plugins', 'cache'), rootId: 'codex-plugins', host: 'codex' },
  ];
  const found = [];
  for (const src of sources) {
    for (const marketplace of subdirs(src.base)) {
      const marketplaceDir = path.join(src.base, marketplace);
      for (const plugin of subdirs(marketplaceDir)) {
        const pluginDir = path.join(marketplaceDir, plugin);
        const versions = subdirs(pluginDir)
          .map(v => ({ dir: path.join(pluginDir, v), mtime: mtimeMs(path.join(pluginDir, v)) }))
          .sort((a, b) => b.mtime - a.mtime || (a.dir < b.dir ? -1 : 1));
        if (!versions.length) continue;
        const skillsDir = path.join(versions[0].dir, 'skills');
        for (const skill of subdirs(skillsDir)) {
          const dir = path.join(skillsDir, skill);
          if (hasSkillFile(dir)) {
            found.push({ dir, rootId: src.rootId, host: src.host, pluginName: plugin });
          }
        }
      }
    }
  }
  return found;
}
