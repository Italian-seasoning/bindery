// Private "Want to try" list: links the user saved to look at later (a Reel, a repo, a post).
// Stored only in <stateDir>/want.json. Nothing here fetches a link or sends data anywhere.
// Removed entries are kept in <stateDir>/backups, and a damaged list is moved there too.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STATUSES = ['saved', 'reviewed', 'added', 'dismissed'];
const LIMITS = { link: 2048, title: 120, creator: 80, note: 1000 };
const SHORTHAND_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const REPO_HELP = 'The source repository must be an https link, such as https://github.com/owner/repo, or owner/repo.';
const NOT_FOUND = 'That item is no longer in your list. Refresh the list and try again.';
const SAVE_FAILED = 'Bindery could not save your want list. Check the folder permissions, then try again.';

function requireState(stateDir) {
  if (!stateDir) throw new Error('The Bindery folder location is missing.');
  return stateDir;
}

const wantFile = stateDir => path.join(stateDir, 'want.json');
const backupsDir = stateDir => path.join(stateDir, 'backups');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const nowIso = () => new Date().toISOString();

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const onHost = (host, domain) => host === domain || host.endsWith(`.${domain}`);

export function sourceOf(url) {
  const host = hostOf(url);
  if (onHost(host, 'instagram.com')) return 'instagram';
  if (onHost(host, 'github.com')) return 'github';
  return 'web';
}

// Used when the person leaves the title empty: owner/repo for GitHub, "Instagram reel" for Reels, else the hostname.
export function defaultTitle(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);
  if (onHost(host, 'github.com') && segs.length >= 2) {
    return `${segs[0]}/${segs[1].replace(/\.git$/, '')}`.slice(0, LIMITS.title);
  }
  if (onHost(host, 'instagram.com') && /^reels?$/.test(segs[0] ?? '')) return 'Instagram reel';
  return u.hostname;
}

// Trims text and enforces its length. Missing values become ''.
function text(value, label, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`The ${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`The ${label} must be ${max} characters or fewer.`);
  return trimmed;
}

function cleanLink(value) {
  const raw = text(value, 'link', LIMITS.link);
  if (!raw) throw new Error('Paste a link to save.');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('That does not look like a web link. Paste the full address, starting with https://.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only web links (http or https) can be saved.');
  }
  return raw;
}

// Empty stays empty. owner/repo becomes https://github.com/owner/repo. Other values must be https links.
function cleanRepo(value) {
  const raw = text(value, 'source repository', LIMITS.link);
  if (!raw) return '';
  const short = SHORTHAND_RE.exec(raw);
  if (short) return `https://github.com/${short[1]}/${short[2]}`;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(REPO_HELP);
  }
  const segs = u.pathname.split('/').filter(Boolean);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !u.hostname
    || segs.length < 2 || segs.some(s => s === '..' || s === '.')) {
    throw new Error(REPO_HELP);
  }
  return `https://${u.hostname}/${segs.join('/')}`;
}

function parseItems(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return null;
  const ok = parsed.items.every(item => item && typeof item === 'object'
    && typeof item.id === 'string' && typeof item.url === 'string' && typeof item.createdAt === 'string');
  return ok ? parsed.items : null;
}

// Writes a file through a temp file and a rename, so a crash never leaves half a file behind.
function writeFileAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
    throw new Error(SAVE_FAILED);
  }
}

// A damaged want.json is moved into backups and the list starts empty. It is never deleted.
function quarantine(stateDir, file) {
  const dir = backupsDir(stateDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = `want-corrupt-${stamp()}`;
  let dest = path.join(dir, `${base}.json`);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `${base}-${n}.json`);
  try {
    fs.renameSync(file, dest);
  } catch {
    throw new Error('Your want list could not be read, and Bindery could not move it aside. Check the folder permissions, then try again.');
  }
}

function readList(stateDir) {
  const file = wantFile(stateDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error('Bindery could not read your want list. Check the folder permissions, then try again.');
  }
  const items = parseItems(raw);
  if (items) return items;
  quarantine(stateDir, file);
  return [];
}

function writeList(stateDir, items) {
  writeFileAtomic(wantFile(stateDir), `${JSON.stringify({ items }, null, 2)}\n`);
}

