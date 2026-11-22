// Builds the process command line for tslaws. No vscode import; `exists` is injectable for tests.
//
// Nothing here ever goes through a shell: a workspace controls file names, settings and node_modules, and a shell would
// let a crafted name or setting run other commands. tslaws is started with `node <entry.js>` (or a native executable
// named in the settings), with every argument passed as its own argv entry.

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {{root: string, ceiling?: string, executable?: string, args?: string[], exists?: (p: string) => boolean}} o
 *   `root` is the directory the command runs in; with a `ceiling` (the workspace folder) tslaws is also looked for in the
 *   node_modules of each directory above `root` up to it, which is where a monorepo's package manager puts it
 * @param {string[]} sub subcommand and its arguments, e.g. ['check', '--json']
 * @returns {{command: string, args: string[], shell: false} | {error: string}}
 */
function resolveCommand(o, sub) {
  const exists = o.exists ?? fs.existsSync;
  const extra = Array.isArray(o.args) ? o.args.map(String) : [];
  const executable = typeof o.executable === 'string' ? o.executable : '';
  if (executable !== '') {
    if (/\.(cmd|bat)$/i.test(executable))
      return {
        error: 'tslaws.executable cannot be a .cmd or .bat shim; point it at tslaws.js or a native executable.',
      };
    if (/\.[cm]?js$/i.test(executable)) return { command: 'node', args: [executable, ...sub, ...extra], shell: false };
    return { command: executable, args: [...sub, ...extra], shell: false };
  }
  const stop = o.ceiling === undefined ? o.root : o.ceiling;
  for (let dir = o.root; ; dir = path.dirname(dir)) {
    const entry = path.join(dir, 'node_modules', 'tslaws', 'bin', 'tslaws.js');
    if (exists(entry)) return { command: 'node', args: [entry, ...sub, ...extra], shell: false };
    const parent = path.dirname(dir);
    if (path.normalize(dir).toLowerCase() === path.normalize(stop).toLowerCase() || parent === dir) break;
  }
  return { error: 'tslaws is not installed in this workspace. Run `npm i -D tslaws` (or set tslaws.executable).' };
}

/** Shell text of the accept command, to type into a terminal and never run. */
function acceptCommandText(files = []) {
  return ['npx', 'tslaws', 'accept', ...files].join(' ');
}

export { resolveCommand, acceptCommandText };
