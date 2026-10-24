#!/usr/bin/env node
// Claude Code hook: keeps an agent from stopping, or committing, while a law is failed, open or tampered with.
//   PreToolUse (Bash): blocks `git commit` when `tslaws check` fails.
//   Stop: sends the agent back to work when `tslaws check` fails (once, so a stuck run still ends).
// Exit status 2 with a message on stderr is how Claude Code feeds the reason back to the agent.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
const event = input.hook_event_name;

if (event === 'PreToolUse') {
  const command = input.tool_input?.command ?? '';
  if (input.tool_name !== 'Bash' || !/\bgit\s+commit\b/.test(command)) process.exit(0);
} else if (event === 'Stop') {
  if (input.stop_hook_active) process.exit(0);
} else {
  process.exit(0);
}

// The agent must not be able to accept its own edits to the laws.
const cwd = input.cwd ?? process.cwd();
const cli = join(dirname(createRequire(join(cwd, 'noop.js')).resolve('tslaws/package.json')), 'bin', 'tslaws.js');
const run = spawnSync(process.execPath, [cli, 'check'], {
  cwd,
  encoding: 'utf8',
  env: { ...process.env, TSLAWS_AGENT: '1' },
});
if (run.status === 0) process.exit(0);
process.stderr.write(
  `tslaws check failed. Fix the code, not the laws. Laws are the human's side; to propose a new or changed law, put it in a *.proposed.laws.ts file.\n\n${run.stdout}${run.stderr}`,
);
process.exit(2);
