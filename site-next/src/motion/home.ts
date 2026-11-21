// Home sections: the LED ticker, the verbs list and the typed terminal. Each component renders its
// full content and a static state in its markup; this file only adds the motion and scroll state.
// Everything here runs on the GSAP clock, so it pauses and reverts with the page.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { onPage, onScroll, prefersReducedMotion } from '../engine';

// ---------- Pictograms (Verbs.astro paints the rest frame at render; the client loops the frames) ----------

export const PICT_W = 15;
export const PICT_H = 9;
/** Cell values: 0 off, 1 signal (lit), 2 amber, 3 ghost (a faint track or outline). */
export type Frames = number[][][];
type Pict = { frames: Frames; dt: number; rest: number };

const CLS = ['', 'on', 'amber', 'ghost'];

const blank = (): number[][] => Array.from({ length: PICT_H }, () => Array(PICT_W).fill(0));
const put = (g: number[][], x: number, y: number, w: number, h: number, v: number) => {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    if (yy >= 0 && yy < PICT_H && xx >= 0 && xx < PICT_W) g[yy][xx] = v;
  }
};
const hold = (frames: Frames, n: number) => { const last = frames[frames.length - 1]; for (let i = 0; i < n; i++) frames.push(last); };

// Find: a scanning column lights three stacked bars, left to right.
const find = (): Pict => {
  const frames: Frames = [];
  const bars = [1, 4, 7];
  for (let f = 0; f < PICT_W + 4; f++) {
    const g = blank();
    bars.forEach((y) => put(g, 2, y, 11, 2, 3));
    for (let x = 2; x <= Math.min(f, 12); x++) bars.forEach((y) => put(g, x, y, 1, 2, 1));
    if (f < PICT_W) put(g, f, 0, 1, PICT_H, 1);
    frames.push(g);
  }
  return { frames, dt: 0.09, rest: frames.length - 1 };
};

// Resolve: an amber block and a signal block meet, overlap, and merge into one signal block.
const resolve = (): Pict => {
  const frames: Frames = [];
  for (let f = 0; f <= 4; f++) {
    const g = blank();
    put(g, 10 - f, 2, 4, 5, 1);
    put(g, f, 2, 4, 5, 2);
    frames.push(g);
  }
  for (let f = 0; f < 6; f++) {
    const g = blank();
    put(g, 4, 2, 6, 5, 1);
    frames.push(g);
  }
  return { frames, dt: 0.13, rest: 0 };
};

// Bind: loose dots run in along the top row and drop into a column.
const bind = (): Pict => {
  const STACK = 7;
  const DELAY = 4;
  const starts = [1, 13, 3, 11, 5];
  const slots = [8, 7, 6, 5, 4]; // landing rows, bottom first
  const paths = starts.map((x0, i) => {
    const path: [number, number][] = [[x0, 0]];
    let x = x0;
    let y = 0;
    while (x !== STACK) { x += Math.sign(STACK - x); path.push([x, y]); }
    while (y < slots[i]) { y++; path.push([x, y]); }
    return path;
  });
  const total = Math.max(...paths.map((p, i) => i * DELAY + p.length)) + 8;
  const frames: Frames = [];
  for (let f = 0; f < total; f++) {
    const g = blank();
    slots.forEach((y) => { g[y][STACK] = 3; });
    paths.forEach((p, i) => {
      const [x, y] = p[Math.min(Math.max(f - i * DELAY, 0), p.length - 1)];
      g[y][x] = 1;
    });
    frames.push(g);
  }
  return { frames, dt: 0.12, rest: frames.length - 1 };
};

// Share: a block crosses a gap between two ghost pillars.
const share = (): Pict => {
  const frames: Frames = [];
  for (let x = 0; x <= 12; x++) {
    const g = blank();
    put(g, 5, 1, 1, 7, 3);
    put(g, 9, 1, 1, 7, 3);
    put(g, x, 3, 3, 3, 1);
    frames.push(g);
  }
  hold(frames, 3);
  return { frames, dt: 0.1, rest: 0 };
};

