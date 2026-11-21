import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanPrompts, planSharePrompt, promptOp } from '../../plugins/bindery/manager/lib/prompts.mjs';
import { applyPlan, undo } from '../../plugins/bindery/manager/lib/changes.mjs';

const REVIEW = '---\ndescription: Review a pull request\nargument-hint: <pr>\n---\nReview $ARGUMENTS carefully.\n';
const EXPLAIN = '# Explain\n\nExplain the selected code in plain words.\n';

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-pr-')));
  const home = path.join(base, 'home');
  const stateDir = path.join(base, 'state');
  const dirs = {
    claude: path.join(home, '.claude', 'commands'),
    codex: path.join(home, '.codex', 'prompts'),
  };
  fs.mkdirSync(dirs.claude, { recursive: true });
  fs.mkdirSync(dirs.codex, { recursive: true });
  const write = (file, text) => { fs.writeFileSync(file, text); return file; };
  const scan = () => scanPrompts({ home, cwd: home });
  const group = (name) => scan().groups.find(g => g.name === name);
  return {
    base, home, stateDir, dirs, write, scan, group,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

test('scan lists top-level markdown prompts with frontmatter or first-line descriptions', () => {
  const env = sandbox();
  try {
    env.write(path.join(env.dirs.claude, 'review-pr.md'), REVIEW);
    env.write(path.join(env.dirs.codex, 'explain.md'), EXPLAIN);
    env.write(path.join(env.dirs.claude, 'notes.txt'), 'not a prompt');
    fs.mkdirSync(path.join(env.dirs.claude, 'nested'));
    env.write(path.join(env.dirs.claude, 'nested', 'deep.md'), 'ignored');

    const { roots, prompts, groups } = env.scan();
    assert.deepEqual(roots.map(r => r.id), ['claude-commands', 'codex-prompts']);
    assert.deepEqual(prompts.map(p => p.id).sort(), ['claude-commands:review-pr', 'codex-prompts:explain']);

    const review = prompts.find(p => p.id === 'claude-commands:review-pr');
    assert.equal(review.description, 'Review a pull request');
    assert.equal(review.app, 'claude');
    assert.equal(review.broken, false);
    assert.equal(review.isSymlink, false);

    const explain = prompts.find(p => p.id === 'codex-prompts:explain');
    assert.equal(explain.description, 'Explain the selected code in plain words.');
    assert.equal(explain.app, 'codex');

    assert.deepEqual(groups.find(g => g.name === 'review-pr').apps, { claude: true, codex: false });
    assert.deepEqual(groups.find(g => g.name === 'explain').apps, { claude: false, codex: true });
  } finally { env.cleanup(); }
});

test('differs is true only when the files are different copies with different contents', () => {
  const env = sandbox();
  try {
    env.write(path.join(env.dirs.claude, 'review-pr.md'), REVIEW);
    env.write(path.join(env.dirs.codex, 'review-pr.md'), REVIEW.replace('carefully', 'quickly'));
    let g = env.group('review-pr');
    assert.equal(g.differs, true);
    assert.equal(g.sameSource, false);

    fs.writeFileSync(path.join(env.dirs.codex, 'review-pr.md'), REVIEW);
    g = env.group('review-pr');
    assert.equal(g.differs, false, 'identical copies do not differ');
    assert.equal(g.sameSource, false);
  } finally { env.cleanup(); }
});

test('sharing review-pr with Codex links it into ~/.codex/prompts, and undo removes the link', () => {
  const env = sandbox();
  try {
    const src = env.write(path.join(env.dirs.claude, 'review-pr.md'), REVIEW);
    const { plan, reason } = planSharePrompt({ home: env.home, cwd: env.home, name: 'review-pr', app: 'codex', on: true });
    assert.equal(reason, undefined);
    assert.equal(plan.kind, 'share');
    assert.equal(plan.summary, 'Shared review-pr with Codex');
    assert.equal(plan.title, 'Share review-pr with Codex');
    assert.deepEqual(plan.ops.map(o => o.op), ['create']);

    const { txId } = applyPlan(plan, { stateDir: env.stateDir });
    const link = path.join(env.dirs.codex, 'review-pr.md');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.realpathSync(link), src);
    assert.equal(env.group('review-pr').sameSource, true);
    assert.equal(env.group('review-pr').apps.codex, true);

    undo(txId, { stateDir: env.stateDir });
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.readFileSync(src, 'utf8'), REVIEW);
  } finally { env.cleanup(); }
});

