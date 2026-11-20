// Local HTTP server for the Agent Compass manager. Importing this module has no side effects:
// nothing listens, opens or reads until startServer() is called.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanAll } from './lib/scan.mjs';
import { loadCatalog, fetchPack, cachedPack } from './lib/catalog.mjs';
import { planInstallMany, planRemove, applyPlan, undo, history } from './lib/changes.mjs';
import { planShare, shareStatus } from './lib/share.mjs';

const MANAGER_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(MANAGER_DIR, 'ui');
const TOKEN_HEADER = 'x-compass-token';
const MAX_BODY = 64 * 1024;
const SKILL_MD_CAP = 64 * 1024;
const FILE_LIST_CAP = 200;
const DIR_WALK_CAP = 2000;
const PLAN_CAP = 50;
const SKILL_ID_CAP = 200;
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const BYE_DELAY_MS = 1500;
const LOCK_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EBUSY']);
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
// Most-preferred first. Index into this list is the rank; anything else ranks last.
const PACK_PATH_PREFERENCE = [/^skills\/[^/]+$/, /^\.agents\/skills\//, /^\.claude\/skills\//];

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map(item => mapStrings(item, fn));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, fn);
    return out;
  }
  return value;
}

// Replaces the home folder, both as typed and as its resolved real path, with "~" in every string.
// The boundary check keeps "/Users/ann" from matching "/Users/anne".
export function tildify(value, home = os.homedir()) {
  const forms = new Set([path.resolve(home)]);
  try {
    forms.add(fs.realpathSync(home));
  } catch {
    // home does not exist: the plain form is enough
  }
  const patterns = [...forms]
    .sort((a, b) => b.length - a.length)
    .map(form => new RegExp(`${escapeRe(form)}(?![A-Za-z0-9_-])`, 'g'));
  return mapStrings(value, text => patterns.reduce((out, re) => out.replace(re, '~'), text));
}

// One canonical entry per skill name. Preference: skills/<x> at repo top, then .agents/skills,
// then .claude/skills, then anything else; the shortest path wins ties.
export function canonicalPackSkills(skills = []) {
  const byName = new Map();
  for (const skill of skills) {
    const key = String(skill.name).toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(skill);
  }
  const rank = rel => {
    const index = PACK_PATH_PREFERENCE.findIndex(re => re.test(rel));
    return index === -1 ? PACK_PATH_PREFERENCE.length : index;
  };
  const out = [...byName.values()].map(list => {
    const [best, ...rest] = [...list].sort((a, b) =>
      rank(a.relPath) - rank(b.relPath)
      || a.relPath.length - b.relPath.length
      || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    return { ...best, alsoAt: rest.map(skill => skill.relPath) };
  });
  return out.sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

export function groupsWithInstalled(groups) {
  return groups.map(group => ({
    ...group,
    installed: {
      claude: group.hosts.includes('claude'),
      codex: group.hosts.includes('codex'),
      agents: group.hosts.includes('agents'),
    },
  }));
}

// lower-cased skill name -> root ids where a skill of that name is installed now.
function installIndex(scan) {
  const map = new Map();
  for (const skill of scan.skills) {
    const key = skill.name.toLowerCase();
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(skill.rootId);
  }
  return new Map([...map].map(([key, ids]) => [key, [...ids]]));
}

function packView(pack, index) {
  return {
    ...pack,
    skills: canonicalPackSkills(pack.skills).map(skill => ({
      ...skill,
      installedIn: index.get(skill.name.toLowerCase()) ?? [],
    })),
  };
}

// Turns an error from a lib module into an API error. Lib messages are already plain English.
function clientError(err, status = 400) {
  if (err instanceof ApiError) return err;
  if (err && LOCK_CODES.has(err.code)) {
    return new ApiError(500, 'The system denied access to that folder. Check its permissions, then try again.');
  }
  const message = err instanceof Error && err.message ? err.message : 'Something went wrong. Try again.';
  return new ApiError(status, message);
}

function guard(fn, status = 400) {
  try {
    return fn();
  } catch (err) {
    throw clientError(err, status);
  }
}

// Builds an install plan from a fetched pack's skills. Shared by the server and the CLI.
export function planPackInstall({ pack, cached, relPaths, rootId, mode = 'copy', roots = [] }) {
  if (!Array.isArray(relPaths) || relPaths.length === 0) {
    throw new ApiError(400, 'Choose at least one skill to install.');
  }
  const root = roots.find(r => r.id === rootId);
  if (!root) throw new ApiError(400, 'Choose a skill location from the list.');
  if (root.scope === 'plugin') {
    throw new ApiError(400, `${root.label} is managed by a plugin. Choose a Claude Code, Codex or Agents location instead.`);
  }
  if (root.readOnly || root.writable === false) {
    throw new ApiError(400, `${root.label} is read-only. Choose another location.`);
  }
  const items = relPaths.map(rel => {
    if (!cached.skills.some(skill => skill.relPath === rel)) {
      throw new ApiError(400, 'That skill is not in this pack. Fetch the pack again and choose from its list.');
    }
    const src = path.join(cached.dir, rel);
    const name = rel === '.' ? pack.id : path.basename(src);
    return { src, name, targetRoot: root, mode };
  });
  return guard(() => planInstallMany(items));
}

function hostAllowed(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function tokenMatches(given, token) {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new ApiError(400, 'That request is too large.'));
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new ApiError(400, 'The request was not valid JSON.'));
      }
    });
    req.on('error', () => reject(new ApiError(400, 'The request was interrupted. Try again.')));
  });
}