// Undo: a block steps back to the left, leaving ghost marks of each step it took back.
const undo = (): Pict => {
  const xs = [12, 9, 6, 3, 0];
  const frames: Frames = xs.map((x, k) => {
    const g = blank();
    xs.slice(0, k).forEach((p) => put(g, p, 3, 3, 3, 3));
    put(g, x, 3, 3, 3, 1);
    return g;
  });
  hold(frames, 4);
  return { frames, dt: 0.22, rest: frames.length - 1 };
};

export const PICTS: Record<string, Pict> = { find: find(), resolve: resolve(), bind: bind(), share: share(), undo: undo() };

/** The resting frame of a pictogram, as cells, for server rendering. */
export function restCells(id: string): { x: number; y: number; v: number }[] {
  const p = PICTS[id];
  const g = p.frames[p.rest];
  const out: { x: number; y: number; v: number }[] = [];
  for (let y = 0; y < PICT_H; y++) for (let x = 0; x < PICT_W; x++) out.push({ x, y, v: g[y][x] });
  return out;
}

const paint = (rects: SVGRectElement[], g: number[][]) => {
  for (let i = 0; i < rects.length; i++) {
    const c = CLS[g[Math.floor(i / PICT_W)][i % PICT_W]];
    if (rects[i].getAttribute('class') !== (c || null)) {
      if (c) rects[i].setAttribute('class', c); else rects[i].removeAttribute('class');
    }
  }
};

// ---------- Ticker ----------

const BASE_SPEED = 3; // columns per second at rest: about one character every 2 s, readable
const KICK = 0.5; // scroll velocity (px per frame) to columns per second
const KICK_MAX = 14;

function initTicker(root: HTMLElement): () => void {
  if (prefersReducedMotion()) return () => {};
  const rows = gsap.utils.toArray<HTMLElement>('[data-ticker-row]', root).map((el, i) => {
    const k = { v: 0 };
    return {
      track: el.querySelector<HTMLElement>('[data-ticker-track]')!,
      copy: Number(el.dataset.copy),
      sign: i % 2 ? -1 : 1, // row A runs left, row B runs right
      offset: 0,
      last: NaN,
      k,
      ease: gsap.quickTo(k, 'v', { duration: 0.8, ease: 'power3.out' }),
    };
  });

  // Scroll pushes both rows along their own direction; with no scroll for 140 ms the push is zero,
  // and the quickTo eases the speed back to the base pace.
  let velocity = 0;
  let seen = 0;
  const unsub = onScroll((s) => { velocity = s.velocity; seen = performance.now(); });
  let inView = true;
  const io = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; });
  io.observe(root);

  const tick = (_time: number, ms: number) => {
    if (!inView) return;
    const dt = Math.min(ms, 80) / 1000;
    const live = performance.now() - seen < 140 ? velocity : 0;
    rows.forEach((r) => {
      r.ease(gsap.utils.clamp(-KICK_MAX, KICK_MAX, r.sign * live * KICK));
      r.offset += (r.sign * BASE_SPEED + r.k.v) * dt;
      const m = ((r.offset % r.copy) + r.copy) % r.copy;
      const x = -Math.floor(m); // whole columns only: the sign steps, it does not glide
      if (x !== r.last) {
        r.last = x;
        r.track.style.setProperty('--x', String(x));
      }
    });
  };
  gsap.ticker.add(tick);

  return () => {
    gsap.ticker.remove(tick);
    unsub();
    io.disconnect();
    rows.forEach((r) => gsap.killTweensOf(r.k));
  };
}

// ---------- Verbs ----------

const TYPE = 0.5; // seconds for a command to type itself, stepped by character

