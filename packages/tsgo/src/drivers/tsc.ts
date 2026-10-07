// Runs the translated tsc command line. Usage: tsc [tsc options] [files]
// Lib files are read from the directory given by TSC_TS_LIB_DIR, or the
// bundled TypeScript-Go libs.
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync, mkdirSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import * as checkhost from '../tsgo/checkhost.js';
import * as classes from '../tsgo/classes.js';
import { initDone, keepClasses, fromBytes, fromHostString, toHostString, stringToBytes } from '../go/base.js';

// Lets scriptc lower every class before use; never runs.
if (keepClasses()) classes.keepAll();
initDone();

const host = new checkhost.Host();
host.Cwd = fromHostString(process.cwd());
host.LibPath = fromHostString(process.env.TSC_TS_LIB_DIR ?? 'upstream/typescript-go/internal/bundled/libs');
host.ReadFile = (path: string): [string, boolean] => {
  try {
    return [fromBytes(readFileSync(toHostString(path))), true];
  } catch {
    return ['', false];
  }
};
host.WriteFile = (path: string, data: string): boolean => {
  try {
    const p = toHostString(path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, Uint8Array.from(stringToBytes(data)));
    return true;
  } catch {
    return false;
  }
};
host.Stat = (path: string): [number, number, number] => {
  try {
    const s = statSync(toHostString(path));
    return [s.isDirectory() ? 2 : 1, s.size, s.mtimeMs];
  } catch {
    return [0, 0, 0];
  }
};
host.ReadDir = (path: string): [string[], string[]] => {
  const files: string[] = [];
  const dirs: string[] = [];
  const dir = toHostString(path);
  try {
    for (const name of readdirSync(dir)) {
      try {
        if (statSync(dir + '/' + name).isDirectory()) dirs.push(fromHostString(name));
        else files.push(fromHostString(name));
      } catch {
        // Broken links are skipped.
      }
    }
  } catch {
    // Unreadable directories have no entries.
  }
  return [files, dirs];
};
host.Realpath = (path: string): string => {
  try {
    return fromHostString(realpathSync(toHostString(path)));
  } catch {
    return path;
  }
};
host.Write = (text: string): void => {
  writeSync(1, toHostString(text));
};
host.Now = (): number => Date.now();

const args = process.argv.slice(2).map(fromHostString);
const status = checkhost.RunTSC(host, args);
process.exit(status);
