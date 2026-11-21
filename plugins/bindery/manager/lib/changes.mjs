// Transactional skill install, removal and undo.
// Nothing is ever deleted. Anything a change displaces is moved into
// <stateDir>/backups/<txId>/ and every step is recorded in
// <stateDir>/journal/<txId>.json before the next one runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TX_RE = /^[0-9a-f]{12}$/;
const SCRIPT_EXT = new Set(['.sh', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.ps1', '.bat', '.cmd']);
const SYMLINK_FALLBACK = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'UNKNOWN']);
const WALK_CAP = 2000;

const fail = (message, options) => new Error(message, options);

function resolveStateDir({ home, stateDir } = {}) {
  if (stateDir) return path.resolve(stateDir);
  if (process.env.BINDERY_HOME) return path.resolve(process.env.BINDERY_HOME);
  return path.join(home || os.homedir(), '.bindery');
}

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

function existingInfo(p) {
  const st = lstatOrNull(p);
  if (!st) return null;
  const isSymlink = st.isSymbolicLink();
  return { isSymlink, linkTarget: isSymlink ? fs.readlinkSync(p) : null };
}

function assertDirectChild(rootPath, dest) {
  const root = path.resolve(rootPath);
  const target = path.resolve(dest);
  const base = path.basename(target);
  if (!base || base === '.' || base === '..' || path.dirname(target) !== root) {
    throw fail(`"${base || dest}" is not a skill folder directly inside the chosen location. Nothing was changed.`);
  }
}

function checkWritableRoot(root) {
  if (!root || typeof root !== 'object' || typeof root.path !== 'string' || !path.isAbsolute(root.path)) {
    throw fail('Choose a valid skill location.');
  }
  const label = root.label || 'That location';
  if (root.scope === 'plugin' || root.readOnly) throw fail(`${label} is managed by a plugin and is read-only.`);
  if (root.writable === false) throw fail(`${label} is not writable.`);
}

function hasSkillFile(dir) {
  return fs.existsSync(path.join(dir, 'SKILL.md')) || fs.existsSync(path.join(dir, 'skill.md'));
}

function checkSource(src) {
  if (typeof src !== 'string' || !path.isAbsolute(src)) throw fail('The skill source must be an absolute folder path.');
  let st = null;
  try { st = fs.statSync(src); } catch { st = null; }
  if (!st || !st.isDirectory()) throw fail(`Skill source folder was not found: ${path.basename(src)}.`);
  if (!hasSkillFile(src)) throw fail(`${path.basename(src)} has no SKILL.md, so it is not a skill.`);
}

// Single-file ops (custom prompts). Added for lib/prompts.mjs; folder ops never reach this.
function checkSourceFile(src) {
  if (typeof src !== 'string' || !path.isAbsolute(src)) throw fail('The prompt source must be an absolute file path.');
  let st = null;
  try { st = fs.statSync(src); } catch { st = null; }
  if (!st || !st.isFile()) throw fail(`Prompt source file was not found: ${path.basename(src)}.`);
}

function containsScripts(dir) {
  const queue = [dir];
  let seen = 0;
  while (queue.length && seen < WALK_CAP) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > WALK_CAP) break;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (entry.isDirectory()) {
        if (entry.name === 'scripts') return true;
        queue.push(path.join(current, entry.name));
      } else if (entry.isFile() && SCRIPT_EXT.has(path.extname(entry.name).toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

// pendingSource: true makes a symlink whose src is the dest of an earlier op in the same plan.
// That folder does not exist yet, so its SKILL.md is not checked here; makePlan and applyPlan
// check that an earlier op really creates it.
export function installOp({ src, name, targetRoot, mode = 'copy', pendingSource = false } = {}) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw fail(`"${name}" is not a valid skill folder name. Use letters, numbers, dots, dashes and underscores (100 characters at most).`);
  }
  if (mode !== 'copy' && mode !== 'symlink') throw fail('Install mode must be "copy" or "symlink".');
  checkWritableRoot(targetRoot);
  if (pendingSource) {
    if (mode !== 'symlink') throw fail('A link to a folder from the same change must use mode "symlink".');
    if (typeof src !== 'string' || !path.isAbsolute(src)) throw fail('The skill source must be an absolute folder path.');
  } else {
    checkSource(src);
  }
  const source = path.resolve(src);
  const dest = path.join(path.resolve(targetRoot.path), name);
  assertDirectChild(targetRoot.path, dest);
  if (source === dest) throw fail('That skill is already in this location.');
  const existing = existingInfo(dest);
  const warnings = [];
  if (existing) warnings.push(`Replaces existing ${name} in ${targetRoot.label}. The current copy is kept as a backup.`);
  if (!pendingSource && containsScripts(source)) warnings.push('Contains scripts. Read them before running this skill.');
  const op = { op: existing ? 'replace' : 'create', dest, src: source, mode, existing, root: path.resolve(targetRoot.path) };
  if (pendingSource) op.pendingSrc = true;
  return {
    op,
    warnings,
    label: targetRoot.label || targetRoot.path,
  };
}

