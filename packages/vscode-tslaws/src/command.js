'use strict';

// Builds the process command line for tslaws. No vscode import; `exists` is injectable for tests.
//
// Nothing here ever goes through a shell: a workspace controls file names, settings and node_modules, and a shell would
// let a crafted name or setting run other commands. tslaws is started with `node <entry.js>` (or a native executable
// named in the settings), with every argument passed as its own argv entry.

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {{root: string, executable?: string, args?: string[], exists?: (p: string) => boolean}} o
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
  const entry = path.join(o.root, 'node_modules', 'tslaws', 'bin', 'tslaws.js');
  if (exists(entry)) return { command: 'node', args: [entry, ...sub, ...extra], shell: false };
  return { error: 'tslaws is not installed in this workspace. Run `npm i -D tslaws` (or set tslaws.executable).' };
}

/** Shell text of the accept command, to type into a terminal and never run. */
function acceptCommandText(files = []) {
  return ['npx', 'tslaws', 'accept', ...files].join(' ');
}

module.exports = { resolveCommand, acceptCommandText };
