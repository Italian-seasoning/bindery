// The hero board's second line: the opening of the story, read off the same dot-matrix as the stage.
// Each word steps in column by column (agent.set sweeps text changes). Paused while the hero is offscreen.
import { gsap } from 'gsap';
import { onPage, prefersReducedMotion } from '../engine';
import { agentOf } from './agent';

const LINES = [
  { text: '3 FOLDERS', tone: 'signal' },
  { text: 'WHERE?', tone: 'signal' },
  { text: '2 COPIES', tone: 'amber' },
] as const;
const HOLD = 2.8; // seconds per word: long enough to read, and the first word is still up when the page settles

export function startHero() {
  onPage(() => {
    const svg = document.querySelector<SVGSVGElement>('[data-hero-line]');
    const line = agentOf(svg);
    if (!svg || !line) return;
    // Reduced motion: the opening line stays put, no cycling.
    if (prefersReducedMotion()) { line.set({ text: LINES[0].text, tone: LINES[0].tone }); return; }

    const tl = gsap.timeline({ repeat: -1, paused: true });
    LINES.forEach((l, i) => tl.call(() => line.set({ text: l.text, tone: l.tone }), [], i * HOLD));
    tl.to({}, { duration: HOLD }); // the last word holds one beat, then the cycle starts again

    // The cycle waits for a first interaction, so the first screen settles and holds "3 FOLDERS".
    // It also starts when the hero comes back into view after the reader has scrolled away.
    let started = false;
    let left = false;
    let inView = false;
    const begin = () => { started = true; if (inView) tl.play(); };
    const events = ['scroll', 'pointermove', 'keydown', 'touchstart'] as const;
    events.forEach((e) => addEventListener(e, begin, { once: true, passive: true }));

    const io = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      if (!inView) { left = true; tl.pause(); return; }
      if (started || left) { started = true; tl.play(); }
    });
    io.observe(svg);
    return () => {
      events.forEach((e) => removeEventListener(e, begin));
      io.disconnect();
      tl.kill();
    };
  });
}