// A pendingSrc op may only link to a folder that an earlier create/replace op in the same plan makes.
function checkPendingSources(ops) {
  const made = new Set();
  for (const op of ops) {
    if (op.pendingSrc === true) {
      const name = path.basename(String(op.dest));
      if (op.op === 'remove' || op.mode !== 'symlink') {
        throw fail(`"${name}" links to a folder from the same change, so it must be a symlink install. Nothing was changed.`);
      }
      if (typeof op.src !== 'string' || !path.isAbsolute(op.src) || !made.has(path.resolve(op.src))) {
        throw fail(`"${name}" links to a folder that no earlier change in this plan creates. Nothing was changed.`);
      }
    }
    if (op.op !== 'remove') made.add(path.resolve(String(op.dest)));
  }
}

function makePlan(kind, ops, warnings, label, summary) {
  checkPendingSources(ops);
  const plan = {
    id: crypto.randomBytes(6).toString('hex'),
    kind,
    createdAt: new Date().toISOString(),
    label,
    ops,
    warnings: [...new Set(warnings)],
  };
  if (summary) plan.summary = summary;
  return plan;
}

export function planInstall(args) {
  const built = installOp(args);
  return makePlan('install', [built.op], built.warnings, built.label);
}

export function planInstallMany(items) {
  if (!Array.isArray(items) || items.length === 0) throw fail('Choose at least one skill to install.');
  const built = items.map(installOp);
  const seen = new Set();
  for (const { op } of built) {
    if (seen.has(op.dest)) throw fail(`"${path.basename(op.dest)}" appears twice in this install.`);
    seen.add(op.dest);
  }
  const labels = [...new Set(built.map(b => b.label))];
  return makePlan('install', built.map(b => b.op), built.flatMap(b => b.warnings), labels.join(', '));
}

export function removeOp({ skillPath, root } = {}) {
  checkWritableRoot(root);
  if (typeof skillPath !== 'string' || !path.isAbsolute(skillPath)) throw fail('Choose a skill folder to remove.');
  const dest = path.resolve(skillPath);
  assertDirectChild(root.path, dest);
  const existing = existingInfo(dest);
  if (!existing) throw fail(`"${path.basename(dest)}" is not in ${root.label || 'that location'} any more.`);
  const warnings = existing.isSymlink
    ? ['Only the link is removed. The folder it points to is not touched.']
    : ['The folder is moved to a backup, so this can be undone.'];
  return {
    op: { op: 'remove', dest, src: null, mode: 'remove', existing, root: path.resolve(root.path) },
    warnings,
    label: root.label || root.path,
  };
}

export function planRemove(args) {
  const built = removeOp(args);
  return makePlan('remove', [built.op], built.warnings, built.label);
}

// A share plan may add links or copies and remove entries in one transaction.
// Ops run in order, so any copy that replaces a link must come before the removal it depends on.
export function planShareOps({ ops, warnings = [], label, summary }) {
  if (!Array.isArray(ops) || ops.length === 0) throw fail('There is nothing to change.');
  const seen = new Set();
  for (const op of ops) {
    if (seen.has(op.dest)) throw fail(`"${path.basename(op.dest)}" would be changed twice. Nothing was changed.`);
    seen.add(op.dest);
  }
  return makePlan('share', ops, warnings, label, summary);
}

function summarize(plan) {
  if (typeof plan.summary === 'string' && plan.summary) return plan.summary.slice(0, 200);
  const n = plan.ops.length;
  const names = [...new Set(plan.ops.map((op) => path.basename(op.dest)))];
  if (plan.kind === 'remove') {
    if (n === 1) return `Removed ${names[0]} from ${plan.label}`;
    return names.length === 1 ? `Removed ${names[0]} from ${n} locations` : `Removed ${n} skills`;
  }
  if (n === 1) return `Installed ${path.basename(plan.ops[0].dest)} into ${plan.label}`;
  return `Installed ${n} skills into ${plan.label}`;
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') throw fail('There is no plan to apply.');
  if (typeof plan.id !== 'string' || !TX_RE.test(plan.id)) throw fail('The plan id is not valid.');
  if (!['install', 'remove', 'share'].includes(plan.kind)) throw fail('Unknown plan type.');
  if (!Array.isArray(plan.ops) || plan.ops.length === 0) throw fail('The plan has nothing to change.');
  const dests = new Set();
  for (const op of plan.ops) {
    if (!op || typeof op !== 'object') throw fail('The plan has a damaged change. Nothing was changed.');
    if (plan.kind !== 'share' && (plan.kind === 'remove') !== (op.op === 'remove')) {
      throw fail('The plan mixes installs and removals. Nothing was changed.');
    }
    const key = path.resolve(String(op.dest));
    if (dests.has(key)) throw fail('The plan changes the same folder twice. Nothing was changed.');
    dests.add(key);
  }
  checkPendingSources(plan.ops);
}

