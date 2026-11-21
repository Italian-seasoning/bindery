import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

try {
  const event = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (event.hook_event_name !== 'UserPromptSubmit' || !event.session_id || !event.prompt?.trim()) process.exit(0);
  const dir = path.join(os.tmpdir(), `codex-starter-${process.getuid()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = path.join(dir, crypto.createHash('sha256').update(event.session_id).digest('hex'));
  try { fs.writeFileSync(marker, '', { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code === 'EEXIST') process.exit(0); throw e; }
  const prompt = event.prompt.toLowerCase();
  const registry = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'models.json'), 'utf8'));
  let category = 'everyday';
  if (/\b(robotics|robot|advanced 3d)\b/.test(prompt)) category = 'robotics';
  else if (/\b(3d|three\.js|threejs|webgl|interactive visual)\b/.test(prompt)) category = 'visual';
  else if (/\b(complex debug|difficult bug|hard bug|root cause)\b/.test(prompt)) category = 'debug';
  else if (/\b(architecture|architectural)\b/.test(prompt)) category = 'architecture';
  else if (/\b(mechanical|deterministic|rename only)\b/.test(prompt)) category = 'mechanical';
  else if (/\b(explor(e|ation)|read.only|find files|repository search)\b/.test(prompt)) category = 'exploration';
  else if (/\b(lego.brick|repetitive implementation|explicit implementation)\b/.test(prompt)) category = 'implementation';
  else if (/\b(ui|ux|frontend|front.end|website|design|css)\b/.test(prompt)) category = 'ui';
  const route = registry.routes[category];
  const profile = registry.models[route.model];
  const advice = `At the start of the first reply, give a small two-line visual suggestion: "Model: [name] · [effort] | Usage: [low/medium/high estimate]" then one short, friendly reason. Use plain language and no charts that imply measured usage. Mention a cheaper alternative only if useful or asked. Recommended: ${route.model} ${route.effort}; reason: ${route.reason}; rough impact: ${route.impact}; alternative: ${route.fallback}. Internal context suggestion ${profile.window}/${profile.compact}, skill ${route.skill}; don't recite these settings or skill names unless helpful. Availability is unverified; active model ${event.model || 'unknown'}. Preserve explicit choices and higher effort, continue immediately, never switch models or block work. Default to no subagents; verify the result.`;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: advice } }));
} catch { process.exit(0); }