function initVerbs(root: HTMLElement): () => void {
  const reduced = prefersReducedMotion();
  const cleanups: (() => void)[] = [];

  gsap.utils.toArray<HTMLElement>('[data-verb]', root).forEach((row) => {
    const svg = row.querySelector<SVGSVGElement>('[data-pict]');
    const pict = PICTS[svg?.dataset.pict ?? ''];
    if (!pict || !svg) return;
    const rects = Array.from(svg.querySelectorAll<SVGRectElement>('rect'));
    const rest = pict.frames[pict.rest];

    // One stepped frame per call, so the loop moves in discrete jumps like the readout.
    const tl = gsap.timeline({ paused: true, repeat: -1 });
    if (!reduced) {
      pict.frames.forEach((g, f) => tl.call(() => paint(rects, g), [], f * pict.dt));
      tl.to({}, { duration: pict.dt }); // hold the timeline to whole frames before it repeats
    }

    // The command types itself each time the row becomes current, and shows in full otherwise.
    const cmd = row.querySelector<HTMLElement>('[data-typed]');
    const len = Number(cmd?.dataset.len ?? 0);
    const o = { n: len };
    const setN = () => cmd?.style.setProperty('--n', String(Math.round(o.n)));
    const typing = gsap.fromTo(o, { n: 0 }, {
      n: len, duration: TYPE, ease: 'none', paused: true, snap: { n: 1 }, onUpdate: setN,
      onComplete: () => cmd?.classList.remove('is-typing'), immediateRender: false,
    });
    o.n = len; // rest state: the full command, dimmed
    setN();
    const type = (on: boolean) => {
      if (!cmd) return;
      if (reduced) { o.n = len; setN(); return; }
      if (on) { typing.restart(); cmd.classList.add('is-typing'); }
      else { typing.pause(); cmd.classList.remove('is-typing'); o.n = len; setN(); }
    };

    let current = false;
    let hovered = false;
    const apply = () => {
      const lit = current || hovered;
      row.classList.toggle('is-lit', lit);
      svg.classList.toggle('is-lit', lit);
      if (!reduced && lit) tl.play();
      else { tl.pause(); paint(rects, rest); } // unlit: still, on the rest frame
    };

    // The current row is the one that contains the viewport's centre line.
    ScrollTrigger.create({
      trigger: row,
      start: 'top center',
      end: 'bottom center',
      onToggle: (s) => { current = s.isActive; row.classList.toggle('is-current', current); apply(); type(current); },
    });

    const enter = (e: PointerEvent) => { if (e.pointerType === 'mouse') { hovered = true; apply(); } };
    const leave = () => { hovered = false; apply(); };
    row.addEventListener('pointerenter', enter);
    row.addEventListener('pointerleave', leave);
    apply();
    cleanups.push(() => {
      row.removeEventListener('pointerenter', enter);
      row.removeEventListener('pointerleave', leave);
      tl.kill();
      typing.kill();
    });
  });

  // The signal line down the left edge: scrubbed with the section, stepped in 14 jumps.
  const signal = root.querySelector('[data-verbs-signal]');
  if (signal) {
    if (reduced) gsap.set(signal, { scaleY: 1 });
    else gsap.fromTo(signal, { scaleY: 0 }, {
      scaleY: 1,
      ease: 'steps(14)',
      scrollTrigger: { trigger: root, start: 'top 70%', end: 'bottom 60%', scrub: true },
    });
  }

  return () => cleanups.forEach((c) => c());
}

// ---------- Entry ----------

export function startHomeSections() {
  onPage(() => {
    const cleanups: (() => void)[] = [];
    const ticker = document.querySelector<HTMLElement>('[data-ticker]');
    if (ticker) cleanups.push(initTicker(ticker));
    const verbs = document.querySelector<HTMLElement>('[data-verbs]');
    if (verbs) cleanups.push(initVerbs(verbs));
    return () => cleanups.forEach((c) => c());
  });
}
