import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCatalog, fetchPack, cachedPack } from '../../plugins/bindery/manager/lib/catalog.mjs';

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

function git(args, cwd) {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: GIT_ENV },
  ).trim();
}

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const tempDirs = [];
function tmp(prefix = 'ac-catalog-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

let fixture;

function fixturePack(overrides = {}) {
  return { id: 'fixture', title: 'Fixture', repo: fixture.url, kind: 'skills', ...overrides };
}

before(() => {
  const root = tmp();
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  git(['init', '-q', '-b', 'main'], work);

  write(work, 'skills/alpha/SKILL.md', [
    '---',
    'name: alpha',
    'description: |',
    '  Multi line',
    '  description for alpha.',
    'metadata:',
    '  type: example',
    '---',
    '# Alpha',
    '',
  ].join('\n'));
  write(work, 'skills/alpha/scripts/run.sh', '#!/bin/sh\necho hi\n');

  write(work, 'tools/beta/SKILL.md', [
    '---',
    'description: >',
    '  Folded text',
    '  continues here.',
    '---',
    '# Beta',
    '',
  ].join('\n'));

  write(work, '.claude/skills/gamma/SKILL.md', [
    '---',
    "name: 'gamma'",
    'description: Quoted name skill.',
    '---',
    '# Gamma',
    '',
  ].join('\n'));

  write(work, 'node_modules/pkg/SKILL.md', '---\nname: pkg\n---\n');
  write(work, '.hidden/SKILL.md', '---\nname: hidden\n---\n');
  write(work, 'LICENSE', 'MIT License\n\nCopyright (c) 2026 Fixture\n\nPermission is hereby granted, free of charge.\n');

  fs.mkdirSync(path.join(work, 'links'));
  fs.symlinkSync('../tools/beta', path.join(work, 'links', 'beta-alias'), 'dir');

  git(['add', '-A'], work);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], work);

  const bare = path.join(root, 'remote.git');
  execFileSync('git', ['clone', '-q', '--bare', work, bare], { env: GIT_ENV });

  fixture = { root, work, bare, url: pathToFileURL(bare).href };
});

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadCatalog', () => {
  test('reads the shipped packs.json without network', () => {
    const catalog = loadCatalog();
    assert.match(catalog.checked, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof catalog.note, 'string');
    assert.ok(Array.isArray(catalog.packs));
    const impeccable = catalog.packs.find((p) => p.id === 'impeccable');
    assert.ok(impeccable, 'impeccable pack present');
    for (const p of catalog.packs) {
      assert.equal(typeof p.id, 'string');
      assert.equal(typeof p.repo, 'string');
    }
  });
});

describe('fetchPack and cachedPack', () => {
  const shared = { stateDir: null };

  before(() => {
    shared.stateDir = tmp('ac-state-');
  });

  test('clones the pack, lists skills and guesses the licence', async () => {
    const r = await fetchPack(fixturePack(), { stateDir: shared.stateDir });

    assert.equal(r.packId, 'fixture');
    assert.match(r.commit, /^[0-9a-f]{40}$/);
    assert.equal(r.commit, git(['rev-parse', 'HEAD'], fixture.work));
    assert.equal(r.dir, path.join(shared.stateDir, 'cache', 'fixture'));
    assert.ok(!Number.isNaN(Date.parse(r.fetchedAt)));
    assert.deepEqual(r.license, { file: 'LICENSE', spdxGuess: 'MIT' });

    // node_modules and dot-folders (other than .claude) are skipped; the
    // symlinked duplicate of beta collapses into one entry.
    assert.deepEqual(r.skills.map((s) => s.name), ['alpha', 'beta', 'gamma']);

    const alpha = r.skills.find((s) => s.name === 'alpha');
    assert.equal(alpha.relPath, 'skills/alpha');
    assert.equal(alpha.description, 'Multi line description for alpha.');
    assert.equal(alpha.fileCount, 2);
    assert.equal(alpha.hasScripts, true);
    assert.equal(alpha.dir, path.join(r.dir, 'skills', 'alpha'));

    const beta = r.skills.find((s) => s.name === 'beta');
    assert.equal(beta.description, 'Folded text continues here.');
    assert.equal(beta.fileCount, 1);
    assert.equal(beta.hasScripts, false);

    const gamma = r.skills.find((s) => s.name === 'gamma');
    assert.equal(gamma.relPath, '.claude/skills/gamma');
    assert.equal(gamma.description, 'Quoted name skill.');
  });

  test('refetches an existing cache and reports the new commit', async () => {
    const before1 = await fetchPack(fixturePack(), { stateDir: shared.stateDir });

    write(fixture.work, 'skills/delta/SKILL.md', '---\nname: delta\ndescription: Added later.\n---\n');
    git(['add', '-A'], fixture.work);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'add delta'], fixture.work);
    git(['push', '-q', fixture.bare, 'HEAD:refs/heads/main'], fixture.work);
    const newHead = git(['rev-parse', 'HEAD'], fixture.work);
    assert.notEqual(newHead, before1.commit);

    const after1 = await fetchPack(fixturePack(), { stateDir: shared.stateDir });
    assert.equal(after1.dir, before1.dir);
    assert.equal(after1.commit, newHead);
    assert.ok(after1.skills.some((s) => s.name === 'delta' && s.description === 'Added later.'));
  });

  test('cachedPack returns the cached copy without touching the network', async () => {
    const c = cachedPack(fixturePack(), { stateDir: shared.stateDir });
    assert.ok(c, 'cache hit');
    assert.equal(c.commit, git(['rev-parse', 'HEAD'], fixture.work));
    assert.ok(c.skills.some((s) => s.name === 'delta'));

    // Pointing at an unreachable repo still works: nothing is fetched.
    const offline = cachedPack(fixturePack({ repo: 'file:///nonexistent/nowhere.git' }), {
      stateDir: shared.stateDir,
    });
    assert.equal(offline.commit, c.commit);
  });

  test('cachedPack returns null when nothing is cached', () => {
    assert.equal(cachedPack(fixturePack(), { stateDir: tmp('ac-empty-') }), null);
  });

  test('a missing git binary gives a readable error', async () => {
    await assert.rejects(
      fetchPack(fixturePack(), {
        stateDir: tmp('ac-nogit-'),
        git: path.join(fixture.root, 'no-such-git-binary'),
      }),
      (err) => err.message === 'Git is not installed, so packs cannot be fetched.',
    );
  });

  test('an unreachable repo gives a readable error with a cause and leaves no cache behind', async () => {
    const state = tmp('ac-broken-');
    const repo = 'file:///nonexistent/nowhere.git';
    await assert.rejects(
      fetchPack(fixturePack({ id: 'broken', repo }), { stateDir: state }),
      (err) => {
        assert.equal(err.message, `Could not reach ${repo}. Check your connection and try again.`);
        assert.ok(err.cause);
        return true;
      },
    );
    assert.equal(fs.existsSync(path.join(state, 'cache', 'broken')), false);
  });

  test('rejects unsafe pack ids and a missing stateDir', async () => {
    await assert.rejects(fetchPack(fixturePack({ id: '../evil' }), { stateDir: tmp() }), /not valid/);
    assert.throws(() => cachedPack(fixturePack({ id: '../evil' }), { stateDir: tmp() }), /not valid/);
    assert.throws(() => cachedPack(fixturePack(), {}), /stateDir is required/);
  });
});
