// The homepage's signature hero. A pinned, scrubbed stage in eight beats, one per skill. In beat i chip i
// blinks out of its folder and row i pops into the library card and becomes the current row. Beat 1 is
// the merge: the amber pr-review copy squashes into the first row and the row reads "merged". Every frame
// is a pure function of progress, so scrolling back reverses cleanly. Positions are measured once per
// refresh (invalidateOnRefresh). Reduced motion gets the static end state from CSS (html:not(.motion)).
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { onPage, prefersReducedMotion } from '../engine';
import { agentOf } from './agent';
import { setLine } from './readout';

// The beats, in the order the rows pop in. Beat i is skill SKILL_IDS[i] and row i.
const SKILL_IDS = ['pr-claude', 'release-notes', 'polish', 'tidy-commits', 'dev-setup', 'figma-notes', 'changelog', 'test-plan'];
const ROT = [-4, 3, -2, -3, 2, -5, 4, -1]; // each chip's resting tilt, in degrees
const MERGE_ID = 'pr-codex'; // the amber copy: it squashes into row 0 in beat 1
const MERGE_ROT = 5;
const BEATS = 8;
const BLINK = 0.3; // share of a beat in which a chip blinks out of its folder, in steps(3)
const POP_FROM = 0.5; // share of a beat where its row starts to pop into the card
const MERGE_FROM = 0.3; // share of beat 1 where the amber copy leaves its folder
const MERGE_TO = 0.5; // share of beat 1 where it lands in row 0
const ANTICIPATE = 0.16; // share of a flight spent nudging away from the target first
const OVERSHOOT_AT = 0.9; // share of a flight after which the copy overshoots and settles
const NUDGE_PX = 6;
const OVERSHOOT_PX = 3;
const ARC_RATIO = 0.18; // the flight bows up by this share of its length (clamped below)
const SQUASH = 0.12; // the amber copy squashes to scaleX 1.12, scaleY 0.88 as it lands
const SQUASH_FROM = 0.75; // share of its flight where the squash starts
const CURRENT_SCALE = 1.03;
const FACE_AT = 7 / 8; // the agent's face turns happy with the last beat
const DONE_AT = 0.999; // all rows settle into the uniform end state
const GROW_AT = 0.94; // the card grows toward the folder column after the last beat
const KEEP_STEPS = 4; // folders collapse in four steps as their chips leave
const LIT_BASE = 0.45; // the field's lit wave, at its calm opacity
const LIT_PEAK = 0.25; // the glow adds this much around the card at the end
const PITCH = 22; // dot pitch in px; the lit wave advances one column at a time

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const stepped = (t: number, n: number) => Math.floor(clamp01(t) * n) / n;
const smooth = (t: number) => clamp01(t) * clamp01(t) * (3 - 2 * clamp01(t));
const easeInOut2 = (u: number) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
const easeOut = (u: number) => 1 - Math.pow(1 - clamp01(u), 3);
// A row's pop: 0.85 to 1.06 with a short overshoot, then settling to 1.
const popScale = (v: number) => (v < 0.6 ? 0.85 + 0.21 * easeOut(v / 0.6) : 1.06 - 0.06 * easeInOut2((v - 0.6) / 0.4));
const phone = () => matchMedia('(max-width: 899px)').matches;
// Pin distance: about 200vh of scroll on desktop, 140vh on a phone.
const scrollLength = () => (phone() ? 1.4 : 2.0) * innerHeight;

type Chip = { id: string; el: HTMLElement; row: number; rot: number; merge: boolean; from: number; to: number; dx: number; dy: number; len: number; ux: number; uy: number; arc: number };

