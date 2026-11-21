#!/usr/bin/env node
// Bindery command line. With no command it opens the manager window (same as `open`).
// Plain text output, no colours. Exit codes: 0 ok, 1 error, 2 usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanAll } from './lib/scan.mjs';
import { loadCatalog, fetchPack, cachedPack } from './lib/catalog.mjs';
import { planRemove, applyPlan, undo, history } from './lib/changes.mjs';
import { planShare, shareStatus, APPS } from './lib/share.mjs';
import { diffSkillFolders } from './lib/diff.mjs';
import { planResolve } from './lib/resolve.mjs';
import { findBroken, planRepair } from './lib/repair.mjs';
import { listLibraries, readLibrary, exportLibrary, librariesDir } from './lib/library.mjs';
import { previewLibrary, planLibraryInstall } from './lib/library-install.mjs';
import { fetchLibrary } from './lib/library-git.mjs';
import { listWant, addWant, updateWant, removeWant, exportWant } from './lib/want.mjs';
import {
  startServer, canonicalPackSkills, planPackInstall, groupsWithInstalled, tildify,
} from './server.mjs';

const USAGE = `Usage: bindery [command]

  open [--no-open] [--port N]        open the manager (default when no command is given)
  list [--host claude|codex|agents] [--json]
  search <query>
  show <name>
  packs                              list the curated skill packs
  pack <id>                          fetch a pack and list its skills
  install <packId> <skill...|--all> --to <rootId> [--link] [--yes]
  remove <name> --from <rootId> [--yes]
  share <name...|--all> --with claude|codex [--copy] [--yes]
                                     let the other app use a skill (a link by default)
  unshare <name...> --from claude|codex [--yes]
                                     stop one app using a skill; the other keeps it
  library list                       your libraries: name, id and item count
  library show <id>                  the items in a library, with apps and best-for notes
  library export <id> <folder>       copy a library folder into <folder>
  library import <folder|link> [--only name,name] [--yes]
                                     preview a library folder or git link, then install its items;
                                     items with a high safety finding need --only
  library sources                    libraries fetched from git links: url, ref, commit, time
  library update <link>              fetch a git library again and list what changed
  want list [--json]                 your want-to-try list, newest first
  want add <link> [--title T] [--creator C] [--repo R] [--note N]
                                     save a link to look at later
  want set <id> [--status S] [--title T] [--creator C] [--repo R] [--note N]
                                     change a saved link; S is saved, reviewed, added or dismissed
  want remove <id>                   remove a saved link; a copy is kept in backups
  want export                        print the want list as Markdown
  diff <name>                        compare the first two copies of a skill
  resolve <name> --keep claude|codex [--yes]
                                     keep the copy one app reads; the other copies link to it
  repair <name> [--remove] [--yes]   point broken links at a working copy, or remove them
  history
  undo <txId>

Installs, removals, shares, imports, resolves and repairs print a plan first and change
nothing until --yes is given.`;

const VALUE_FLAGS = new Set(['host', 'port', 'to', 'from', 'with', 'only', 'keep', 'title', 'creator', 'repo', 'note', 'status']);
const BOOL_FLAGS = new Set(['json', 'yes', 'all', 'link', 'copy', 'no-open', 'help', 'remove']);
const HOSTS = new Set(['claude', 'codex', 'agents']);
const LIBRARY_COMMANDS = new Set(['list', 'show', 'export', 'import', 'sources', 'update']);
const WANT_USAGE = 'Usage: want list [--json] | add <link> | set <id> [--status S] | remove <id> | export';
const LIBRARY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const APP_NAMES = { claude: 'Claude Code', codex: 'Codex' };
const DIFF_CONTEXT = 2;
const DIFF_COLLAPSE_AT = 6;

