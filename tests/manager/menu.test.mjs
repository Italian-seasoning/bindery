import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextIndex, typeaheadIndex } from '../../plugins/bindery/manager/ui/menu.js';
import { applySavedTheme, openSettings } from '../../plugins/bindery/manager/ui/settings.js';

const items = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta', disabled: true },
  { id: 'c', label: 'Alpine' },
  { id: 'd', label: 'Gamma' },
];

test('nextIndex moves forward and backward, wrapping at both ends', () => {
  assert.equal(nextIndex(items, 0, 1), 2, 'skips the disabled Beta');
  assert.equal(nextIndex(items, 3, 1), 0, 'wraps forward past the end');
  assert.equal(nextIndex(items, 0, -1), 3, 'wraps backward past the start');
  assert.equal(nextIndex(items, 2, -1), 0, 'skips disabled items going back');
});

test('nextIndex starts from the ends when nothing is focused yet', () => {
  assert.equal(nextIndex(items, -1, 1), 0);
  assert.equal(nextIndex(items, -1, -1), 3);
  assert.equal(nextIndex(items, items.length, -1), 3);
});

test('nextIndex returns -1 for empty or fully disabled lists', () => {
  assert.equal(nextIndex([], 0, 1), -1);
  assert.equal(nextIndex([{ label: 'x', disabled: true }], 0, 1), -1);
});

test('typeaheadIndex finds the next item after `from` whose label starts with the text', () => {
  assert.equal(typeaheadIndex(items, 0, 'al'), 2, 'Alpine comes after Alpha');
  assert.equal(typeaheadIndex(items, 2, 'al'), 0, 'wraps to Alpha');
  assert.equal(typeaheadIndex(items, -1, 'g'), 3);
});

test('typeaheadIndex ignores case', () => {
  assert.equal(typeaheadIndex(items, -1, 'GAMMA'), 3);
  assert.equal(typeaheadIndex(items, -1, 'gA'), 3);
});

test('typeaheadIndex skips disabled items', () => {
  assert.equal(typeaheadIndex(items, 0, 'BE'), -1, 'Beta is disabled');
});

test('typeaheadIndex returns -1 when nothing matches or the text is empty', () => {
  assert.equal(typeaheadIndex(items, 0, 'z'), -1);
  assert.equal(typeaheadIndex(items, 0, ''), -1);
  assert.equal(typeaheadIndex([], 0, 'a'), -1);
});

test('importing settings.js in Node does not throw, and applySavedTheme is safe without a DOM', () => {
  assert.equal(typeof openSettings, 'function');
  assert.doesNotThrow(() => applySavedTheme());
});
