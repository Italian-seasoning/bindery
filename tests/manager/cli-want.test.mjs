import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../../plugins/bindery/manager/cli.mjs');

// A throwaway HOME and state folder. Every spawn gets these, never the real ones.
function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cli-want-'));
  const home = path.join(base, 'home');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(home, { recursive: true });
  return { base, home, stateDir };
}

function run(t, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: t.home,
    encoding: 'utf8',
    env: { ...process.env, HOME: t.home, BINDERY_HOME: t.stateDir },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const idFrom = out => /id: ([0-9a-f]{12})/.exec(out)[1];

test('want list says so when the list is empty', () => {
  const t = setup();
  try {
    const r = run(t, ['want', 'list']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Your want list is empty\. Save a link with: bindery want add <link>\n$/);
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});

test('want add saves a link and prints its title and id', () => {
  const t = setup();
  try {
    const r = run(t, ['want', 'add', 'https://github.com/owner/repo', '--creator', 'Ana', '--note', 'Try the layout']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Saved owner\/repo\./);
    assert.match(r.out, /id: [0-9a-f]{12}/);
    assert.ok(fs.existsSync(path.join(t.stateDir, 'want.json')));
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});

test('want list prints newest first with status, link, creator and note', () => {
  const t = setup();
  try {
    run(t, ['want', 'add', 'https://example.com/first', '--title', 'First one']);
    run(t, ['want', 'add', 'https://www.instagram.com/reel/abc/', '--creator', 'Ana', '--note', 'Hook idea']);
    const r = run(t, ['want', 'list']);
    assert.equal(r.code, 0, r.err);
    const lines = r.out.split('\n');
    const second = lines.findIndex(l => l.startsWith('Instagram reel'));
    const first = lines.findIndex(l => l.startsWith('First one'));
    assert.ok(second >= 0 && first >= 0, r.out);
    assert.ok(second < first, 'newest entry should come first');
    assert.match(lines[second], /\(saved\)$/);
    assert.match(r.out, /https:\/\/www\.instagram\.com\/reel\/abc\//);
    assert.match(r.out, /by Ana; note: Hook idea/);
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});

test('want list --json prints the items as JSON', () => {
  const t = setup();
  try {
    run(t, ['want', 'add', 'https://example.com/post', '--title', 'Post']);
    const r = run(t, ['want', 'list', '--json']);
    assert.equal(r.code, 0, r.err);
    const items = JSON.parse(r.out);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Post');
    assert.equal(items[0].url, 'https://example.com/post');
    assert.equal(items[0].status, 'saved');
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});

test('want set changes the status and the note', () => {
  const t = setup();
  try {
    const id = idFrom(run(t, ['want', 'add', 'https://example.com/post', '--title', 'Post']).out);
    const r = run(t, ['want', 'set', id, '--status', 'reviewed', '--note', 'Read it']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Updated Post\. Status: reviewed\./);
    const listed = JSON.parse(run(t, ['want', 'list', '--json']).out);
    assert.equal(listed[0].status, 'reviewed');
    assert.equal(listed[0].note, 'Read it');
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});

test('want set with a bad status prints a plain error and exits 1', () => {
  const t = setup();
  try {
    const id = idFrom(run(t, ['want', 'add', 'https://example.com/post']).out);
    const r = run(t, ['want', 'set', id, '--status', 'maybe']);
    assert.equal(r.code, 1);
    assert.match(r.err, /Choose one of: saved, reviewed, added, dismissed\./);
    assert.equal(JSON.parse(run(t, ['want', 'list', '--json']).out)[0].status, 'saved');
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});

test('want remove deletes the entry and keeps a copy in backups', () => {
  const t = setup();
  try {
    const id = idFrom(run(t, ['want', 'add', 'https://example.com/post', '--title', 'Post']).out);
    const r = run(t, ['want', 'remove', id]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Removed Post\. A copy is kept in backups\./);
    assert.deepEqual(JSON.parse(run(t, ['want', 'list', '--json']).out), []);
    const backups = fs.readdirSync(path.join(t.stateDir, 'backups'));
    assert.equal(backups.length, 1);
    const kept = JSON.parse(fs.readFileSync(path.join(t.stateDir, 'backups', backups[0]), 'utf8'));
    assert.equal(kept[0].id, id);
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});

test('want export prints the list as Markdown', () => {
  const t = setup();
  try {
    run(t, ['want', 'add', 'https://example.com/post', '--title', 'Post', '--creator', 'Ana']);
    const r = run(t, ['want', 'export']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^# Want to try\n\n- \[Post\]\(https:\/\/example\.com\/post\) · by Ana · status: saved\n$/);
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});

test('want add with a link that is not web or not a link prints a plain error and exits 1', () => {
  const t = setup();
  try {
    const bad = run(t, ['want', 'add', 'not a link']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /That does not look like a web link/);

    const ftp = run(t, ['want', 'add', 'ftp://example.com/file']);
    assert.equal(ftp.code, 1);
    assert.match(ftp.err, /Only web links \(http or https\) can be saved\./);
    assert.equal(fs.existsSync(path.join(t.stateDir, 'want.json')), false);
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});

test('want without a link or id prints usage and exits 2', () => {
  const t = setup();
  try {
    const r = run(t, ['want', 'add']);
    assert.equal(r.code, 2);
    assert.match(r.err, /Usage: want add <link>/);
  } finally {
    fs.rmSync(t.base, { recursive: true, force: true });
  }
});