class UsageError extends Error {}
class CliError extends Error {}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h') {
      flags.help = true;
    } else if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (VALUE_FLAGS.has(name)) {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value.`);
        flags[name] = value;
        i++;
      } else if (BOOL_FLAGS.has(name)) {
        flags[name] = true;
      } else {
        throw new UsageError(`Unknown option --${name}.`);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function trim(text, max = 70) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function pad(text, width) {
  return String(text).padEnd(width);
}

function lowerEq(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function findPack(packId) {
  const pack = loadCatalog().packs.find(p => p.id === packId);
  if (!pack) throw new CliError(`Unknown pack "${packId}". Run "packs" to see the list.`);
  return pack;
}

function printPlan(plan, home, write) {
  const head = plan.summary || `${plan.kind === 'remove' ? 'remove' : 'install'}${plan.label ? ` (${plan.label})` : ''}`;
  write(`Plan ${plan.id}: ${tildify(head, home)}`);
  for (const op of plan.ops) {
    if (op.op === 'remove') {
      write(`  remove   ${tildify(op.dest, home)}`);
    } else {
      const verb = op.op === 'replace' ? 'replace' : 'add    ';
      write(`  ${verb} ${tildify(op.dest, home)}  <- ${tildify(op.src, home)} (${op.mode})`);
    }
  }
  for (const warning of plan.warnings) write(`  ! ${warning}`);
}

const DRY_RUN_NOTE = 'Nothing was changed. Run the same command with --yes to apply this plan.';

// Lines of a diff hunk list. Long runs of unchanged lines are cut down to a little context.
function diffLines(hunks) {
  const out = [];
  hunks.forEach((hunk, index) => {
    if (hunk.type === 'add' || hunk.type === 'del') {
      const sign = hunk.type === 'add' ? '+' : '-';
      for (const line of hunk.lines) out.push(`${sign} ${line}`);
      return;
    }
    const lines = hunk.lines;
    if (lines.length <= DIFF_COLLAPSE_AT) {
      for (const line of lines) out.push(`  ${line}`);
      return;
    }
    const head = index > 0 ? lines.slice(0, DIFF_CONTEXT) : [];
    const tail = index < hunks.length - 1 ? lines.slice(-DIFF_CONTEXT) : [];
    for (const line of head) out.push(`  ${line}`);
    out.push(`  ... ${lines.length - head.length - tail.length} unchanged line(s)`);
    for (const line of tail) out.push(`  ${line}`);
  });
  return out;
}

function printFinding(item, finding, write) {
  const where = item.type === 'skill' && finding.file ? `${item.path}/${finding.file}` : item.path;
  const loc = finding.line ? `${where}:${finding.line}` : where;
  write(`      ${finding.level}: ${loc}  ${finding.message || finding.rule}`);
}

const shortCommit = commit => (commit ? String(commit).slice(0, 8) : 'unknown');

function isFolder(source) {
  try {
    return fs.statSync(path.resolve(source)).isDirectory();
  } catch {
    return false;
  }
}

// Libraries fetched from git links. Same reading as the manager's librarySources(): one cache folder per link.
function gitSources({ stateDir }) {
  const root = path.join(stateDir, 'cache', 'libraries');
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const cacheDir = path.join(root, entry.name);
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(cacheDir, '.fetch.json'), 'utf8'));
    } catch {
      meta = null;
    }
    if (!meta || typeof meta.url !== 'string') continue;
    const dir = meta.subdir ? path.join(cacheDir, meta.subdir) : cacheDir;
    let name = null;
    try {
      name = readLibrary(dir).manifest.name ?? null;
    } catch {
      name = null;
    }
    out.push({
      url: meta.url,
      ref: meta.ref ?? null,
      subdir: meta.subdir ?? null,
      commit: meta.commit ?? null,
      fetchedAt: meta.fetchedAt ?? null,
      name,
    });
  }
  return out.sort((a, b) => String(a.name ?? a.url).localeCompare(String(b.name ?? b.url)));
}

async function runLibrary(sub, args, flags, { stateDir, home, cwd, git }, write) {
  if (sub === 'sources') {
    const sources = gitSources({ stateDir });
    if (sources.length === 0) {
      write('No libraries have been fetched from git links yet. Import one with: bindery library import <link>');
      return 0;
    }
    for (const s of sources) {
      write(`${s.name ?? '(no name)'}`);
      write(`  url:      ${s.url}${s.subdir ? `  folder: ${s.subdir}` : ''}`);
      write(`  ref:      ${s.ref ?? 'default branch'}`);
      write(`  commit:   ${shortCommit(s.commit)}`);
      write(`  fetched:  ${s.fetchedAt ?? 'unknown'}`);
    }
    return 0;
  }

  if (sub === 'update') {
    const link = args[0];
    if (!link) throw new UsageError('Usage: library update <link>');
    const fetched = await fetchLibrary({ stateDir, input: link, git });
    write(`Fetched ${fetched.url} at ${shortCommit(fetched.commit)}.`);
    if (!fetched.changes) {
      write('This is the first fetch of that link, so there is nothing to compare yet.');
      write(`Run bindery library import ${link} to install its items.`);
      return 0;
    }
    const { added, removed, changed } = fetched.changes;
    if (added.length + removed.length + changed.length === 0) {
      write('Already up to date.');
      return 0;
    }
    if (fetched.previousCommit) write(`Changes since ${shortCommit(fetched.previousCommit)}:`);
    for (const item of added) write(`  + added    ${item.type} ${item.name}`);
    for (const item of changed) write(`  ~ changed  ${item.type} ${item.name} (${item.parts.join(', ')})`);
    for (const item of removed) write(`  - removed  ${item.type} ${item.name}`);
    write(`Run bindery library import ${link} to install the changes.`);
    return 0;
  }

  if (sub === 'list') {
    const libraries = listLibraries({ stateDir });
    if (libraries.length === 0) {
      write('No libraries yet.');
      return 0;
    }
    const nameWidth = Math.min(32, Math.max(...libraries.map(l => l.name.length)));
    const idWidth = Math.min(32, Math.max(...libraries.map(l => l.id.length)));
    for (const lib of libraries) {
      write(`${pad(lib.name, nameWidth)}  ${pad(lib.id, idWidth)}  ${lib.itemCount} item(s)`);
    }
    return 0;
  }

  if (sub === 'show') {
    const id = args[0];
    if (!id) throw new UsageError('Usage: library show <id>');
    const dir = libraryDirFor(stateDir, id);
    const { manifest, problems } = readLibrary(dir);
    write(`${manifest.name}  (${manifest.id}, ${manifest.items.length} item(s))`);
    if (manifest.description) write(`  ${trim(manifest.description, 200)}`);
    for (const item of manifest.items) {
      write(`  ${pad(item.type, 8)}${pad(item.name, 32)}  ${pad(item.apps.join(','), 13)}  ${trim(item.bestFor, 60)}`);
    }
    for (const problem of problems) write(`  ! ${problem}`);
    return 0;
  }

  if (sub === 'export') {
    const [id, folder] = args;
    if (!id || !folder) throw new UsageError('Usage: library export <id> <folder>');
    const { dir } = exportLibrary({ stateDir, libraryId: id, dest: path.resolve(folder) });
    write(`Exported ${id} to ${dir}`);
    return 0;
  }

  // import: an existing folder, or a git link that is fetched into the cache first
  const source = args[0];
  if (!source) throw new UsageError('Usage: library import <folder|link> [--only name,name] [--yes]');
  let dir;
  if (isFolder(source)) {
    dir = path.resolve(source);
  } else {
    const fetched = await fetchLibrary({ stateDir, input: source, git });
    write(`Fetched ${fetched.url} at ${shortCommit(fetched.commit)}.`);
    dir = fetched.dir;
  }
  const preview = previewLibrary(dir);
  const { manifest } = preview;
  write(`${manifest.name}  (${manifest.id}, ${preview.items.length} item(s), license: ${preview.license || 'not stated'})`);
  for (const problem of preview.problems) write(`  ! ${problem}`);
  for (const item of preview.items) {
    write(`  ${pad(item.safety.level, 8)}${pad(item.type, 8)}${pad(item.name, 32)}  ${pad(item.apps.join(','), 13)}  ${trim(item.bestFor, 50)}`);
    for (const finding of item.safety.findings) printFinding(item, finding, write);
  }

  let only = null;
  if (flags.only !== undefined) {
    only = String(flags.only).split(',').map(s => s.trim()).filter(Boolean);
    if (only.length === 0) throw new UsageError('--only needs at least one item name, for example --only polish,review.');
    for (const name of only) {
      if (!preview.items.some(item => item.name === name)) throw new CliError(`This library has no item called ${name}.`);
    }
  }
  const chosen = [];
  for (const item of preview.items) {
    if (only) {
      if (only.includes(item.name)) chosen.push(item);
    } else if (item.safety.level === 'high') {
      write(`Skipped ${item.type} ${item.name}: it has a high safety finding. Name it with --only ${item.name} to include it.`);
    } else {
      chosen.push(item);
    }
  }
  if (chosen.length === 0) throw new CliError('Nothing to import.');

  const picks = chosen.map(item => ({ type: item.type, name: item.name }));
  const roots = scanAll({ home, cwd }).roots;
  const plan = planLibraryInstall({ dir, picks, roots, home, cwd });
  printPlan(plan, home, write);
  if (!flags.yes) {
    write(DRY_RUN_NOTE);
    return 0;
  }
  const result = applyPlan(plan, { stateDir, home });
  write(`Imported ${chosen.length} item(s) from ${manifest.name}. Change ${result.txId} can be undone with: undo ${result.txId}`);
  return 0;
}

// Folder of a library by id. Throws a plain sentence when the id is malformed or unknown.
function libraryDirFor(stateDir, id) {
  if (!LIBRARY_ID_RE.test(id)) throw new CliError(`There is no library called ${id}. Run "library list" to see yours.`);
  const dir = path.join(librariesDir({ stateDir }), id);
  if (!fs.existsSync(dir)) throw new CliError(`There is no library called ${id}. Run "library list" to see yours.`);
  return dir;
}

// want list | add | set | remove | export. Errors from want.mjs are plain sentences, shown with exit 1.
function runWant(sub, args, flags, { stateDir }, write) {
  try {
    if (sub === 'list') {
      const items = listWant({ stateDir });
      if (flags.json) {
        write(JSON.stringify(items, null, 2));
        return 0;
      }
      if (items.length === 0) {
        write('Your want list is empty. Save a link with: bindery want add <link>');
        return 0;
      }
      for (const item of items) {
        write(`${trim(item.title, 60)}  (${item.status})`);
        write(`  ${item.id}  ${item.url}`);
        const extra = [];
        if (item.creator) extra.push(`by ${trim(item.creator, 40)}`);
        if (item.repo) extra.push(`repo: ${item.repo}`);
        if (item.note) extra.push(`note: ${trim(item.note, 80)}`);
        if (extra.length) write(`  ${extra.join('; ')}`);
      }
      return 0;
    }

    if (sub === 'add') {
      const link = args[0];
      if (!link) throw new UsageError('Usage: want add <link> [--title T] [--creator C] [--repo R] [--note N]');
      const item = addWant({ stateDir, url: link, title: flags.title, creator: flags.creator, repo: flags.repo, note: flags.note });
      write(`Saved ${item.title}.`);
      write(`  id: ${item.id}`);
      return 0;
    }

    if (sub === 'set') {
      const id = args[0];
      const fields = {};
      for (const key of ['status', 'title', 'creator', 'repo', 'note']) {
        if (flags[key] !== undefined) fields[key] = flags[key];
      }
      if (!id || Object.keys(fields).length === 0) {
        throw new UsageError('Usage: want set <id> [--status saved|reviewed|added|dismissed] [--title T] [--creator C] [--repo R] [--note N]');
      }
      const item = updateWant({ stateDir, id, ...fields });
      write(`Updated ${item.title}. Status: ${item.status}.`);
      return 0;
    }

    if (sub === 'remove') {
      const id = args[0];
      if (!id) throw new UsageError('Usage: want remove <id>');
      const removed = removeWant({ stateDir, id });
      write(`Removed ${removed.title}. A copy is kept in backups.`);
      return 0;
    }

    if (sub === 'export') {
      write(exportWant({ stateDir }).replace(/\n$/, ''));
      return 0;
    }
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new CliError(oneLine(err));
  }
  throw new UsageError(WANT_USAGE);
}

async function main(argv, { write = line => process.stdout.write(`${line}\n`), git } = {}) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help) {
    write(USAGE);
    return 0;
  }
  const [command = 'open', ...rest] = positional;
  const home = os.homedir();
  const cwd = process.cwd();
  const stateDir = process.env.BINDERY_HOME
    ? path.resolve(process.env.BINDERY_HOME)
    : path.join(home, '.bindery');
  const ctx = { home, cwd, stateDir };

  switch (command) {
    case 'open': {
      let port = 0;
      if (flags.port !== undefined) {
        port = Number(flags.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port needs a number from 0 to 65535.');
      }
      const server = await startServer({ ...ctx, port, open: !flags['no-open'] });
      write(`Bindery is open at ${server.url}  (Ctrl+C to close)`);
      return 0;
    }

    case 'list': {
      let groups = groupsWithInstalled(scanAll(ctx).groups);
      if (flags.host !== undefined) {
        if (!HOSTS.has(flags.host)) throw new UsageError('--host must be claude, codex or agents.');
        groups = groups.filter(g => g.hosts.includes(flags.host));
      }
      if (flags.json) {
        write(JSON.stringify(tildify({ groups }, home), null, 2));
        return 0;
      }
      if (groups.length === 0) {
        write('No skills found.');
        return 0;
      }
      const width = Math.min(32, Math.max(...groups.map(g => g.name.length)));
      for (const g of groups) {
        write(`${pad(g.name, width)}  ${pad(g.hosts.join(','), 14)}  ${trim(g.description)}`);
      }
      return 0;
    }

    case 'search': {
      const query = rest.join(' ').trim().toLowerCase();
      if (!query) throw new UsageError('Usage: search <query>');
      const matches = scanAll(ctx).skills.filter(s =>
        s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query));
      if (matches.length === 0) {
        write(`No skills match "${rest.join(' ')}".`);
        return 0;
      }
      for (const s of matches) write(`${pad(s.name, 32)}  ${pad(s.host, 8)}  ${trim(s.description)}`);
      return 0;
    }

    case 'show': {
      const name = rest.join(' ').trim();
      if (!name) throw new UsageError('Usage: show <name>');
      const scan = scanAll(ctx);
      const matches = scan.skills.filter(s => lowerEq(s.name, name));
      if (matches.length === 0) throw new CliError(`No skill named "${name}" was found.`);
      for (const s of matches) {
        const root = scan.roots.find(r => r.id === s.rootId);
        write(`${s.name}  (${s.host}, ${root ? root.label : s.rootId})`);
        write(`  path:        ${tildify(s.path, home)}`);
        if (s.isSymlink) {
          const target = s.broken ? '(broken link)' : tildify(s.realPath ?? s.linkTarget ?? '', home);
          write(`  links to:    ${target}`);
        }
        write(`  scripts:     ${s.hasScripts ? 'yes, read them before running' : 'no'}`);
        write(`  files:       ${s.fileCount}`);
        write(`  description: ${s.description || '(none)'}`);
      }
      return 0;
    }

    case 'packs': {
      const catalog = loadCatalog();
      for (const pack of catalog.packs) {
        const state = cachedPack(pack, { stateDir }) ? 'fetched' : 'not fetched';
        write(`${pad(pack.id, 22)}  ${pad(state, 12)}  ${pack.title} (${pack.publisher})`);
      }
      return 0;
    }

    case 'pack': {
      const packId = rest[0];
      if (!packId) throw new UsageError('Usage: pack <id>');
      const pack = findPack(packId);
      const fetched = await fetchPack(pack, { stateDir });
      const skills = canonicalPackSkills(fetched.skills);
      write(`${pack.title} at commit ${fetched.commit.slice(0, 8)}: ${skills.length} skill(s)`);
      if (fetched.license) {
        write(`License: ${fetched.license.spdxGuess ?? 'unknown'} (${fetched.license.file})`);
      }
      for (const s of skills) {
        const copies = s.alsoAt.length ? `  (+${s.alsoAt.length} more copies)` : '';
        write(`${pad(s.name, 32)}  ${pad(s.relPath, 30)}${copies}  ${trim(s.description, 50)}`);
      }
      return 0;
    }

    case 'install': {
      const [packId, ...names] = rest;
      if (!packId || (!flags.all && names.length === 0)) {
        throw new UsageError('Usage: install <packId> <skill...|--all> --to <rootId> [--link] [--yes]');
      }
      if (flags.all && names.length) throw new UsageError('Use either skill names or --all, not both.');
      if (!flags.to) throw new UsageError('Choose a location with --to <rootId>, for example --to claude-global.');
      const pack = findPack(packId);
      const cached = cachedPack(pack, { stateDir }) ?? await fetchPack(pack, { stateDir });
      const available = canonicalPackSkills(cached.skills);
      let chosen = available;
      if (!flags.all) {
        chosen = names.map(n => {
          const hit = available.find(s => lowerEq(s.name, n) || s.relPath === n);
          if (!hit) throw new CliError(`"${n}" is not in ${pack.id}. Run "pack ${pack.id}" to see its skills.`);
          return hit;
        });
      }
      const roots = scanAll(ctx).roots;
      const plan = planPackInstall({
        pack,
        cached,
        relPaths: chosen.map(s => s.relPath),
        rootId: flags.to,
        mode: flags.link ? 'symlink' : 'copy',
        roots,
      });
      printPlan(plan, home, write);
      if (!flags.yes) {
        write('Nothing was changed. Run the same command with --yes to apply this plan.');
        return 0;
      }
      const result = applyPlan(plan, { stateDir, home });
      write(`Installed ${result.applied} item(s). Change ${result.txId} can be undone with: undo ${result.txId}`);
      return 0;
    }

    case 'remove': {
      const name = rest.join(' ').trim();
      if (!name || !flags.from) throw new UsageError('Usage: remove <name> --from <rootId> [--yes]');
      const scan = scanAll(ctx);
      const skill = scan.skills.find(s => lowerEq(s.name, name) && s.rootId === flags.from);
      if (!skill) throw new CliError(`No skill named "${name}" is in ${flags.from}. Run "show ${name}" to see where it is.`);
      const root = scan.roots.find(r => r.id === skill.rootId);
      let plan;
      try {
        plan = planRemove({ skillPath: skill.path, root });
      } catch (err) {
        throw new CliError(err.message);
      }
      printPlan(plan, home, write);
      if (!flags.yes) {
        write('Nothing was changed. Run the same command with --yes to apply this plan.');
        return 0;
      }
      const result = applyPlan(plan, { stateDir, home });
      write(`Removed ${name}. Change ${result.txId} can be undone with: undo ${result.txId}`);
      return 0;
    }

    case 'share':
    case 'unshare': {
      const on = command === 'share';
      const app = on ? flags.with : flags.from;
      const usage = on
        ? 'Usage: share <name...|--all> --with claude|codex [--copy] [--yes]'
        : 'Usage: unshare <name...> --from claude|codex [--yes]';
      if (!APPS[app]) throw new UsageError(usage);
      const scan = scanAll(ctx);
      let names = rest;
      if (on && flags.all) {
        if (names.length) throw new UsageError('Use either skill names or --all, not both.');
        const byId = new Map(scan.skills.map(s => [s.id, s]));
        names = scan.groups.filter(g => shareStatus(g, byId)[app].canTurnOn).map(g => g.name);
        if (!names.length) {
          write(`Every skill that can be shared is already in ${APPS[app].label}.`);
          return 0;
        }
      }
      if (!names.length) throw new UsageError(usage);
      const { plan, skipped } = planShare({ scan, names, app, on, mode: flags.copy ? 'copy' : 'symlink' });
      for (const s of skipped) write(`  skipped  ${s.name}: ${s.reason}`);
      if (!plan) throw new CliError('Nothing to change.');
      printPlan(plan, home, write);
      if (!flags.yes) {
        write('Nothing was changed. Run the same command with --yes to apply this plan.');
        return 0;
      }
      const result = applyPlan(plan, { stateDir, home });
      write(`${plan.summary}. Change ${result.txId} can be undone with: undo ${result.txId}`);
      return 0;
    }

    case 'history': {
      const rows = history({ stateDir, home });
      if (rows.length === 0) {
        write('No changes recorded yet.');
        return 0;
      }
      for (const row of rows) {
        write(`${row.txId}  ${pad(row.status, 12)}  ${row.createdAt ?? ''}  ${row.summary ?? ''}`);
      }
      return 0;
    }

    case 'undo': {
      const txId = rest[0];
      if (!txId) throw new UsageError('Usage: undo <txId>');
      const result = undo(txId, { stateDir, home });
      write(`Restored ${result.restored} item(s) from change ${txId}.`);
      return 0;
    }

    case 'library': {
      const [sub, ...args] = rest;
      if (!sub) throw new UsageError('Usage: library list | show <id> | export <id> <folder> | import <folder> [--only name,name] [--yes]');
      if (!LIBRARY_COMMANDS.has(sub)) throw new UsageError(`Unknown library command "${sub}".`);
      return runLibrary(sub, args, flags, { stateDir, home, cwd, git }, write);
    }

    case 'want': {
      const [sub, ...args] = rest;
      if (!sub) throw new UsageError(WANT_USAGE);
      return runWant(sub, args, flags, { stateDir }, write);
    }

    case 'diff': {
      const name = rest.join(' ').trim();
      if (!name) throw new UsageError('Usage: diff <skill-name>');
      const scan = scanAll(ctx);
      const group = scan.groups.find(g => lowerEq(g.name, name));
      if (!group) throw new CliError(`No skill named "${name}" is installed.`);
      const byId = new Map(scan.skills.map(s => [s.id, s]));
      const copies = [];
      for (const id of group.entries) {
        const entry = byId.get(id);
        if (!entry || entry.broken || !entry.realPath) continue;
        if (!copies.some(c => c.realPath === entry.realPath)) copies.push(entry);
      }
      if (copies.length < 2) throw new CliError(`${group.name} has only one copy, so there is nothing to compare.`);
      const [a, b] = copies;
      const result = diffSkillFolders(a.realPath, b.realPath);
      write(`A: ${tildify(a.path, home)}  (${APP_NAMES[a.host] ?? a.host})`);
      write(`B: ${tildify(b.path, home)}  (${APP_NAMES[b.host] ?? b.host})`);
      if (result.same) {
        write('The two copies have the same files.');
        return 0;
      }
      const label = { changed: 'changed', 'only-a': 'only in A', 'only-b': 'only in B' };
      write('Files:');
      for (const file of result.files) {
        if (file.status !== 'same') write(`  ${pad(label[file.status], 12)}${file.rel}`);
      }
      const md = result.skillMd;
      if (!md.hunks) {
        write('SKILL.md is too large to show a line diff.');
      } else if (md.hunks.every(h => h.type === 'eq')) {
        write('SKILL.md is the same in both copies.');
      } else {
        write('SKILL.md (+ only in B, - only in A):');
        for (const line of diffLines(md.hunks)) write(line);
      }
      return 0;
    }

    case 'resolve': {
      const name = rest.join(' ').trim();
      const keep = flags.keep;
      if (!name || keep === undefined) throw new UsageError('Usage: resolve <skill-name> --keep claude|codex [--yes]');
      if (keep !== 'claude' && keep !== 'codex') throw new UsageError('--keep must be claude or codex.');
      const scan = scanAll(ctx);
      const group = scan.groups.find(g => lowerEq(g.name, name));
      if (!group) throw new CliError(`No skill named "${name}" is installed.`);
      const byId = new Map(scan.skills.map(s => [s.id, s]));
      const copies = group.entries
        .map(id => byId.get(id))
        .filter(e => e && e.host === keep && !e.broken && e.realPath);
      if (copies.length === 0) throw new CliError(`${APP_NAMES[keep]} has no working copy of ${group.name} to keep.`);
      const kept = copies.find(e => e.scope !== 'plugin') ?? copies[0];
      let plan;
      try {
        ({ plan } = planResolve({ scan, name: group.name, keepId: kept.id }));
      } catch (err) {
        throw new CliError(err.message);
      }
      if (!plan) {
        write('Nothing to change. Every copy already uses the same folder.');
        return 0;
      }
      printPlan(plan, home, write);
      if (!flags.yes) {
        write(DRY_RUN_NOTE);
        return 0;
      }
      const result = applyPlan(plan, { stateDir, home });
      write(`Kept the ${APP_NAMES[keep]} copy of ${group.name}. Change ${result.txId} can be undone with: undo ${result.txId}`);
      return 0;
    }

    case 'repair': {
      const name = rest.join(' ').trim();
      if (!name) throw new UsageError('Usage: repair <skill-name> [--remove] [--yes]');
      const scan = scanAll(ctx);
      const broken = findBroken(scan).filter(b => lowerEq(b.name, name));
      if (broken.length === 0) throw new CliError(`No broken links for "${name}" were found.`);
      const plans = [];
      for (const link of broken) {
        const where = tildify(link.path, home);
        try {
          if (flags.remove) {
            plans.push(planRepair({ scan, skillId: link.skillId, action: 'remove' }));
          } else if (link.candidates.length === 0) {
            write(`  skipped  ${where}: no working copy to link to. Use --remove to delete the link.`);
          } else {
            plans.push(planRepair({ scan, skillId: link.skillId, action: 'relink', targetId: link.candidates[0].skillId }));
          }
        } catch (err) {
          write(`  skipped  ${where}: ${oneLine(err)}`);
        }
      }
      if (plans.length === 0) throw new CliError(`Could not repair ${name}. Nothing was changed.`);
      for (const plan of plans) printPlan(plan, home, write);
      if (!flags.yes) {
        write(DRY_RUN_NOTE);
        return 0;
      }
      for (const plan of plans) {
        const result = applyPlan(plan, { stateDir, home });
        write(`${flags.remove ? 'Removed' : 'Repaired'} the broken link for ${name}. Change ${result.txId} can be undone with: undo ${result.txId}`);
      }
      return 0;
    }

    default:
      throw new UsageError(`Unknown command "${command}".`);
  }
}

function oneLine(err) {
  return String(err && err.message ? err.message : err).split(/\r?\n/)[0];
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    err => {
      if (err instanceof UsageError) {
        process.stderr.write(`${oneLine(err)}\n${USAGE}\n`);
        process.exitCode = 2;
        return;
      }
      process.stderr.write(`${oneLine(err)}\n`);
      process.exitCode = 1;
    },
  );
}

export { main, parseArgs };
