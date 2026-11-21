// The narrator. Any readout with [data-agent] is the agent's face: it blinks at rest, its eyes follow
// the pointer when it is idle, and it looks left and right while it searches. Mood and text come
// from the story driver; blinking and looking are layered on top without touching the text.
import { gsap } from 'gsap';
import { onPage, isTouch, prefersReducedMotion } from '../engine';
import { setLine, type Line } from './readout';

export type Mood = 'idle' | 'look' | 'alert' | 'happy' | 'sleep';

export class Agent {
  svg: SVGSVGElement;
  mood: Mood = 'idle';
  text = '';
  tone: Line['tone'] = 'signal';
  label = '';
  private blinking = false;
  private gaze: 'look-left' | 'idle' | 'look-right' = 'idle';
  private lookFlip = false;
  private lastFace = '';
  private lastText = '';
  private calls: gsap.core.Tween[] = [];
  private lookTimer: gsap.core.Tween | null = null;

  constructor(svg: SVGSVGElement, mood: Mood = 'idle') {
    this.svg = svg;
    this.mood = mood;
  }

  private face() {
    if (this.mood === 'sleep') return 'sleep';
    if (this.blinking) return 'blink';
    if (this.mood === 'look') return this.lookFlip ? 'look-right' : 'look-left';
    if (this.mood === 'idle') return this.gaze;
    return this.mood;
  }

  /** Repaint. A text change sweeps column by column; a face-only change switches at once, like a display. */
  render(force = false) {
    const face = this.face();
    const textChanged = this.text !== this.lastText;
    if (!force && face === this.lastFace && !textChanged) return;
    setLine(this.svg, { face, text: this.text, tone: this.tone, label: this.label || undefined }, { sweep: textChanged || force });
    this.lastFace = face;
    this.lastText = this.text;
  }

  set({ mood, text, tone, label }: { mood?: Mood; text?: string; tone?: Line['tone']; label?: string }) {
    if (mood) this.mood = mood;
    if (text !== undefined) this.text = text;
    if (tone) this.tone = tone;
    if (label) this.label = label;
    this.lookTimer?.kill();
    this.lookTimer = null;
    if (this.mood === 'look' && !prefersReducedMotion()) {
      this.lookTimer = gsap.delayedCall(0.55, function loop(this: Agent) {
        this.lookFlip = !this.lookFlip;
        this.render();
        this.lookTimer = gsap.delayedCall(0.55, loop, [], this);
      }, [], this);
    }
    this.render();
  }

  look(gaze: 'look-left' | 'idle' | 'look-right') {
    if (gaze === this.gaze) return;
    this.gaze = gaze;
    this.render();
  }

  /** Idle life: a blink every few seconds. Nothing at all under reduced motion. */
  startBlinking() {
    if (prefersReducedMotion()) return;
    const schedule = () => {
      this.calls.push(gsap.delayedCall(gsap.utils.random(2.4, 4.8), () => {
        if (this.mood === 'sleep') return schedule();
        this.blinking = true;
        this.render();
        this.calls.push(gsap.delayedCall(0.14, () => { this.blinking = false; this.render(); schedule(); }));
      }));
    };
    schedule();
  }

  stop() {
    this.calls.forEach((c) => c.kill());
    this.calls = [];
    this.lookTimer?.kill();
  }
}