test('the prompts folder is created when it does not exist yet', () => {
  const env = sandbox();
  try {
    fs.rmSync(env.dirs.codex, { recursive: true, force: true });
    env.write(path.join(env.dirs.claude, 'review-pr.md'), REVIEW);
    const { plan } = planSharePrompt({ home: env.home, cwd: env.home, name: 'review-pr', app: 'codex', on: true });
    applyPlan(plan, { stateDir: env.stateDir });
    assert.ok(fs.lstatSync(path.join(env.dirs.codex, 'review-pr.md')).isSymbolicLink());
  } finally { env.cleanup(); }
});

test('turning Claude Code off for a prompt Codex links to gives Codex a real copy first, and undo restores both', () => {
  const env = sandbox();
  try {
    const src = env.write(path.join(env.dirs.claude, 'review-pr.md'), REVIEW);
    const link = path.join(env.dirs.codex, 'review-pr.md');
    fs.symlinkSync(src, link, 'file');

    const { plan } = planSharePrompt({ home: env.home, cwd: env.home, name: 'review-pr', app: 'claude', on: false });
    assert.equal(plan.summary, 'Turned off review-pr in Claude Code');
    assert.deepEqual(plan.ops.map(o => o.op), ['replace', 'remove']);
    const { txId } = applyPlan(plan, { stateDir: env.stateDir });

    assert.equal(fs.existsSync(src), false, 'Claude Code no longer has it');
    const copy = fs.lstatSync(link);
    assert.ok(copy.isFile() && !copy.isSymbolicLink(), 'Codex has a real copy');
    assert.equal(fs.readFileSync(link, 'utf8'), REVIEW);
    assert.equal(env.group('review-pr').apps.claude, false);
    assert.equal(env.group('review-pr').apps.codex, true);

    undo(txId, { stateDir: env.stateDir });
    assert.equal(fs.readFileSync(src, 'utf8'), REVIEW);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the Codex link is back');
    assert.equal(fs.realpathSync(link), src);
  } finally { env.cleanup(); }
});

test('copy mode writes an independent file', () => {
  const env = sandbox();
  try {
    env.write(path.join(env.dirs.claude, 'review-pr.md'), REVIEW);
    const { plan } = planSharePrompt({ home: env.home, cwd: env.home, name: 'review-pr', app: 'codex', on: true, mode: 'copy' });
    applyPlan(plan, { stateDir: env.stateDir });
    const dest = path.join(env.dirs.codex, 'review-pr.md');
    assert.ok(fs.lstatSync(dest).isFile() && !fs.lstatSync(dest).isSymbolicLink());
    assert.equal(fs.readFileSync(dest, 'utf8'), REVIEW);
  } finally { env.cleanup(); }
});

test('planSharePrompt reports why nothing changed', () => {
  const env = sandbox();
  try {
    env.write(path.join(env.dirs.claude, 'review-pr.md'), REVIEW);
    const missing = planSharePrompt({ home: env.home, cwd: env.home, name: 'nope', app: 'codex', on: true });
    assert.equal(missing.plan, null);
    assert.match(missing.reason, /not installed/);

    const already = planSharePrompt({ home: env.home, cwd: env.home, name: 'review-pr', app: 'claude', on: true });
    assert.equal(already.plan, null);
    assert.match(already.reason, /already in Claude Code/);
  } finally { env.cleanup(); }
});

test('bad prompt names and non-markdown sources are rejected', () => {
  const env = sandbox();
  try {
    const src = env.write(path.join(env.dirs.claude, 'review-pr.md'), REVIEW);
    const targetRoot = { id: 'codex-prompts', label: 'Codex · prompts', path: env.dirs.codex, scope: 'global', writable: true };
    for (const bad of ['bad name', '../evil', '.hidden', 'a'.repeat(101), '', 'x/y']) {
      assert.throws(() => promptOp({ src, name: bad, targetRoot }), /not a valid prompt name/, `name ${JSON.stringify(bad)}`);
    }
    const txt = env.write(path.join(env.dirs.claude, 'plain.txt'), 'x');
    assert.throws(() => promptOp({ src: txt, name: 'plain', targetRoot }), /not a markdown prompt file/);

    const op = promptOp({ src, name: 'review-pr', targetRoot });
    assert.equal(op.op.op, 'create');
    assert.equal(op.op.dest, path.join(env.dirs.codex, 'review-pr.md'));
    assert.equal(op.op.file, true);
  } finally { env.cleanup(); }
});
