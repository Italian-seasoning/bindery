import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATUSES,
  sourceOf,
  defaultTitle,
  listWant,
  addWant,
  updateWant,
  removeWant,
  exportWant,
} from '../../plugins/bindery/manager/lib/want.mjs';

const tmpState = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bindery-want-'));
const backups = stateDir => {
  const dir = path.join(stateDir, 'backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

test('sourceOf and defaultTitle recognise GitHub, Instagram and other links', () => {
  assert.equal(sourceOf('https://github.com/a/b'), 'github');
  assert.equal(sourceOf('https://www.instagram.com/reel/xyz/'), 'instagram');
  assert.equal(sourceOf('https://notgithub.com/a/b'), 'web');
  assert.equal(sourceOf('not a url'), 'web');
  assert.equal(defaultTitle('https://github.com/owner/repo.git'), 'owner/repo');
  assert.equal(defaultTitle('https://www.instagram.com/reel/xyz/'), 'Instagram reel');
  assert.equal(defaultTitle('https://example.com/post/1'), 'example.com');
  assert.equal(defaultTitle('nope'), '');
});

test('an empty or missing list reads as empty and writes nothing', () => {
  const stateDir = tmpState();
  assert.deepEqual(listWant({ stateDir }), []);
  assert.equal(fs.existsSync(path.join(stateDir, 'want.json')), false);
  assert.throws(() => listWant({}), /folder location is missing/);
});

test('addWant saves a cleaned item with derived fields', () => {
  const stateDir = tmpState();
  const item = addWant({ stateDir, url: '  https://github.com/acme/tools  ', repo: 'acme/tools', note: '  try the review skill ' });
  assert.equal(item.url, 'https://github.com/acme/tools');
  assert.equal(item.title, 'acme/tools');
  assert.equal(item.repo, 'https://github.com/acme/tools');
  assert.equal(item.note, 'try the review skill');
  assert.equal(item.status, 'saved');
  assert.equal(item.source, 'github');
  assert.match(item.id, /^[0-9a-f]{12}$/);
  assert.deepEqual(listWant({ stateDir }).map(i => i.id), [item.id]);
  const mode = fs.statSync(path.join(stateDir, 'want.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('addWant rejects bad links, duplicates, bad repos and long text', () => {
  const stateDir = tmpState();
  assert.throws(() => addWant({ stateDir, url: '' }), /Paste a link/);
  assert.throws(() => addWant({ stateDir, url: 'example.com' }), /starting with https/);
  assert.throws(() => addWant({ stateDir, url: 'file:///etc/passwd' }), /Only web links/);
  assert.throws(() => addWant({ stateDir, url: 'javascript:alert(1)' }), /Only web links/);
  assert.throws(() => addWant({ stateDir, url: 'https://a.test', repo: 'http://github.com/a/b' }), /source repository/);
  assert.throws(() => addWant({ stateDir, url: 'https://a.test', repo: 'https://user:pw@github.com/a/b' }), /source repository/);
  assert.throws(() => addWant({ stateDir, url: 'https://a.test', title: 'x'.repeat(121) }), /120 characters/);
  assert.throws(() => addWant({ stateDir, url: 'https://a.test', note: 5 }), /must be text/);
  addWant({ stateDir, url: 'https://a.test' });
  assert.throws(() => addWant({ stateDir, url: 'https://a.test' }), /already in your list/);
});

test('listWant returns newest first', async () => {
  const stateDir = tmpState();
  const first = addWant({ stateDir, url: 'https://one.test' });
  await new Promise(r => setTimeout(r, 5));
  const second = addWant({ stateDir, url: 'https://two.test' });
  assert.deepEqual(listWant({ stateDir }).map(i => i.id), [second.id, first.id]);
});

test('updateWant changes allowed fields only and validates status', () => {
  const stateDir = tmpState();
  const item = addWant({ stateDir, url: 'https://github.com/acme/tools', title: 'Tools' });
  const next = updateWant({ stateDir, id: item.id, title: '', status: 'reviewed', url: 'https://evil.test', source: 'x' });
  assert.equal(next.title, 'acme/tools', 'empty title falls back to the derived one');
  assert.equal(next.status, 'reviewed');
  assert.equal(next.url, item.url);
  assert.equal(next.source, 'github');
  assert.ok(STATUSES.includes(next.status));
  assert.throws(() => updateWant({ stateDir, id: item.id, status: 'done' }), /Choose one of/);
  assert.throws(() => updateWant({ stateDir, id: 'missing' }), /no longer in your list/);
});

test('removeWant backs the entry up before dropping it', () => {
  const stateDir = tmpState();
  const item = addWant({ stateDir, url: 'https://a.test', note: 'keep me' });
  const removed = removeWant({ stateDir, id: item.id });
  assert.equal(removed.id, item.id);
  assert.deepEqual(listWant({ stateDir }), []);
  const files = backups(stateDir);
  assert.equal(files.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'backups', files[0]), 'utf8'));
  assert.equal(saved[0].note, 'keep me');
  assert.ok(saved[0].removedAt);
  assert.throws(() => removeWant({ stateDir, id: item.id }), /no longer in your list/);
});

test('a damaged want.json is moved to backups and the list starts empty', () => {
  const stateDir = tmpState();
  fs.writeFileSync(path.join(stateDir, 'want.json'), '{ not json');
  assert.deepEqual(listWant({ stateDir }), []);
  assert.equal(fs.existsSync(path.join(stateDir, 'want.json')), false);
  const files = backups(stateDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^want-corrupt-/);
  assert.equal(fs.readFileSync(path.join(stateDir, 'backups', files[0]), 'utf8'), '{ not json');
});

test('exportWant writes one escaped Markdown bullet per item', () => {
  const stateDir = tmpState();
  assert.equal(exportWant({ stateDir }), '# Want to try\n\nNothing saved yet.\n');
  addWant({ stateDir, url: 'https://a.test/x (1)', title: 'A [draft]', creator: 'Sam', note: 'line one\nline two' });
  const md = exportWant({ stateDir });
  assert.match(md, /^# Want to try\n\n- \[A \\\[draft\\\]\]\(https:\/\/a\.test\/x%20%281%29\) · by Sam · status: saved · note: line one line two\n$/);
});
