import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, canonicalPackSkills, tildify } from '../../plugins/agent-compass/manager/server.mjs';
import { scanAll } from '../../plugins/agent-compass/manager/lib/scan.mjs';
import { planInstall, applyPlan } from '../../plugins/agent-compass/manager/lib/changes.mjs';

const MANAGER = fileURLToPath(new URL('../../plugins/agent-compass/manager/', import.meta.url));
const CLI = path.join(MANAGER, 'cli.mjs');
const UI_INDEX = path.join(MANAGER, 'ui', 'index.html');
const TOKEN_HEADER = 'x-compass-token';
const DEMO_MD = '---\nname: demo\ndescription: Demo skill for the server tests\n---\nDemo body\n';

let base;
let home;
let stateDir;
let server;
let token;
let port;

function request(urlPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function api(urlPath, options = {}) {
  return request(urlPath, { ...options, headers: { [TOKEN_HEADER]: token, ...(options.headers || {}) } });
}

function json(res) {
  return JSON.parse(res.text);
}

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-server-'));
  home = path.join(base, 'home');
  stateDir = path.join(base, 'state');
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'demo', 'SKILL.md'), DEMO_MD);
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'demo', 'helper.py'), 'print("hi")\n');
  // A plugin-managed skill, to check that plugin skills cannot be removed through the API.
  const pluginSkill = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'plug', '1.0.0', 'skills', 'pskill');
  fs.mkdirSync(pluginSkill, { recursive: true });
  fs.writeFileSync(path.join(pluginSkill, 'SKILL.md'), '---\nname: pskill\ndescription: Plugin skill\n---\n');
  server = await startServer({ home, cwd: home, stateDir, port: 0, open: false });
  token = server.token;
  port = server.port;
});

