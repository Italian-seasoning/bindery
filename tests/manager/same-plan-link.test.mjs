import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  installOp, planShareOps, planInstall, applyPlan, undo,
} from '../../plugins/bindery/manager/lib/changes.mjs';
import { createLibrary, addSkill, exportLibrary } from '../../plugins/bindery/manager/lib/library.mjs';
import { planLibraryInstall } from '../../plugins/bindery/manager/lib/library-install.mjs';
import { listRoots } from '../../plugins/bindery/manager/lib/roots.mjs';

const SKILL_MD = '---\nname: demo\ndescription: Demo skill\n---\nbody\n';
const OLD_MD = '---\nname: demo\ndescription: Old copy\n---\nold\n';

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-samelink-'));
  const stateDir = path.join(base, 'state');
  const claudeRoot = path.join(base, 'home', '.claude', 'skills');
  const agentsRoot = path.join(base, 'home', '.agents', 'skills');
  fs.mkdirSync(claudeRoot, { recursive: true });
  fs.mkdirSync(agentsRoot, { recursive: true });
  const root = (id, rootPath) => ({ id, host: id, scope: 'global', label: id, path: rootPath, exists: true, writable: true });
  return {
    base,
    stateDir,
    claudeRoot,
    agentsRoot,
    claude: () => root('claude-global', claudeRoot),
    agents: () => root('agents-global', agentsRoot),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

function makeSkill(dir, text = SKILL_MD) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
  return dir;
}

test('a copy plus a link to that copy applies, the link resolves to the copy, and undo restores replaced entries', () => {
  const env = sandbox();
  try {
    const src = makeSkill(path.join(env.base, 'src', 'demo'));
    makeSkill(path.join(env.claudeRoot, 'demo'), OLD_MD);
    makeSkill(path.join(env.agentsRoot, 'demo'), OLD_MD);

    const copy = installOp({ src, name: 'demo', targetRoot: env.claude(), mode: 'copy' });
    const link = installOp({ src: copy.op.dest, name: 'demo', targetRoot: env.agents(), mode: 'symlink', pendingSource: true });
    assert.equal(copy.op.op, 'replace');
    assert.equal(link.op.pendingSrc, true);
    const plan = planShareOps({ ops: [copy.op, link.op], label: 'test' });

    const res = applyPlan(plan, { stateDir: env.stateDir });
    const linkPath = path.join(env.agentsRoot, 'demo');
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
    assert.equal(fs.readlinkSync(linkPath), path.join(env.claudeRoot, 'demo'));
    assert.equal(fs.readFileSync(path.join(linkPath, 'SKILL.md'), 'utf8'), SKILL_MD);

    undo(res.txId, { stateDir: env.stateDir });
    assert.equal(fs.lstatSync(path.join(env.claudeRoot, 'demo')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(env.claudeRoot, 'demo', 'SKILL.md'), 'utf8'), OLD_MD);
    assert.equal(fs.lstatSync(path.join(env.agentsRoot, 'demo')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(env.agentsRoot, 'demo', 'SKILL.md'), 'utf8'), OLD_MD);
  } finally {
    env.cleanup();
  }
});

test('a link whose source no earlier op in the plan creates is rejected at plan time and at apply time', () => {
  const env = sandbox();
  try {
    const src = makeSkill(path.join(env.base, 'src', 'demo'));
    const copy = installOp({ src, name: 'demo', targetRoot: env.claude(), mode: 'copy' });
    const elsewhere = path.join(env.claudeRoot, 'not-in-plan');
    const badLink = installOp({ src: elsewhere, name: 'demo', targetRoot: env.agents(), mode: 'symlink', pendingSource: true });

    assert.throws(() => planShareOps({ ops: [copy.op, badLink.op] }), /no earlier change in this plan creates/);
    assert.throws(() => planInstall({ src: elsewhere, name: 'demo', targetRoot: env.agents(), mode: 'symlink', pendingSource: true }), /no earlier change in this plan creates/);

    // A link placed before the copy it needs is also refused.
    const link = installOp({ src: copy.op.dest, name: 'demo', targetRoot: env.agents(), mode: 'symlink', pendingSource: true });
    assert.throws(() => planShareOps({ ops: [link.op, copy.op] }), /no earlier change in this plan creates/);

    // A plan whose order was changed after it was built is refused by applyPlan before anything is written.
    const good = planShareOps({ ops: [copy.op, link.op] });
    good.ops.reverse();
    assert.throws(() => applyPlan(good, { stateDir: env.stateDir }), /no earlier change in this plan creates/);
    assert.equal(fs.existsSync(path.join(env.claudeRoot, 'demo')), false);
    assert.equal(fs.existsSync(path.join(env.agentsRoot, 'demo')), false);
    assert.equal(fs.existsSync(path.join(env.stateDir, 'journal')), false);
  } finally {
    env.cleanup();
  }
});

