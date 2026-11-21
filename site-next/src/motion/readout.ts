// Client side of the readout: repaint a server-rendered matrix column by column, left to right.
// Runs on the GSAP clock (a timeline of calls), so it pauses and reverts with everything else.
import { gsap } from 'gsap';
import { lineGrid } from '../lib/matrix';
import { prefersReducedMotion } from '../engine';

const running = new WeakMap<SVGSVGElement, gsap.core.Timeline>();
const COL = 0.014; // seconds per column

export type Line = { face?: string | null; text?: string; tone?: 'signal' | 'amber' | 'red'; label?: string };

/** Paint `grid` into `svg`. Only columns that change are touched; returns the sweep timeline. */
export function paint(svg: SVGSVGElement, grid: boolean[][], { sweep = true } = {}) {
  running.get(svg)?.kill();
  const rects = svg.querySelectorAll<SVGRectElement>('rect');
  const w = Number(svg.dataset.cols);
  const setCol = (x: number) => {
    for (let y = 0; y < 7; y++) rects[y * w + x]?.classList.toggle('on', !!grid[y]?.[x]);
  };
  if (!sweep || prefersReducedMotion()) {
    for (let x = 0; x < w; x++) setCol(x);
    return null;
  }
  const tl = gsap.timeline();
  let t = 0;
  for (let x = 0; x < w; x++) {
    let changed = false;
    for (let y = 0; y < 7; y++) if (rects[y * w + x]?.classList.contains('on') !== !!grid[y]?.[x]) changed = true;
    if (changed) tl.call(setCol, [x], t);
    t += COL;
  }
  running.set(svg, tl);
  return tl;
}

/** Set a readout's face and/or text, keeping the width it was rendered with. */
export function setLine(svg: SVGSVGElement, line: Line, opts?: { sweep?: boolean }) {
  const glyphs = Number(svg.dataset.glyphs || 0);
  const hasFace = svg.dataset.face === 'true';
  const grid = lineGrid({ face: hasFace ? (line.face ?? 'idle') : undefined, text: line.text ?? '', glyphs });
  if (line.tone) { svg.dataset.tone = line.tone; svg.setAttribute('class', svg.getAttribute('class')!.replace(/readout--\w+/, `readout--${line.tone}`)); }
  if (line.label) svg.setAttribute('aria-label', line.label);
  return paint(svg, grid, opts);
}