after(async () => {
  if (server) await server.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

test('API refuses requests without the token', async () => {
  const res = await request('/api/state');
  assert.equal(res.status, 403);
  assert.match(json(res).error, /link printed in your terminal/);
  const wrong = await request('/api/state', { headers: { [TOKEN_HEADER]: 'nope' } });
  assert.equal(wrong.status, 403);
});

test('API refuses a Host header that is not this server', async () => {
  const res = await request('/api/state', {
    headers: { [TOKEN_HEADER]: token, Host: 'evil.example:' + port },
  });
  assert.equal(res.status, 403);
  const staticRes = await request('/', { headers: { Host: 'attacker.test' } });
  assert.equal(staticRes.status, 403);
});

test('state lists the demo group with install flags and never the home path', async () => {
  const res = await api('/api/state');
  assert.equal(res.status, 200);
  const state = json(res);
  const group = state.groups.find(g => g.name === 'demo');
  assert.ok(group, 'demo group present');
  assert.equal(group.installed.claude, true);
  assert.equal(group.installed.codex, false);
  assert.equal(group.installed.agents, false);
  assert.equal(state.home, '~');
  assert.ok(!res.text.includes(home), 'raw home path must not be sent');
  assert.ok(!res.text.includes(fs.realpathSync(home)), 'real home path must not be sent');
  assert.match(res.text, /~\/\.claude\/skills\/demo/);
});

test('skill detail returns SKILL.md and its files through the scan id', async () => {
  const res = await api('/api/skill?id=' + encodeURIComponent('claude-global:demo'));
  assert.equal(res.status, 200);
  const detail = json(res);
  assert.match(detail.skillMd, /Demo body/);
  assert.deepEqual(detail.files.sort(), ['SKILL.md', 'helper.py']);
  const missing = await api('/api/skill?id=' + encodeURIComponent('claude-global:nope'));
  assert.equal(missing.status, 404);
});

test('remove plan, apply and undo restore the folder', async () => {
  const demoDir = path.join(home, '.claude', 'skills', 'demo');
  const planRes = await api('/api/plan', { method: 'POST', body: { kind: 'remove', skillIds: ['claude-global:demo'] } });
  assert.equal(planRes.status, 200);
  const plan = json(planRes);
  assert.ok(!planRes.text.includes(home), 'plan paths must be ~-ified');
  assert.equal(plan.ops[0].op, 'remove');

  const applyRes = await api('/api/apply', { method: 'POST', body: { planId: plan.id } });
  assert.equal(applyRes.status, 200, applyRes.text);
  assert.equal(fs.existsSync(demoDir), false, 'folder removed');
  const txId = json(applyRes).txId;

  const again = await api('/api/apply', { method: 'POST', body: { planId: plan.id } });
  assert.equal(again.status, 404, 'a plan can only be applied once');

  const undoRes = await api('/api/undo', { method: 'POST', body: { txId } });
  assert.equal(undoRes.status, 200, undoRes.text);
  assert.equal(fs.readFileSync(path.join(demoDir, 'SKILL.md'), 'utf8'), DEMO_MD);
  assert.equal(json(undoRes).state.groups.some(g => g.name === 'demo'), true);
});

test('history lists both the removal and a later install', async () => {
  const planRes = await api('/api/plan', { method: 'POST', body: { kind: 'remove', skillIds: ['claude-global:demo'] } });
  const applied = await api('/api/apply', { method: 'POST', body: { planId: json(planRes).id } });
  const removeTx = json(applied).txId;
  await api('/api/undo', { method: 'POST', body: { txId: removeTx } });

  const src = path.join(base, 'extra-src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: extra\ndescription: Extra\n---\n');
  const roots = scanAll({ home, cwd: home }).roots;
  const installPlan = planInstall({
    src, name: 'extra', targetRoot: roots.find(r => r.id === 'claude-global'), mode: 'copy',
  });
  const installTx = applyPlan(installPlan, { stateDir, home }).txId;

  const res = await api('/api/history');
  assert.equal(res.status, 200);
  const changes = json(res).changes;
  const ids = changes.map(c => c.txId);
  assert.ok(ids.includes(removeTx), 'removal listed');
  assert.ok(ids.includes(installTx), 'install listed');
  assert.equal(changes.find(c => c.txId === removeTx).status, 'undone');
  assert.equal(changes.find(c => c.txId === installTx).status, 'applied');
});

test('plugin skills cannot be removed through the API', async () => {
  const res = await api('/api/plan', { method: 'POST', body: { kind: 'remove', skillIds: ['claude-plugins:plug/pskill'] } });
  assert.equal(res.status, 400);
  assert.match(json(res).error, /plugin/);
});

test('unknown install packs and unfetched packs give plain errors', async () => {
  const unknown = await api('/api/plan', { method: 'POST', body: { kind: 'install', packId: 'nope', skills: ['x'], rootId: 'claude-global' } });
  assert.equal(unknown.status, 404);
  const packs = await api('/api/packs');
  assert.equal(packs.status, 200);
  const body = json(packs);
  assert.ok(body.packs.length > 0);
  assert.ok(body.packs.every(p => p.cached === null), 'nothing fetched in a temp state dir');
  const unfetched = await api('/api/plan', {
    method: 'POST',
    body: { kind: 'install', packId: body.packs[0].id, skills: ['x'], rootId: 'claude-global' },
  });
  assert.equal(unfetched.status, 400);
  assert.match(json(unfetched).error, /Fetch this pack first/);
});

test('pack install plan, apply and undo use the cached pack copy', async () => {
  // Seed the cache with a real local git repo under the catalog id "superpowers" (no network).
  const cacheDir = path.join(stateDir, 'cache', 'superpowers');
  const skillDir = path.join(cacheDir, 'skills', 'packdemo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(cacheDir, '.claude', 'skills', 'packdemo'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: packdemo\ndescription: From a pack\n---\n');
  fs.writeFileSync(path.join(cacheDir, '.claude', 'skills', 'packdemo', 'SKILL.md'), '---\nname: packdemo\ndescription: Copy\n---\n');
  const git = (...args) => execFileSync('git', ['-C', cacheDir, ...args], { stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  git('init', '--quiet');
  git('add', '-A');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'seed');

  const planRes = await api('/api/plan', {
    method: 'POST',
    body: { kind: 'install', packId: 'superpowers', skills: ['skills/packdemo'], rootId: 'claude-global', mode: 'copy' },
  });
  assert.equal(planRes.status, 200, planRes.text);
  const plan = json(planRes);
  assert.equal(plan.ops[0].op, 'create');
  assert.match(plan.ops[0].dest, /^~\/\.claude\/skills\/packdemo$/);

  const applied = await api('/api/apply', { method: 'POST', body: { planId: plan.id } });
  assert.equal(applied.status, 200, applied.text);
  const installed = path.join(home, '.claude', 'skills', 'packdemo', 'SKILL.md');
  assert.match(fs.readFileSync(installed, 'utf8'), /From a pack/);
  const pack = json(await api('/api/packs')).packs.find(p => p.id === 'superpowers');
  assert.ok(pack.cached, 'cached pack reported');
  assert.deepEqual(pack.cached.skills.map(s => s.name), ['packdemo']);
  assert.deepEqual(pack.cached.skills[0].installedIn, ['claude-global']);

  const undoRes = await api('/api/undo', { method: 'POST', body: { txId: json(applied).txId } });
  assert.equal(undoRes.status, 200, undoRes.text);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'packdemo')), false);

  const badRoot = await api('/api/plan', {
    method: 'POST',
    body: { kind: 'install', packId: 'superpowers', skills: ['skills/packdemo'], rootId: 'codex-system' },
  });
  assert.equal(badRoot.status, 400);
  assert.match(json(badRoot).error, /plugin/);
});

