import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GLYPHS, FACES, cells, faceCells, readoutEl, faceEl, setText, animateFace,
} from '../../plugins/bindery/manager/ui/readout.js';

// Minimal fake DOM element: records attributes, children and classes. No real DOM.
function fakeDoc() {
  return {
    createElementNS(ns, name) {
      const classes = new Set();
      return {
        ns,
        name,
        attrs: {},
        children: [],
        classList: {
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
          contains: (c) => classes.has(c),
        },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k]; },
        appendChild(child) { this.children.push(child); return child; },
      };
    },
  };
}

// Stub matchMedia for one test, restoring the previous value after.
async function withReducedMotion(matches, fn) {
  const saved = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches });
  try { return await fn(); } finally {
    if (saved === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = saved;
  }
}

// Cell state of a readout as a string: one char per cell, row-major.
function bitmap(svg) {
  return svg.children.map((r) => (r.attrs.class === 'ro-on' ? '#' : '.')).join('');
}

const REQUIRED = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ -./!?:+'];

test('every glyph is 7 rows of 5 chars, only # and .', () => {
  for (const [ch, rows] of Object.entries(GLYPHS)) {
    assert.equal(rows.length, 7, `glyph ${JSON.stringify(ch)} has ${rows.length} rows`);
    for (const row of rows) {
      assert.match(row, /^[#.]{5}$/, `glyph ${JSON.stringify(ch)} row ${JSON.stringify(row)}`);
    }
  }
});

test('all required characters have a glyph', () => {
  for (const ch of REQUIRED) {
    assert.ok(Object.hasOwn(GLYPHS, ch), `missing glyph ${JSON.stringify(ch)}`);
  }
});

test('cells("A1") is 11 wide, 7 high, and lit cells are in bounds', () => {
  const grid = cells('A1');
  assert.equal(grid.width, 11);
  assert.equal(grid.height, 7);
  assert.ok(grid.lit.length > 0);
  for (const [x, y] of grid.lit) {
    assert.ok(x >= 0 && x < grid.width, `x ${x} out of bounds`);
    assert.ok(y >= 0 && y < grid.height, `y ${y} out of bounds`);
  }
});

test('cells: lowercase equals uppercase', () => {
  assert.deepEqual(cells('abc-9'), cells('ABC-9'));
});

test('cells: unknown characters render like a space', () => {
  assert.deepEqual(cells('#'), cells(' '));
  assert.deepEqual(cells('A#B'), cells('A B'));
});

test('cells: text is truncated at 12 glyphs', () => {
  const twelve = cells('123456789012');
  assert.equal(twelve.width, 12 * 6 - 1);
  assert.deepEqual(cells('1234567890123456'), twelve);
});

test('cells: cols pads on the right with spaces', () => {
  const grid = cells('A', { cols: 4 });
  assert.equal(grid.width, 4 * 6 - 1);
  assert.deepEqual(grid.lit, cells('A   ').lit);
  assert.deepEqual(cells('A', { cols: 1 }), cells('A'));
});

test('faces: every mood is 7 rows of 13 chars', () => {
  for (const [mood, rows] of Object.entries(FACES)) {
    assert.equal(rows.length, 7, `${mood} rows`);
    for (const row of rows) {
      assert.equal(row.length, 13, `${mood} row ${JSON.stringify(row)}`);
      assert.match(row, /^[#.]+$/);
    }
    const grid = faceCells(mood);
    assert.equal(grid.width, 13);
    assert.equal(grid.height, 7);
  }
});

test('faceCells: unknown mood falls back to idle', () => {
  assert.deepEqual(faceCells('nope'), faceCells('idle'));
  assert.deepEqual(faceCells('toString'), faceCells('idle'));
});

test('readoutEl: role, aria-label, classes and one rect per cell', () => {
  const doc = fakeDoc();
  const svg = readoutEl(doc, 'ok', { tone: 'amber', size: 'sm' });
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  assert.equal(svg.attrs.role, 'img');
  assert.equal(svg.attrs['aria-label'], 'ok');
  assert.equal(svg.attrs.class, 'readout readout-amber readout-sm');
  assert.equal(svg.attrs.viewBox, `0 0 ${cells('ok').width * 4 - 1} ${7 * 4 - 1}`);
  assert.equal(svg.children.length, cells('ok').width * 7);
  assert.ok(svg.children.every((r) => r.name === 'rect' && r.attrs.rx === '0.5'));
  assert.ok(svg.children.some((r) => r.attrs.class === 'ro-on'));
  assert.ok(svg.children.some((r) => r.attrs.class === 'ro-off'));
});

test('readoutEl: label overrides text, default tone and size', () => {
  const svg = readoutEl(fakeDoc(), '42', { label: 'Four two' });
  assert.equal(svg.attrs['aria-label'], 'Four two');
  assert.equal(svg.attrs.class, 'readout readout-signal readout-md');
});

test('faceEl: default aria-label is Bindery and it draws 91 cells', () => {
  const svg = faceEl(fakeDoc(), 'idle');
  assert.equal(svg.attrs['aria-label'], 'Bindery');
  assert.equal(svg.attrs.role, 'img');
  assert.equal(svg.children.length, 13 * 7);
  const expected = Array.from({ length: 13 * 7 }, () => '.');
  for (const [x, y] of faceCells('idle').lit) expected[y * 13 + x] = '#';
  assert.equal(bitmap(svg), expected.join(''));
});

test('setText: updates an existing readout (reduced motion, all at once)', async () => {
  const svg = readoutEl(fakeDoc(), 'AB', { cols: 3 });
  await withReducedMotion(true, () => setText(svg, 'OK'));
  assert.equal(bitmap(svg), bitmap(readoutEl(fakeDoc(), 'OK', { cols: 3 })));
  assert.equal(svg.attrs['aria-label'], 'OK');
});

test('setText: animates column by column and resolves when done', async () => {
  const svg = readoutEl(fakeDoc(), 'AB', { cols: 2 });
  const target = bitmap(readoutEl(fakeDoc(), 'OK', { cols: 2 }));
  const pending = setText(svg, 'OK');
  assert.notEqual(bitmap(svg), target, 'first column only should be painted synchronously-ish');
  await pending;
  assert.equal(bitmap(svg), target);
});

test('setText: a missing matchMedia is fine', async () => {
  const saved = globalThis.matchMedia;
  delete globalThis.matchMedia;
  try {
    const svg = readoutEl(fakeDoc(), 'A', { cols: 1 });
    await setText(svg, 'B');
    assert.equal(bitmap(svg), bitmap(readoutEl(fakeDoc(), 'B', { cols: 1 })));
  } finally {
    if (saved !== undefined) globalThis.matchMedia = saved;
  }
});

test('animateFace: cycles moods and stops when loop is false', async () => {
  const svg = faceEl(fakeDoc(), 'idle');
  animateFace(svg, ['idle', 'sleep'], { interval: 5, loop: false });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(bitmap(svg), bitmap(faceEl(fakeDoc(), 'sleep')));
});

test('animateFace: stop() halts the cycle', async () => {
  const svg = faceEl(fakeDoc(), 'idle');
  const stop = animateFace(svg, ['idle', 'sleep'], { interval: 5 });
  stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bitmap(svg), bitmap(faceEl(fakeDoc(), 'idle')));
});

test('animateFace: reduced motion shows the first mood only', async () => {
  await withReducedMotion(true, async () => {
    const svg = faceEl(fakeDoc(), 'idle');
    const stop = animateFace(svg, ['happy', 'alert'], { interval: 5 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bitmap(svg), bitmap(faceEl(fakeDoc(), 'happy')));
    stop();
  });
});