function readCapped(file, cap) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(cap + 1);
    const n = fs.readSync(fd, buf, 0, cap + 1, 0);
    return { text: buf.toString('utf8', 0, Math.min(n, cap)), truncated: n > cap };
  } finally {
    fs.closeSync(fd);
  }
}

// Bounded breadth-first list of file paths (relative, forward slashes) inside a skill folder.
function listFiles(dir) {
  const out = [];
  const queue = [''];
  let dirs = 0;
  while (queue.length && out.length < FILE_LIST_CAP && dirs < DIR_WALK_CAP) {
    const rel = queue.shift();
    dirs += 1;
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) queue.push(child);
      else if (entry.isFile()) {
        out.push(child);
        if (out.length >= FILE_LIST_CAP) break;
      }
    }
  }
  return out;
}

function skillDetail(id, scan) {
  const skill = scan.skills.find(s => s.id === id);
  if (!skill) throw new ApiError(404, 'That skill was not found. It may have been removed. Refresh the list.');
  let skillMd = '';
  let skillMdTruncated = false;
  let files = [];
  if (!skill.broken) {
    const mdName = ['SKILL.md', 'skill.md'].find(name => {
      try {
        return fs.statSync(path.join(skill.path, name)).isFile();
      } catch {
        return false;
      }
    });
    if (mdName) {
      try {
        ({ text: skillMd, truncated: skillMdTruncated } = readCapped(path.join(skill.path, mdName), SKILL_MD_CAP));
      } catch {
        skillMd = '';
      }
    }
    files = listFiles(skill.path);
  }
  return { ...skill, skillMd, skillMdTruncated, files };
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new ApiError(405, 'That action is not supported here.');
  }
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new ApiError(400, 'That address is not valid. Open the link printed in your terminal.');
  }
  if (rel.includes('..') || rel.includes('\0')) throw new ApiError(404, 'That page does not exist.');
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(UI_DIR, rel);
  if (!file.startsWith(UI_DIR + path.sep)) throw new ApiError(404, 'That page does not exist.');
  let isFile = false;
  try {
    isFile = fs.statSync(file).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw new ApiError(404, 'The Agent Compass screen is not available in this copy. Open the link printed in your terminal.');
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': body.length,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendJson(res, status, body, home) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(tildify(body, home)));
}

function sendError(res, err, home) {
  const apiError = err instanceof ApiError ? err : new ApiError(500, 'Something went wrong. Try again, and check the terminal if it keeps happening.');
  sendJson(res, apiError.status, { error: apiError.message }, home);
}

// Opens the manager in a window: Chrome app window on macOS when installed, else the default browser.
// Detached and fire-and-forget: failures are ignored, the URL is always printed by the caller.
export function openInBrowser(url, { platform = process.platform, exists = fs.existsSync } = {}) {
  let cmd;
  let args;
  let verbatim = false;
  if (platform === 'darwin') {
    cmd = 'open';
    args = exists('/Applications/Google Chrome.app')
      ? ['-na', 'Google Chrome', '--args', `--app=${url}`, '--window-size=1040,760']
      : [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
    verbatim = true;
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: verbatim });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no opener available: the URL is printed instead
  }
}

