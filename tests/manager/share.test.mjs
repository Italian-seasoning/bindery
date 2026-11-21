import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAll } from '../../plugins/bindery/manager/lib/scan.mjs';
import { applyPlan, undo } from '../../plugins/bindery/manager/lib/changes.mjs';
import { planShare, shareStatus } from '../../plugins/bindery/manager/lib/share.mjs';
import { main } from '../../plugins/bindery/manager/cli.mjs';

const md = name => `---\nname: ${name}\ndescription: ${name} skill\n---\nbody\n`;

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-share-')));
  const home = path.join(base, 'home');
  const stateDir = path.join(home, '.bindery');
  const dirs = {
    claude: path.join(home, '.claude', 'skills'),
    codex: path.join(home, '.codex', 'skills'),
    agents: path.join(home, '.agents', 'skills'),
  };
  Object.values(dirs).forEach(d => fs.mkdirSync(d, { recursive: true }));
  const skill = (dir, name, extra = {}) => {
    const p = path.join(dir, name);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'SKILL.md'), md(name));
    for (const [rel, text] of Object.entries(extra)) fs.writeFileSync(path.join(p, rel), text);
    return p;
  };
  const scan = () => scanAll({ home, cwd: home });
  const status = name => {
    const s = scan();
    const g = s.groups.find(x => x.name === name);
    return g ? shareStatus(g, new Map(s.skills.map(k => [k.id, k]))) : null;
  };
  return { base, home, stateDir, dirs, skill, scan, status, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('sharing a Claude Code skill with Codex links it into ~/.agents/skills', () => {
  const env = sandbox();
  try {
    const src = env.skill(env.dirs.claude, 'demo');
    assert.deepEqual(env.status('demo').codex, { on: false, fixed: false, canTurnOn: true, canTurnOff: false });
    const { plan, skipped } = planShare({ scan: env.scan(), names: ['demo'], app: 'codex', on: true });
    assert.deepEqual(skipped, []);
    assert.equal(plan.kind, 'share');
    assert.equal(plan.summary, 'Shared demo with Codex');
    assert.equal(plan.ops.length, 1);
    applyPlan(plan, { stateDir: env.stateDir });
    const link = path.join(env.dirs.agents, 'demo');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.realpathSync(link), src);
    const g = env.scan().groups.find(x => x.name === 'demo');
    assert.equal(g.sameSource, true);
    assert.equal(env.status('demo').codex.on, true);
    assert.equal(env.status('demo').claude.on, true);
  } finally { env.cleanup(); }
});

test('copy mode makes an independent copy', () => {
  const env = sandbox();
  try {
    env.skill(env.dirs.codex, 'tool');
    const { plan } = planShare({ scan: env.scan(), names: ['tool'], app: 'claude', on: true, mode: 'copy' });
    applyPlan(plan, { stateDir: env.stateDir });
    const dest = path.join(env.dirs.claude, 'tool');
    assert.ok(fs.lstatSync(dest).isDirectory());
    assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
  } finally { env.cleanup(); }
});

test('turning off the app that holds the real folder gives the other app its own copy, and undo restores the link', () => {
  const env = sandbox();
  try {
    const src = env.skill(env.dirs.claude, 'demo', { 'notes.txt': 'hello' });
    const link = path.join(env.dirs.agents, 'demo');
    fs.symlinkSync(src, link, 'dir');

    const { plan } = planShare({ scan: env.scan(), names: ['demo'], app: 'claude', on: false });
    assert.equal(plan.summary, 'Turned off demo in Claude Code');
    assert.deepEqual(plan.ops.map(o => o.op), ['replace', 'remove']);
    const { txId } = applyPlan(plan, { stateDir: env.stateDir });

    assert.equal(fs.existsSync(src), false, 'Claude Code no longer has it');
    assert.ok(fs.lstatSync(link).isDirectory() && !fs.lstatSync(link).isSymbolicLink(), 'Codex has a real copy');
    assert.equal(fs.readFileSync(path.join(link, 'notes.txt'), 'utf8'), 'hello');
    assert.equal(env.status('demo').claude.on, false);
    assert.equal(env.status('demo').codex.on, true);

    undo(txId, { stateDir: env.stateDir });
    assert.ok(fs.lstatSync(src).isDirectory());
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.realpathSync(link), src);
  } finally { env.cleanup(); }
});

