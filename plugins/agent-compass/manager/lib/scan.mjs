import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSkill } from './skill.mjs';
import { listRoots, listPluginSkillDirs } from './roots.mjs';

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function byName(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Scans every skill root synchronously and groups skills by name.
export function scanAll({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const roots = listRoots({ home, cwd });
  const systemPath = path.join(home, '.codex', 'skills', '.system');
  const pluginRoots = [
    { id: 'claude-plugins', host: 'claude', scope: 'plugin', label: 'Claude Code · plugins', path: path.join(home, '.claude', 'plugins', 'cache') },
    { id: 'codex-plugins', host: 'codex', scope: 'plugin', label: 'Codex · plugins', path: path.join(home, '.codex', 'plugins', 'cache') },
    { id: 'codex-system', host: 'codex', scope: 'plugin', label: 'Codex · system', path: systemPath },
  ].map(root => ({ ...root, exists: isDir(root.path), writable: false }));

  const rootById = new Map([...roots, ...pluginRoots].map(root => [root.id, root]));
  const skills = [];
  const seen = new Set();
  const add = entry => {
    let id = entry.id;
    for (let n = 2; seen.has(id); n++) id = `${entry.id}~${n}`;
    entry.id = id;
    seen.add(id);
    skills.push(entry);
  };

  const scanFolder = (dirPath, root) => {
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => byName(a.name, b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skill = readSkill(path.join(dirPath, entry.name), root);
      if (skill) add(skill);
    }
  };

  for (const root of roots) {
    if (root.exists) scanFolder(root.path, root);
  }
  const system = rootById.get('codex-system');
  if (system.exists) scanFolder(system.path, system);

  for (const plugin of listPluginSkillDirs({ home })) {
    const root = rootById.get(plugin.rootId);
    const skill = readSkill(plugin.dir, root);
    if (!skill) continue;
    skill.pluginName = plugin.pluginName;
    skill.id = `${plugin.rootId}:${plugin.pluginName}/${skill.folder}`;
    add(skill);
  }

  const byLowerName = new Map();
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    if (!byLowerName.has(key)) byLowerName.set(key, []);
    byLowerName.get(key).push(skill);
  }
  const groups = [...byLowerName.entries()]
    .sort(([a], [b]) => byName(a, b))
    .map(([, list]) => {
      const sources = new Set(list.map(s => s.realPath ?? s.path));
      const sameSource = sources.size === 1;
      const descriptions = new Set(list.map(s => s.description).filter(Boolean));
      return {
        name: list[0].name,
        description: list.map(s => s.description).find(Boolean) || '',
        entries: list.map(s => s.id),
        hosts: [...new Set(list.map(s => s.host))],
        sameSource,
        conflict: !sameSource && descriptions.size > 1,
      };
    });

  return {
    roots: [...roots, ...pluginRoots],
    skills,
    groups,
    scannedAt: new Date().toISOString(),
  };
}
