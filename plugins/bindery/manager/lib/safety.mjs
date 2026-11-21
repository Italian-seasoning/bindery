import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|ps1|bat|cmd)$/i;
const BINARY_EXT = new Set(['.exe', '.dll', '.so', '.dylib', '.bin']);
const HOOK_NAME = /^(hooks\.json|settings\.json|config\.toml)$/i;
const LICENSE_NAME = /^(LICENSE|COPYING)/i;
const SNIFF_BYTES = 8 * 1024;
const EXCERPT_MAX = 120;
const LEVEL_ORDER = { high: 0, medium: 1, info: 2 };

// Text rules. Patterns are linear-time: no nested unbounded quantifiers.
export const RULES = [
  {
    rule: 'pipe-to-shell', level: 'high',
    test: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?)\b/i,
    message: 'Downloads and runs code from the internet.',
  },
  {
    rule: 'destructive-delete', level: 'high',
    test: /^\s*(?:sudo\s+)?rm\s+-(?:rf|fr)\s+(?:\/|~\/?|\$HOME\/?|\*)(?:\s|$)/i,
    message: 'Can delete large parts of your disk.',
  },
  {
    rule: 'secrets-read', level: 'high',
    test: /(?:~|\$HOME)\/\.ssh\b|\bid_rsa\b|~\/\.aws\/credentials|\.netrc\b|security\s+find-(?:generic|internet)-password|Library\/Keychains|Chrome\/User Data|Library\/Application Support\/Google\/Chrome|Firefox\/Profiles/i,
    message: 'Reads credentials or private keys.',
  },
  {
    rule: 'encoded-exec', level: 'high',
    test: /base64\s+(?:-d|--decode|-D)\b[^|\n]*\|\s*(?:sh|bash|zsh|python3?|eval)\b|\beval\b[^\n]*base64\s+(?:-d|--decode|-D)\b|\beval\s*\(\s*atob\s*\(|\bexec\s*\(\s*base64/i,
    message: 'Runs hidden, encoded code.',
  },
  {
    rule: 'disable-safety', level: 'high',
    test: /--dangerously-skip-permissions|approval_policy\s*=\s*["']never["']|sandbox_mode\s*=\s*["']danger-full-access["']|\bchmod\s+(?:-R\s+)?777\b/i,
    message: 'Turns off safety prompts or permissions.',
  },
  {
    rule: 'script-file', level: 'medium',
    test: SCRIPT_EXT,
    message: 'Contains a script. Read it before running.',
  },
  {
    rule: 'network-url', level: 'medium',
    test: /https?:\/\/\S/i,
    message: 'Script contacts the network.',
  },
  {
    rule: 'hook-config', level: 'medium',
    test: /^(?:hooks\.json|settings\.json|config\.toml)$|"hooks"\s*:/i,
    message: 'Changes app hooks or settings.',
  },
  {
    rule: 'long-line', level: 'medium',
    test: /^.{1001,}$/,
    message: 'Very long line; may hide code.',
  },
  {
    rule: 'no-license', level: 'info',
    test: LICENSE_NAME,
    message: 'No license file.',
  },
];

const RULE_BY_NAME = Object.fromEntries(RULES.map(r => [r.rule, r]));

function excerptOf(text) {
  const t = String(text ?? '').trim();
  return t.length > EXCERPT_MAX ? `${t.slice(0, EXCERPT_MAX - 3)}...` : t;
}

function makeFinding(level, rule, file, line, excerpt, message) {
  return { level, rule, file, line, excerpt: excerptOf(excerpt), message };
}

function dedupe(findings) {
  const seen = new Map();
  for (const f of findings) {
    const key = `${f.rule}\u0000${f.file ?? ''}\u0000${f.line ?? ''}`;
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()];
}

function compareFindings(a, b) {
  const byLevel = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];
  if (byLevel) return byLevel;
  const fa = a.file ?? '';
  const fb = b.file ?? '';
  if (fa !== fb) return fa < fb ? -1 : 1;
  return (a.line ?? 0) - (b.line ?? 0);
}

// Pure: applies RULES to one file's text. relPath uses forward slashes.
export function scanFile(text, relPath) {
  const file = String(relPath);
  const base = path.posix.basename(file);
  const ext = path.posix.extname(base).toLowerCase();
  const isScript = SCRIPT_EXT.test(base);
  const isMarkdown = ext === '.md';
  const isJson = ext === '.json';
  const nameIsHookConfig = HOOK_NAME.test(base);
  const findings = [];

  const fileRule = (rule) => {
    const r = RULE_BY_NAME[rule];
    findings.push(makeFinding(r.level, rule, file, null, base, r.message));
  };
  if (isScript) fileRule('script-file');
  if (nameIsHookConfig) fileRule('hook-config');

  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const lineNo = i + 1;
    for (const r of RULES) {
      if (r.rule === 'script-file' || r.rule === 'no-license') continue;
      if (r.rule === 'network-url' && !isScript) continue;
      if (r.rule === 'hook-config' && (!isJson || nameIsHookConfig)) continue;
      if (r.rule === 'long-line' && isMarkdown) continue;
      if (r.rule === 'long-line') {
        if (raw.length > 1000) findings.push(makeFinding(r.level, r.rule, file, lineNo, raw, r.message));
        continue;
      }
      if (r.test.test(raw)) findings.push(makeFinding(r.level, r.rule, file, lineNo, raw, r.message));
    }
  }
  return dedupe(findings);
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// Read-only folder scan. Never executes, requires or imports anything it finds.
export function scanFolder(dir, { maxFiles = 500, maxBytes = 512 * 1024 } = {}) {
  const root = fs.realpathSync(dir);
  const findings = [];
  let filesScanned = 0;
  let truncated = false;
  let stop = false;

  const rootEntries = fs.readdirSync(root, { withFileTypes: true });
  if (!rootEntries.some(e => !e.isDirectory() && RULE_BY_NAME['no-license'].test.test(e.name))) {
    const r = RULE_BY_NAME['no-license'];
    findings.push(makeFinding(r.level, r.rule, null, null, '', r.message));
  }

  const linkTargetOf = (full) => {
    try {
      return fs.readlinkSync(full);
    } catch {
      return '';
    }
  };

  const checkLink = (full, rel) => {
    let target;
    try {
      target = fs.realpathSync(full);
    } catch {
      target = path.resolve(path.dirname(full), linkTargetOf(full));
    }
    if (!isInside(root, target)) {
      findings.push(makeFinding('medium', 'symlink', rel, null, linkTargetOf(full), 'Links outside this folder.'));
    }
  };

  const scanEntry = (full, rel) => {
    let buf;
    let mode = 0;
    let size = 0;
    try {
      const st = fs.statSync(full);
      mode = st.mode;
      size = st.size;
      const readLen = Math.min(size, maxBytes);
      if (size > maxBytes) truncated = true;
      const fd = fs.openSync(full, 'r');
      try {
        const chunk = Buffer.alloc(readLen);
        const n = fs.readSync(fd, chunk, 0, readLen, 0);
        buf = chunk.subarray(0, n);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }

    const ext = path.extname(rel).toLowerCase();
    const hasNul = buf.subarray(0, SNIFF_BYTES).includes(0);
    const isBinary = hasNul || BINARY_EXT.has(ext);
    if (isBinary) {
      const execLike = (mode & 0o111) !== 0 || BINARY_EXT.has(ext);
      if (execLike) {
        findings.push(makeFinding('medium', 'binary', rel, null, path.posix.basename(rel),
          'Program or library file; its contents are not read.'));
      }
      return;
    }
    findings.push(...scanFile(buf.toString('utf8'), rel));
  };

  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const visit = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true }).sort(byName);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (stop) return;
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(full);
        continue;
      }
      if (entry.isSymbolicLink()) {
        checkLink(full, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (filesScanned >= maxFiles) {
        truncated = true;
        stop = true;
        return;
      }
      filesScanned++;
      scanEntry(full, rel);
    }
  };
  visit(root);

  const unique = dedupe(findings).sort(compareFindings);
  let level = 'clean';
  for (const f of unique) {
    if (level === 'clean' || LEVEL_ORDER[f.level] < LEVEL_ORDER[level]) level = f.level;
  }
  return { level, findings: unique, filesScanned, truncated };
}
