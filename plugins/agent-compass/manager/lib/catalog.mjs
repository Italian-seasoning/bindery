// Curated skill-pack catalog: loads the shipped list, fetches packs with git
// into a per-user cache, and lists the skills each pack contains.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CATALOG_URL = new URL('../catalog/packs.json', import.meta.url);
const PACK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SKILL_FILES = ['SKILL.md', 'skill.md'];
const MAX_DEPTH = 5;
const MAX_FILES = 2000;
const HEAD_BYTES = 64 * 1024;
const SCRIPT_EXT = new Set(['.sh', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.ps1', '.bat', '.cmd']);
const ALLOWED_DOT_DIRS = new Set(['.claude', '.agents', '.codex']);
const LICENSE_RE = /^(LICENSE|LICENCE|COPYING)/i;
const LICENSE_HINTS = [
  ['MIT License', 'MIT'],
  ['Apache License', 'Apache-2.0'],
  ['BSD', 'BSD'],
  ['GNU GENERAL PUBLIC', 'GPL'],
  ['Mozilla Public', 'MPL-2.0'],
];

export function loadCatalog() {
  const data = JSON.parse(fs.readFileSync(CATALOG_URL, 'utf8'));
  return {
    checked: data.checked ?? null,
    note: data.note ?? '',
    packs: Array.isArray(data.packs) ? data.packs : [],
  };
}

export async function fetchPack(pack, { stateDir, git = 'git', timeoutMs = 60000 } = {}) {
  const dir = cacheDirFor(stateDir, pack);
  if (typeof pack.repo !== 'string' || pack.repo === '') {
    throw new Error('Pack has no repository URL.');
  }
  const opts = { git, timeoutMs, repo: pack.repo };
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    try {
      await runGit(['clone', '--depth', '1', '--quiet', '--', pack.repo, dir], opts);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw gitError(err, opts);
    }
  } else {
    try {
      await runGit(['-C', dir, 'fetch', '--depth', '1', '--quiet', 'origin'], opts);
      await runGit(['-C', dir, 'reset', '--hard', '--quiet', 'FETCH_HEAD'], opts);
    } catch (err) {
      throw gitError(err, opts);
    }
  }
  const { stdout } = await runGit(['-C', dir, 'rev-parse', 'HEAD'], opts);
  return buildPack(pack, dir, stdout.trim(), new Date().toISOString());
}

// Synchronous and network-free: returns the cached copy or null.
export function cachedPack(pack, { stateDir, git = 'git' } = {}) {
  const dir = cacheDirFor(stateDir, pack);
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  try {
    const stdout = execFileSync(git, ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      env: gitEnv(),
    });
    return buildPack(pack, dir, stdout.trim(), cacheTime(dir));
  } catch {
    return null;
  }
}

function buildPack(pack, dir, commit, fetchedAt) {
  return {
    packId: pack.id,
    commit,
    fetchedAt,
    dir,
    license: readLicense(dir),
    skills: findSkills(dir),
  };
}

function cacheDirFor(stateDir, pack) {
  if (!stateDir) throw new Error('stateDir is required.');
  if (!pack || typeof pack.id !== 'string' || !PACK_ID_RE.test(pack.id)) {
    throw new Error('Pack id is not valid.');
  }
  return path.join(stateDir, 'cache', pack.id);
}

function gitEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
}

function runGit(args, { git, timeoutMs }) {
  return execFileAsync(git, args, {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: gitEnv(),
  });
}

function gitError(err, { repo }) {
  if (err && err.code === 'ENOENT') {
    return new Error('Git is not installed, so packs cannot be fetched.', { cause: err });
  }
  return new Error(`Could not reach ${repo}. Check your connection and try again.`, { cause: err });
}

