import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAll } from '../../plugins/bindery/manager/lib/scan.mjs';
import { applyPlan, undo } from '../../plugins/bindery/manager/lib/changes.mjs';
import { diffSkillFolders } from '../../plugins/bindery/manager/lib/diff.mjs';
import { planResolve } from '../../plugins/bindery/manager/lib/resolve.mjs';

const md = name => `---\nname: ${name}\ndescription: ${name} skill\n---\nbody\n`;

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-res-')));
  const home = path.join(base, 'home');
  const stateDir = path.join(home, '.bindery');
  const dirs = {
    claude: path.join(home, '.claude', 'skills'),
    codex: path.join(home, '.codex', 'skills'),
    agents: path.join(home, '.agents', 'skills'),
  };
  Object.values(dirs).forEach(d => fs.mkdirSync(d, { recursive: true }));
  const skill = (dir, name, text = md(name)) => {
    const p = path.join(dir, name);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'SKILL.md'), text);
    return p;
  };
  const scan = () => scanAll({ home, cwd: home });
  const idAt = (s, p) => s.skills.find(k => k.path === p).id;
  return { base, home, stateDir, dirs, skill, scan, idAt, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('diff reports changed SKILL.md lines and a file only in the first folder', () => {
  const env = sandbox();
  try {
    const a = env.skill(env.base, 'a', '---\nname: x\n---\nold line\nshared\n');
    const b = env.skill(env.base, 'b', '---\nname: x\n---\nnew line\nshared\n');
    fs.writeFileSync(path.join(a, 'extra.txt'), 'only here');

    const diff = diffSkillFolders(a, b);
    assert.equal(diff.same, false);
    assert.deepEqual(diff.files, [
      { rel: 'SKILL.md', status: 'changed' },
      { rel: 'extra.txt', status: 'only-a' },
    ]);
    assert.equal(diff.skillMd.tooLarge, false);
    assert.deepEqual(diff.skillMd.hunks, [
      { type: 'eq', lines: ['---', 'name: x', '---'] },
      { type: 'del', lines: ['old line'] },
      { type: 'add', lines: ['new line'] },
      { type: 'eq', lines: ['shared'] },
    ]);
  } finally { env.cleanup(); }
});

test('diff of identical folders is same and has no changed lines', () => {
  const env = sandbox();
  try {
    const a = env.skill(env.base, 'a');
    const b = env.skill(env.base, 'b', md('a'));
    const diff = diffSkillFolders(a, b);
    assert.equal(diff.same, true);
    assert.deepEqual(diff.files, [{ rel: 'SKILL.md', status: 'same' }]);
    assert.deepEqual(diff.skillMd.hunks.map(h => h.type), ['eq']);
  } finally { env.cleanup(); }
});

test('diff skips line hunks when SKILL.md is over maxLines', () => {
  const env = sandbox();
  try {
    const a = env.skill(env.base, 'a', 'one\ntwo\nthree\n');
    const b = env.skill(env.base, 'b', 'one\ntwo\n');
    const diff = diffSkillFolders(a, b, { maxLines: 2 });
    assert.equal(diff.skillMd.tooLarge, true);
    assert.equal(diff.skillMd.hunks, null);
  } finally { env.cleanup(); }
});

test('keeping the Claude copy replaces the Codex copy with a link, and undo restores it byte for byte', () => {
  const env = sandbox();
  try {
    const claude = env.skill(env.dirs.claude, 'demo');
    const codexText = '---\nname: demo\n---\nold codex text\n';
    const codex = env.skill(env.dirs.codex, 'demo', codexText);
    const before = fs.readFileSync(path.join(codex, 'SKILL.md'));

    const scan = env.scan();
    const { plan } = planResolve({ scan, name: 'demo', keepId: env.idAt(scan, claude) });
    assert.equal(plan.title, 'Use one copy of demo everywhere');
    assert.deepEqual(plan.resolve, { name: 'demo', keepId: env.idAt(scan, claude) });
    assert.deepEqual(plan.ops.map(o => [o.op, o.mode]), [['replace', 'symlink']]);
    assert.ok(plan.warnings.includes('The other copies move to backups. Undo puts them back.'));

    const { txId } = applyPlan(plan, { stateDir: env.stateDir });
    assert.equal(fs.realpathSync(codex), fs.realpathSync(claude));
    assert.ok(fs.lstatSync(codex).isSymbolicLink());

    undo(txId, { stateDir: env.stateDir });
    const restored = path.join(env.dirs.codex, 'demo');
    assert.ok(fs.lstatSync(restored).isDirectory());
    assert.ok(!fs.lstatSync(restored).isSymbolicLink());
    assert.deepEqual(fs.readFileSync(path.join(restored, 'SKILL.md')), before);
  } finally { env.cleanup(); }
});

test('copies that already share one folder give no plan', () => {
  const env = sandbox();
  try {
    const claude = env.skill(env.dirs.claude, 'demo');
    fs.symlinkSync(claude, path.join(env.dirs.agents, 'demo'), 'dir');
    const scan = env.scan();
    const result = planResolve({ scan, name: 'demo', keepId: env.idAt(scan, claude) });
    assert.equal(result.plan, null);
    assert.equal(result.reason, 'Every copy already uses the same folder.');
  } finally { env.cleanup(); }
});

test('an unknown skill name throws', () => {
  const env = sandbox();
  try {
    env.skill(env.dirs.claude, 'demo');
    const scan = env.scan();
    assert.throws(() => planResolve({ scan, name: 'nope', keepId: 'x' }), /nope is not installed\./);
  } finally { env.cleanup(); }
});

test('a keepId that is not a working copy in the group throws', () => {
  const env = sandbox();
  try {
    env.skill(env.dirs.claude, 'demo');
    env.skill(env.dirs.codex, 'demo');
    const scan = env.scan();
    assert.throws(() => planResolve({ scan, name: 'demo', keepId: 'claude-global:other' }), /Choose a working copy to keep\./);
  } finally { env.cleanup(); }
});

test('a plugin copy is left alone with a warning', () => {
  const env = sandbox();
  try {
    const claude = env.skill(env.dirs.claude, 'demo');
    const codex = env.skill(env.dirs.codex, 'demo');
    const pluginSkills = path.join(env.home, '.claude', 'plugins', 'cache', 'mkt', 'plug', '1.0.0', 'skills');
    const plugin = env.skill(pluginSkills, 'demo');
    const scan = env.scan();

    const { plan } = planResolve({ scan, name: 'demo', keepId: env.idAt(scan, claude) });
    assert.deepEqual(plan.ops.map(o => o.dest), [path.join(env.dirs.codex, 'demo')]);
    assert.ok(plan.warnings.some(w => /from a plugin, so it keeps its own copy/.test(w)), plan.warnings.join('\n'));
    applyPlan(plan, { stateDir: env.stateDir });
    assert.equal(fs.realpathSync(codex), fs.realpathSync(claude));
    assert.ok(fs.lstatSync(plugin).isDirectory() && !fs.lstatSync(plugin).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(plugin, 'SKILL.md')));
  } finally { env.cleanup(); }
});
