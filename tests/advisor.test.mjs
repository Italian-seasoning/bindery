import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-test-'));
const hook = fileURLToPath(new URL('../plugins/bindery/hooks/advisor.mjs', import.meta.url));
const call = event => spawnSync(process.execPath, [hook], { input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, TMPDIR: tmp } });
try {
  const event = { hook_event_name: 'UserPromptSubmit', session_id: 'one', prompt: 'build a 3d scene', model: 'active' };
  const result = call(event);
  assert.equal(result.status, 0);
  const guidance = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(guidance, /gpt-6.2-sol/);
  assert.match(guidance, /two-line visual/);
  assert.match(guidance, /never switch models/);
  assert.equal(call(event).stdout, '');
  assert.match(call({ ...event, session_id: 'two', prompt: 'explore the repository' }).stdout, /gpt-6-luna/);
  console.log('Advisor tests passed.');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
