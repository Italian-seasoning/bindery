// Page transitions. Adapters run leave() while the next page loads, so a transition adds
// little or no latency. Override the look with setTransition().
import { gsap } from 'gsap';
import { prefersReducedMotion } from './env';

export type Transition = {
  leave: (curtain: HTMLElement) => Promise<unknown> | gsap.core.Animation;
  enter: (curtain: HTMLElement) => Promise<unknown> | gsap.core.Animation;
};

// Default: the curtain wipes across column by column (steps), and a lit band of signal cells
// rides its leading edge, like the pixel-board readout. Same total time as the readout's own
// wipe: 0.45 s off, 0.45 s on.
const STEPS = 'steps(12)';
const DUR = 0.45;

const panelOf = (c: HTMLElement) => c.querySelector<HTMLElement>('.curtain__panel') as HTMLElement;

// The lit band is created on first use so the markup stays in the layout.
function bandOf(c: HTMLElement): HTMLElement {
  const panel = panelOf(c);
  let band = panel.querySelector<HTMLElement>('.curtain__band');
  if (!band) {
    band = document.createElement('div');
    band.className = 'curtain__band';
    band.setAttribute('aria-hidden', 'true');
    panel.appendChild(band);
  }
  return band;
}

let current: Transition = {
  // Panel slides in from the left; its right edge is the leading edge, so the band sits there.
  leave: (c) => {
    const panel = panelOf(c);
    const band = bandOf(c);
    return gsap.timeline()
      .set(c, { autoAlpha: 1 })
      .set(panel, { clipPath: 'none', xPercent: -100 })
      .set(band, { left: 'auto', right: 0, autoAlpha: 1 })
      .to(panel, { xPercent: 0, duration: DUR, ease: STEPS })
      .set(band, { autoAlpha: 0 }); // covered screen is all unlit cells
  },
  // Panel slides off to the right; its left edge is the leading edge, so the band moves there.
  enter: (c) => {
    const panel = panelOf(c);
    const band = bandOf(c);
    return gsap.timeline()
      .set(panel, { clipPath: 'none', xPercent: 0 })
      .set(band, { left: 0, right: 'auto', autoAlpha: 1 })
      .to(panel, { xPercent: 100, duration: DUR, ease: STEPS })
      .set(band, { autoAlpha: 0 })
      .set(c, { autoAlpha: 0 })
      .set(panel, { xPercent: 0 });
  },
};

const reduced: Transition = {
  leave: (c) => gsap.timeline().set(c, { autoAlpha: 1 }).fromTo(c, { opacity: 0 }, { opacity: 1, duration: 0.2 }),
  enter: (c) => gsap.to(c, { autoAlpha: 0, duration: 0.2 }),
};

export const setTransition = (t: Transition) => { current = t; };
const pick = () => (prefersReducedMotion() ? reduced : current);
const curtain = () => document.getElementById('curtain') as HTMLElement;

export const playLeave = () => Promise.resolve(pick().leave(curtain()));
export const playEnter = () => Promise.resolve(pick().enter(curtain()));
