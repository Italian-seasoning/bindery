// Plans "use one copy everywhere" for a skill that is installed in several places.
// The chosen copy stays where it is. Every other writable copy is replaced by a link to it,
// and the replaced copies move to backups through changes.mjs, so undo puts them back.
import path from 'node:path';
import { installOp, planShareOps } from './changes.mjs';

// scan: result of scanAll(). name: skill group name. keepId: id of the copy to keep.
// Returns { plan } or { plan: null, reason } when every copy already shares one folder.
export function planResolve({ scan, name, keepId }) {
  const wanted = String(name ?? '').toLowerCase();
  const group = scan.groups.find(g => g.name.toLowerCase() === wanted);
  if (!group) throw new Error(`${name} is not installed.`);

  const skillsById = new Map(scan.skills.map(s => [s.id, s]));
  const entries = group.entries.map(id => skillsById.get(id)).filter(Boolean);
  const keep = entries.find(e => e.id === keepId && !e.broken && e.realPath);
  if (!keep) throw new Error('Choose a working copy to keep.');

  const ops = [];
  const warnings = [];
  for (const entry of entries) {
    if (entry.id === keep.id) continue;
    if (entry.broken) continue;
    if (entry.realPath === keep.realPath) continue;
    const root = scan.roots.find(r => r.id === entry.rootId);
    const label = root?.label ?? path.dirname(entry.path);
    if (entry.scope === 'plugin' || entry.readOnly) {
      warnings.push(`${label} gets ${name} from a plugin, so it keeps its own copy.`);
      continue;
    }
    if (!root || root.writable === false) {
      warnings.push(`${label} is read-only, so it keeps its own copy of ${name}.`);
      continue;
    }
    const built = installOp({ src: keep.realPath, name: entry.folder, targetRoot: root, mode: 'symlink' });
    ops.push(built.op);
    warnings.push(...built.warnings);
  }

  if (!ops.length) return { plan: null, reason: 'Every copy already uses the same folder.' };

  const keepRoot = scan.roots.find(r => r.id === keep.rootId);
  const plan = planShareOps({
    ops,
    warnings: [...warnings, 'The other copies move to backups. Undo puts them back.'],
    label: keepRoot?.label ?? path.dirname(keep.path),
    summary: `Kept one copy of ${group.name}`,
  });
  plan.title = `Use one copy of ${group.name} everywhere`;
  plan.resolve = { name: group.name, keepId };
  return { plan };
}