// Adds the removed entry to a backup file. Reuses this timestamp's file when it already holds a list.
function appendBackup(stateDir, entry) {
  const dir = backupsDir(stateDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = `want-${stamp()}`;
  let file = path.join(dir, `${base}.json`);
  let list = [];
  for (let n = 2; fs.existsSync(file); n++) {
    let parsed = null;
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(value)) parsed = value;
    } catch {
      parsed = null;
    }
    if (parsed) {
      list = parsed;
      break;
    }
    file = path.join(dir, `${base}-${n}.json`);
  }
  list.push(entry);
  writeFileAtomic(file, `${JSON.stringify(list, null, 2)}\n`);
}

// Newest first.
export function listWant({ stateDir } = {}) {
  return readList(requireState(stateDir))
    .slice()
    .reverse()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export function addWant({ stateDir, url, title, creator, repo, note } = {}) {
  const list = readList(requireState(stateDir));
  const link = cleanLink(url);
  if (list.some(item => item.url === link)) throw new Error('This link is already in your list.');
  const cleanTitle = text(title, 'title', LIMITS.title);
  const cleanCreator = text(creator, 'creator', LIMITS.creator);
  const cleanRepoUrl = cleanRepo(repo);
  const cleanNote = text(note, 'note', LIMITS.note);
  let id;
  do {
    id = crypto.randomBytes(6).toString('hex');
  } while (list.some(item => item.id === id));
  const now = nowIso();
  const item = {
    id,
    url: link,
    title: cleanTitle || defaultTitle(link),
    creator: cleanCreator,
    repo: cleanRepoUrl,
    note: cleanNote,
    status: 'saved',
    source: sourceOf(link),
    createdAt: now,
    updatedAt: now,
  };
  list.push(item);
  writeList(stateDir, list);
  return item;
}

// Only title, creator, repo, note and status can change. An empty title goes back to the derived one.
export function updateWant({ stateDir, id, ...fields } = {}) {
  const list = readList(requireState(stateDir));
  const index = list.findIndex(item => item.id === id);
  if (index === -1) throw new Error(NOT_FOUND);
  const current = list[index];
  const next = { ...current, updatedAt: nowIso() };
  if (fields.title !== undefined) next.title = text(fields.title, 'title', LIMITS.title) || defaultTitle(current.url);
  if (fields.creator !== undefined) next.creator = text(fields.creator, 'creator', LIMITS.creator);
  if (fields.repo !== undefined) next.repo = cleanRepo(fields.repo);
  if (fields.note !== undefined) next.note = text(fields.note, 'note', LIMITS.note);
  if (fields.status !== undefined) {
    if (!STATUSES.includes(fields.status)) throw new Error(`Choose one of: ${STATUSES.join(', ')}.`);
    next.status = fields.status;
  }
  list[index] = next;
  writeList(stateDir, list);
  return next;
}

// The removed entry is written to a backup file first, so nothing is lost if the list write fails.
export function removeWant({ stateDir, id } = {}) {
  const list = readList(requireState(stateDir));
  const index = list.findIndex(item => item.id === id);
  if (index === -1) throw new Error(NOT_FOUND);
  const [removed] = list.splice(index, 1);
  appendBackup(stateDir, { ...removed, removedAt: nowIso() });
  writeList(stateDir, list);
  return removed;
}

const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const escapeLabel = value => oneLine(value).replace(/[\\[\]]/g, ch => `\\${ch}`);
const escapeLink = value => value.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');

function bullet(item) {
  const parts = [`[${escapeLabel(item.title) || escapeLabel(item.url)}](${escapeLink(item.url)})`];
  if (item.creator) parts.push(`by ${oneLine(item.creator)}`);
  if (item.repo) parts.push(`repo: ${item.repo}`);
  parts.push(`status: ${item.status}`);
  if (item.note) parts.push(`note: ${oneLine(item.note)}`);
  return `- ${parts.join(' · ')}`;
}

export function exportWant({ stateDir } = {}) {
  const items = listWant({ stateDir });
  const lines = ['# Want to try', ''];
  if (items.length === 0) lines.push('Nothing saved yet.');
  for (const item of items) lines.push(bullet(item));
  return `${lines.join('\n')}\n`;
}