export async function startServer({
  home = os.homedir(),
  cwd = process.cwd(),
  stateDir,
  port = 0,
  open = true,
  idleMs = DEFAULT_IDLE_MS,
} = {}) {
  const ctx = {
    home: path.resolve(home),
    cwd: path.resolve(cwd),
    stateDir: path.resolve(stateDir || process.env.AGENT_COMPASS_HOME || path.join(home, '.agent-compass')),
  };
  const token = crypto.randomBytes(24).toString('hex');
  const plans = new Map();
  let boundPort = 0;
  let idleTimer = null;
  let byeTimer = null;
  let closing = null;

  const buildState = () => {
    const scan = scanAll({ home: ctx.home, cwd: ctx.cwd });
    const byId = new Map(scan.skills.map(s => [s.id, s]));
    return {
      ...scan,
      groups: groupsWithInstalled(scan.groups).map(g => ({ ...g, apps: shareStatus(g, byId) })),
      cwd: ctx.cwd,
      home: '~',
      stateDir: ctx.stateDir,
    };
  };

  const storePlan = plan => {
    if (plans.size >= PLAN_CAP) plans.delete(plans.keys().next().value);
    plans.set(plan.id, plan);
    return plan;
  };

  const planInstallFromPack = body => {
    const packId = body.packId;
    const pack = typeof packId === 'string' ? loadCatalog().packs.find(p => p.id === packId) : undefined;
    if (!pack) throw new ApiError(404, 'That pack is not in the catalog.');
    const cached = cachedPack(pack, { stateDir: ctx.stateDir });
    if (!cached) throw new ApiError(400, 'Fetch this pack first, then choose skills from it.');
    if (!Array.isArray(body.skills) || body.skills.length > SKILL_ID_CAP || !body.skills.every(s => typeof s === 'string')) {
      throw new ApiError(400, 'Choose at least one skill to install.');
    }
    if (body.mode !== undefined && body.mode !== 'copy' && body.mode !== 'symlink') {
      throw new ApiError(400, 'Choose either a copy or a link for the install.');
    }
    const roots = scanAll({ home: ctx.home, cwd: ctx.cwd }).roots;
    return planPackInstall({
      pack,
      cached,
      relPaths: [...new Set(body.skills)],
      rootId: body.rootId,
      mode: body.mode ?? 'copy',
      roots,
    });
  };

  const planRemoval = body => {
    const ids = body.skillIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > SKILL_ID_CAP || !ids.every(i => typeof i === 'string')) {
      throw new ApiError(400, 'Choose at least one skill to remove.');
    }
    const scan = scanAll({ home: ctx.home, cwd: ctx.cwd });
    let merged = null;
    for (const id of [...new Set(ids)]) {
      const skill = scan.skills.find(s => s.id === id);
      if (!skill) throw new ApiError(400, 'That skill is no longer installed. Refresh the list and try again.');
      if (skill.readOnly || skill.scope === 'plugin') {
        throw new ApiError(400, `${skill.name} comes from a plugin, so it cannot be removed here. Remove the plugin in its host app instead.`);
      }
      const root = scan.roots.find(r => r.id === skill.rootId);
      const plan = guard(() => planRemove({ skillPath: skill.path, root }));
      if (!merged) {
        merged = plan;
      } else {
        merged.ops.push(...plan.ops);
        merged.warnings = [...new Set([...merged.warnings, ...plan.warnings])];
        merged.label = [...new Set([merged.label, plan.label])].join(', ');
      }
    }
    return merged;
  };

  const planSharing = body => {
    const names = body.names;
    if (!Array.isArray(names) || names.length === 0 || names.length > SKILL_ID_CAP || !names.every(n => typeof n === 'string')) {
      throw new ApiError(400, 'Choose at least one skill.');
    }
    if (body.app !== 'claude' && body.app !== 'codex') throw new ApiError(400, 'Choose Claude Code or Codex.');
    if (typeof body.on !== 'boolean') throw new ApiError(400, 'Choose whether to turn the skill on or off.');
    if (body.mode !== undefined && body.mode !== 'copy' && body.mode !== 'symlink') {
      throw new ApiError(400, 'Choose either a link or a copy.');
    }
    const scan = scanAll({ home: ctx.home, cwd: ctx.cwd });
    const { plan, skipped } = guard(() => planShare({ scan, names, app: body.app, on: body.on, mode: body.mode ?? 'symlink' }));
    if (!plan) {
      const first = skipped[0];
      throw new ApiError(400, first ? `Nothing to change: ${first.name} ${first.reason}.` : 'Nothing to change.');
    }
    plan.skipped = skipped;
    return plan;
  };

  const handleApi = async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;
    const home = ctx.home;

    if (method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, buildState(), home);
    }
    if (method === 'GET' && pathname === '/api/skill') {
      const id = url.searchParams.get('id') || '';
      return sendJson(res, 200, skillDetail(id, scanAll({ home: ctx.home, cwd: ctx.cwd })), home);
    }
    if (method === 'GET' && pathname === '/api/packs') {
      const catalog = loadCatalog();
      const index = installIndex(scanAll({ home: ctx.home, cwd: ctx.cwd }));
      const packs = catalog.packs.map(pack => {
        const cached = cachedPack(pack, { stateDir: ctx.stateDir });
        return { ...pack, cached: cached ? packView(cached, index) : null };
      });
      return sendJson(res, 200, { checked: catalog.checked, note: catalog.note, packs }, home);
    }
    if (method === 'GET' && pathname === '/api/history') {
      return sendJson(res, 200, { changes: history({ stateDir: ctx.stateDir, home: ctx.home }) }, home);
    }

    const fetchMatch = /^\/api\/packs\/([^/]+)\/fetch$/.exec(pathname);
    if (method === 'POST' && fetchMatch) {
      let packId;
      try {
        packId = decodeURIComponent(fetchMatch[1]);
      } catch {
        throw new ApiError(404, 'That pack is not in the catalog.');
      }
      const pack = loadCatalog().packs.find(p => p.id === packId);
      if (!pack) throw new ApiError(404, 'That pack is not in the catalog.');
      let fetched;
      try {
        fetched = await fetchPack(pack, { stateDir: ctx.stateDir });
      } catch (err) {
        throw clientError(err, 500);
      }
      return sendJson(res, 200, packView(fetched, installIndex(scanAll({ home: ctx.home, cwd: ctx.cwd }))), home);
    }

    if (method !== 'POST') {
      if (['/api/plan', '/api/apply', '/api/undo', '/api/bye'].includes(pathname)) {
        throw new ApiError(405, 'That action needs a POST request.');
      }
      throw new ApiError(404, 'That address is not part of Agent Compass. Check the link and try again.');
    }

    const body = await readBody(req);
    if (pathname === '/api/plan') {
      let plan;
      if (body.kind === 'install') plan = planInstallFromPack(body);
      else if (body.kind === 'remove') plan = planRemoval(body);
      else if (body.kind === 'share') plan = planSharing(body);
      else throw new ApiError(400, 'Choose whether to install, remove or share skills.');
      return sendJson(res, 200, storePlan(plan), home);
    }
    if (pathname === '/api/apply') {
      const plan = typeof body.planId === 'string' ? plans.get(body.planId) : undefined;
      if (!plan) throw new ApiError(404, 'That plan has expired or was already used. Build the change again.');
      plans.delete(plan.id);
      const result = guard(() => applyPlan(plan, { stateDir: ctx.stateDir, home: ctx.home }));
      return sendJson(res, 200, { txId: result.txId, applied: result.applied, state: buildState() }, home);
    }
    if (pathname === '/api/undo') {
      if (typeof body.txId !== 'string') throw new ApiError(400, 'Choose a change to undo.');
      const result = guard(() => undo(body.txId, { stateDir: ctx.stateDir, home: ctx.home }));
      return sendJson(res, 200, { restored: result.restored, state: buildState() }, home);
    }
    if (pathname === '/api/bye') {
      sendJson(res, 200, { ok: true }, home);
      byeTimer = setTimeout(() => { close(); }, BYE_DELAY_MS);
      byeTimer.unref();
      return undefined;
    }
    throw new ApiError(404, 'That address is not part of Agent Compass. Check the link and try again.');
  };

  const handle = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const home = ctx.home;
    if (!hostAllowed(req.headers.host, boundPort)) {
      throw new ApiError(403, 'This request did not come from Agent Compass on this computer. Open the link printed in your terminal.');
    }
    // Any request other than a bye cancels a pending shutdown (a page reload).
    if (url.pathname !== '/api/bye') clearTimeout(byeTimer);
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    if (!tokenMatches(req.headers[TOKEN_HEADER], token)) {
      throw new ApiError(403, 'Open Agent Compass from the link printed in your terminal so it can check that you are the one using it.');
    }
    armIdle();
    return handleApi(req, res, url);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (!res.headersSent) sendError(res, err, ctx.home);
      else res.end();
    });
  });

  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { close(); }, idleMs);
    idleTimer.unref();
  };

  function close() {
    if (!closing) {
      clearTimeout(idleTimer);
      clearTimeout(byeTimer);
      closing = new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
    return closing;
  }

  await new Promise((resolve, reject) => {
    server.once('error', err => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Try again with a different --port.`));
      } else {
        reject(new Error('Agent Compass could not start its local server. Try again.'));
      }
    });
    server.listen(port, '127.0.0.1', resolve);
  });
  boundPort = server.address().port;
  armIdle();

  const url = `http://127.0.0.1:${boundPort}/?t=${token}`;
  if (open) openInBrowser(url);
  return { url, token, port: boundPort, close };
}
