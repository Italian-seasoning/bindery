import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAll } from '../../plugins/bindery/manager/lib/scan.mjs';
import { applyPlan, undo } from '../../plugins/bindery/manager/lib/changes.mjs';
import { findBroken, planRepair } from '../../plugins/bindery/manager/lib/repair.mjs';

const md = name => `---\nname: ${name}\ndescription: ${name} skill\n---\nbody\n`;
const NOWHERE = '/nowhere/demo';

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-rep-')));
  const home = path.join(base, 'home');
  const stateDir = path.join(home, '.bindery');
  const claudeDir = path.join(home, '.claude', 'skills');
  const agentsDir = path.join(home, '.agents', 'skills');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  const claudeCopy = path.join(claudeDir, 'demo');
  fs.mkdirSync(claudeCopy, { recursive: true });
  fs.writeFileSync(path.join(claudeCopy, 'SKILL.md'), md('demo'));
  const brokenLink = path.join(agentsDir, 'demo');
  fs.symlinkSync(NOWHERE, brokenLink, 'dir');
  const scan = () => scanAll({ home, cwd: home });
  return { base, home, stateDir, claudeCopy, brokenLink, scan, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('findBroken lists the broken link with the working Claude copy as its candidate', () => {
  const env = sandbox();
  try {
    const scan = env.scan();
    const broken = findBroken(scan);
    assert.equal(broken.length, 1);
    const [item] = broken;
    assert.equal(item.name, 'demo');
    assert.equal(item.path, env.brokenLink);
    assert.equal(item.linkTarget, NOWHERE);
    assert.equal(item.candidates.length, 1);
    const claude = scan.skills.find(s => !s.broken && s.realPath === env.claudeCopy);
    assert.equal(item.candidates[0].skillId, claude.id);
    assert.equal(item.candidates[0].realPath, env.claudeCopy);
  } finally { env.cleanup(); }
});

test('relink points the broken link at the working copy, and undo restores the broken link', () => {
  const env = sandbox();
  try {
    const scan = env.scan();
    const [item] = findBroken(scan);
    const plan = planRepair({ scan, skillId: item.skillId, action: 'relink', targetId: item.candidates[0].skillId });
    assert.equal(plan.summary, 'Pointed demo at a working copy');
    assert.equal(plan.title, 'Point demo at a working copy');
    assert.deepEqual(plan.repair, { skillId: item.skillId, action: 'relink' });
    const { txId } = applyPlan(plan, { stateDir: env.stateDir });

    assert.equal(fs.realpathSync(env.brokenLink), env.claudeCopy);
    assert.ok(fs.existsSync(path.join(env.brokenLink, 'SKILL.md')));

    undo(txId, { stateDir: env.stateDir });
    assert.ok(fs.lstatSync(env.brokenLink).isSymbolicLink());
    assert.equal(fs.readlinkSync(env.brokenLink), NOWHERE);
    assert.ok(fs.existsSync(path.join(env.claudeCopy, 'SKILL.md')));
  } finally { env.cleanup(); }
});

test('remove deletes only the broken link, and undo restores it', () => {
  const env = sandbox();
  try {
    const scan = env.scan();
    const [item] = findBroken(scan);
    const plan = planRepair({ scan, skillId: item.skillId, action: 'remove' });
    assert.equal(plan.summary, 'Removed the broken link for demo');
    assert.equal(plan.title, 'Remove the broken link for demo');
    assert.deepEqual(plan.repair, { skillId: item.skillId, action: 'remove' });
    const { txId } = applyPlan(plan, { stateDir: env.stateDir });

    assert.equal(fs.existsSync(env.brokenLink), false);
    assert.ok(fs.lstatSync(env.claudeCopy).isDirectory());
    assert.ok(fs.existsSync(path.join(env.claudeCopy, 'SKILL.md')));

    undo(txId, { stateDir: env.stateDir });
    assert.ok(fs.lstatSync(env.brokenLink).isSymbolicLink());
    assert.equal(fs.readlinkSync(env.brokenLink), NOWHERE);
  } finally { env.cleanup(); }
});

test('planRepair refuses a link that is not broken', () => {
  const env = sandbox();
  try {
    const scan = env.scan();
    const working = scan.skills.find(s => !s.broken);
    assert.throws(() => planRepair({ scan, skillId: working.id, action: 'remove' }), /That link is not broken\./);
  } finally { env.cleanup(); }
});

test('planRepair refuses an unknown action', () => {
  const env = sandbox();
  try {
    const scan = env.scan();
    const [item] = findBroken(scan);
    assert.throws(() => planRepair({ scan, skillId: item.skillId, action: 'delete' }), /Choose remove or relink\./);
  } finally { env.cleanup(); }
});

test('planRepair refuses a target that is not a working copy of the skill', () => {
  const env = sandbox();
  try {
    const scan = env.scan();
    const [item] = findBroken(scan);
    assert.throws(
      () => planRepair({ scan, skillId: item.skillId, action: 'relink', targetId: 'no-such-skill' }),
      /Choose a working copy to link to\./,
    );
    assert.throws(
      () => planRepair({ scan, skillId: item.skillId, action: 'relink' }),
      /Choose a working copy to link to\./,
    );
    assert.equal(fs.readlinkSync(env.brokenLink), NOWHERE, 'nothing was changed');
  } finally { env.cleanup(); }
});