test('turning off a plain link removes only the link', () => {
  const env = sandbox();
  try {
    const src = env.skill(env.dirs.claude, 'demo');
    const link = path.join(env.dirs.agents, 'demo');
    fs.symlinkSync(src, link, 'dir');
    const { plan } = planShare({ scan: env.scan(), names: ['demo'], app: 'codex', on: false });
    assert.deepEqual(plan.ops.map(o => o.op), ['remove']);
    applyPlan(plan, { stateDir: env.stateDir });
    assert.equal(fs.existsSync(link), false);
    assert.ok(fs.existsSync(path.join(src, 'SKILL.md')));
  } finally { env.cleanup(); }
});

test('a link that goes through a removed link is pointed at the final folder', () => {
  const env = sandbox();
  try {
    const lib = env.skill(path.join(env.base, 'library'), 'demo');
    const claudeLink = path.join(env.dirs.claude, 'demo');
    const codexLink = path.join(env.dirs.agents, 'demo');
    fs.symlinkSync(lib, claudeLink, 'dir');
    fs.symlinkSync(claudeLink, codexLink, 'dir');
    const { plan } = planShare({ scan: env.scan(), names: ['demo'], app: 'claude', on: false });
    applyPlan(plan, { stateDir: env.stateDir });
    assert.equal(fs.existsSync(claudeLink), false);
    assert.equal(fs.readlinkSync(codexLink), lib);
    assert.ok(fs.existsSync(path.join(lib, 'SKILL.md')), 'library folder untouched');
  } finally { env.cleanup(); }
});

test('skips skills that are already on, missing, or plugin-only', () => {
  const env = sandbox();
  try {
    env.skill(env.dirs.claude, 'both');
    env.skill(env.dirs.codex, 'both');
    const plugin = path.join(env.home, '.claude', 'plugins', 'cache', 'mkt', 'plug', '1.0.0', 'skills');
    env.skill(plugin, 'plugged');
    env.skill(env.dirs.claude, 'solo');
    const { plan, skipped } = planShare({ scan: env.scan(), names: ['both', 'nope', 'plugged', 'solo'], app: 'codex', on: true });
    assert.deepEqual(plan.share.names, ['solo']);
    assert.deepEqual(skipped.map(s => s.name).sort(), ['both', 'nope', 'plugged']);
    assert.match(skipped.find(s => s.name === 'plugged').reason, /plugin/);
    assert.equal(plan.summary, 'Shared solo with Codex');

    const off = planShare({ scan: env.scan(), names: ['plugged'], app: 'claude', on: false });
    assert.equal(off.plan, null);
    assert.match(off.skipped[0].reason, /plugin/);
  } finally { env.cleanup(); }
});

test('several skills share in one change and undo together', () => {
  const env = sandbox();
  try {
    env.skill(env.dirs.claude, 'a');
    env.skill(env.dirs.claude, 'b');
    const { plan } = planShare({ scan: env.scan(), names: ['a', 'b'], app: 'codex', on: true });
    assert.equal(plan.summary, 'Shared 2 skills with Codex');
    const { txId } = applyPlan(plan, { stateDir: env.stateDir });
    assert.ok(fs.lstatSync(path.join(env.dirs.agents, 'a')).isSymbolicLink());
    undo(txId, { stateDir: env.stateDir });
    assert.equal(fs.existsSync(path.join(env.dirs.agents, 'a')), false);
    assert.equal(fs.existsSync(path.join(env.dirs.agents, 'b')), false);
  } finally { env.cleanup(); }
});

test('CLI share prints a plan and changes nothing without --yes', async () => {
  const env = sandbox();
  const prevHome = process.env.HOME;
  const prevState = process.env.BINDERY_HOME;
  const prevCwd = process.cwd();
  try {
    env.skill(env.dirs.claude, 'demo');
    process.env.HOME = env.home;
    process.env.BINDERY_HOME = env.stateDir;
    process.chdir(env.home);
    const lines = [];
    const code = await main(['share', '--all', '--with', 'codex'], { write: l => lines.push(l) });
    assert.equal(code, 0);
    assert.match(lines.join('\n'), /Shared demo with Codex/);
    assert.match(lines.join('\n'), /Nothing was changed/);
    assert.equal(fs.existsSync(path.join(env.dirs.agents, 'demo')), false);
  } finally {
    process.chdir(prevCwd);
    process.env.HOME = prevHome;
    if (prevState === undefined) delete process.env.BINDERY_HOME; else process.env.BINDERY_HOME = prevState;
    env.cleanup();
  }
});
