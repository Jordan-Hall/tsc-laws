// tsc-ts: `--api` serves the TypeScript API; anything else runs tsc.
import { dirname } from 'node:path';
import { runServer } from './api/server.js';
import { runTsc } from './drivers/node-system.js';
import './drivers/lowering.js';

// Lib files come from TSC_TS_LIB_DIR, or the executable's directory as in tsc.
const defaultLibraryPath =
  process.env.TSC_TS_LIB_DIR ?? dirname(isNode() ? (process.argv[1] ?? '.') : process.execPath);

const args = process.argv.slice(2);
process.exit(args[0] === '--api' ? runServer(args.slice(1), defaultLibraryPath) : runTsc(args, defaultLibraryPath));

function isNode(): boolean {
  return /(^|[/\\])node(\.exe)?$/.test(process.execPath);
}
