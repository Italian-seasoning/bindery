// Importing a shared library from a git link. The clone lands in a cache folder keyed by the link,
// and a previous copy is moved into <stateDir>/backups, never deleted. Only https links are used.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { diffSkillFolders } from './diff.mjs';
import { readLibrary, validateManifest } from './library.mjs';

const execFileAsync = promisify(execFile);

const SEG_RE = /^[A-Za-z0-9_.-]+$/;
const SHORTHAND_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const UP_RE = /(^|\/)(\.\.|%2e%2e|\.%2e|%2e\.)(\/|$)/i;
const GIT_TIMEOUT_MS = 60000;
const GIT_SAFETY = [
  '-c', `core.hooksPath=${os.devNull}`,
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
];

// The real git runner. Same safety style as catalog.mjs: no prompts, timeouts, bounded output,
// hooks disabled, and only https allowed as a transport.
export async function defaultGitRunner(args, { cwd } = {}) {
  const { stdout } = await execFileAsync('git', [...GIT_SAFETY, ...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { stdout: String(stdout) };
}

const notHttps = () => new Error('Only https links can be used to import a library.');

function decodeSegment(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new Error('The link is not valid. Copy it again from the browser address bar.');
  }
}

// Turns a pasted link into { url, ref, subdir }. url is always an https .git address.
export function normalizeGitUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('Enter a library link, such as https://github.com/owner/repo.');
  }
  let text = input.trim();
  if (/\s/.test(text)) throw new Error('The library link must not contain spaces.');

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(text);
  if (scheme) {
    if (scheme[1].toLowerCase() !== 'https') throw notHttps();
  } else if (/^[^/@\s]+@[^/\s]+:/.test(text)) {
    // ssh style, such as git@github.com:owner/repo
    throw notHttps();
  } else if (/^[^/]+\.[^/]+\//.test(text)) {
    text = `https://${text}`;
  } else if (SHORTHAND_RE.test(text.replace(/\/$/, ''))) {
    text = `https://github.com/${text.replace(/\/$/, '')}`;
  } else {
    throw new Error('That does not look like a library link. Use a link such as https://github.com/owner/repo.');
  }

  // Checked on the raw text, because URL parsing would quietly resolve "..".
  if (UP_RE.test(text.replace(/^https:\/\/[^/]+/, ''))) {
    throw new Error("The folder path in the link must not go up with '..'.");
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('That does not look like a web link. Use a link such as https://github.com/owner/repo.');
  }
  if (url.username || url.password) {
    throw new Error('Links with a username or password are not accepted. Remove the part before the @ and try again.');
  }
  if (url.port) throw new Error('Links with a port number are not accepted.');

  const parts = url.pathname.split('/').filter(Boolean).map(decodeSegment);
  if (parts.length < 2) {
    throw new Error('The link must point to a repository, such as https://github.com/owner/repo.');
  }
  const [owner, rawRepo] = parts;
  const repo = rawRepo.replace(/\.git$/, '');
  const isDots = s => /^\.+$/.test(s);
  if (!SEG_RE.test(owner) || !SEG_RE.test(repo) || isDots(owner) || isDots(repo)) {
    throw new Error('The owner or repository name in the link is not valid.');
  }
  const base = `https://${url.hostname}/${owner}/${repo}.git`;

  const rest = parts.slice(2);
  if (rest.length === 0) return { url: base, ref: null, subdir: null };

  if (rest[0] !== 'tree' || url.hostname !== 'github.com') {
    throw new Error('Use the repository link, or a GitHub link to a folder that starts with /tree/.');
  }
  if (rest.length < 2) throw new Error('The link is missing the branch name after /tree/.');
  const ref = rest[1];
  if (!REF_RE.test(ref) || ref.includes('..')) throw new Error('The branch name in the link is not valid.');

  const subParts = rest.slice(2).flatMap(p => p.split('/'));
  if (subParts.some(p => p === '..' || p === '.')) {
    throw new Error("The folder path in the link must not go up with '..'.");
  }
  if (subParts.some(p => p === '' || p.includes('\\') || p.includes('\0'))) {
    throw new Error('The folder path in the link is not valid.');
  }
  return { url: base, ref, subdir: subParts.length ? subParts.join('/') : null };
}

// One cache folder per link, branch and folder, so two folders of one repository never share a cache.
// The name is a short hash, so the link itself stays out of the path. A plain repository link keeps
// the same key it always had.
export function libraryCacheDir({ stateDir, url, ref = null, subdir = null }) {
  if (!stateDir) throw new Error('The library folder location is missing.');
  const id = ref || subdir ? `${url}#${ref ?? ''}:${subdir ?? ''}` : String(url);
  const key = crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);
  return path.join(stateDir, 'cache', 'libraries', key);
}

function gitFailure(err) {
  if (err && err.code === 'ENOENT') {
    return new Error('Git is not installed, so libraries cannot be imported.', { cause: err });
  }
  return new Error('Could not download the library from that link. Check the link and your connection, then try again.', { cause: err });
}

async function runGit(git, args, opts) {
  try {
    const result = await git(args, opts);
    return String(result?.stdout ?? '');
  } catch (err) {
    throw gitFailure(err);
  }
}

