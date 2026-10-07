// `tsc --api`: serves the API over stdin and stdout.
//
//   tsc --api [--cwd DIR] [--callbacks=readFile,fileExists,...] [--timing]
import { existsSync } from 'node:fs';
import { Connection } from './connection.js';
import { ClientFileSystem, isCallback } from './fs.js';
import type { Callback } from './fs.js';
import { Session } from './session.js';

interface ServerOptions {
  cwd: string;
  callbacks: Set<Callback>;
  timing: boolean;
}

// Runs the server until the client closes stdin; returns the exit status.
export function runServer(args: string[], defaultLibraryPath: string): number {
  const options = parseArgs(args);
  if (options === undefined) return 2;
  const fs = new ClientFileSystem(options.callbacks);
  const session = new Session(
    {
      fs,
      currentDirectory: options.cwd,
      defaultLibraryPath,
      useCaseSensitiveFileNames: isFileSystemCaseSensitive(),
    },
    options.timing,
  );
  const connection = new Connection(0, 1);
  fs.connect(connection);
  connection.run(session);
  return 0;
}

// Parses Go-style flags: -name, --name, -name=value or -name value.
function parseArgs(args: string[]): ServerOptions | undefined {
  const options: ServerOptions = { cwd: process.cwd(), callbacks: new Set(), timing: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) break;
    const name = arg.replace(/^--?/, '').split('=')[0];
    const eq = arg.indexOf('=');
    const value = (): string | undefined => (eq >= 0 ? arg.slice(eq + 1) : args[++i]);
    switch (name) {
      case 'cwd': {
        const cwd = value();
        if (cwd === undefined) return usage('flag needs an argument: -cwd');
        options.cwd = cwd;
        break;
      }
      case 'callbacks': {
        const list = value();
        if (list === undefined) return usage('flag needs an argument: -callbacks');
        for (const callback of list === '' ? [] : list.split(',')) {
          if (!isCallback(callback)) throw new Error(`unknown callback name: ${callback}`);
          options.callbacks.add(callback);
        }
        break;
      }
      case 'timing':
        options.timing = eq < 0 || arg.slice(eq + 1) === 'true';
        break;
      case 'async':
      case 'pipe':
        return usage(`-${name} is not supported`);
      default:
        return usage(`flag provided but not defined: -${name}`);
    }
  }
  return options;
}

function usage(message: string): undefined {
  process.stderr.write(`${message}\nUsage of api:\n  -callbacks string\n  -cwd string\n  -timing\n`);
  return undefined;
}

// The file system is case-insensitive if the executable exists under a
// different case, as in TypeScript-Go.
function isFileSystemCaseSensitive(): boolean {
  if (process.platform === 'win32') return false;
  const path = process.execPath;
  let swapped = '';
  for (const c of path) {
    const upper = c.toUpperCase();
    swapped += upper === c ? c.toLowerCase() : upper;
  }
  return swapped === path || !existsSync(swapped);
}
