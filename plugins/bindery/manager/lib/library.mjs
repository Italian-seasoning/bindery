// Libraries: shareable folders of skills and prompts with a short "best for" note per item.
// A library folder holds library.json (the manifest), README.md (generated), skills/<name>/ and
// prompts/<name>.md. Nothing here installs anything into an app; that is changes.mjs' job.
// Removed or replaced items are moved into <stateDir>/backups, never deleted.
import fs from 'node:fs';
import path from 'node:path';

export const FORMAT = 'agent-library/1';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ITEM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const APP_IDS = ['claude', 'codex'];
const APP_LABEL = { claude: 'Claude Code', codex: 'Codex' };
const TYPES = ['skill', 'prompt'];
const TYPE_LABEL = { skill: 'Skill', prompt: 'Prompt' };
const KNOWN_TOP = new Set(['format', 'id', 'name', 'author', 'description', 'version', 'license', 'createdAt', 'items']);
const KNOWN_ITEM = new Set(['type', 'name', 'path', 'bestFor', 'apps', 'source']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_MESSAGE = 'The library id must use only lowercase letters, numbers and dashes, start with a letter or number, and be at most 64 characters.';

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;

function extraKeys(obj, known) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (known.has(key) || UNSAFE_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

// Returns a human problem with a relative, folder-safe path, or null when the path is fine.
function pathProblem(p) {
  if (typeof p !== 'string' || p === '') return 'has no path';
  if (p.includes('\\') || p.includes('\0')) return 'path must use forward slashes and no special characters';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'path must be relative to the library folder, not an absolute path';
  if (p.split('/').some(part => part === '' || part === '.' || part === '..')) {
    return 'path must not contain "..", "." or empty parts';
  }
  return null;
}

// Checks a manifest against the agent-library/1 rules. Always returns a normalized copy with
// defaults filled and unknown keys kept, even when invalid (check `ok` before using it).
export function validateManifest(obj) {
  if (!isPlainObject(obj)) {
    return { ok: false, errors: ['library.json must contain a JSON object.'], manifest: null };
  }
  const errors = [];

  const format = obj.format ?? FORMAT;
  if (format !== FORMAT) errors.push(`This library uses format "${format}". This version reads ${FORMAT}.`);

  const id = obj.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) errors.push(ID_MESSAGE);

  const name = obj.name;
  if (!isText(name, 1, 80)) errors.push('The library name must be 1 to 80 characters.');

  const author = obj.author ?? '';
  if (!isText(author, 0, 120)) errors.push('The author must be text of at most 120 characters.');

  const description = obj.description ?? '';
  if (!isText(description, 0, 600)) errors.push('The description must be at most 600 characters.');

  const version = obj.version ?? '1.0.0';
  if (typeof version !== 'string' || !VERSION_RE.test(version)) errors.push('The version must look like 1.0.0.');

  const license = obj.license ?? '';
  if (typeof license !== 'string') errors.push('The license must be text.');

  const createdAt = obj.createdAt ?? '';
  if (typeof createdAt !== 'string') errors.push('createdAt must be text, such as an ISO date.');

  const rawItems = obj.items ?? [];
  if (!Array.isArray(rawItems)) errors.push('items must be a list.');
  const items = [];
  const seen = new Set();
  if (Array.isArray(rawItems)) {
    rawItems.forEach((raw, index) => {
      const where = `Item ${index + 1}`;
      if (!isPlainObject(raw)) {
        errors.push(`${where} must be an object.`);
        return;
      }
      const type = raw.type;
      if (!TYPES.includes(type)) errors.push(`${where} has type "${type}". Use "skill" or "prompt".`);

      const itemName = raw.name;
      const label = typeof itemName === 'string' ? `${type} "${itemName}"` : where;
      if (typeof itemName !== 'string' || !ITEM_NAME_RE.test(itemName)) {
        errors.push(`${where} needs a name using letters, numbers, dots, dashes or underscores, starting with a letter or number.`);
      } else if (TYPES.includes(type)) {
        const key = `${type}:${itemName}`;
        if (seen.has(key)) errors.push(`Two ${type}s are named "${itemName}". Names must be unique per type.`);
        seen.add(key);
      }

      const problem = pathProblem(raw.path);
      if (problem) {
        errors.push(`${label} ${problem}.`);
      } else if (type === 'skill' && !raw.path.startsWith('skills/')) {
        errors.push(`${label} is a skill, so its path must be under skills/.`);
      } else if (type === 'prompt' && (!raw.path.startsWith('prompts/') || !raw.path.endsWith('.md'))) {
        errors.push(`${label} is a prompt, so its path must be a .md file under prompts/.`);
      }

      const bestFor = raw.bestFor ?? '';
      if (!isText(bestFor, 0, 200)) errors.push(`${label} "best for" note must be at most 200 characters.`);

      const apps = raw.apps ?? [...APP_IDS];
      const appsOk = Array.isArray(apps) && apps.length > 0
        && apps.every(app => APP_IDS.includes(app))
        && new Set(apps).size === apps.length;
      if (!appsOk) errors.push(`${label} apps must list "claude" and/or "codex", each once.`);

      const source = raw.source ?? null;
      if (source !== null && !isPlainObject(source)) errors.push(`${label} source must be an object or null.`);

      items.push({
        type,
        name: itemName,
        path: raw.path,
        bestFor,
        apps: Array.isArray(apps) ? [...apps] : apps,
        source,
        ...extraKeys(raw, KNOWN_ITEM),
      });
    });
  }

  const manifest = {
    format: FORMAT,
    id,
    name,
    author,
    description,
    version,
    license,
    createdAt,
    items,
    ...extraKeys(obj, KNOWN_TOP),
  };
  return { ok: errors.length === 0, errors, manifest };
}

export function librariesDir({ stateDir }) {
  return path.join(stateDir, 'libraries');
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Reads and validates dir/library.json. Throws a plain sentence when the folder is not a library.
export function readLibrary(dir) {
  const root = path.resolve(dir);
  const file = path.join(root, 'library.json');
  if (!fs.existsSync(file)) throw new Error('This folder has no library.json.');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('library.json is not valid JSON.');
  }
  const { ok, errors, manifest } = validateManifest(raw);
  if (!ok) throw new Error(errors[0]);

  const problems = [];
  for (const item of manifest.items) {
    const label = `${item.type} "${item.name}"`;
    const where = path.join(root, item.path);
    if (!fs.existsSync(where)) {
      problems.push(`${label} is missing from this folder (${item.path}).`);
    } else if (item.type === 'skill' && !isFile(path.join(where, 'SKILL.md'))) {
      problems.push(`${label} has no SKILL.md.`);
    }
  }
  return { manifest, dir: root, problems };
}

// Renders the README shown next to library.json. Pipes and newlines are kept out of table cells.
export function renderReadme(manifest) {
  const cell = value => String(value ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  const lines = [`# ${cell(manifest.name)}`, ''];
  if (manifest.description) lines.push(manifest.description, '');
  if (manifest.author) lines.push(`By ${cell(manifest.author)}`, '');
  lines.push('| Item | Type | Best for | Apps |', '| --- | --- | --- | --- |');
  for (const item of manifest.items) {
    const apps = item.apps.map(app => APP_LABEL[app] ?? app).join(', ');
    lines.push(`| ${cell(item.name)} | ${TYPE_LABEL[item.type]} | ${cell(item.bestFor)} | ${apps} |`);
  }
  lines.push('', '## Import', '', 'Open Bindery, choose Libraries, then Import, and pick this folder or its git URL.', '');
  return lines.join('\n');
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function writeLibrary(dir, manifest) {
  writeAtomic(path.join(dir, 'library.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeAtomic(path.join(dir, 'README.md'), renderReadme(manifest));
}

function libraryFolder(stateDir, libraryId) {
  if (typeof libraryId !== 'string' || !ID_RE.test(libraryId)) throw new Error('That library id is not valid.');
  return path.join(librariesDir({ stateDir }), libraryId);
}

// Opens an existing library for changes. Throws when the folder is missing or broken.
function openLibrary(stateDir, libraryId) {
  const dir = libraryFolder(stateDir, libraryId);
  if (!isDirectory(dir)) throw new Error(`There is no library called ${libraryId}.`);
  return readLibrary(dir);
}

// Lists the user's libraries, skipping folders that are not valid libraries.
export function listLibraries({ stateDir }) {
  const base = librariesDir({ stateDir });
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(base, entry.name);
    let lib;
    try {
      lib = readLibrary(dir);
    } catch {
      continue;
    }
    let updatedAt = '';
    try {
      updatedAt = fs.statSync(path.join(dir, 'library.json')).mtime.toISOString();
    } catch { /* keep empty */ }
    out.push({
      id: lib.manifest.id,
      name: lib.manifest.name,
      description: lib.manifest.description,
      itemCount: lib.manifest.items.length,
      dir,
      updatedAt,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function createLibrary({ stateDir, id, name, description = '', author = '' }) {
  const checked = validateManifest({
    format: FORMAT,
    id,
    name,
    author,
    description,
    version: '1.0.0',
    license: '',
    createdAt: new Date().toISOString(),
    items: [],
  });
  if (!checked.ok) throw new Error(checked.errors[0]);

  const base = librariesDir({ stateDir });
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(base, id);
  try {
    fs.mkdirSync(dir);
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error(`A library called ${id} already exists.`);
    throw err;
  }
  fs.mkdirSync(path.join(dir, 'skills'));
  fs.mkdirSync(path.join(dir, 'prompts'));
  writeLibrary(dir, checked.manifest);
  return checked.manifest;
}

// A fresh folder under <stateDir>/backups for one operation's moved files.
function backupRoot(stateDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let dir = path.join(stateDir, 'backups', `library-${stamp}`);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(stateDir, 'backups', `library-${stamp}-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Moves libDir/relPath into a backup folder (never deletes). Returns the new location.
function backUp(stateDir, libraryId, libDir, relPath) {
  const dest = path.join(backupRoot(stateDir), libraryId, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(path.join(libDir, relPath), dest);
  return dest;
}

const keepSkillEntry = src => {
  const base = path.basename(src);
  return base !== '.git' && base !== 'node_modules';
};

// Adds or replaces one item. `stage` writes the new file/folder to a temp path first, so a
// failed copy leaves the existing item alone. The old item, if any, is backed up.
function putItem(stateDir, libraryId, item, stage) {
  const { dir, manifest: current } = openLibrary(stateDir, libraryId);
  const items = [...current.items];
  const index = items.findIndex(i => i.type === item.type && i.name === item.name);
  if (index === -1) items.push(item);
  else items[index] = item;
  const checked = validateManifest({ ...current, items });
  if (!checked.ok) throw new Error(checked.errors[0]);

  const target = path.join(dir, item.path);
  const staged = path.join(path.dirname(target), `.incoming-${process.pid}-${Date.now()}-${path.basename(target)}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    stage(staged);
    if (fs.existsSync(target)) backUp(stateDir, libraryId, dir, item.path);
    fs.renameSync(staged, target);
  } catch (err) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw err;
  }
  writeLibrary(dir, checked.manifest);
  return checked.manifest;
}

export function addSkill({ stateDir, libraryId, skillDir, name, bestFor = '', apps, source = null }) {
  const src = path.resolve(skillDir);
  if (!isDirectory(src)) throw new Error(`${src} is not a folder.`);
  if (!isFile(path.join(src, 'SKILL.md'))) throw new Error('This folder has no SKILL.md, so it is not a skill.');
  const item = {
    type: 'skill',
    name,
    path: `skills/${name}`,
    bestFor,
    apps: apps ?? [...APP_IDS],
    source,
  };
  // Links that leave the skill folder (for example to ~/.ssh) are not vendored into a shareable library.
  const realSrc = fs.realpathSync(src);
  const inside = p => {
    try {
      const real = fs.realpathSync(p);
      return real === realSrc || real.startsWith(realSrc + path.sep);
    } catch {
      return false;
    }
  };
  return putItem(stateDir, libraryId, item, staged => {
    fs.cpSync(src, staged, { recursive: true, dereference: true, filter: p => keepSkillEntry(p) && inside(p) });
  });
}

export function addPrompt({ stateDir, libraryId, promptFile, name, bestFor = '', apps, source = null }) {
  const src = path.resolve(promptFile);
  if (!isFile(src) || path.extname(src).toLowerCase() !== '.md') {
    throw new Error('Choose a single .md file for a prompt.');
  }
  const item = {
    type: 'prompt',
    name,
    path: `prompts/${name}.md`,
    bestFor,
    apps: apps ?? [...APP_IDS],
    source,
  };
  return putItem(stateDir, libraryId, item, staged => {
    fs.copyFileSync(src, staged);
  });
}

export function removeItem({ stateDir, libraryId, type, name }) {
  const { dir, manifest: current } = openLibrary(stateDir, libraryId);
  const item = current.items.find(i => i.type === type && i.name === name);
  if (!item) throw new Error(`${libraryId} has no ${type} called ${name}.`);
  const checked = validateManifest({ ...current, items: current.items.filter(i => i !== item) });
  if (!checked.ok) throw new Error(checked.errors[0]);
  if (fs.existsSync(path.join(dir, item.path))) backUp(stateDir, libraryId, dir, item.path);
  writeLibrary(dir, checked.manifest);
  return checked.manifest;
}

// Edits the "best for" note and/or the apps of one item. Files are not touched.
export function updateItem({ stateDir, libraryId, type, name, bestFor, apps }) {
  const { dir, manifest: current } = openLibrary(stateDir, libraryId);
  const index = current.items.findIndex(i => i.type === type && i.name === name);
  if (index === -1) throw new Error(`${libraryId} has no ${type} called ${name}.`);
  const old = current.items[index];
  const next = { ...old, bestFor: bestFor ?? old.bestFor, apps: apps ?? old.apps };
  const checked = validateManifest({
    ...current,
    items: current.items.map((item, i) => (i === index ? next : item)),
  });
  if (!checked.ok) throw new Error(checked.errors[0]);
  writeLibrary(dir, checked.manifest);
  return checked.manifest;
}

// Copies the whole library folder to <dest>/<libraryId>. Never overwrites.
export function exportLibrary({ stateDir, libraryId, dest }) {
  const { dir } = openLibrary(stateDir, libraryId);
  const outRoot = path.resolve(dest);
  if (outRoot === dir || outRoot.startsWith(dir + path.sep)) {
    throw new Error('Choose a folder outside the library itself.');
  }
  const target = path.join(outRoot, libraryId);
  if (fs.existsSync(target)) throw new Error(`${target} already exists. Choose another folder.`);
  fs.mkdirSync(outRoot, { recursive: true });
  fs.cpSync(dir, target, { recursive: true, dereference: true, errorOnExist: true, force: false });
  return { dir: target };
}
