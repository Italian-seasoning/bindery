import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeGitUrl,
  libraryCacheDir,
  fetchLibrary,
  compareLibraries,
} from '../../plugins/bindery/manager/lib/library-git.mjs';
import { readLibrary } from '../../plugins/bindery/manager/lib/library.mjs';

const SHA_1 = 'a'.repeat(40);
const SHA_2 = 'b'.repeat(40);

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'library-git-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const manifest = items => ({
  format: 'agent-library/1',
  id: 'ui-kit',
  name: 'UI kit',
  author: '',
  description: 'Test library.',
  version: '1.0.0',
  license: 'MIT',
  createdAt: '2026-11-20T00:00:00.000Z',
  items,
});

const alphaItem = { type: 'skill', name: 'alpha', path: 'skills/alpha', bestFor: 'Layouts', apps: ['claude'], source: null };
const betaItem = { type: 'prompt', name: 'beta', path: 'prompts/beta.md', bestFor: '', apps: ['claude', 'codex'], source: null };
const gammaItem = { type: 'prompt', name: 'gamma', path: 'prompts/gamma.md', bestFor: 'Extra', apps: ['codex'], source: null };

// Writes a valid library into `base` (or base/subdir). Options change the content for later fetches.
function writeLibrary(base, { subdir = null, skillBody = 'version one', extraPrompt = false, bestFor = 'Layouts', noManifest = false } = {}) {
  const lib = subdir ? path.join(base, subdir) : base;
  fs.mkdirSync(path.join(lib, 'skills', 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(lib, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'skills', 'alpha', 'SKILL.md'), `---\nname: alpha\n---\n${skillBody}\n`);
  fs.writeFileSync(path.join(lib, 'prompts', 'beta.md'), 'Say hello.\n');
  const items = [{ ...alphaItem, bestFor }, betaItem];
  if (extraPrompt) {
    fs.writeFileSync(path.join(lib, 'prompts', 'gamma.md'), 'Extra prompt.\n');
    items.push(gammaItem);
  }
  if (!noManifest) fs.writeFileSync(path.join(lib, 'library.json'), `${JSON.stringify(manifest(items), null, 2)}\n`);
  return lib;
}

// Fake git: clone copies `repo` into the target folder, rev-parse returns `sha`.
function fakeGit({ repo, sha = SHA_1, fail = null }) {
  const calls = [];
  const git = async (args, { cwd } = {}) => {
    calls.push({ args: [...args], cwd });
    if (fail) throw fail;
    if (args[0] === 'clone') {
      fs.cpSync(repo, args[args.length - 1], { recursive: true });
      return { stdout: '' };
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${sha}\n` };
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  git.calls = calls;
  return git;
}

const cloneCalls = git => git.calls.filter(c => c.args[0] === 'clone');

test('normalizeGitUrl accepts the plain repository forms', () => {
  const expected = { url: 'https://github.com/o/r.git', ref: null, subdir: null };
  assert.deepEqual(normalizeGitUrl('https://github.com/o/r'), expected);
  assert.deepEqual(normalizeGitUrl('https://github.com/o/r.git'), expected);
  assert.deepEqual(normalizeGitUrl('github.com/o/r'), expected);
  assert.deepEqual(normalizeGitUrl('o/r'), expected);
  assert.deepEqual(normalizeGitUrl('  https://github.com/o/r/  '), expected);
});

test('normalizeGitUrl reads a branch and folder from a tree link', () => {
  assert.deepEqual(normalizeGitUrl('https://github.com/o/r/tree/main/skills/x'), {
    url: 'https://github.com/o/r.git',
    ref: 'main',
    subdir: 'skills/x',
  });
  assert.deepEqual(normalizeGitUrl('https://github.com/o/r/tree/v2'), {
    url: 'https://github.com/o/r.git',
    ref: 'v2',
    subdir: null,
  });
});

test('normalizeGitUrl rejects anything but https', () => {
  for (const link of [
    'ssh://git@github.com/o/r.git',
    'git@github.com:o/r.git',
    'git://github.com/o/r.git',
    'file:///Users/someone/repo',
    'http://github.com/o/r',
  ]) {
    assert.throws(() => normalizeGitUrl(link), /Only https links can be used/, link);
  }
});

test('normalizeGitUrl rejects credentials in the link', () => {
  assert.throws(() => normalizeGitUrl('https://user:secret@github.com/o/r'), /username or password/);
  assert.throws(() => normalizeGitUrl('https://someone@github.com/o/r'), /username or password/);
});

test('normalizeGitUrl rejects ".." in the folder path', () => {
  assert.throws(() => normalizeGitUrl('https://github.com/o/r/tree/main/a/../b'), /must not go up/);
  assert.throws(() => normalizeGitUrl('https://github.com/o/r/tree/main/a/%2e%2e/b'), /must not go up/);
  assert.throws(() => normalizeGitUrl('https://github.com/o/r/tree/main/..'), /must not go up/);
});

test('normalizeGitUrl rejects incomplete or odd links with plain sentences', () => {
  assert.throws(() => normalizeGitUrl(''), /Enter a library link/);
  assert.throws(() => normalizeGitUrl('   '), /Enter a library link/);
  assert.throws(() => normalizeGitUrl(42), /Enter a library link/);
  assert.throws(() => normalizeGitUrl('just-a-word'), /does not look like a library link/);
  assert.throws(() => normalizeGitUrl('https://github.com/o'), /must point to a repository/);
  assert.throws(() => normalizeGitUrl('https://github.com/o/../r'), /must not go up/);
  assert.throws(() => normalizeGitUrl('https://github.com/o/r/blob/main/x'), /\/tree\//);
  assert.throws(() => normalizeGitUrl('https://github.com/o/r/tree'), /missing the branch/);
  assert.throws(() => normalizeGitUrl('https://github.com/o/r/tree/-x/y'), /branch name/);
  assert.throws(() => normalizeGitUrl('https://github.com/o/r with space'), /must not contain spaces/);
});

test('libraryCacheDir is a short hash under the state folder', () => {
  const dir = libraryCacheDir({ stateDir: '/state', url: 'https://github.com/o/r.git' });
  const key = crypto.createHash('sha256').update('https://github.com/o/r.git').digest('hex').slice(0, 16);
  assert.equal(dir, path.join('/state', 'cache', 'libraries', key));
  assert.match(path.basename(dir), /^[0-9a-f]{16}$/);
  assert.notEqual(dir, libraryCacheDir({ stateDir: '/state', url: 'https://github.com/o/other.git' }));
  assert.throws(() => libraryCacheDir({ url: 'https://github.com/o/r.git' }), /library folder location/);
  const plain = libraryCacheDir({ stateDir: '/state', url: 'https://github.com/o/r.git' });
  const a = libraryCacheDir({ stateDir: '/state', url: 'https://github.com/o/r.git', ref: 'main', subdir: 'a' });
  const b = libraryCacheDir({ stateDir: '/state', url: 'https://github.com/o/r.git', ref: 'main', subdir: 'b' });
  assert.notEqual(a, b, 'two folders of one repository get their own caches');
  assert.notEqual(a, plain);
});

test('fetchLibrary clones a new library into the cache on first fetch', async t => {
  const base = sandbox(t);
  const stateDir = path.join(base, 'state');
  const repo = path.join(base, 'repo');
  writeLibrary(repo);
  const git = fakeGit({ repo, sha: SHA_1 });

  const result = await fetchLibrary({ stateDir, input: 'o/r', git });

  const cacheDir = libraryCacheDir({ stateDir, url: 'https://github.com/o/r.git' });
  assert.equal(result.dir, cacheDir);
  assert.equal(result.commit, SHA_1);
  assert.equal(result.url, 'https://github.com/o/r.git');
  assert.equal(result.previousCommit, null);
  assert.equal(result.changes, null);

  const clone = cloneCalls(git)[0].args;
  assert.deepEqual(clone.slice(0, 4), ['clone', '--depth', '1', '--quiet']);
  assert.equal(clone.includes('--branch'), false);
  assert.equal(clone.at(-3), '--');
  assert.equal(clone.at(-2), 'https://github.com/o/r.git');
  assert.equal(clone.at(-1).startsWith(path.join(stateDir, 'cache', 'libraries')), true);

  const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, '.fetch.json'), 'utf8'));
  assert.equal(meta.url, 'https://github.com/o/r.git');
  assert.equal(meta.ref, null);
  assert.equal(meta.subdir, null);
  assert.equal(meta.commit, SHA_1);
  assert.ok(!Number.isNaN(Date.parse(meta.fetchedAt)));

  assert.equal(readLibrary(result.dir).manifest.name, 'UI kit');
  assert.equal(fs.existsSync(path.join(cacheDir, '.git')), false);
  assert.equal(fs.existsSync(path.join(stateDir, 'backups')), false);
  assert.deepEqual(fs.readdirSync(path.join(stateDir, 'cache', 'libraries')), [path.basename(cacheDir)]);
});

test('fetchLibrary moves the previous copy to backups and reports what changed', async t => {
  const base = sandbox(t);
  const stateDir = path.join(base, 'state');
  const repo = path.join(base, 'repo');
  writeLibrary(repo, { skillBody: 'version one', bestFor: 'Layouts' });
  await fetchLibrary({ stateDir, input: 'https://github.com/o/r', git: fakeGit({ repo, sha: SHA_1 }) });

  // The upstream repo changes: skill text, a "best for" note, and a new prompt.
  fs.rmSync(repo, { recursive: true, force: true });
  writeLibrary(repo, { skillBody: 'version two', bestFor: 'Dashboards', extraPrompt: true });
  const result = await fetchLibrary({ stateDir, input: 'https://github.com/o/r', git: fakeGit({ repo, sha: SHA_2 }) });

  assert.equal(result.commit, SHA_2);
  assert.equal(result.previousCommit, SHA_1);
  assert.deepEqual(result.changes.added, [{ type: 'prompt', name: 'gamma' }]);
  assert.deepEqual(result.changes.removed, []);
  assert.deepEqual(result.changes.changed, [{ type: 'skill', name: 'alpha', parts: ['notes', 'files'] }]);

  const cacheDir = libraryCacheDir({ stateDir, url: 'https://github.com/o/r.git' });
  assert.match(fs.readFileSync(path.join(cacheDir, 'skills', 'alpha', 'SKILL.md'), 'utf8'), /version two/);

  const backupRoots = fs.readdirSync(path.join(stateDir, 'backups'));
  assert.equal(backupRoots.length, 1);
  assert.match(backupRoots[0], /^library-fetch-/);
  const oldCopy = path.join(stateDir, 'backups', backupRoots[0], path.basename(cacheDir));
  assert.match(fs.readFileSync(path.join(oldCopy, 'skills', 'alpha', 'SKILL.md'), 'utf8'), /version one/);
  assert.equal(fs.existsSync(path.join(oldCopy, 'prompts', 'gamma.md')), false);
});

test('fetchLibrary passes the branch and returns the folder inside the repo', async t => {
  const base = sandbox(t);
  const stateDir = path.join(base, 'state');
  const repo = path.join(base, 'repo');
  writeLibrary(repo, { subdir: 'libs/ui-kit' });
  const git = fakeGit({ repo, sha: SHA_1 });

  const result = await fetchLibrary({
    stateDir,
    input: 'https://github.com/o/r/tree/v2/libs/ui-kit',
    git,
  });

  const clone = cloneCalls(git)[0].args;
  const branchAt = clone.indexOf('--branch');
  assert.notEqual(branchAt, -1);
  assert.equal(clone[branchAt + 1], 'v2');

  const cacheDir = libraryCacheDir({ stateDir, url: 'https://github.com/o/r.git', ref: 'v2', subdir: 'libs/ui-kit' });
  assert.equal(result.cacheDir, cacheDir);
  assert.equal(result.dir, path.join(cacheDir, 'libs', 'ui-kit'));
  assert.equal(readLibrary(result.dir).manifest.id, 'ui-kit');
  const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, '.fetch.json'), 'utf8'));
  assert.equal(meta.ref, 'v2');
  assert.equal(meta.subdir, 'libs/ui-kit');
});

test('fetchLibrary keeps the cache but reports a folder that is not a library', async t => {
  const base = sandbox(t);
  const stateDir = path.join(base, 'state');
  const repo = path.join(base, 'repo');
  writeLibrary(repo, { noManifest: true });

  await assert.rejects(
    fetchLibrary({ stateDir, input: 'o/r', git: fakeGit({ repo }) }),
    /This folder has no library\.json\./,
  );

  const cacheDir = libraryCacheDir({ stateDir, url: 'https://github.com/o/r.git' });
  assert.equal(fs.existsSync(path.join(cacheDir, '.fetch.json')), true);
  assert.equal(fs.existsSync(path.join(cacheDir, 'skills', 'alpha', 'SKILL.md')), true);
});

test('fetchLibrary reports a missing subfolder and leaves no temp folder behind', async t => {
  const base = sandbox(t);
  const stateDir = path.join(base, 'state');
  const repo = path.join(base, 'repo');
  writeLibrary(repo);

  await assert.rejects(
    fetchLibrary({ stateDir, input: 'https://github.com/o/r/tree/main/nowhere', git: fakeGit({ repo }) }),
    /was not found in that repository/,
  );
  assert.deepEqual(fs.readdirSync(path.join(stateDir, 'cache', 'libraries')), []);
});

test('fetchLibrary explains a missing git install in plain words', async t => {
  const base = sandbox(t);
  const stateDir = path.join(base, 'state');
  const missing = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });

  await assert.rejects(
    fetchLibrary({ stateDir, input: 'o/r', git: fakeGit({ repo: base, fail: missing }) }),
    err => {
      assert.match(err.message, /Git is not installed/);
      assert.doesNotMatch(err.message, /ENOENT/);
      return true;
    },
  );
  const libs = path.join(stateDir, 'cache', 'libraries');
  assert.ok(!fs.existsSync(libs) || fs.readdirSync(libs).length === 0);
});

test('fetchLibrary gives a plain message when the download fails and cleans its temp folder', async t => {
  const base = sandbox(t);
  const stateDir = path.join(base, 'state');
  const failure = Object.assign(new Error('fatal: repository not found'), { code: 128 });

  await assert.rejects(
    fetchLibrary({ stateDir, input: 'o/r', git: fakeGit({ repo: base, fail: failure }) }),
    /Could not download the library from that link/,
  );
  const libs = path.join(stateDir, 'cache', 'libraries');
  assert.ok(!fs.existsSync(libs) || fs.readdirSync(libs).length === 0);
});

test('fetchLibrary rejects an unsafe link before running git', async t => {
  const base = sandbox(t);
  const git = fakeGit({ repo: base });

  await assert.rejects(
    fetchLibrary({ stateDir: path.join(base, 'state'), input: 'ssh://git@github.com/o/r.git', git }),
    /Only https links/,
  );
  assert.equal(git.calls.length, 0);
});

test('fetchLibrary needs a state folder', async () => {
  await assert.rejects(fetchLibrary({ input: 'o/r', git: fakeGit({ repo: os.tmpdir() }) }), /library folder location/);
});

test('compareLibraries reports nothing for identical folders', t => {
  const base = sandbox(t);
  const a = writeLibrary(path.join(base, 'a'));
  const b = writeLibrary(path.join(base, 'b'));
  assert.deepEqual(compareLibraries(a, b), { added: [], removed: [], changed: [] });
});

test('compareLibraries finds added, removed and changed items', t => {
  const base = sandbox(t);
  const oldDir = writeLibrary(path.join(base, 'old'), { extraPrompt: true });
  const newDir = writeLibrary(path.join(base, 'new'), { skillBody: 'edited', bestFor: 'Tables' });
  fs.writeFileSync(path.join(newDir, 'prompts', 'beta.md'), 'Say hi.\n');
  const manifestNew = manifest([{ ...alphaItem, bestFor: 'Tables' }, { ...betaItem }]);
  fs.writeFileSync(path.join(newDir, 'library.json'), JSON.stringify(manifestNew));

  assert.deepEqual(compareLibraries(oldDir, newDir), {
    added: [],
    removed: [{ type: 'prompt', name: 'gamma' }],
    changed: [
      { type: 'prompt', name: 'beta', parts: ['files'] },
      { type: 'skill', name: 'alpha', parts: ['notes', 'files'] },
    ],
  });
});

test('compareLibraries treats an unreadable manifest as empty', t => {
  const base = sandbox(t);
  const good = writeLibrary(path.join(base, 'good'));
  const missing = path.join(base, 'missing');
  fs.mkdirSync(missing);

  const diff = compareLibraries(missing, good);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.added.map(i => i.name).sort(), ['alpha', 'beta']);
});
