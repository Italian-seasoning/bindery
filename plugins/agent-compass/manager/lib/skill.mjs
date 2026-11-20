import fs from 'node:fs';
import path from 'node:path';

const SKILL_FILES = ['SKILL.md', 'skill.md'];
const FILE_CAP = 2000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SCRIPT_EXTS = new Set(['.sh', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.ps1', '.bat', '.cmd']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Minimal YAML subset for SKILL.md frontmatter. Never throws.
export function parseFrontmatter(text) {
  const src = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : '';
  const match = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!match) return { data: {}, body: src };
  const data = parseMapping(String(match[1] ?? '').split(/\r?\n/), 0, 0, false).obj;
  return { data, body: src.slice(match[0].length) };
}

function indentOf(line) {
  return /^ */.exec(line)[0].length;
}

function parseMapping(lines, start, indent, nested) {
  const obj = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) { i++; continue; }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) { i++; continue; }
    const m = /^([A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]+(.*)|$)/.exec(line.trim());
    i++;
    if (!m) continue;
    const key = m[1];
    const rest = (m[2] ?? '').trim();
    if (UNSAFE_KEYS.has(key)) { i = skipDeeper(lines, i, indent); continue; }
    if (/^[|>][+-]?[0-9]?$/.test(rest)) {
      const block = readBlock(lines, i, indent, rest[0]);
      obj[key] = block.value;
      i = block.next;
      continue;
    }
    if (rest === '') {
      const child = nested ? -1 : nextContentIndex(lines, i, indent);
      if (child !== -1 && isMappingLine(lines[child])) {
        const nestedResult = parseMapping(lines, child, indentOf(lines[child]), true);
        obj[key] = nestedResult.obj;
        i = nestedResult.next;
      } else {
        obj[key] = '';
        i = skipDeeper(lines, i, indent);
      }
      continue;
    }
    let text = rest;
    while (i < lines.length && lines[i].trim() && indentOf(lines[i]) > indent) {
      text += ' ' + lines[i].trim();
      i++;
    }
    obj[key] = parseScalar(text);
  }
  return { obj, next: i };
}

function isMappingLine(line) {
  return typeof line === 'string' && /^\s*[A-Za-z_][\w.-]*[ \t]*:(?:[ \t]|$)/.test(line);
}

function nextContentIndex(lines, i, indent) {
  let j = i;
  while (j < lines.length && !lines[j].trim()) j++;
  return j < lines.length && indentOf(lines[j]) > indent ? j : -1;
}

function skipDeeper(lines, i, indent) {
  let j = i;
  while (j < lines.length && (!lines[j].trim() || indentOf(lines[j]) > indent)) j++;
  return j;
}

function readBlock(lines, start, parentIndent, style) {
  let end = start;
  while (end < lines.length && (!lines[end].trim() || indentOf(lines[end]) > parentIndent)) end++;
  const body = lines.slice(start, end);
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const indents = body.filter(l => l.trim()).map(indentOf);
  const base = indents.length ? Math.min(...indents) : 0;
  const stripped = body.map(l => (l.trim() ? l.slice(base) : ''));
  let value;
  if (style === '|') {
    value = stripped.join('\n');
  } else {
    const paras = [];
    let cur = [];
    for (const l of stripped) {
      if (l === '') {
        if (cur.length) { paras.push(cur.join(' ')); cur = []; }
        paras.push('');
      } else {
        cur.push(l.trim());
      }
    }
    if (cur.length) paras.push(cur.join(' '));
    value = paras.join('\n');
  }
  return { value, next: end };
}

function parseScalar(raw) {
  const t = String(raw).trim();
  if (!t) return '';
  const dq = /^"((?:[^"\\]|\\.)*)"/.exec(t);
  if (dq) return dq[1].replace(/\\(["\\])/g, '$1');
  const sq = /^'((?:[^']|'')*)'/.exec(t);
  if (sq) return sq[1].replace(/''/g, "'");
  if (t[0] === '"' || t[0] === "'") return t.slice(1);
  if (t[0] === '[' && t.endsWith(']')) return splitList(t.slice(1, -1));
  return t.replace(/[ \t]+#.*$/, '').trim();
}

function splitList(inner) {
  const items = [];
  let cur = '';
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ',') { items.push(cur); cur = ''; continue; }
    cur += ch;
  }
  items.push(cur);
  return items.map(s => parseScalar(s)).filter(s => s !== '');
}

function findSkillFile(dir) {
  for (const name of SKILL_FILES) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* not present */ }
  }
  return null;
}

function resolveLink(dir) {
  try {
    return path.resolve(path.dirname(dir), fs.readlinkSync(dir));
  } catch {
    return null;
  }
}

// Bounded walk of the real folder: counts files and detects scripts.
function countFiles(realDir) {
  let fileCount = 0;
  let bytes = 0;
  let hasScripts = false;
  const stack = [realDir];
  outer: while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name === 'scripts') hasScripts = true;
        stack.push(path.join(dir, e.name));
        continue;
      }
      if (fileCount >= FILE_CAP) break outer;
      fileCount++;
      if (SCRIPT_EXTS.has(path.extname(e.name).toLowerCase())) hasScripts = true;
      try {
        bytes += fs.lstatSync(path.join(dir, e.name)).size;
      } catch { /* vanished mid-walk */ }
    }
  }
  return { fileCount, bytes, hasScripts };
}

// Reads one skill folder. Returns a SkillEntry, or null when the folder is not a skill.
export function readSkill(dir, root) {
  const folder = path.basename(dir);
  const readOnly = root.writable === false || root.scope === 'plugin';

  let lst;
  try {
    lst = fs.lstatSync(dir);
  } catch {
    return null;
  }
  const isSymlink = lst.isSymbolicLink();
  const head = {
    id: `${root.id}:${folder}`,
    name: folder,
    description: '',
    folder,
    rootId: root.id,
    host: root.host,
    scope: root.scope,
    path: dir,
  };

  let realPath;
  try {
    realPath = fs.realpathSync(dir);
  } catch {
    if (!isSymlink) return null;
    return {
      ...head,
      isSymlink: true,
      linkTarget: resolveLink(dir),
      realPath: null,
      broken: true,
      fileCount: 0,
      bytes: 0,
      hasScripts: false,
      updatedAt: lst.mtime.toISOString(),
      pluginName: null,
      readOnly,
    };
  }

  const skillPath = findSkillFile(dir);
  if (!skillPath) return null;

  let text = '';
  try {
    text = fs.readFileSync(skillPath, 'utf8');
  } catch { /* unreadable: keep the entry with empty metadata */ }
  const { data } = parseFrontmatter(text);
  const str = value => (typeof value === 'string' ? value : '');
  const name = str(data.name).replace(/\s+/g, ' ').trim() || folder;
  const description = str(data.description).replace(/\s+/g, ' ').trim();

  const { fileCount, bytes, hasScripts } = countFiles(realPath);
  let updatedAt = lst.mtime.toISOString();
  try {
    updatedAt = fs.statSync(skillPath).mtime.toISOString();
  } catch { /* keep folder mtime */ }

  return {
    ...head,
    name,
    description,
    isSymlink,
    linkTarget: isSymlink ? resolveLink(dir) : null,
    realPath,
    broken: false,
    fileCount,
    bytes,
    hasScripts,
    updatedAt,
    pluginName: null,
    readOnly,
  };
}
