// The story driver: one variable (the active chapter) sets the stage, the narrator's face and its
// readout line. Chapters are real sections of text; the stage is sticky beside them.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { onPage, prefersReducedMotion } from '../engine';
import { agentOf, type Mood } from './agent';

const phone = () => matchMedia('(max-width: 899px)').matches;

type ChapterData = { readout: string; face: Mood; tone: 'signal' | 'amber' | 'red'; title: string };

export function startStory() {
  onPage(({ intro }) => {
    // Hero: the agent wakes up as the page arrives.
    const hero = agentOf(document.querySelector('[data-hero-agent]'));
    if (hero) {
      if (prefersReducedMotion()) hero.set({ mood: 'idle' });
      else {
        hero.set({ mood: 'sleep' });
        intro.call(() => hero.set({ mood: 'idle' }), [], 0.55);
      }
    }
    const key = document.querySelector<HTMLElement>('.hero .key');
    const smile = () => hero?.set({ mood: 'happy' });
    const rest = () => hero?.set({ mood: 'idle' });
    key?.addEventListener('pointerenter', smile);
    key?.addEventListener('pointerleave', rest);
    key?.addEventListener('focus', smile);
    key?.addEventListener('blur', rest);

    // Story: each chapter section switches the stage.
    const stage = document.querySelector<HTMLElement>('[data-stage]');
    const chapters = gsap.utils.toArray<HTMLElement>('[data-chapter]');
    if (stage && chapters.length) {
      const narrator = agentOf(stage.querySelector('[data-agent]'));
      const show = (i: number) => {
        const data = JSON.parse(chapters[i].dataset.chapter!) as ChapterData;
        stage.dataset.state = String(i + 1);
        narrator?.set({ mood: data.face, text: data.readout, tone: data.tone, label: `The agent's readout: ${data.readout.toLowerCase()}` });
        chapters.forEach((c, j) => c.classList.toggle('is-current', j === i));
      };
      // On a phone the sticky stage covers the top of the viewport. A chapter is current while it
      // sits just below the stage's bottom edge, so the readout never gets ahead of the copy.
      const stageBottom = () => stage.getBoundingClientRect().height + 24;
      chapters.forEach((ch, i) => ScrollTrigger.create({
        trigger: ch,
        start: () => (phone() ? `top ${stageBottom()}px` : 'center 80%'),
        end: () => (phone() ? `bottom ${stageBottom()}px` : 'center 10%'),
        invalidateOnRefresh: true,
        onToggle: (self) => { if (self.isActive) show(i); },
      }));
      show(0);
    }

  });
}
