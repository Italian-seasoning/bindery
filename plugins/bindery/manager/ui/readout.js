// Readout: a small dot-matrix display (5x7 glyphs, 4-unit pitch) drawn as SVG.
// Vanilla, no build step. Imports cleanly in Node: the DOM is touched only inside functions.
// Spec: docs/THEME.md, "Readout".

const NS = 'http://www.w3.org/2000/svg';
const PITCH = 4; // distance between cell origins, user units
const CELL = 3; // lit cell size, user units
const MAX_GLYPHS = 12;

// 5x7 glyphs. '#' is lit, '.' is unlit. Classic LCD style.
export const GLYPHS = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  'C': ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  'D': ['###..', '#..#.', '#...#', '#...#', '#...#', '#..#.', '###..'],
  'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  'G': ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'I': ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  'J': ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  'K': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  'M': ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  'N': ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  'Q': ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  'S': ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  'U': ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'V': ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  'W': ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  'X': ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  'Y': ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  'Z': ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
};

// Agent face on a 13 x 7 grid. Eyes sit in columns 2-4 and 8-10 (or the 2-wide idle pair).
export const FACES = {
  idle: [
    '.............',
    '.............',
    '...##...##...',
    '...##...##...',
    '...##...##...',
    '.............',
    '.............',
  ],
  sleep: [
    '.............',
    '.............',
    '.............',
    '.............',
    '...##...##...',
    '.............',
    '.............',
  ],
  'look-left': [
    '.............',
    '.............',
    '..##....##...',
    '..##....##...',
    '..##....##...',
    '.............',
    '.............',
  ],
  'look-right': [
    '.............',
    '.............',
    '....##...##..',
    '....##...##..',
    '....##...##..',
    '.............',
    '.............',
  ],
  happy: [
    '.............',
    '.............',
    '.............',
    '..###...###..',
    '..#.#...#.#..',
    '.............',
    '.............',
  ],
  alert: [
    '.............',
    '...#.....#...',
    '...#.....#...',
    '...#.....#...',
    '.............',
    '...#.....#...',
    '.............',
  ],
  blink: [
    '.............',
    '.............',
    '.............',
    '.............',
    '...##...##...',
    '.............',
    '.............',
  ],
};

// Turn a list of glyph rows into { width, height, lit }. Used for faces and text alike.
function gridFromRows(rows) {
  const lit = [];
  rows.forEach((row, y) => [...row].forEach((ch, x) => ch === '#' && lit.push([x, y])));
  return { width: rows[0].length, height: rows.length, lit };
}

// Text to a grid. Uppercases, unknown characters become space, max 12 glyphs.
// `cols` fixes the glyph count: longer text is cut, shorter text is padded with spaces on the right.
export function cells(text, { cols } = {}) {
  let chars = [...String(text ?? '').toUpperCase()].slice(0, MAX_GLYPHS);
  if (cols !== undefined) chars = chars.slice(0, cols);
  const count = Math.max(cols ?? chars.length, 1); // an empty readout still gets one blank glyph
  while (chars.length < count) chars.push(' ');

  const lit = [];
  chars.forEach((ch, g) => {
    const glyph = Object.hasOwn(GLYPHS, ch) ? GLYPHS[ch] : GLYPHS[' '];
    glyph.forEach((row, y) => [...row].forEach((bit, x) => {
      if (bit === '#') lit.push([g * 6 + x, y]); // 5 cells + 1 gap
    }));
  });
  return { width: count * 6 - 1, height: 7, lit };
}

// Agent face grid. Unknown moods fall back to idle.
export function faceCells(mood) {
  const rows = Object.hasOwn(FACES, mood) ? FACES[mood] : FACES.idle;
  return gridFromRows(rows);
}

// Per-element state, kept out of the DOM: grid size, glyph count and the cell rects.
const STATE = new WeakMap();

// Build the SVG tree for a grid. Every cell is drawn; lit or unlit is a class.
function build(doc, grid, { tone, size, label, cols }) {
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('class', `readout readout-${tone} readout-${size}`);
  svg.setAttribute('viewBox', `0 0 ${grid.width * PITCH - 1} ${grid.height * PITCH - 1}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);

  const on = toBools(grid);
  const rects = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const rect = doc.createElementNS(NS, 'rect');
      rect.setAttribute('x', x * PITCH);
      rect.setAttribute('y', y * PITCH);
      rect.setAttribute('width', CELL);
      rect.setAttribute('height', CELL);
      rect.setAttribute('rx', 0.5);
      rect.setAttribute('class', on[y][x] ? 'ro-on' : 'ro-off');
      svg.appendChild(rect);
      rects.push(rect);
    }
  }
  STATE.set(svg, { width: grid.width, height: grid.height, rects, cols, run: 0 });
  return svg;
}

// Grid to a rows-of-booleans table, indexed [y][x].
function toBools(grid) {
  const table = Array.from({ length: grid.height }, () => Array(grid.width).fill(false));
  grid.lit.forEach(([x, y]) => { table[y][x] = true; });
  return table;
}

// Set one column of an existing readout to the given booleans.
function paintColumn(state, table, x) {
  for (let y = 0; y < state.height; y++) {
    state.rects[y * state.width + x].setAttribute('class', table[y][x] ? 'ro-on' : 'ro-off');
  }
}

// Paint a whole grid at once.
function paintAll(svg, grid) {
  const state = STATE.get(svg);
  if (!state) return;
  const table = toBools(grid);
  for (let x = 0; x < state.width; x++) paintColumn(state, table, x);
}

function reducedMotion() {
  const mm = globalThis.matchMedia;
  return typeof mm === 'function' && !!mm('(prefers-reduced-motion: reduce)').matches;
}

export function readoutEl(doc, text, { cols, tone = 'signal', size = 'md', label } = {}) {
  const grid = cells(text, { cols });
  const glyphs = Math.round((grid.width + 1) / 6);
  return build(doc, grid, { tone, size, label: label ?? String(text), cols: glyphs });
}

export function faceEl(doc, mood, { tone = 'signal', size = 'md', label = 'Bindery' } = {}) {
  return build(doc, faceCells(mood), { tone, size, label, cols: null });
}

// Change a readout's text in place, one column at a time, left to right, 12ms apart.
// The glyph count stays as it was when the readout was made.
export function setText(svg, text) {
  const state = STATE.get(svg);
  if (!state || state.cols == null) return Promise.resolve();
  const table = toBools(cells(text, { cols: state.cols }));
  const run = ++state.run; // a newer setText supersedes this one
  svg.setAttribute('aria-label', String(text));

  if (reducedMotion()) {
    for (let x = 0; x < state.width; x++) paintColumn(state, table, x);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    for (let x = 0; x < state.width; x++) {
      setTimeout(() => {
        if (state.run === run) paintColumn(state, table, x);
        if (x === state.width - 1) resolve();
      }, x * 12);
    }
  });
}

// Cycle a face through moods. Returns stop(). Reduced motion shows the first mood only.
export function animateFace(svg, moods, { interval = 300, loop = true } = {}) {
  if (!moods || moods.length === 0) return () => {};
  paintAll(svg, faceCells(moods[0]));
  if (reducedMotion()) return () => {};

  let i = 0;
  const timer = setInterval(() => {
    i += 1;
    if (i >= moods.length) {
      if (!loop) { clearInterval(timer); return; }
      i = 0;
    }
    paintAll(svg, faceCells(moods[i]));
  }, interval);
  return () => clearInterval(timer);
}
