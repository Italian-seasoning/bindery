import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../plugins/bindery/manager/cli.mjs';

const SHA_1 = 'a'.repeat(40);
const SHA_2 = 'b'.repeat(40);

// Points HOME, BINDERY_HOME and the working folder at temp folders for one test, then puts them back.
function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cli-git-'));
  const home = path.join(base, 'home');
  const stateDir = path.join(base, 'state');
  const work = path.join(base, 'work');
  for (const dir of [home, stateDir, work]) fs.mkdirSync(dir, { recursive: true });
  const saved = { HOME: process.env.HOME, BINDERY_HOME: process.env.BINDERY_HOME, cwd: process.cwd() };
  process.env.HOME = home;
  process.env.BINDERY_HOME = stateDir;
  process.chdir(work);
  t.after(() => {
    process.chdir(saved.cwd);
    for (const key of ['HOME', 'BINDERY_HOME']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, home, stateDir };
}

// A library folder as a git repository would hold it. Options change the content between fetches.
function writeRepo(dir, { skillBody = 'version one', bestFor = 'Layouts', extraPrompt = false } = {}) {
  fs.mkdirSync(path.join(dir, 'skills', 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'alpha', 'SKILL.md'), `---\nname: alpha\ndescription: alpha skill.\n---\n${skillBody}\n`);
  fs.writeFileSync(path.join(dir, 'prompts', 'beta.md'), 'Say hello.\n');
  const items = [
    { type: 'skill', name: 'alpha', path: 'skills/alpha', bestFor, apps: ['claude'], source: null },
    { type: 'prompt', name: 'beta', path: 'prompts/beta.md', bestFor: '', apps: ['claude', 'codex'], source: null },
  ];
  if (extraPrompt) {
    fs.writeFileSync(path.join(dir, 'prompts', 'gamma.md'), 'Extra prompt.\n');
    items.push({ type: 'prompt', name: 'gamma', path: 'prompts/gamma.md', bestFor: 'Extra', apps: ['codex'], source: null });
  }
  const manifest = {
    format: 'agent-library/1',
    id: 'ui-kit',
    name: 'UI kit',
    author: '',
    description: 'Test library.',
    version: '1.0.0',
    license: 'MIT',
    createdAt: '2026-11-20T00:00:00.000Z',
    items,
  };
  fs.writeFileSync(path.join(dir, 'library.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

// Fake git runner. clone copies `state.repo` into the target folder; rev-parse returns `state.sha`.
function fakeGit(state) {
  const calls = [];
  const git = async (args) => {
    calls.push([...args]);
    if (args[0] === 'clone') {
      fs.cpSync(state.repo, args[args.length - 1], { recursive: true });
      return { stdout: '' };
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${state.sha}\n` };
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  git.calls = calls;
  return git;
}

function collector() {
  const lines = [];
  return { lines, write: line => lines.push(line), text: () => lines.join('\n') };
}

test('library import from a git link previews and plans without --yes, and installs nothing', async t => {
  const s = sandbox(t);
  const state = { repo: writeRepo(path.join(s.base, 'repo')), sha: SHA_1 };
  const git = fakeGit(state);
  const out = collector();

  const code = await main(['library', 'import', 'owner/kit'], { write: out.write, git });
  assert.equal(code, 0);
  assert.match(out.text(), /^Fetched https:\/\/github\.com\/owner\/kit\.git at aaaaaaaa\./);
  assert.match(out.text(), /UI kit\s+\(ui-kit, 2 item\(s\)/);
  assert.match(out.text(), /add\s+~\/\.claude\/skills\/alpha/);
  assert.match(out.text(), /~\/\.claude\/commands\/beta\.md/);
  assert.match(out.text(), /Nothing was changed\. Run the same command with --yes/);

  assert.equal(git.calls[0][0], 'clone');
  assert.equal(fs.existsSync(path.join(s.home, '.claude', 'skills', 'alpha')), false);
  assert.equal(fs.existsSync(path.join(s.home, '.claude', 'commands', 'beta.md')), false);
});

test('library sources lists the libraries fetched from git links', async t => {
  const s = sandbox(t);
  const state = { repo: writeRepo(path.join(s.base, 'repo')), sha: SHA_1 };
  const git = fakeGit(state);
  await main(['library', 'import', 'https://github.com/owner/kit'], { write: () => {}, git });

  const out = collector();
  const code = await main(['library', 'sources'], { write: out.write, git });
  assert.equal(code, 0);
  assert.match(out.text(), /^UI kit\n/);
  assert.match(out.text(), /url:\s+https:\/\/github\.com\/owner\/kit\.git/);
  assert.match(out.text(), /ref:\s+default branch/);
  assert.match(out.text(), /commit:\s+aaaaaaaa/);
  assert.match(out.text(), /fetched:\s+\d{4}-\d{2}-\d{2}T/);
});

test('library sources says so when nothing was fetched from git', async t => {
  sandbox(t);
  const out = collector();
  const code = await main(['library', 'sources'], { write: out.write, git: fakeGit({ repo: '', sha: SHA_1 }) });
  assert.equal(code, 0);
  assert.match(out.text(), /No libraries have been fetched from git links yet\./);
});

test('library update says already up to date when the repository has not changed', async t => {
  const s = sandbox(t);
  const state = { repo: writeRepo(path.join(s.base, 'repo')), sha: SHA_1 };
  const git = fakeGit(state);
  await main(['library', 'import', 'owner/kit'], { write: () => {}, git });

  const out = collector();
  const code = await main(['library', 'update', 'owner/kit'], { write: out.write, git });
  assert.equal(code, 0);
  assert.match(out.text(), /^Fetched https:\/\/github\.com\/owner\/kit\.git at aaaaaaaa\./);
  assert.match(out.text(), /Already up to date\./);
  assert.doesNotMatch(out.text(), /Run bindery library import/);
});

test('library update lists added, changed and removed items and suggests import', async t => {
  const s = sandbox(t);
  const repo = path.join(s.base, 'repo');
  const state = { repo: writeRepo(repo), sha: SHA_1 };
  const git = fakeGit(state);
  await main(['library', 'import', 'owner/kit'], { write: () => {}, git });

  state.repo = writeRepo(path.join(s.base, 'repo2'), { skillBody: 'version two', bestFor: 'Layouts, faster', extraPrompt: true });
  state.sha = SHA_2;
  const out = collector();
  const code = await main(['library', 'update', 'owner/kit'], { write: out.write, git });
  assert.equal(code, 0);
  assert.match(out.text(), /Changes since aaaaaaaa:/);
  assert.match(out.text(), /\+ added\s+prompt gamma/);
  assert.match(out.text(), /~ changed\s+skill alpha \(notes, files\)/);
  assert.match(out.text(), /Run bindery library import owner\/kit to install the changes\./);
});

test('a link that is not https errors cleanly and never reaches git', async t => {
  sandbox(t);
  const git = fakeGit({ repo: '', sha: SHA_1 });
  for (const link of ['git@github.com:owner/kit.git', 'http://github.com/owner/kit', 'ssh://git@github.com/owner/kit.git']) {
    await assert.rejects(
      main(['library', 'import', link], { write: () => {}, git }),
      /Only https links can be used to import a library\./,
      link,
    );
    await assert.rejects(
      main(['library', 'update', link], { write: () => {}, git }),
      /Only https links can be used to import a library\./,
      link,
    );
  }
  assert.equal(git.calls.length, 0);
});

test('library update with no link prints usage', async t => {
  sandbox(t);
  await assert.rejects(main(['library', 'update'], { write: () => {}, git: fakeGit({ repo: '', sha: SHA_1 }) }), /Usage: library update <link>/);
});