/** Every [data-agent] on the page gets blinking; [data-gaze] ones also follow the pointer. */
export function startAgents() {
  onPage(() => {
    const agents = [...document.querySelectorAll<SVGSVGElement>('[data-agent]')].map((svg) => {
      const a = new Agent(svg, (svg.dataset.agent as Mood) || 'idle');
      (svg as SVGSVGElement & { agent?: Agent }).agent = a;
      if (svg.dataset.tone) a.tone = svg.dataset.tone as Line['tone'];
      if (svg.dataset.text) { a.text = svg.dataset.text; (a as unknown as { lastText: string }).lastText = svg.dataset.text; }
      if (!svg.closest('[data-stage]')) a.set({}); // readouts outside the story start their own mood; the story drives the stage
      a.startBlinking();
      return a;
    });
    const gazers = agents.filter((a) => a.svg.hasAttribute('data-gaze'));
    let onMove: ((e: PointerEvent) => void) | null = null;
    let lastMove = 0;
    const drift: gsap.core.Tween[] = [];
    if (gazers.length && !prefersReducedMotion()) {
      // At rest the agent looks back to centre, then glances left and right in turn, as if still searching.
      let side: 'look-left' | 'look-right' = 'look-right';
      let restingSince = 0;
      const tick = () => {
        drift.push(gsap.delayedCall(0.25, () => {
          const now = performance.now();
          if (now - lastMove < 1000) { restingSince = 0; return tick(); }
          if (!restingSince) { restingSince = now; gazers.forEach((a) => a.look('idle')); }
          const t = (now - restingSince) % 2300; // 1.4 s centred, 0.9 s to one side
          if (t >= 1400) gazers.forEach((a) => a.look(side));
          else { if (gazers[0] && (gazers[0] as unknown as { gaze: string }).gaze === side) side = side === 'look-left' ? 'look-right' : 'look-left'; gazers.forEach((a) => a.look('idle')); }
          tick();
        }));
      };
      tick();
    }
    if (gazers.length && !isTouch() && !prefersReducedMotion()) {
      onMove = (e) => {
        lastMove = performance.now();
        for (const a of gazers) {
          const r = a.svg.getBoundingClientRect();
          const dx = (e.clientX - (r.left + r.width / 2)) / Math.max(r.width, 1);
          a.look(dx < -0.55 ? 'look-left' : dx > 0.55 ? 'look-right' : 'idle');
        }
      };
      addEventListener('pointermove', onMove, { passive: true });
    }
    const stopMark = startMark();
    return () => {
      stopMark();
      drift.forEach((d) => d.kill());
      agents.forEach((a) => a.stop());
      if (onMove) removeEventListener('pointermove', onMove);
    };
  });
}

/** The header mark is the same agent, small: its eyes glance and blink at rest, and look at the name on hover. */
function startMark() {
  const brand = document.querySelector<HTMLElement>('.bar__brand');
  const eyes = brand?.querySelector<SVGGElement>('.bar__eyes');
  if (!brand || !eyes || prefersReducedMotion()) return () => {};
  const eyeRects = eyes.querySelectorAll('.eye');
  gsap.set(eyeRects, { transformOrigin: '50% 50%' });
  let hovered = false;
  const calls: gsap.core.Tween[] = [];
  const shift = (x: number) => gsap.set(eyes, { x });
  const blink = () => gsap.timeline().set(eyeRects, { scaleY: 0.15 }).set(eyeRects, { scaleY: 1 }, 0.12);
  const loop = () => {
    // Rest, glance to one side, come back; a blink now and then while resting.
    calls.push(gsap.delayedCall(gsap.utils.random(1.2, 2), () => {
      if (hovered) return loop();
      if (Math.random() < 0.3) blink();
      shift(Math.random() < 0.5 ? -3 : 3);
      calls.push(gsap.delayedCall(gsap.utils.random(1, 1.4), () => { if (!hovered) shift(0); loop(); }));
    }));
  };
  loop();
  const enter = () => { hovered = true; shift(6); blink(); };
  const leave = () => { hovered = false; shift(0); };
  brand.addEventListener('pointerenter', enter);
  brand.addEventListener('pointerleave', leave);
  brand.addEventListener('focus', enter);
  brand.addEventListener('blur', leave);
  return () => {
    calls.forEach((c) => c.kill());
    brand.removeEventListener('pointerenter', enter);
    brand.removeEventListener('pointerleave', leave);
    brand.removeEventListener('focus', enter);
    brand.removeEventListener('blur', leave);
  };
}

export const agentOf = (el: Element | null) => (el as (SVGSVGElement & { agent?: Agent }) | null)?.agent ?? null;
