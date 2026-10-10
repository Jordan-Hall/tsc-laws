// tsc-ts: `--api` serves the TypeScript API; anything else runs tsc.
import { dirname } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { publish, sharesPublishedGraphs } from '@scriptc/threads';
import { runServer } from './api/server.js';
import { reserveNodeIds, shareNodeIds } from './compiler/ast.js';
import { CheckerResult, checkFromQueue, parallelCheck } from './compiler/parallel-check.js';
import { type LoadMessage, parallelParse } from './compiler/parallel-parse.js';
import { useLazyJSDocTable } from './compiler/parser.js';
import { CheckedProgram } from './compiler/program-checker.js';
import type { Program } from './compiler/program.js';
import { assignSymbolIdsAtCreation, reserveSymbolIds, shareSymbolIds } from './compiler/symbol.js';
import { parseThreadOfCommandLine, programOfCommandLine, runTsc, watching } from './drivers/node-system.js';
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
    parallelParse.spawn = (configFileName, counter) =>
      new Worker(new URL(import.meta.url), {
        workerData: { kind: 'parse', configFileName, counter },
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

/** A parse thread (parallel-parse.ts): loads the chunks the main thread posts until it posts `stop`. */
function runParseThread(): void {
  const job = workerData as { kind: string; configFileName: string; counter: SharedArrayBuffer };
  // Ids, also of the nodes of the config, come in chunks from the counter shared with the other threads.
  shareNodeIds(new Int32Array(job.counter, 0, 1));
  shareSymbolIds(new Int32Array(job.counter, 4, 1));
  assignSymbolIdsAtCreation();
  const thread = parseThreadOfCommandLine(args, job.configFileName, defaultLibraryPath);
  const port = parentPort!;
  port.on('message', (message: unknown) => {
    const chunk = message as LoadMessage;
    if (chunk.stop) port.close();
    // The main thread read the project, so this one can too; if not, the program's FileLoader
    // parses the files of the chunk (the main thread sees this thread fail).
    else if (thread === undefined) throw new Error('A parse thread could not read the project');
    else port.postMessage({ batch: thread.load(chunk) });
  });
}

function isNode(): boolean {
  return /(^|[/\\])node(\.exe)?$/.test(process.execPath);
}