function cacheTime(dir) {
  for (const p of [path.join(dir, '.git', 'FETCH_HEAD'), path.join(dir, '.git')]) {
    try {
      return fs.statSync(p).mtime.toISOString();
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function readLicense(dir) {
  const names = readEntries(dir)
    .map((e) => e.name)
    .filter((n) => LICENSE_RE.test(n))
    .sort();
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      return { file: name, spdxGuess: guessSpdx(readHead(file, 400)) };
    } catch {
      // unreadable licence file: try the next candidate
    }
  }
  return null;
}

function guessSpdx(text) {
  const lower = text.toLowerCase();
  for (const [needle, spdx] of LICENSE_HINTS) {
    if (lower.includes(needle.toLowerCase())) return spdx;
  }
  return null;
}

function findSkills(repoDir) {
  const found = [];
  const seen = new Set();
  const stack = [{ dir: repoDir, rel: '', depth: 0 }];
  while (stack.length > 0) {
    const { dir, rel, depth } = stack.pop();
    const entries = readEntries(dir);
    const skillFile = SKILL_FILES.find((n) => entries.some((e) => e.name === n));
    if (skillFile) {
      let real;
      try {
        real = fs.realpathSync(dir);
      } catch {
        continue;
      }
      if (!seen.has(real)) {
        seen.add(real);
        found.push(toSkill(dir, rel, skillFile));
      }
      continue; // a skill folder is a leaf
    }
    if (depth >= MAX_DEPTH) continue;
    for (const e of entries) {
      if (skipDir(e.name) || !isDirEntry(dir, e)) continue;
      stack.push({
        dir: path.join(dir, e.name),
        rel: rel ? `${rel}/${e.name}` : e.name,
        depth: depth + 1,
      });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name) || a.relPath.localeCompare(b.relPath));
}

function toSkill(dir, rel, skillFile) {
  let fm = {};
  try {
    fm = parseFrontmatter(readHead(path.join(dir, skillFile), HEAD_BYTES));
  } catch {
    // unreadable SKILL.md: fall back to the folder name
  }
  const { fileCount, hasScripts } = countFiles(dir);
  const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : path.basename(dir);
  return {
    name,
    description: collapse(fm.description),
    relPath: rel || '.',
    dir,
    fileCount,
    hasScripts,
  };
}

function countFiles(dir) {
  let fileCount = 0;
  let hasScripts = false;
  const stack = [dir];
  while (stack.length > 0 && fileCount < MAX_FILES) {
    const current = stack.pop();
    for (const e of readEntries(current)) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      if (e.isDirectory()) {
        if (e.name === 'scripts') hasScripts = true;
        stack.push(path.join(current, e.name));
        continue;
      }
      fileCount += 1;
      if (SCRIPT_EXT.has(path.extname(e.name).toLowerCase())) hasScripts = true;
      if (fileCount >= MAX_FILES) break;
    }
  }
  return { fileCount, hasScripts };
}

function skipDir(name) {
  if (name === '.git' || name === 'node_modules') return true;
  return name.startsWith('.') && !ALLOWED_DOT_DIRS.has(name);
}

function isDirEntry(dir, e) {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(dir, e.name)).isDirectory();
  } catch {
    return false;
  }
}

function readEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function collapse(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

// Private minimal frontmatter reader: returns string values for top-level keys
// (quoted, plain, and `|` / `>` block scalars). Nested maps and lists are
// ignored. Only `name` and `description` are used by this module.
function parseFrontmatter(text) {
  const data = {};
  const src = text.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return data;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):(?:\s*(.*))?$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    const value = (kv[2] ?? '').trim();
    if (/^[|>][+-]?$/.test(value)) {
      const parts = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || /^\s/.test(lines[j]))) {
        parts.push(lines[j].trim());
        j += 1;
      }
      i = j - 1;
      while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
      data[key] = value.startsWith('|') ? parts.join('\n') : parts.join(' ');
    } else if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      data[key] = value.slice(1, -1);
    } else if (value !== '' && value[0] !== '"' && value[0] !== "'") {
      const parts = [value];
      let j = i + 1;
      while (j < lines.length && /^\s+\S/.test(lines[j])) {
        parts.push(lines[j].trim());
        j += 1;
      }
      i = j - 1;
      data[key] = parts.join(' ');
    } else if (value === '') {
      data[key] = '';
    }
  }
  return data;
}