test('GET / serves the manager page when it exists', { skip: !fs.existsSync(UI_INDEX) && 'manager/ui/index.html not present yet' }, async () => {
  const res = await request('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.text, fs.readFileSync(UI_INDEX, 'utf8'));
});

test('static paths cannot escape the ui folder', async () => {
  const res = await request('/../server.mjs');
  assert.equal(res.status, 404);
});

test('canonicalPackSkills keeps one entry per name with the preferred path', () => {
  const skill = (relPath) => ({ name: 'impeccable', description: 'd', relPath, dir: '/x/' + relPath });
  const out = canonicalPackSkills([
    skill('cursor-plugin/skills/impeccable'),
    skill('.claude/skills/impeccable'),
    skill('plugin/skills/impeccable'),
    skill('.agents/skills/impeccable'),
    { name: 'other', description: '', relPath: 'skills/other', dir: '/x/skills/other' },
    { name: 'other', description: '', relPath: 'deep/skills/other', dir: '/x/deep' },
  ]);
  assert.equal(out.length, 2);
  const imp = out.find(s => s.name === 'impeccable');
  assert.equal(imp.relPath, '.agents/skills/impeccable');
  assert.deepEqual(imp.alsoAt.sort(), ['.claude/skills/impeccable', 'cursor-plugin/skills/impeccable', 'plugin/skills/impeccable']);
  const other = out.find(s => s.name === 'other');
  assert.equal(other.relPath, 'skills/other');
  assert.deepEqual(other.alsoAt, ['deep/skills/other']);
});

test('tildify replaces only whole home-path segments', () => {
  const out = tildify({ a: `${home}/.claude`, b: `${home}2/x`, c: [home] }, home);
  assert.equal(out.a, '~/.claude');
  assert.equal(out.b, `${home}2/x`);
  assert.equal(out.c[0], '~');
});

test('CLI list --json works with HOME and AGENT_COMPASS_HOME set to temp dirs', async () => {
  const { stdout } = await new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, 'list', '--json'], {
      cwd: base,
      env: { ...process.env, HOME: home, AGENT_COMPASS_HOME: stateDir },
    }, (err, out, errOut) => (err ? reject(Object.assign(err, { stderr: errOut })) : resolve({ stdout: out })));
  });
  const data = JSON.parse(stdout);
  const demo = data.groups.find(g => g.name === 'demo');
  assert.ok(demo, 'demo listed by the CLI');
  assert.equal(demo.installed.claude, true);
  assert.ok(!stdout.includes(home), 'CLI output is ~-ified');
});

test('CLI with an unknown command exits 2 with one error line', async () => {
  const result = await new Promise(resolve => {
    execFile(process.execPath, [CLI, 'nonsense'], { env: { ...process.env, HOME: home, AGENT_COMPASS_HOME: stateDir } }, (err, out, errOut) => {
      resolve({ code: err ? err.code : 0, errOut });
    });
  });
  assert.equal(result.code, 2);
  assert.match(result.errOut.split('\n')[0], /Unknown command "nonsense"/);
});