export function startBind() {
  onPage(() => {
    const root = document.querySelector<HTMLElement>('[data-bind]');
    if (!root || prefersReducedMotion()) return; // the end state is static (CSS)

    const stage = root.querySelector<HTMLElement>('[data-bind-stage]');
    const lit = root.querySelector<HTMLElement>('[data-bind-lit]');
    const lib = root.querySelector<HTMLElement>('[data-bind-lib]');
    const unit = root.querySelector<HTMLElement>('[data-bind-unit]');
    const count = root.querySelector<SVGSVGElement>('[data-bind-count]');
    const face = root.querySelector<SVGSVGElement>('[data-bind-face]');
    const rows = [...root.querySelectorAll<HTMLElement>('[data-bind-row]')];
    const names = rows.map((r) => r.querySelector<HTMLElement>('[data-bind-slot]'));
    if (!stage || !lit || !lib || !unit || !count || !face || rows.length !== BEATS) return;

    const chips: Chip[] = [];
    const add = (id: string, row: number, rot: number, merge: boolean, from: number, to: number) => {
      const el = root.querySelector<HTMLElement>(`[data-bind-chip="${id}"]`);
      if (el) chips.push({ id, el, row, rot, merge, from, to, dx: 0, dy: 0, len: 0, ux: 0, uy: 0, arc: 0 });
    };
    SKILL_IDS.forEach((id, i) => add(id, i, ROT[i], false, i / BEATS, (i + BLINK) / BEATS));
    add(MERGE_ID, 0, MERGE_ROT, true, (1 + MERGE_FROM) / BEATS, (1 + MERGE_TO) / BEATS);

    // Folders: each collapses in steps once its chips are gone; its label goes with it.
    const folders = [...root.querySelectorAll<HTMLElement>('[data-bind-cluster]')].flatMap((cl) => {
      const label = cl.querySelector<HTMLElement>('[data-bind-path]');
      const el = cl.querySelector<HTMLElement>('[data-bind-folder]');
      if (!label || !el) return [];
      return [{ label, el, own: chips.filter((c) => el.contains(c.el)) }];
    });

    let cols = 1;
    let growTo = 1.1;
    // Measure from the rest pose: chips back in their folders, untilted; rows and card unscaled.
    const measure = () => {
      cols = Math.max(1, Math.ceil(stage.clientWidth / PITCH));
      growTo = phone() ? 1.04 : 1.1;
      gsap.set(lib, { scale: 1 });
      gsap.set(rows, { scale: 1 });
      chips.forEach((c) => gsap.set(c.el, { x: 0, y: 0, rotation: c.rot, scaleX: 1, scaleY: 1, opacity: 1 }));
      const s = stage.getBoundingClientRect();
      const u = unit.getBoundingClientRect();
      lit.style.setProperty('--gx', `${u.left - s.left + u.width / 2}px`);
      lit.style.setProperty('--gy', `${u.top - s.top + u.height / 2}px`);
      lit.style.setProperty('--grx', `${u.width * 0.6 + 40}px`);
      lit.style.setProperty('--gry', `${u.height * 0.6 + 40}px`);
      // The amber copy flies to the centre of row 0's name.
      chips.filter((c) => c.merge).forEach((c) => {
        const target = names[c.row]?.getBoundingClientRect();
        if (!target) return;
        const at = c.el.getBoundingClientRect();
        c.dx = target.left + target.width / 2 - (at.left + at.width / 2);
        c.dy = target.top + target.height / 2 - (at.top + at.height / 2);
        c.len = Math.hypot(c.dx, c.dy);
        c.ux = c.len ? c.dx / c.len : 0;
        c.uy = c.len ? c.dy / c.len : 0;
        c.arc = Math.min(48, Math.max(12, ARC_RATIO * c.len));
      });
    };

    let shownCount = -1;
    let shownFace = '';
    let litCols = -1;
    // One frame at progress p. Pure: the same p always paints the same frame.
    const paint = (p: number) => {
      for (const f of folders) {
        const gone = f.own.filter((c) => p >= c.to).length / Math.max(1, f.own.length);
        const keep = 1 - stepped(gone, KEEP_STEPS);
        gsap.set(f.el, { '--keep': keep });
        gsap.set(f.label, { opacity: keep });
      }

      for (const c of chips) {
        const t = clamp01((p - c.from) / (c.to - c.from));
        if (!c.merge) {
          // Blink out of the folder in three steps.
          gsap.set(c.el, { x: 0, y: 0, rotation: c.rot, scaleX: 1, scaleY: 1, opacity: 1 - stepped(t, 3) });
          continue;
        }
        // The amber copy: anticipation, a slow-in slow-out arc, an overshoot, then the squash on landing.
        let along = 0;
        let f = 0;
        let over = 0;
        if (t < ANTICIPATE) along = -NUDGE_PX * Math.sin((Math.PI * t) / ANTICIPATE);
        else if (t < OVERSHOOT_AT) f = easeInOut2((t - ANTICIPATE) / (OVERSHOOT_AT - ANTICIPATE));
        else {
          f = 1;
          over = OVERSHOOT_PX * Math.sin((Math.PI * (t - OVERSHOOT_AT)) / (1 - OVERSHOOT_AT));
        }
        const dist = c.len * f + along + over;
        const arc = -c.arc * Math.sin(Math.PI * f);
        const sq = smooth((t - SQUASH_FROM) / (1 - SQUASH_FROM));
        gsap.set(c.el, {
          x: c.ux * dist,
          y: c.uy * dist + arc,
          rotation: c.rot * (1 - f),
          scaleX: 1 + SQUASH * sq,
          scaleY: 1 - SQUASH * sq,
          opacity: t >= 1 ? 0 : 1, // landed: the row's name takes over
        });
      }

      // Rows: row i pops in during beat i. Row 0 pops as the merged copy, 1.08 back to 1.
      const popped = Math.max(0, Math.min(BEATS, Math.floor(p * BEATS - POP_FROM) + 1));
      const cur = popped - 1;
      const done = p >= DONE_AT;
      rows.forEach((row, i) => {
        const pv = clamp01((p - (i + POP_FROM) / BEATS) / ((1 - POP_FROM) / BEATS));
        const isCur = i === cur && !done;
        let scale = i === 0 ? 1.08 - 0.08 * easeOut(pv) : popScale(pv);
        if (isCur) scale *= CURRENT_SCALE;
        gsap.set(row, { scale, opacity: i === 0 ? clamp01(pv / 0.2) : clamp01(pv / 0.4) });
        row.classList.toggle('is-current', isCur);
        if (i === 0) row.classList.toggle('is-merged', p >= (1 + MERGE_TO) / BEATS);
      });
      if (popped !== shownCount) {
        shownCount = popped;
        setLine(count, { text: `${popped} ITEMS` });
      }
      count.classList.toggle('is-peak', done);
      lib.classList.toggle('is-done', done);

      const mood = p >= FACE_AT ? 'happy' : 'look';
      if (mood !== shownFace) {
        shownFace = mood;
        const agent = agentOf(face);
        if (agent) agent.set({ mood });
        else setLine(face, { face: mood === 'happy' ? 'happy' : 'look-left' });
      }

      // The lit wave: whole columns only, so the edge steps like a dot-matrix display. Its glow rises at the end.
      const litNow = Math.round(clamp01(p) * cols);
      if (litNow !== litCols) {
        litCols = litNow;
        lit.style.clipPath = `inset(0 ${Math.max(0, stage.clientWidth - litNow * PITCH)}px 0 0)`;
      }
      lit.style.opacity = String(LIT_BASE + LIT_PEAK * stepped((p - FACE_AT) / (1 - FACE_AT), 3));

      // The card grows toward the folder column once the last row is in.
      gsap.set(lib, { scale: 1 + (growTo - 1) * smooth((p - GROW_AT) / (1 - GROW_AT)) });
    };

    const state = { p: 0 };
    measure();
    paint(0);
    gsap.to(state, {
      p: 1,
      ease: 'none',
      onUpdate: () => paint(state.p),
      scrollTrigger: {
        trigger: stage,
        start: 'top top',
        end: () => `+=${scrollLength()}`,
        pin: true,
        scrub: 0.6,
        invalidateOnRefresh: true,
        // Desktop only: the scroll settles on beat boundaries. Phones keep it free.
        ...(phone() ? {} : { snap: { snapTo: 1 / BEATS, duration: { min: 0.15, max: 0.35 }, delay: 0.05, ease: 'power2.inOut' } }),
        onRefreshInit: measure,
        onRefresh: () => paint(state.p),
      },
    });
    // Web fonts change chip and name widths, so measure again once they are in.
    document.fonts?.ready.then(() => ScrollTrigger.refresh());
  });
}