function readFetchMeta(cacheDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir, '.fetch.json'), 'utf8'));
  } catch {
    return null;
  }
}

// A fresh folder under <stateDir>/backups for one fetch's moved copy.
function fetchBackupRoot(stateDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let dir = path.join(stateDir, 'backups', `library-fetch-${stamp}`);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(stateDir, 'backups', `library-fetch-${stamp}-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The folder for a subfolder path, only when it is a real folder inside the clone (no links out).
function folderInside(root, rel) {
  const target = path.join(root, rel);
  let realRoot;
  let real;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(target);
  } catch {
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  if (!fs.statSync(real).isDirectory()) return null;
  return target;
}

// Imports the library behind a link into the cache, then validates it.
export async function fetchLibrary({ stateDir, input, git = defaultGitRunner } = {}) {
  if (!stateDir) throw new Error('The library folder location is missing.');
  const { url, ref, subdir } = normalizeGitUrl(input);
  const cacheDir = libraryCacheDir({ stateDir, url, ref, subdir });
  const parent = path.dirname(cacheDir);
  fs.mkdirSync(parent, { recursive: true });

  const tmpRoot = fs.mkdtempSync(path.join(parent, '.incoming-'));
  let backupDir = null;
  let prevMeta = null;
  let commit;
  try {
    const cloneArgs = ['clone', '--depth', '1', '--quiet', ...(ref ? ['--branch', ref] : []), '--', url, tmpRoot];
    await runGit(git, cloneArgs, { cwd: parent });
    commit = (await runGit(git, ['rev-parse', 'HEAD'], { cwd: tmpRoot })).trim();
    fs.rmSync(path.join(tmpRoot, '.git'), { recursive: true, force: true });

    if (subdir && !folderInside(tmpRoot, subdir)) {
      throw new Error('The folder named in the link was not found in that repository.');
    }

    fs.writeFileSync(
      path.join(tmpRoot, '.fetch.json'),
      `${JSON.stringify({ url, ref, subdir, commit, fetchedAt: new Date().toISOString() }, null, 2)}\n`,
    );

    prevMeta = readFetchMeta(cacheDir);
    if (fs.existsSync(cacheDir)) {
      backupDir = path.join(fetchBackupRoot(stateDir), path.basename(cacheDir));
      fs.renameSync(cacheDir, backupDir);
    }
    try {
      fs.renameSync(tmpRoot, cacheDir);
    } catch (err) {
      if (backupDir) fs.renameSync(backupDir, cacheDir);
      throw err;
    }
  } catch (err) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw err;
  }

  // The cache is kept from here on, even when the folder turns out not to be a valid library.
  const dir = subdir ? path.join(cacheDir, subdir) : cacheDir;
  readLibrary(dir);

  let previousCommit = null;
  let changes = null;
  if (backupDir) {
    previousCommit = prevMeta?.commit ?? null;
    const prevSubdir = prevMeta ? prevMeta.subdir : subdir;
    const oldDir = prevSubdir ? path.join(backupDir, prevSubdir) : backupDir;
    changes = compareLibraries(oldDir, dir);
  }
  return { dir, cacheDir, commit, url, previousCommit, changes };
}

function manifestItems(dir) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'));
  } catch {
    return new Map();
  }
  const { manifest } = validateManifest(raw);
  const items = new Map();
  for (const item of manifest?.items ?? []) {
    items.set(`${item.type}:${item.name}`, { ...item, root: dir });
  }
  return items;
}

// Resolves an item's path inside its library folder. Returns null for anything that leaves it.
function itemPath(root, rel) {
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel) || rel.split('/').includes('..')) return null;
  return path.join(root, rel);
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function sameItemFiles(a, b) {
  const pa = itemPath(a.root, a.path);
  const pb = itemPath(b.root, b.path);
  if (!pa || !pb) return pa === pb;
  if (a.type === 'skill') {
    const inA = isDirectory(pa);
    const inB = isDirectory(pb);
    if (!inA || !inB) return inA === inB;
    return diffSkillFolders(pa, pb).same;
  }
  return readOptional(pa) === readOptional(pb);
}

const notesOf = item => JSON.stringify([item.bestFor ?? '', item.apps ?? []]);
const byTypeName = (x, y) => (x.type.localeCompare(y.type) || x.name.localeCompare(y.name));

// Compares two library folders: items added, removed, and changed (files or the "best for"/apps notes).
export function compareLibraries(oldDir, newDir) {
  const oldItems = manifestItems(oldDir);
  const newItems = manifestItems(newDir);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, item] of newItems) {
    if (!oldItems.has(key)) added.push({ type: item.type, name: item.name });
  }
  for (const [key, item] of oldItems) {
    if (!newItems.has(key)) removed.push({ type: item.type, name: item.name });
  }
  for (const [key, item] of newItems) {
    const prev = oldItems.get(key);
    if (!prev) continue;
    const parts = [];
    if (notesOf(prev) !== notesOf(item)) parts.push('notes');
    if (!sameItemFiles(prev, item)) parts.push('files');
    if (parts.length > 0) changed.push({ type: item.type, name: item.name, parts });
  }
  return {
    added: added.sort(byTypeName),
    removed: removed.sort(byTypeName),
    changed: changed.sort(byTypeName),
  };
}
