// Turns a library folder into a preview (items, safety findings) and an install plan.
// A skill is copied into its first app and linked from the other apps; prompts are copied into each app.
import fs from 'node:fs';
import path from 'node:path';
import { readLibrary } from './library.mjs';
import { scanFolder, scanFile } from './safety.mjs';
import { installOp, planShareOps } from './changes.mjs';
import { promptRoots, promptOp } from './prompts.mjs';
import { diffSkillFolders } from './diff.mjs';

const SKILL_ROOT = { claude: 'claude-global', codex: 'agents-global' };
const PROMPT_ROOT = { claude: 'claude-commands', codex: 'codex-prompts' };
const LEVEL_ORDER = { high: 0, medium: 1, info: 2, clean: 3 };

const worst = levels => levels.reduce((a, b) => (LEVEL_ORDER[b] < LEVEL_ORDER[a] ? b : a), 'clean');

// Reads the library and runs the static safety scan on every item. Nothing is executed.
export function previewLibrary(dir) {
  const lib = readLibrary(dir);
  const whole = scanFolder(lib.dir, { maxFiles: 2000 });
  const items = lib.manifest.items.map((item) => {
    const where = path.join(lib.dir, item.path);
    let safety = { level: 'clean', findings: [] };
    try {
      if (item.type === 'skill') safety = scanFolder(where);
      else safety = { findings: scanFile(fs.readFileSync(where, 'utf8'), path.basename(where)) };
    } catch { /* missing items are listed in problems */ }
    const findings = safety.findings.filter(f => f.rule !== 'no-license');
    return { ...item, safety: { level: worst(findings.map(f => f.level)), findings } };
  });
  const license = lib.manifest.license || (whole.findings.some(f => f.rule === 'no-license') ? '' : 'See LICENSE file');
  return {
    dir: lib.dir,
    manifest: { ...lib.manifest, items: undefined },
    items,
    problems: lib.problems,
    license,
    level: worst(items.map(i => i.safety.level)),
  };
}

// picks: [{ type, name, apps }]; apps narrows what the manifest allows. Returns a share-kind plan.
export function planLibraryInstall({ dir, picks, roots, home, cwd }) {
  const lib = readLibrary(dir);
  if (lib.problems.length) throw new Error(lib.problems[0]);
  if (!Array.isArray(picks) || picks.length === 0) throw new Error('Choose at least one item to install.');
  const pRoots = promptRoots({ home, cwd });
  const ops = [];
  const warnings = new Set();
  const names = [];
  const same = [];
  // An item already installed with identical files is left alone instead of replaced.
  const unchanged = (op, type) => {
    if (op.op !== 'replace' || op.existing?.broken) return false;
    try {
      if (type === 'prompt') return fs.readFileSync(op.dest, 'utf8') === fs.readFileSync(op.src, 'utf8');
      return diffSkillFolders(fs.realpathSync(op.dest), op.src).same === true;
    } catch { return false; }
  };
  for (const pick of picks) {
    const item = lib.manifest.items.find(i => i.type === pick?.type && i.name === pick?.name);
    if (!item) throw new Error(`This library has no ${pick?.type} called ${pick?.name}.`);
    const apps = (Array.isArray(pick.apps) && pick.apps.length ? pick.apps : item.apps).filter(a => item.apps.includes(a));
    if (!apps.length) throw new Error(`${item.name} is not made for the apps you chose.`);
    const src = path.join(lib.dir, item.path);
    const [first, ...rest] = apps;
    names.push(item.name);
    if (item.type === 'skill') {
      // The first app gets the copy. Each other app links to that folder: to the copy this plan
      // creates, or to the existing folder when the first app was already up to date.
      const firstRoot = roots.find(r => r.id === SKILL_ROOT[first]);
      const firstBuilt = installOp({ src, name: item.name, targetRoot: firstRoot, mode: 'copy' });
      let linkTo = null;
      let linkPending = false;
      if (unchanged(firstBuilt.op, 'skill')) {
        same.push(item.name);
        linkTo = fs.realpathSync(firstBuilt.op.dest);
      } else {
        ops.push(firstBuilt.op);
        firstBuilt.warnings.forEach(w => warnings.add(w));
        linkTo = firstBuilt.op.dest;
        linkPending = true;
      }
      for (const app of rest) {
        const root = roots.find(r => r.id === SKILL_ROOT[app]);
        const copyCheck = installOp({ src, name: item.name, targetRoot: root, mode: 'copy' });
        if (unchanged(copyCheck.op, 'skill')) { same.push(item.name); continue; }
        const built = linkPending
          ? installOp({ src: linkTo, name: item.name, targetRoot: root, mode: 'symlink', pendingSource: true })
          : installOp({ src: linkTo, name: item.name, targetRoot: root, mode: 'symlink' });
        ops.push(built.op);
        built.warnings.forEach(w => warnings.add(w));
      }
    } else {
      for (const app of apps) {
        const root = pRoots.find(r => r.id === PROMPT_ROOT[app]);
        const built = promptOp({ src, name: item.name, targetRoot: root, mode: 'copy' });
        if (unchanged(built.op, 'prompt')) { same.push(item.name); continue; }
        ops.push(built.op);
        built.warnings.forEach(w => warnings.add(w));
      }
    }
  }
  const label = lib.manifest.name;
  const sameNames = [...new Set(same)];
  if (!ops.length) throw new Error(sameNames.length ? 'Everything you chose is already installed with the same files. Nothing to change.' : 'There is nothing to change.');
  if (sameNames.length) warnings.add(`Already installed with the same files, so left alone: ${sameNames.join(', ')}.`);
  const plan = planShareOps({
    ops,
    warnings: [...warnings],
    label,
    summary: names.length === 1 ? `Installed ${names[0]} from ${label}` : `Installed ${names.length} items from ${label}`,
  });
  plan.title = `Install from ${label}`;
  return plan;
}
