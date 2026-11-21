// Compares two skill folders file by file, and SKILL.md line by line.
// Symlinks inside a folder are never followed. The top-level folder may itself be a link.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SKIP_DIRS = new Set(['.git', 'node_modules']);

const sha1 = file => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

// Map of relative path -> absolute path for regular files, capped at maxFiles.
function walk(dir, maxFiles) {
  const files = new Map();
  let top;
  try {
    top = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  const stack = [{ abs: dir, rel: '', entries: top }];
  while (stack.length && files.size < maxFiles) {
    const { abs, rel, entries } = stack.pop();
    for (const entry of entries) {
      if (files.size >= maxFiles) break;
      if (SKIP_DIRS.has(entry.name)) continue;
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const childAbs = path.join(abs, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        let children;
        try {
          children = fs.readdirSync(childAbs, { withFileTypes: true });
        } catch {
          continue;
        }
        stack.push({ abs: childAbs, rel: childRel, entries: children });
      } else if (entry.isFile()) {
        files.set(childRel, childAbs);
      }
    }
  }
  return files;
}

function sameContent(aFile, bFile) {
  let aSize;
  let bSize;
  try {
    aSize = fs.statSync(aFile).size;
    bSize = fs.statSync(bFile).size;
  } catch {
    return false;
  }
  if (aSize !== bSize) return false;
  return sha1(aFile) === sha1(bFile);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// Splits text into lines, ignoring one trailing newline.
function toLines(text) {
  if (text === '') return [];
  return text.replace(/\r?\n$/, '').split(/\r?\n/);
}

// Line diff through a suffix LCS table. Consecutive lines of one kind are merged into a hunk.
function lineHunks(aText, bText) {
  const a = toLines(aText);
  const b = toLines(bText);
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const lcs = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const steps = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      steps.push({ type: 'eq', line: a[i] });
      i++;
      j++;
    } else if (j >= m || (i < n && lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
      steps.push({ type: 'del', line: a[i] });
      i++;
    } else {
      steps.push({ type: 'add', line: b[j] });
      j++;
    }
  }

  const hunks = [];
  for (const step of steps) {
    const last = hunks[hunks.length - 1];
    if (last && last.type === step.type) last.lines.push(step.line);
    else hunks.push({ type: step.type, lines: [step.line] });
  }
  return hunks;
}

// aDir and bDir: skill folders. Returns per-file status and a SKILL.md line diff.
export function diffSkillFolders(aDir, bDir, { maxFiles = 2000, maxLines = 4000 } = {}) {
  for (const dir of [aDir, bDir]) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`Skill folder was not found: ${path.basename(dir)}.`);
    }
  }
  const aFiles = walk(aDir, maxFiles);
  const bFiles = walk(bDir, maxFiles);
  const rels = new Set([...aFiles.keys(), ...bFiles.keys()]);

  const files = [...rels].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)).map(rel => {
    const inA = aFiles.get(rel);
    const inB = bFiles.get(rel);
    let status;
    if (inA && inB) status = sameContent(inA, inB) ? 'same' : 'changed';
    else status = inA ? 'only-a' : 'only-b';
    return { rel, status };
  });

  const aText = readText(path.join(aDir, 'SKILL.md'));
  const bText = readText(path.join(bDir, 'SKILL.md'));
  const tooLarge = toLines(aText).length > maxLines || toLines(bText).length > maxLines;
  const skillMd = {
    a: aText,
    b: bText,
    hunks: tooLarge ? null : lineHunks(aText, bText),
    tooLarge,
  };

  return {
    same: files.every(f => f.status === 'same'),
    files,
    skillMd,
  };
}
