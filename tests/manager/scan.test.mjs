import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { parseFrontmatter, readSkill } from '../../plugins/agent-compass/manager/lib/skill.mjs';
import { listPluginSkillDirs, listRoots } from '../../plugins/agent-compass/manager/lib/roots.mjs';
import { scanAll } from '../../plugins/agent-compass/manager/lib/scan.mjs';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function buildFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-'));
  const home = path.join(base, 'home');
  const cwd = path.join(home, 'work', 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const claude = path.join(home, '.claude', 'skills');
  const codex = path.join(home, '.codex', 'skills');
  const agents = path.join(home, '.agents', 'skills');

  write(path.join(claude, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: "Alpha from Claude."\n---\nBody\n');
  write(path.join(claude, 'blocky', 'SKILL.md'), '---\nname: blocky\ndescription: |\n  First line of\n  the description.\nmetadata:\n  type: workflow\n---\n# Blocky\n');
  write(path.join(claude, '.hidden', 'SKILL.md'), '---\nname: hidden\n---\n');
  write(path.join(claude, 'not-a-skill', 'README.md'), 'no skill here\n');

  const shared = path.join(base, 'store', 'shared-skill');
  write(path.join(shared, 'SKILL.md'), '---\nname: shared\ndescription: Shared one.\n---\n');
  write(path.join(shared, 'scripts', 'run.sh'), 'echo hi\n');
  fs.symlinkSync(shared, path.join(claude, 'shared'), 'dir');
  fs.mkdirSync(agents, { recursive: true });
  fs.symlinkSync(shared, path.join(agents, 'shared'), 'dir');

  write(path.join(codex, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha from Codex.\n---\n');
  write(path.join(codex, 'tooled', 'SKILL.md'), '---\nname: tooled\ndescription: Has files.\n---\n');
  write(path.join(codex, 'tooled', 'lib', 'helper.py'), 'print(1)\n');
  write(path.join(codex, 'tooled', '.git', 'HEAD'), 'ref\n');
  write(path.join(codex, 'tooled', 'node_modules', 'pkg', 'index.js'), 'x\n');
  write(path.join(codex, '.system', 'imagegen', 'SKILL.md'), '---\nname: imagegen\ndescription: System image skill.\n---\n');
  fs.symlinkSync(path.join(base, 'nowhere'), path.join(codex, 'gone'), 'dir');

  write(path.join(cwd, '.claude', 'skills', 'local-only', 'SKILL.md'), '---\nname: local-only\ndescription: Project skill.\n---\n');

  const plug = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'plug');
  write(path.join(plug, '1.0.0', 'skills', 'old-skill', 'SKILL.md'), '---\nname: old-skill\ndescription: Old.\n---\n');
  write(path.join(plug, '2.0.0', 'skills', 'new-skill', 'SKILL.md'), '---\nname: new-skill\ndescription: New.\n---\n');
  const past = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(path.join(plug, '1.0.0'), past, past);

  write(path.join(home, '.codex', 'plugins', 'cache', 'mkt', 'cplug', '1.0.0', 'skills', 'cskill', 'SKILL.md'), '---\nname: cskill\ndescription: Codex plugin skill.\n---\n');

  return {
    base,
    home,
    cwd,
    claude,
    codex,
    agents,
    shared,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

describe('parseFrontmatter', () => {
  test('returns empty data when there is no frontmatter', () => {
    const text = '# Title\nbody';
    assert.deepEqual(parseFrontmatter(text), { data: {}, body: text });
  });

  test('parses quotes, inline lists, comments and body', () => {
    const { data, body } = parseFrontmatter("---\nname: x\ndescription: 'It''s here'\nquoted: \"a \\\"b\\\"\"\ntags: [a, \"b, c\"]\nnote: value # trailing\n---\nbody");
    assert.equal(data.name, 'x');
    assert.equal(data.description, "It's here");
    assert.equal(data.quoted, 'a "b"');
    assert.deepEqual(data.tags, ['a', 'b, c']);
    assert.equal(data.note, 'value');
    assert.equal(body, 'body');
  });

  test('parses literal and folded block scalars', () => {
    const { data } = parseFrontmatter('---\nlit: |\n  one\n  two\nfold: >\n  alpha\n  beta\nnext: ok\n---\n');
    assert.equal(data.lit, 'one\ntwo');
    assert.equal(data.fold, 'alpha beta');
    assert.equal(data.next, 'ok');
  });

  test('parses one level of nested map', () => {
    const { data } = parseFrontmatter('---\nname: n\nmetadata:\n  type: x\n  owner: "me"\n---\n');
    assert.deepEqual(data.metadata, { type: 'x', owner: 'me' });
  });

  test('ignores unknown lines and never throws', () => {
    const { data } = parseFrontmatter('---\n???\n: :\n  - item\n- bullet\nname: ok\n---\n');
    assert.equal(data.name, 'ok');
  });

  test('does not allow prototype pollution', () => {
    const { data } = parseFrontmatter('---\n__proto__: bad\nname: ok\n---\n');
    assert.equal(({}).bad, undefined);
    assert.equal(data.name, 'ok');
  });
});

describe('manager scan on a fake home', () => {
  let fx;
  let scan;
  before(() => {
    fx = buildFixture();
    scan = scanAll({ home: fx.home, cwd: fx.cwd });
  });
  after(() => fx.cleanup());

  const byId = id => scan.skills.find(s => s.id === id);

  test('readSkill reads frontmatter, block scalars and file stats', () => {
    const root = { id: 'claude-global', host: 'claude', scope: 'global', writable: true };
    const blocky = readSkill(path.join(fx.claude, 'blocky'), root);
    assert.equal(blocky.id, 'claude-global:blocky');
    assert.equal(blocky.description, 'First line of the description.');
    assert.equal(blocky.broken, false);
    assert.equal(blocky.isSymlink, false);
    assert.equal(blocky.readOnly, false);
    assert.equal(blocky.pluginName, null);
    assert.equal(blocky.hasScripts, false);
    assert.equal(blocky.fileCount, 1);
    assert.ok(blocky.bytes > 0);
    assert.equal(typeof blocky.updatedAt, 'string');
    assert.equal(readSkill(path.join(fx.claude, 'not-a-skill'), root), null);
  });

  test('counts files while skipping .git and node_modules', () => {
    const root = { id: 'codex-global', host: 'codex', scope: 'global', writable: true };
    const tooled = readSkill(path.join(fx.codex, 'tooled'), root);
    assert.equal(tooled.fileCount, 2);
    assert.equal(tooled.hasScripts, true);
  });

  test('symlinked skill reports its target and real path', () => {
    const root = { id: 'claude-global', host: 'claude', scope: 'global', writable: true };
    const shared = readSkill(path.join(fx.claude, 'shared'), root);
    assert.equal(shared.isSymlink, true);
    assert.equal(shared.linkTarget, fx.shared);
    assert.equal(shared.realPath, fs.realpathSync(fx.shared));
    assert.equal(shared.hasScripts, true);
  });

  test('broken symlink gives a broken entry', () => {
    const gone = byId('codex-global:gone');
    assert.ok(gone, 'broken entry present');
    assert.equal(gone.broken, true);
    assert.equal(gone.name, 'gone');
    assert.equal(gone.description, '');
    assert.equal(gone.realPath, null);
    assert.equal(gone.isSymlink, true);
  });

  test('returns the roots with exists and writable flags', () => {
    const ids = scan.roots.map(r => r.id);
    for (const id of ['claude-global', 'codex-global', 'agents-global', 'claude-project', 'agents-project', 'claude-plugins', 'codex-plugins', 'codex-system']) {
      assert.ok(ids.includes(id), `root ${id} present`);
    }
    const system = scan.roots.find(r => r.id === 'codex-system');
    assert.equal(system.scope, 'plugin');
    assert.equal(system.writable, false);
    assert.equal(system.exists, true);
    assert.equal(scan.roots.find(r => r.id === 'claude-global').exists, true);
    assert.equal(scan.roots.find(r => r.id === 'claude-global').writable, true);
  });

  test('lists the expected skills and nothing hidden or non-skill', () => {
    const ids = scan.skills.map(s => s.id).sort();
    assert.deepEqual(ids, [
      'claude-global:alpha',
      'claude-global:blocky',
      'claude-global:shared',
      'claude-plugins:plug/new-skill',
      'claude-project:local-only',
      'codex-global:alpha',
      'codex-global:gone',
      'codex-global:tooled',
      'codex-plugins:cplug/cskill',
      'codex-system:imagegen',
      'agents-global:shared',
    ].sort());
  });

  test('system skills and plugin skills are read-only plugin scope', () => {
    const imagegen = byId('codex-system:imagegen');
    assert.equal(imagegen.scope, 'plugin');
    assert.equal(imagegen.readOnly, true);
    assert.equal(imagegen.host, 'codex');
    const plugin = byId('claude-plugins:plug/new-skill');
    assert.equal(plugin.pluginName, 'plug');
    assert.equal(plugin.readOnly, true);
    assert.equal(plugin.scope, 'plugin');
    assert.equal(plugin.host, 'claude');
    assert.equal(byId('codex-plugins:cplug/cskill').pluginName, 'cplug');
  });

  test('project skill is included with project scope', () => {
    const local = byId('claude-project:local-only');
    assert.equal(local.scope, 'project');
    assert.equal(local.readOnly, false);
  });

  test('groups same-name skills and flags conflicts', () => {
    const alpha = scan.groups.find(g => g.name === 'alpha');
    assert.deepEqual(alpha.entries.sort(), ['claude-global:alpha', 'codex-global:alpha']);
    assert.deepEqual(alpha.hosts, ['claude', 'codex']);
    assert.equal(alpha.sameSource, false);
    assert.equal(alpha.conflict, true);
    assert.equal(alpha.description, 'Alpha from Claude.');
  });

  test('groups a shared symlink as same source without conflict', () => {
    const shared = scan.groups.find(g => g.name === 'shared');
    assert.deepEqual(shared.entries.sort(), ['agents-global:shared', 'claude-global:shared']);
    assert.deepEqual(shared.hosts, ['claude', 'agents']);
    assert.equal(shared.sameSource, true);
    assert.equal(shared.conflict, false);
  });

  test('groups are sorted by name', () => {
    const names = scan.groups.map(g => g.name.toLowerCase());
    assert.deepEqual(names, [...names].sort());
  });

  test('plugin cache keeps only the newest version', () => {
    assert.equal(byId('claude-plugins:plug/old-skill'), undefined);
    assert.ok(byId('claude-plugins:plug/new-skill'));
    const dirs = listPluginSkillDirs({ home: fx.home }).map(d => d.dir);
    assert.ok(!dirs.some(d => d.includes('old-skill')));
  });

  test('scannedAt is an ISO timestamp', () => {
    assert.ok(!Number.isNaN(Date.parse(scan.scannedAt)));
  });

  test('cwd equal to home omits project roots', () => {
    const roots = listRoots({ home: fx.home, cwd: fx.home });
    assert.deepEqual(roots.map(r => r.id), ['claude-global', 'codex-global', 'agents-global']);
    const noProject = scanAll({ home: fx.home, cwd: fx.home });
    assert.equal(noProject.skills.some(s => s.id === 'claude-project:local-only'), false);
  });

  test('listRoots reports missing project roots as creatable or not', () => {
    const roots = listRoots({ home: fx.home, cwd: fx.cwd });
    assert.deepEqual(roots.map(r => r.id), ['claude-global', 'codex-global', 'agents-global', 'claude-project', 'agents-project']);
    const agentsProject = roots.find(r => r.id === 'agents-project');
    assert.equal(agentsProject.exists, false);
    assert.equal(agentsProject.writable, false);
    const claudeProject = roots.find(r => r.id === 'claude-project');
    assert.equal(claudeProject.exists, true);
    assert.equal(claudeProject.writable, true);
  });
});