function journalFile(stateDir, txId) {
  return path.join(stateDir, 'journal', `${txId}.json`);
}

function writeJournal(file, journal) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(journal, null, 2));
  fs.renameSync(tmp, file);
}

function readJournal(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') throw fail('No change with that id was found.');
    throw err;
  }
  try { return JSON.parse(text); } catch { throw fail('The record of that change is damaged. Nothing was changed.'); }
}

function sameDevice(a, b) {
  try { return fs.statSync(a).dev === fs.statSync(b).dev; } catch { return false; }
}

function nearestExisting(p) {
  let current = p;
  while (!lstatOrNull(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function prepareOp(o, index, txDir) {
  if (!o || typeof o !== 'object') throw fail('The plan has a damaged change. Nothing was changed.');
  if (!['create', 'replace', 'remove'].includes(o.op)) throw fail('The plan has an unknown operation. Nothing was changed.');
  if (typeof o.root !== 'string' || !path.isAbsolute(o.root)) throw fail('The plan has no valid location. Nothing was changed.');
  assertDirectChild(o.root, o.dest);
  const dest = path.resolve(o.dest);
  const name = path.basename(dest);
  // File ops (prompts) carry file: true; their name check ignores the .md extension.
  const isFile = o.file === true;
  const rec = {
    op: o.op,
    dest,
    src: null,
    mode: o.op === 'remove' ? 'remove' : o.mode,
    root: path.resolve(o.root),
    existing: o.existing ?? null,
    backup: null,
    stage: 'planned',
    file: isFile,
  };
  const exists = lstatOrNull(dest) !== null;
  if (o.op === 'remove') {
    if (!exists) throw fail(`"${name}" is no longer there. Nothing was changed.`);
  } else {
    const bare = isFile ? name.replace(/\.md$/, '') : name;
    if (!NAME_RE.test(bare)) throw fail(`"${name}" is not a valid skill folder name. Nothing was changed.`);
    if (o.mode !== 'copy' && o.mode !== 'symlink') throw fail('Install mode must be "copy" or "symlink".');
    // A pending link's source is created by an earlier op, so it does not exist yet (validatePlan checked where it comes from).
    if (o.pendingSrc === true) {
      if (typeof o.src !== 'string' || !path.isAbsolute(o.src)) throw fail('The plan has no valid source. Nothing was changed.');
    } else if (isFile) checkSourceFile(o.src); else checkSource(o.src);
    rec.src = path.resolve(o.src);
  }
  if (exists) rec.backup = path.join(txDir, String(index), name);
  // Moves must stay on one device, so a rename never has to fall back to copy and delete.
  if (!sameDevice(txDir, nearestExisting(path.dirname(dest)))) {
    throw fail('The backup folder is on a different drive from the skill folder. Nothing was changed.');
  }
  return rec;
}

function placeEntry(src, dest, mode, isFile = false) {
  if (mode === 'symlink') {
    try {
      fs.symlinkSync(src, dest, isFile ? 'file' : 'dir');
      return 'symlink';
    } catch (err) {
      if (!SYMLINK_FALLBACK.has(err.code)) throw err;
    }
  }
  fs.cpSync(src, dest, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
    filter: p => path.basename(p) !== '.git',
  });
  return 'copy';
}

function moveEntry(from, to) {
  fs.renameSync(from, to);
}

function quarantine(from, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const to = path.join(dir, path.basename(from));
  if (lstatOrNull(to)) throw fail(`Could not move "${path.basename(from)}" aside because a backup with that name exists.`);
  moveEntry(from, to);
}

function restoreBackup(rec) {
  if (!rec.backup || !lstatOrNull(rec.backup)) return;
  const name = path.basename(rec.dest);
  if (lstatOrNull(rec.dest)) {
    throw fail(`"${name}" could not be put back because something is already in its place. Its original copy is kept in the backups folder.`);
  }
  fs.mkdirSync(path.dirname(rec.dest), { recursive: true });
  moveEntry(rec.backup, rec.dest);
}

function rollback(journal, journalPath, txDir) {
  const problems = [];
  for (let i = journal.ops.length - 1; i >= 0; i--) {
    const rec = journal.ops[i];
    try {
      if (rec.op !== 'remove' && (rec.stage === 'creating' || rec.stage === 'done') && lstatOrNull(rec.dest)) {
        quarantine(rec.dest, path.join(txDir, 'rollback', String(i)));
      }
      restoreBackup(rec);
      rec.stage = 'reverted';
    } catch (err) {
      problems.push(err.message);
    }
  }
  journal.status = problems.length ? 'rollback-failed' : 'rolled-back';
  writeJournal(journalPath, journal);
  return problems;
}

export function applyPlan(plan, options = {}) {
  validatePlan(plan);
  const stateDir = resolveStateDir(options);
  const txId = plan.id;
  const journalPath = journalFile(stateDir, txId);
  if (lstatOrNull(journalPath)) throw fail('This change was already applied. Build a new plan to make another change.');

  const txDir = path.join(stateDir, 'backups', txId);
  fs.mkdirSync(txDir, { recursive: true });
  const ops = plan.ops.map((o, index) => prepareOp(o, index, txDir));

  const journal = {
    id: txId,
    kind: plan.kind,
    createdAt: plan.createdAt || new Date().toISOString(),
    label: plan.label,
    summary: summarize({ ...plan, ops }),
    status: 'pending',
    ops,
  };
  writeJournal(journalPath, journal);

  try {
    for (const rec of ops) {
      if (rec.backup) {
        fs.mkdirSync(path.dirname(rec.backup), { recursive: true });
        moveEntry(rec.dest, rec.backup);
        rec.stage = 'moved';
        writeJournal(journalPath, journal);
      }
      if (rec.op !== 'remove') {
        if (lstatOrNull(rec.dest)) {
          throw fail(`"${path.basename(rec.dest)}" appeared while installing. Nothing was overwritten.`);
        }
        fs.mkdirSync(path.dirname(rec.dest), { recursive: true });
        rec.stage = 'creating';
        writeJournal(journalPath, journal);
        rec.mode = placeEntry(rec.src, rec.dest, rec.mode, rec.file === true);
      }
      rec.stage = 'done';
      writeJournal(journalPath, journal);
    }
    journal.status = 'applied';
    writeJournal(journalPath, journal);
  } catch (err) {
    const problems = rollback(journal, journalPath, txDir);
    if (problems.length) {
      throw fail(`${err.message} Rolling back also failed: ${problems.join('; ')}. The backups folder was kept.`, { cause: err });
    }
    throw err;
  }
  return { txId, applied: ops.length, journalPath };
}

export function undo(txId, options = {}) {
  if (typeof txId !== 'string' || !TX_RE.test(txId)) throw fail('That change id is not valid.');
  const stateDir = resolveStateDir(options);
  const journalPath = journalFile(stateDir, txId);
  const journal = readJournal(journalPath);
  if (journal.status === 'undone') throw fail('This change was already undone.');
  if (journal.status === 'rolled-back' || journal.status === 'rollback-failed') {
    throw fail('This change was rolled back before it finished, so there is nothing to undo.');
  }
  if (journal.status !== 'applied' && journal.status !== 'pending') {
    throw fail('This change is not in a state that can be undone.');
  }

  for (const rec of journal.ops) {
    if (rec.op === 'remove' && rec.backup && lstatOrNull(rec.backup) && lstatOrNull(rec.dest)) {
      throw fail(`"${path.basename(rec.dest)}" cannot be restored because something with that name is already there. Move it aside and try again.`);
    }
  }

  const txDir = path.join(stateDir, 'backups', txId);
  for (let i = journal.ops.length - 1; i >= 0; i--) {
    const rec = journal.ops[i];
    if (rec.op !== 'remove' && (rec.stage === 'creating' || rec.stage === 'done') && lstatOrNull(rec.dest)) {
      quarantine(rec.dest, path.join(txDir, 'undone', String(i)));
    }
    restoreBackup(rec);
  }
  journal.status = 'undone';
  journal.undoneAt = new Date().toISOString();
  writeJournal(journalPath, journal);
  return { restored: journal.ops.length };
}

export function history(options = {}) {
  const stateDir = resolveStateDir(options);
  const dir = path.join(stateDir, 'journal');
  let names;
  try { names = fs.readdirSync(dir); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const txId = name.slice(0, -5);
    if (!TX_RE.test(txId)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      rows.push({ txId, kind: j.kind, createdAt: j.createdAt, status: j.status, summary: j.summary });
    } catch {
      rows.push({ txId, kind: 'unknown', createdAt: null, status: 'unreadable', summary: 'The record of this change could not be read' });
    }
  }
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return rows;
}
