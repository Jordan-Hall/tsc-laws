// tsc-ts: `--api` serves the TypeScript API; anything else runs tsc.
import { dirname } from 'node:path';
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { runServer } from './api/server.js';
import { runLawsManifest } from './laws/manifest.js';
import { runThread, startThreads, type ThreadData, type ThreadDrivers } from './compiler/thread-entry.js';
import { mark, markMemory, timeline } from './compiler/timeline.js';
import {
  outputWriterOfThread,
  parseThreadOfCommandLine,
  programOfCommandLine,
  runTsc,
  watching,
} from './drivers/node-system.js';
import './drivers/lowering.js';

// Lib files come from TSC_TS_LIB_DIR, or the executable's directory as in tsc.
const defaultLibraryPath =
  process.env.TSC_TS_LIB_DIR ?? dirname(isNode() ? (process.argv[1] ?? '.') : process.execPath);

const args = process.argv.slice(2);

/** What the threads read from this command line. */
const drivers: ThreadDrivers = {
  outputWriter: () => outputWriterOfThread(defaultLibraryPath),
  programOfCommandLine: (threadArgs) => programOfCommandLine(threadArgs, defaultLibraryPath),
  parseThreadOfCommandLine: (threadArgs, configFileName) =>
    parseThreadOfCommandLine(threadArgs, configFileName, defaultLibraryPath),
};

/** Threads run this module again, as workers. */
function spawnThread(data: ThreadData): Worker {
  return new Worker(new URL(import.meta.url), { workerData: data });
}

if (!isMainThread) runThread(workerData, drivers);
else {
  if (timeline) {
    // The monotonic clock at the same moment, to line the timeline up with profiles.
    const hr = process.hrtime();
    mark(`main clock ${hr[0]} ${hr[1]}`);
  }
  if (args[0] === '--laws-manifest') process.exit(runLawsManifest(args.slice(1)));
  if (args[0] !== '--api') startThreads(spawnThread, drivers, args);
  const status = args[0] === '--api' ? runServer(args.slice(1), defaultLibraryPath) : runTsc(args, defaultLibraryPath);
  // Watch mode and `--checkers` keep running until their callbacks exit.
  if (status !== watching) {
    markMemory();
    mark('exit');
    process.exit(status);
  }
}

function isNode(): boolean {
  return /(^|[/\\])node(\.exe)?$/.test(process.execPath);
}
