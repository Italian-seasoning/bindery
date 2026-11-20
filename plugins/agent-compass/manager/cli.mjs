#!/usr/bin/env node
// Agent Compass command line. With no command it opens the manager window (same as `open`).
// Plain text output, no colours. Exit codes: 0 ok, 1 error, 2 usage.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanAll } from './lib/scan.mjs';
import { loadCatalog, fetchPack, cachedPack } from './lib/catalog.mjs';
import { planRemove, applyPlan, undo, history } from './lib/changes.mjs';
import { planShare, shareStatus, APPS } from './lib/share.mjs';
import {
  startServer, canonicalPackSkills, planPackInstall, groupsWithInstalled, tildify,
} from './server.mjs';

const USAGE = `Usage: agent-compass [command]

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
  history
  undo <txId>

Installs and removals print a plan first and change nothing until --yes is given.`;

const VALUE_FLAGS = new Set(['host', 'port', 'to', 'from', 'with']);
const BOOL_FLAGS = new Set(['json', 'yes', 'all', 'link', 'copy', 'no-open', 'help']);
const HOSTS = new Set(['claude', 'codex', 'agents']);

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

async function main(argv, { write = line => process.stdout.write(`${line}\n`) } = {}) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help) {
    write(USAGE);
    return 0;
  }
  const [command = 'open', ...rest] = positional;
  const home = os.homedir();
  const cwd = process.cwd();
  const stateDir = process.env.AGENT_COMPASS_HOME
    ? path.resolve(process.env.AGENT_COMPASS_HOME)
    : path.join(home, '.agent-compass');
  const ctx = { home, cwd, stateDir };

  switch (command) {
    case 'open': {
      let port = 0;
      if (flags.port !== undefined) {
        port = Number(flags.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port needs a number from 0 to 65535.');
      }
      const server = await startServer({ ...ctx, port, open: !flags['no-open'] });
      write(`Agent Compass is open at ${server.url}  (Ctrl+C to close)`);
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
