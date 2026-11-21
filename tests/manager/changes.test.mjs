import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planInstall, planInstallMany, planRemove, applyPlan, undo, history,
} from '../../plugins/bindery/manager/lib/changes.mjs';

const SKILL_MD = '---\nname: demo\ndescription: Demo skill\n---\nbody\n';

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-'));
  const stateDir = path.join(base, 'state');
  const rootPath = path.join(base, 'home', '.claude', 'skills');
  fs.mkdirSync(rootPath, { recursive: true });
  const root = (over = {}) => ({
    id: 'claude-global',
    host: 'claude',
    scope: 'global',
    label: 'Claude Code · global',
    path: rootPath,
    exists: true,
    writable: true,
    ...over,
  });
  return { base, stateDir, rootPath, root, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function makeSkill(dir, files = { 'SKILL.md': SKILL_MD }) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function snapshot(dir) {
  const out = {};
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isSymbolicLink()) out[rel] = `LINK ${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) { out[rel] = 'DIR'; walk(full); }
      else out[rel] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

test('installs a copy into an empty root and records it in history', () => {
  const env = sandbox();
  try {
    const src = makeSkill(path.join(env.base, 'src', 'demo'));
    const plan = planInstall({ src, name: 'demo', targetRoot: env.root() });
    assert.equal(plan.kind, 'install');
    assert.equal(plan.ops[0].op, 'create');
    assert.equal(plan.ops[0].mode, 'copy');
    assert.deepEqual(plan.warnings, []);

    const result = applyPlan(plan, { stateDir: env.stateDir });
    assert.equal(result.applied, 1);
    assert.equal(fs.readFileSync(path.join(env.rootPath, 'demo', 'SKILL.md'), 'utf8'), SKILL_MD);

    const [latest] = history({ stateDir: env.stateDir });
    assert.equal(latest.txId, plan.id);
    assert.equal(latest.status, 'applied');
    assert.equal(latest.summary, 'Installed demo into Claude Code · global');
  } finally { env.cleanup(); }
});

test('replacing an existing copy keeps it as a backup and undo restores it byte-identical', () => {
  const env = sandbox();
  try {
    const existing = makeSkill(path.join(env.rootPath, 'demo'), { 'SKILL.md': 'old', 'notes/keep.txt': 'mine' });
    const before = snapshot(existing);
    const src = makeSkill(path.join(env.base, 'src', 'demo'), { 'SKILL.md': 'new' });

    const plan = planInstall({ src, name: 'demo', targetRoot: env.root() });
    assert.equal(plan.ops[0].op, 'replace');
    assert.deepEqual(plan.ops[0].existing, { isSymlink: false, linkTarget: null });
    assert.deepEqual(plan.warnings, [
      'Replaces existing demo in Claude Code · global. The current copy is kept as a backup.',
    ]);

    applyPlan(plan, { stateDir: env.stateDir });
    assert.equal(fs.readFileSync(path.join(env.rootPath, 'demo', 'SKILL.md'), 'utf8'), 'new');

    assert.deepEqual(undo(plan.id, { stateDir: env.stateDir }), { restored: 1 });
    assert.deepEqual(snapshot(path.join(env.rootPath, 'demo')), before);
    assert.ok(fs.existsSync(path.join(env.stateDir, 'backups', plan.id, 'undone', '0', 'demo', 'SKILL.md')));
    assert.equal(history({ stateDir: env.stateDir })[0].status, 'undone');
  } finally { env.cleanup(); }
});

test('installs as a symlink, or as a copy when symlinks are unavailable', () => {
  const env = sandbox();
  try {
    const src = makeSkill(path.join(env.base, 'src', 'demo'));
    const plan = planInstall({ src, name: 'demo', targetRoot: env.root(), mode: 'symlink' });
    assert.equal(plan.ops[0].mode, 'symlink');
    applyPlan(plan, { stateDir: env.stateDir });

    const dest = path.join(env.rootPath, 'demo');
    const journal = JSON.parse(fs.readFileSync(path.join(env.stateDir, 'journal', `${plan.id}.json`), 'utf8'));
    const actual = journal.ops[0].mode;
    assert.ok(actual === 'symlink' || actual === 'copy');
    if (actual === 'symlink') {
      assert.equal(fs.lstatSync(dest).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(dest), path.resolve(src));
    } else {
      assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), SKILL_MD);
    }
  } finally { env.cleanup(); }
});

test('removing a symlinked skill removes only the link, and undo restores the link', () => {
  const env = sandbox();
  try {
    const store = makeSkill(path.join(env.base, 'store', 'demo'));
    const link = path.join(env.rootPath, 'demo');
    fs.symlinkSync(store, link, 'dir');

    const plan = planRemove({ skillPath: link, root: env.root() });
    assert.equal(plan.ops[0].op, 'remove');
    assert.equal(plan.ops[0].existing.isSymlink, true);
    assert.equal(plan.ops[0].existing.linkTarget, store);

    applyPlan(plan, { stateDir: env.stateDir });
    assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined);
    assert.equal(fs.readFileSync(path.join(store, 'SKILL.md'), 'utf8'), SKILL_MD);

    undo(plan.id, { stateDir: env.stateDir });
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(link), store);
  } finally { env.cleanup(); }
});

test('removing a real folder moves it into the backups folder, not into the trash', () => {
  const env = sandbox();
  try {
    const dir = makeSkill(path.join(env.rootPath, 'demo'), { 'SKILL.md': 'keep me' });
    const plan = planRemove({ skillPath: dir, root: env.root() });
    applyPlan(plan, { stateDir: env.stateDir });
    assert.equal(fs.existsSync(dir), false);
    const kept = path.join(env.stateDir, 'backups', plan.id, '0', 'demo', 'SKILL.md');
    assert.equal(fs.readFileSync(kept, 'utf8'), 'keep me');
  } finally { env.cleanup(); }
});

test('a failed apply rolls back the operations already completed', () => {
  const env = sandbox();
  try {
    makeSkill(path.join(env.rootPath, 'a'), { 'SKILL.md': 'old A' });
    const before = snapshot(path.join(env.rootPath, 'a'));
    const srcA = makeSkill(path.join(env.base, 'src', 'a'), { 'SKILL.md': 'new A' });
    // A dangling symlink passes the preflight check but makes the copy fail midway.
    const srcB = makeSkill(path.join(env.base, 'src', 'b'), { 'SKILL.md': 'B' });
    fs.symlinkSync(path.join(env.base, 'nowhere'), path.join(srcB, 'broken'));

    const plan = planInstallMany([
      { src: srcA, name: 'a', targetRoot: env.root() },
      { src: srcB, name: 'b', targetRoot: env.root() },
    ]);
    assert.throws(() => applyPlan(plan, { stateDir: env.stateDir }));

    assert.deepEqual(snapshot(path.join(env.rootPath, 'a')), before);
    assert.equal(fs.lstatSync(path.join(env.rootPath, 'b'), { throwIfNoEntry: false }), undefined);
    assert.equal(history({ stateDir: env.stateDir })[0].status, 'rolled-back');
  } finally { env.cleanup(); }
});

test('a plan whose source vanished is refused before anything changes', () => {
  const env = sandbox();
  try {
    const src = makeSkill(path.join(env.base, 'src', 'demo'));
    const plan = planInstall({ src, name: 'demo', targetRoot: env.root() });
    fs.rmSync(src, { recursive: true, force: true });
    assert.throws(() => applyPlan(plan, { stateDir: env.stateDir }), /not found/);
    assert.equal(fs.existsSync(path.join(env.rootPath, 'demo')), false);
    assert.deepEqual(history({ stateDir: env.stateDir }), []);
  } finally { env.cleanup(); }
});

test('unsafe skill names are rejected', () => {
  const env = sandbox();
  try {
    const src = makeSkill(path.join(env.base, 'src', 'demo'));
    for (const name of ['../evil', 'a/b', '..', '.', '.hidden', '', 'x'.repeat(101), 'bad name']) {
      assert.throws(() => planInstall({ src, name, targetRoot: env.root() }), /not a valid skill folder name/, name);
    }
  } finally { env.cleanup(); }
});

test('removal targets must be direct children of the root', () => {
  const env = sandbox();
  try {
    makeSkill(path.join(env.rootPath, 'sub', 'x'));
    assert.throws(() => planRemove({ skillPath: path.join(env.rootPath, 'sub', 'x'), root: env.root() }), /directly inside/);
    assert.throws(() => planRemove({ skillPath: path.dirname(env.rootPath), root: env.root() }), /directly inside/);
    assert.throws(() => planRemove({ skillPath: path.join(env.rootPath, '..', 'skills', '..'), root: env.root() }), /directly inside/);
    assert.throws(() => planRemove({ skillPath: path.join(env.rootPath, 'missing'), root: env.root() }), /no longer|any more/);
  } finally { env.cleanup(); }
});

test('plugin and read-only roots are refused', () => {
  const env = sandbox();
  try {
    const src = makeSkill(path.join(env.base, 'src', 'demo'));
    makeSkill(path.join(env.rootPath, 'demo'));
    const plugin = env.root({ scope: 'plugin', writable: false, id: 'claude-plugins', label: 'Claude plugin' });
    const readOnly = env.root({ readOnly: true });
    assert.throws(() => planInstall({ src, name: 'demo', targetRoot: plugin }), /read-only/);
    assert.throws(() => planInstall({ src, name: 'demo', targetRoot: readOnly }), /read-only/);
    assert.throws(() => planRemove({ skillPath: path.join(env.rootPath, 'demo'), root: plugin }), /read-only/);
    assert.throws(() => planRemove({ skillPath: path.join(env.rootPath, 'demo'), root: readOnly }), /read-only/);
  } finally { env.cleanup(); }
});

test('a skill that contains scripts gets a warning', () => {
  const env = sandbox();
  try {
    const src = makeSkill(path.join(env.base, 'src', 'demo'), { 'SKILL.md': SKILL_MD, 'tools/run.sh': 'echo hi' });
    const plan = planInstall({ src, name: 'demo', targetRoot: env.root() });
    assert.ok(plan.warnings.includes('Contains scripts. Read them before running this skill.'));
  } finally { env.cleanup(); }
});

test('a source without SKILL.md is refused', () => {
  const env = sandbox();
  try {
    const src = makeSkill(path.join(env.base, 'src', 'notes'), { 'README.md': 'hello' });
    assert.throws(() => planInstall({ src, name: 'notes', targetRoot: env.root() }), /no SKILL.md/);
  } finally { env.cleanup(); }
});

test('planInstallMany rejects duplicate destinations', () => {
  const env = sandbox();
  try {
    const src = makeSkill(path.join(env.base, 'src', 'demo'));
    assert.throws(() => planInstallMany([
      { src, name: 'demo', targetRoot: env.root() },
      { src, name: 'demo', targetRoot: env.root() },
    ]), /twice/);
  } finally { env.cleanup(); }
});

test('an applied plan cannot be applied twice', () => {
  const env = sandbox();
  try {
    const src = makeSkill(path.join(env.base, 'src', 'demo'));
    const plan = planInstall({ src, name: 'demo', targetRoot: env.root() });
    applyPlan(plan, { stateDir: env.stateDir });
    assert.throws(() => applyPlan(plan, { stateDir: env.stateDir }), /already applied/);
  } finally { env.cleanup(); }
});

test('undo rejects malformed ids and cannot run twice', () => {
  const env = sandbox();
  try {
    const src = makeSkill(path.join(env.base, 'src', 'demo'));
    const plan = planInstall({ src, name: 'demo', targetRoot: env.root() });
    applyPlan(plan, { stateDir: env.stateDir });
    assert.throws(() => undo('../journal/x', { stateDir: env.stateDir }), /not valid/);
    assert.throws(() => undo('000000000000', { stateDir: env.stateDir }), /No change/);
    undo(plan.id, { stateDir: env.stateDir });
    assert.throws(() => undo(plan.id, { stateDir: env.stateDir }), /already undone/);
    assert.equal(fs.existsSync(path.join(env.rootPath, 'demo')), false);
  } finally { env.cleanup(); }
});

test('history lists the newest change first', () => {
  const env = sandbox();
  try {
    const first = planInstall({ src: makeSkill(path.join(env.base, 'src', 'one')), name: 'one', targetRoot: env.root() });
    first.createdAt = '2026-01-01T00:00:00.000Z';
    applyPlan(first, { stateDir: env.stateDir });
    const second = planInstall({ src: makeSkill(path.join(env.base, 'src', 'two')), name: 'two', targetRoot: env.root() });
    second.createdAt = '2026-02-01T00:00:00.000Z';
    applyPlan(second, { stateDir: env.stateDir });
    const rows = history({ stateDir: env.stateDir });
    assert.deepEqual(rows.map(r => r.txId), [second.id, first.id]);
  } finally { env.cleanup(); }
});
