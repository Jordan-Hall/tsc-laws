'use strict';

// Builds the process command line for tslaws. No vscode import; `exists` is injectable for tests.

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {{root: string, executable?: string, args?: string[], platform?: string, exists?: (p: string) => boolean}} o
 * @param {string[]} sub subcommand and its arguments, e.g. ['check', '--json']
 * @returns {{command: string, args: string[], shell: boolean}}
 */
function resolveCommand(o, sub) {
  const exists = o.exists ?? fs.existsSync;
  const platform = o.platform ?? process.platform;
  const extra = Array.isArray(o.args) ? o.args : [];
  const win = platform === 'win32';
  let command;
  let prefix = [];
  if (o.executable !== undefined && o.executable !== '') {
    command = o.executable;
  } else {
    const local = path.join(o.root, 'node_modules', '.bin', win ? 'tslaws.cmd' : 'tslaws');
    if (exists(local)) {
      command = local;
    } else {
      command = 'npx';
      prefix = ['tslaws'];
    }
  }
  // .cmd shims and npx.cmd need a shell on Windows.
  const shell = win && (/\.(cmd|bat)$/i.test(command) || command === 'npx');
  if (shell && /\s/.test(command)) command = `"${command}"`;
  return { command, args: [...prefix, ...sub, ...extra], shell };
}

/** Shell text of the accept command, to type into a terminal and never run. */
function acceptCommandText(files = []) {
  return ['npx', 'tslaws', 'accept', ...files].join(' ');
}

module.exports = { resolveCommand, acceptCommandText };
