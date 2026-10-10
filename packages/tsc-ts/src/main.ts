// tsc-ts: `--api` serves the TypeScript API; anything else runs tsc.
import { dirname } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { publish, sharesPublishedGraphs } from '@scriptc/threads';
import { runServer } from './api/server.js';
import { reserveNodeIds } from './compiler/ast.js';
import { CheckerResult, checkFromQueue, parallelCheck } from './compiler/parallel-check.js';
import { parallelParse, runParseWorker } from './compiler/parallel-parse.js';
import { useLazyJSDocTable } from './compiler/parser.js';
import { CheckedProgram } from './compiler/program-checker.js';
import type { Program } from './compiler/program.js';
import { assignSymbolIdsAtCreation, reserveSymbolIds } from './compiler/symbol.js';
import { createNodeSystem, programOfCommandLine, runTsc, watching } from './drivers/node-system.js';
import './drivers/lowering.js';

// Lib files come from TSC_TS_LIB_DIR, or the executable's directory as in tsc.
const defaultLibraryPath =
  process.env.TSC_TS_LIB_DIR ?? dirname(isNode() ? (process.argv[1] ?? '.') : process.execPath);

const args = process.argv.slice(2);
if (!isMainThread) runThread();
else {
  if (args[0] !== '--api') startThreads();
  const status = args[0] === '--api' ? runServer(args.slice(1), defaultLibraryPath) : runTsc(args, defaultLibraryPath);
  // Watch mode and `--checkers` keep running until their callbacks exit.
  if (status !== watching) process.exit(status);
}

/** Lets `--checkers N` start checker threads, and parse threads where threads share objects. */
function startThreads(): void {
  parallelCheck.spawn = (program, index, counter, nodeIds, symbolIds) =>
    new Worker(new URL(import.meta.url), {
      workerData: { kind: 'check', program, args, index, counter, nodeIds, symbolIds },
    });
  if (sharesPublishedGraphs)
    parallelParse.spawn = (fileNames, paths, flags, counter) =>
      new Worker(new URL(import.meta.url), {
        workerData: { kind: 'parse', fileNames, paths, flags, counter },
      });
}

function runThread(): void {
  if ((workerData as { kind: string }).kind === 'parse') runParseThread();
  else runCheckerThread();
}

/** A checker thread (parallel-check.ts). */
function runCheckerThread(): void {
  const job = workerData as {
    kind: string;
    program: Program | undefined;
    args: string[];
    index: number;
    counter: SharedArrayBuffer;
    nodeIds: number;
    symbolIds: number;
  };
  let program: Program | undefined = undefined;
  if (job.program !== undefined) {
    // The shared program is never written: new ids continue above its own, and lazily parsed JSDoc
    // goes to a table of this thread.
    reserveNodeIds(job.nodeIds);
    reserveSymbolIds(job.symbolIds);
    assignSymbolIdsAtCreation();
    useLazyJSDocTable();
    program = publish(job.program);
  } else program = programOfCommandLine(job.args, defaultLibraryPath);
  // Without a program this thread checks nothing; the main thread checks the files it would have.
  const result =
    program === undefined
      ? new CheckerResult(job.index, [], [], [], 0)
      : checkFromQueue(new CheckedProgram(program), job.index, new Int32Array(job.counter));
  parentPort!.postMessage({ result: sharesPublishedGraphs ? publish(result) : result });
}

/** A parse thread (parallel-parse.ts). */
function runParseThread(): void {
  const job = workerData as {
    kind: string;
    fileNames: string[];
    paths: string[];
    flags: number[];
    counter: SharedArrayBuffer;
  };
  const bundledLibs = process.env.TSC_TS_BUNDLED_LIBS ?? '';
  const sys = createNodeSystem(bundledLibs !== '' ? 'bundled:///libs' : defaultLibraryPath, bundledLibs);
  const batch = runParseWorker(job.fileNames, job.paths, job.flags, job.counter, (fileName) => sys.readFile(fileName));
  parentPort!.postMessage({ batch });
}

function isNode(): boolean {
  return /(^|[/\\])node(\.exe)?$/.test(process.execPath);
}
