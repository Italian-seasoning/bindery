import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FORMAT,
  validateManifest,
  readLibrary,
  listLibraries,
  createLibrary,
  addSkill,
  addPrompt,
  removeItem,
  updateItem,
  renderReadme,
  exportLibrary,
} from '../../plugins/bindery/manager/lib/library.mjs';

const specExample = () => ({
  format: 'agent-library/1',
  id: 'ui-kit',
  name: 'UI kit',
  author: 'Display name or empty',
  description: 'One paragraph, plain language.',
  version: '1.0.0',
  license: 'MIT',
  createdAt: '2026-11-20T00:00:00.000Z',
  items: [
    {
      type: 'skill',
      name: 'impeccable',
      path: 'skills/impeccable',
      bestFor: 'Unslopping and professional layout critique.',
      apps: ['claude', 'codex'],
      source: { repo: 'https://github.com/x/y', commit: 'abc1234', path: 'skills/impeccable' },
    },
    {
      type: 'prompt',
      name: 'review-pr',
      path: 'prompts/review-pr.md',
      bestFor: 'A careful review of the current diff.',
      apps: ['claude', 'codex'],
      source: null,
    },
  ],
});

// Returns the validation errors for the spec example after one mutation.
function errorsFor(mutate) {
  const manifest = specExample();
  mutate(manifest);
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  return result.errors.join('\n');
}

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-lib-')));
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(stateDir);
  const skill = (name, body = 'v1') => {
    const dir = path.join(base, 'src', name);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
    fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), 'echo hi\n');
    return dir;
  };
  const prompt = (name, body = 'Review the diff.') => {
    const file = path.join(base, 'src', `${name}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };
  return { base, stateDir, skill, prompt, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const libDir = (stateDir, id) => path.join(stateDir, 'libraries', id);

// Finds files under the backups folder whose path ends with the given suffix.
function backupFiles(stateDir, suffix) {
  const root = path.join(stateDir, 'backups');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true })
    .filter(rel => rel.endsWith(suffix))
    .map(rel => path.join(root, rel));
}

test('validateManifest accepts the spec example', () => {
  const result = validateManifest(specExample());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.manifest.format, FORMAT);
});

test('validateManifest fills defaults for apps, bestFor, source and description', () => {
  const manifest = { id: 'bare', name: 'Bare', items: [{ type: 'prompt', name: 'p', path: 'prompts/p.md' }] };
  const result = validateManifest(manifest);
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.items[0].apps, ['claude', 'codex']);
  assert.equal(result.manifest.items[0].bestFor, '');
  assert.equal(result.manifest.items[0].source, null);
  assert.equal(result.manifest.description, '');
});

test('validateManifest rejects a bad id', () => {
  assert.match(errorsFor(m => { m.id = 'Bad_ID'; }), /library id/);
});

test('validateManifest rejects a path that climbs out with ".."', () => {
  assert.match(errorsFor(m => { m.items[0].path = 'skills/../../secrets'; }), /"\.\."/);
});

test('validateManifest rejects an absolute path', () => {
  assert.match(errorsFor(m => { m.items[0].path = '/etc/passwd'; }), /absolute path/);
});

test('validateManifest rejects duplicate names within a type', () => {
  const dup = errorsFor(m => { m.items.push({ ...m.items[0] }); });
  assert.match(dup, /named "impeccable"/);
});

test('validateManifest rejects an unknown item type', () => {
  assert.match(errorsFor(m => { m.items[0].type = 'plugin'; }), /type "plugin"/);
});

test('validateManifest rejects bad apps', () => {
  assert.match(errorsFor(m => { m.items[0].apps = ['cursor']; }), /apps must list/);
  assert.match(errorsFor(m => { m.items[0].apps = ['claude', 'claude']; }), /apps must list/);
});

test('validateManifest keeps unknown top-level and item keys', () => {
  const manifest = specExample();
  manifest.futureField = { enabled: true };
  manifest.items[0].futureItemField = 42;
  const result = validateManifest(manifest);
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.futureField, { enabled: true });
  assert.equal(result.manifest.items[0].futureItemField, 42);
});

test('create, add a skill, add a prompt, then read the library back', () => {
  const env = sandbox();
  try {
    const created = createLibrary({ stateDir: env.stateDir, id: 'ui-kit', name: 'UI kit', description: 'Tools', author: 'Ana' });
    assert.equal(created.format, FORMAT);
    assert.deepEqual(created.items, []);

    addSkill({
      stateDir: env.stateDir,
      libraryId: 'ui-kit',
      skillDir: env.skill('impeccable'),
      name: 'impeccable',
      bestFor: 'Critique',
      apps: ['claude', 'codex'],
    });
    addPrompt({
      stateDir: env.stateDir,
      libraryId: 'ui-kit',
      promptFile: env.prompt('review-pr'),
      name: 'review-pr',
      bestFor: 'Review',
      apps: ['claude'],
    });

    const dir = libDir(env.stateDir, 'ui-kit');
    assert.ok(fs.existsSync(path.join(dir, 'skills', 'impeccable', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dir, 'skills', 'impeccable', 'scripts', 'run.sh')));
    assert.ok(!fs.existsSync(path.join(dir, 'skills', 'impeccable', '.git')));
    assert.ok(!fs.existsSync(path.join(dir, 'skills', 'impeccable', 'node_modules')));
    assert.equal(fs.readFileSync(path.join(dir, 'prompts', 'review-pr.md'), 'utf8'), 'Review the diff.');

    const text = fs.readFileSync(path.join(dir, 'library.json'), 'utf8');
    assert.ok(text.endsWith('}\n'));
    assert.ok(text.includes('\n  "id": "ui-kit"'));

    const lib = readLibrary(dir);
    assert.deepEqual(lib.problems, []);
    assert.deepEqual(lib.manifest.items.map(i => `${i.type}:${i.name}`), ['skill:impeccable', 'prompt:review-pr']);
    assert.deepEqual(lib.manifest.items[1].apps, ['claude']);
    assert.equal(lib.manifest.author, 'Ana');
  } finally { env.cleanup(); }
});

test('README lists every item as a table row', () => {
  const env = sandbox();
  try {
    createLibrary({ stateDir: env.stateDir, id: 'ui-kit', name: 'UI kit', description: 'Tools' });
    addSkill({ stateDir: env.stateDir, libraryId: 'ui-kit', skillDir: env.skill('impeccable'), name: 'impeccable', bestFor: 'Critique | layout' });
    addPrompt({ stateDir: env.stateDir, libraryId: 'ui-kit', promptFile: env.prompt('review-pr'), name: 'review-pr', bestFor: 'Review' });

    const readme = fs.readFileSync(path.join(libDir(env.stateDir, 'ui-kit'), 'README.md'), 'utf8');
    assert.match(readme, /^# UI kit$/m);
    assert.match(readme, /^\| Item \| Type \| Best for \| Apps \|$/m);
    assert.ok(readme.includes('| impeccable | Skill | Critique \\| layout | Claude Code, Codex |'));
    assert.ok(readme.includes('| review-pr | Prompt | Review | Claude Code, Codex |'));
    assert.ok(readme.includes('Open Bindery, choose Libraries, then Import, and pick this folder or its git URL.'));
    assert.equal(renderReadme(readLibrary(libDir(env.stateDir, 'ui-kit')).manifest), readme);
  } finally { env.cleanup(); }
});

test('replacing an item moves the old copy into backups', () => {
  const env = sandbox();
  try {
    createLibrary({ stateDir: env.stateDir, id: 'ui-kit', name: 'UI kit' });
    const src = env.skill('demo', 'v1');
    addSkill({ stateDir: env.stateDir, libraryId: 'ui-kit', skillDir: src, name: 'demo' });

    fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: demo\n---\nv2\n');
    addSkill({ stateDir: env.stateDir, libraryId: 'ui-kit', skillDir: src, name: 'demo', bestFor: 'Newer' });

    const backups = backupFiles(env.stateDir, path.join('skills', 'demo', 'SKILL.md'));
    assert.equal(backups.length, 1);
    assert.match(fs.readFileSync(backups[0], 'utf8'), /v1/);

    const current = path.join(libDir(env.stateDir, 'ui-kit'), 'skills', 'demo', 'SKILL.md');
    assert.match(fs.readFileSync(current, 'utf8'), /v2/);
    const lib = readLibrary(libDir(env.stateDir, 'ui-kit'));
    assert.equal(lib.manifest.items.length, 1);
    assert.equal(lib.manifest.items[0].bestFor, 'Newer');
  } finally { env.cleanup(); }
});

test('removeItem moves the item into backups and updates the manifest', () => {
  const env = sandbox();
  try {
    createLibrary({ stateDir: env.stateDir, id: 'ui-kit', name: 'UI kit' });
    addSkill({ stateDir: env.stateDir, libraryId: 'ui-kit', skillDir: env.skill('demo', 'keep me'), name: 'demo' });
    addPrompt({ stateDir: env.stateDir, libraryId: 'ui-kit', promptFile: env.prompt('review-pr'), name: 'review-pr' });

    const manifest = removeItem({ stateDir: env.stateDir, libraryId: 'ui-kit', type: 'skill', name: 'demo' });
    assert.deepEqual(manifest.items.map(i => i.name), ['review-pr']);
    assert.ok(!fs.existsSync(path.join(libDir(env.stateDir, 'ui-kit'), 'skills', 'demo')));

    const backups = backupFiles(env.stateDir, path.join('skills', 'demo', 'SKILL.md'));
    assert.equal(backups.length, 1);
    assert.match(fs.readFileSync(backups[0], 'utf8'), /keep me/);

    assert.throws(
      () => removeItem({ stateDir: env.stateDir, libraryId: 'ui-kit', type: 'skill', name: 'demo' }),
      { message: 'ui-kit has no skill called demo.' },
    );
  } finally { env.cleanup(); }
});

test('updateItem edits the best-for note and apps only', () => {
  const env = sandbox();
  try {
    createLibrary({ stateDir: env.stateDir, id: 'ui-kit', name: 'UI kit' });
    addPrompt({ stateDir: env.stateDir, libraryId: 'ui-kit', promptFile: env.prompt('review-pr'), name: 'review-pr', bestFor: 'Old' });
    const manifest = updateItem({ stateDir: env.stateDir, libraryId: 'ui-kit', type: 'prompt', name: 'review-pr', bestFor: 'New', apps: ['codex'] });
    assert.equal(manifest.items[0].bestFor, 'New');
    assert.deepEqual(manifest.items[0].apps, ['codex']);
    assert.ok(fs.existsSync(path.join(libDir(env.stateDir, 'ui-kit'), 'prompts', 'review-pr.md')));
    assert.match(fs.readFileSync(path.join(libDir(env.stateDir, 'ui-kit'), 'README.md'), 'utf8'), /\| review-pr \| Prompt \| New \| Codex \|/);
  } finally { env.cleanup(); }
});

test('exportLibrary copies the folder and refuses to overwrite', () => {
  const env = sandbox();
  try {
    createLibrary({ stateDir: env.stateDir, id: 'ui-kit', name: 'UI kit' });
    addSkill({ stateDir: env.stateDir, libraryId: 'ui-kit', skillDir: env.skill('demo'), name: 'demo' });

    const dest = path.join(env.base, 'out');
    const { dir } = exportLibrary({ stateDir: env.stateDir, libraryId: 'ui-kit', dest });
    assert.equal(dir, path.join(dest, 'ui-kit'));
    assert.ok(fs.existsSync(path.join(dir, 'library.json')));
    assert.ok(fs.existsSync(path.join(dir, 'README.md')));
    assert.ok(fs.existsSync(path.join(dir, 'skills', 'demo', 'SKILL.md')));

    assert.throws(
      () => exportLibrary({ stateDir: env.stateDir, libraryId: 'ui-kit', dest }),
      { message: `${path.join(dest, 'ui-kit')} already exists. Choose another folder.` },
    );
  } finally { env.cleanup(); }
});

test('readLibrary reports missing files and rejects a folder without library.json', () => {
  const env = sandbox();
  try {
    createLibrary({ stateDir: env.stateDir, id: 'ui-kit', name: 'UI kit' });
    addSkill({ stateDir: env.stateDir, libraryId: 'ui-kit', skillDir: env.skill('demo'), name: 'demo' });
    fs.rmSync(path.join(libDir(env.stateDir, 'ui-kit'), 'skills', 'demo', 'SKILL.md'));
    const lib = readLibrary(libDir(env.stateDir, 'ui-kit'));
    assert.equal(lib.problems.length, 1);
    assert.match(lib.problems[0], /no SKILL\.md/);

    assert.throws(() => readLibrary(env.base), { message: 'This folder has no library.json.' });
  } finally { env.cleanup(); }
});

test('listLibraries skips a broken folder', () => {
  const env = sandbox();
  try {
    createLibrary({ stateDir: env.stateDir, id: 'good', name: 'Good one' });
    const broken = libDir(env.stateDir, 'broken');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'library.json'), '{ not json');

    const list = listLibraries({ stateDir: env.stateDir });
    assert.deepEqual(list.map(l => l.id), ['good']);
    assert.equal(list[0].itemCount, 0);
    assert.equal(list[0].dir, libDir(env.stateDir, 'good'));
    assert.deepEqual(listLibraries({ stateDir: path.join(env.base, 'missing') }), []);
  } finally { env.cleanup(); }
});
