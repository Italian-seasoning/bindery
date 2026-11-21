// Global motion for the site. Every concept move is a stepped, left-to-right switch, like the
// columns of a dot-matrix display updating. The page transition is the engine's default curtain
// (src/engine/transition.ts): a lit band of cells rides the leading edge of a stepped wipe.
import { startAgents } from './agent';
import { startHero } from './hero';
import { startStory } from './story';
import { startBind } from './bind';
import { startHomeSections } from './home';

export function setupMotion() {
  startAgents();
  startHero();
  startStory();
  startBind();
  startHomeSections();
}
