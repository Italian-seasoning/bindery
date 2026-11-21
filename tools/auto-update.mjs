import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const action = process.argv[2];
const label = 'com.italian-seasoning.bindery-update';
const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
const domain = `gui/${process.getuid()}`;
if (process.platform !== 'darwin' || process.getuid() === 0 || !['enable', 'disable'].includes(action)) {
  console.error('Use: node auto-update.mjs enable|disable, as a normal macOS user.');
  process.exit(1);
}
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr.trim() || r.error?.message || `${cmd} failed`);
  return r.stdout.trim();
};
try {
  if (action === 'disable') {
    if (!fs.existsSync(plist)) { console.log('No Bindery schedule found.'); process.exit(0); }
    const status = spawnSync('/bin/launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' });
    if (status.status === 0) run('/bin/launchctl', ['bootout', `${domain}/${label}`]);
    fs.unlinkSync(plist);
    console.log('Automatic refresh disabled.');
  } else {
    if (fs.existsSync(plist)) throw new Error(`Schedule already exists: ${plist}`);
    const codex = run('/usr/bin/which', ['codex']);
    const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
    const env = { HOME: os.homedir(), PATH: process.env.PATH || '/usr/bin:/bin', ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) };
    const envXml = Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${escape(v)}</string>`).join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${escape(codex)}</string><string>plugin</string><string>marketplace</string><string>upgrade</string><string>bindery</string></array><key>EnvironmentVariables</key><dict>${envXml}</dict><key>StartCalendarInterval</key><dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>0</integer></dict></dict></plist>`;
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, xml, { flag: 'wx', mode: 0o600 });
    try { run('/usr/bin/plutil', ['-lint', plist]); run('/bin/launchctl', ['bootstrap', domain, plist]); }
    catch (error) { fs.unlinkSync(plist); throw error; }
    console.log('Daily marketplace refresh enabled. Changed hooks may still need review in /hooks.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