test('a mid-plan failure rolls back the copy, the link and every replaced entry', () => {
  const env = sandbox();
  const cRoot = path.join(env.base, 'home', '.codex', 'skills');
  try {
    const src = makeSkill(path.join(env.base, 'src', 'demo'));
    makeSkill(path.join(env.claudeRoot, 'demo'), OLD_MD);
    makeSkill(path.join(env.agentsRoot, 'demo'), OLD_MD);
    // A dangling symlink inside the third skill makes copying it fail after the first two ops have run.
    const broken = makeSkill(path.join(env.base, 'src', 'broken'));
    fs.symlinkSync(path.join(env.base, 'does-not-exist'), path.join(broken, 'dangling'));
    fs.mkdirSync(cRoot, { recursive: true });

    const copy = installOp({ src, name: 'demo', targetRoot: env.claude(), mode: 'copy' });
    const link = installOp({ src: copy.op.dest, name: 'demo', targetRoot: env.agents(), mode: 'symlink', pendingSource: true });
    const failing = installOp({ src: broken, name: 'broken-skill', targetRoot: { id: 'codex', label: 'codex', path: cRoot, scope: 'global', writable: true }, mode: 'copy' });
    const plan = planShareOps({ ops: [copy.op, link.op, failing.op] });

    assert.throws(() => applyPlan(plan, { stateDir: env.stateDir }));

    assert.equal(fs.readFileSync(path.join(env.claudeRoot, 'demo', 'SKILL.md'), 'utf8'), OLD_MD);
    assert.equal(fs.lstatSync(path.join(env.agentsRoot, 'demo')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(env.agentsRoot, 'demo', 'SKILL.md'), 'utf8'), OLD_MD);
    assert.equal(fs.existsSync(path.join(cRoot, 'broken-skill')), false);
    const journalFile = path.join(env.stateDir, 'journal', `${plan.id}.json`);
    assert.equal(JSON.parse(fs.readFileSync(journalFile, 'utf8')).status, 'rolled-back');
  } finally {
    env.cleanup();
  }
});

function libraryEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-samelink-lib-'));
  const home = path.join(base, 'home');
  const stateDir = path.join(base, 'state');
  const src = path.join(base, 'src');
  fs.mkdirSync(path.join(src, 'polish'), { recursive: true });
  fs.writeFileSync(path.join(src, 'polish', 'SKILL.md'), '---\nname: polish\ndescription: Final pass.\n---\nBody.\n');
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  createLibrary({ stateDir, id: 'kit', name: 'Kit' });
  addSkill({ stateDir, libraryId: 'kit', skillDir: path.join(src, 'polish'), name: 'polish', bestFor: 'Final pass.' });
  const { dir } = exportLibrary({ stateDir, libraryId: 'kit', dest: path.join(base, 'out') });
  return { base, home, stateDir, dir, roots: listRoots({ home, cwd: home }), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('library install copies into the first app and links the second app to that copy', () => {
  const t = libraryEnv();
  try {
    const plan = planLibraryInstall({ dir: t.dir, picks: [{ type: 'skill', name: 'polish', apps: ['claude', 'codex'] }], roots: t.roots, home: t.home, cwd: t.home });
    const linked = plan.ops.filter(o => o.pendingSrc === true);
    assert.equal(linked.length, 1);
    assert.equal(plan.ops.length, 2);
    assert.equal(plan.ops[0].pendingSrc, undefined);
    assert.equal(linked[0].src, plan.ops[0].dest);

    const res = applyPlan(plan, { stateDir: t.stateDir, home: t.home });
    const claudeDest = plan.ops[0].dest;
    const codexLink = linked[0].dest;
    assert.ok(fs.lstatSync(codexLink).isSymbolicLink());
    assert.equal(fs.realpathSync(codexLink), fs.realpathSync(claudeDest));
    assert.equal(fs.readFileSync(path.join(codexLink, 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(claudeDest, 'SKILL.md'), 'utf8'));

    undo(res.txId, { stateDir: t.stateDir, home: t.home });
    assert.equal(fs.existsSync(claudeDest), false);
    assert.equal(fs.existsSync(codexLink), false);
  } finally {
    t.cleanup();
  }
});

test('when the first app is already up to date, the second app links to that existing folder', () => {
  const t = libraryEnv();
  try {
    const first = planLibraryInstall({ dir: t.dir, picks: [{ type: 'skill', name: 'polish', apps: ['claude'] }], roots: t.roots, home: t.home, cwd: t.home });
    applyPlan(first, { stateDir: t.stateDir, home: t.home });
    const claudeDest = path.join(t.home, '.claude', 'skills', 'polish');

    const plan = planLibraryInstall({ dir: t.dir, picks: [{ type: 'skill', name: 'polish', apps: ['claude', 'codex'] }], roots: t.roots, home: t.home, cwd: t.home });
    assert.equal(plan.ops.length, 1);
    const link = plan.ops[0];
    assert.equal(link.pendingSrc, undefined);
    assert.equal(link.mode, 'symlink');
    assert.equal(link.src, fs.realpathSync(claudeDest));

    const res = applyPlan(plan, { stateDir: t.stateDir, home: t.home });
    assert.equal(fs.realpathSync(link.dest), fs.realpathSync(claudeDest));
    undo(res.txId, { stateDir: t.stateDir, home: t.home });
    assert.equal(fs.existsSync(link.dest), false);
    assert.ok(fs.existsSync(claudeDest));
  } finally {
    t.cleanup();
  }
});
