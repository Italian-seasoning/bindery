// Repairs broken skill links. A broken link can be pointed at a working copy of the same
// skill, or removed. Both are built on changes.mjs, so every repair can be undone like any other change.
import { installOp, removeOp, planShareOps } from './changes.mjs';

// Working, non-plugin copies of the same skill that a broken link could point at.
function candidatesFor(scan, entry) {
  const skillsById = new Map(scan.skills.map(s => [s.id, s]));
  const seenReal = new Set();
  const candidates = [];
  for (const group of scan.groups) {
    if (!group.entries.includes(entry.id)) continue;
    for (const id of group.entries) {
      const other = skillsById.get(id);
      if (!other || other.broken || !other.realPath || seenReal.has(other.realPath)) continue;
      seenReal.add(other.realPath);
      candidates.push({ skillId: other.id, realPath: other.realPath, rootId: other.rootId });
    }
  }
  return candidates;
}

// Every broken link in the scan, with the working copies it could be pointed at.
export function findBroken(scan) {
  return scan.skills
    .filter(entry => entry.broken === true)
    .map(entry => ({
      skillId: entry.id,
      name: entry.name,
      path: entry.path,
      linkTarget: entry.linkTarget,
      rootId: entry.rootId,
      candidates: candidatesFor(scan, entry),
    }));
}

// action: 'remove' | 'relink'. For 'relink', targetId is the skillId of the working copy.
export function planRepair({ scan, skillId, action, targetId } = {}) {
  const entry = scan.skills.find(s => s.id === skillId);
  if (!entry || entry.broken !== true) throw new Error('That link is not broken.');

  const root = scan.roots.find(r => r.id === entry.rootId);
  if (!root) throw new Error('That link is not in a known skill location.');
  if (root.scope === 'plugin' || entry.scope === 'plugin' || root.writable === false) {
    throw new Error('That link belongs to a plugin, so it cannot be repaired here.');
  }

  if (action === 'remove') {
    const { op } = removeOp({ skillPath: entry.path, root });
    return buildPlan({ ops: [op], root, skillId, action, summary: `Removed the broken link for ${entry.name}`, title: `Remove the broken link for ${entry.name}` });
  }

  if (action === 'relink') {
    const target = candidatesFor(scan, entry).find(c => c.skillId === targetId);
    if (!target) throw new Error('Choose a working copy to link to.');
    // installOp treats a broken link at the destination as an existing entry, so this becomes a
    // single replace: the broken link is moved to a backup and the new link takes its place.
    const { op } = installOp({ src: target.realPath, name: entry.folder, targetRoot: root, mode: 'symlink' });
    return buildPlan({ ops: [op], root, skillId, action, summary: `Pointed ${entry.name} at a working copy`, title: `Point ${entry.name} at a working copy` });
  }

  throw new Error('Choose remove or relink.');
}

function buildPlan({ ops, root, skillId, action, summary, title }) {
  const plan = planShareOps({ ops, warnings: [], label: root.label, summary });
  plan.title = title;
  plan.repair = { skillId, action };
  return plan;
}
