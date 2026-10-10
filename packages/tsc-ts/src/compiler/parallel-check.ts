/**
 * Checking on several threads (`--checkers N`).
 *
 * The main thread is checker 0; it starts N-1 checker threads. Every checker creates its own checker
 * over the program and takes files from one shared queue, largest first, until it is empty; the
 * threads send back the semantic diagnostics of their files and their global diagnostics, and the main
 * thread reports them like a single checker would. tsgo spreads files over its checkers the same way,
 * and which checker checks a file does not change its diagnostics.
 *
 * In scriptc builds, threads share one program: the main thread computes the program's lazy caches,
 * publishes it with `@scriptc/threads` (the program becomes immutable and immortal, and threads
 * receive it by reference), and keeps the JSDoc that checking parses lazily in tables of each thread.
 * Checker threads publish their diagnostics back. Under Node.js, which copies what it posts, every
 * checker thread builds its own copy of the program from the command line instead, and the main
 * thread revives the diagnostics it receives against its own files.
 */
import type { Worker } from 'node:worker_threads';
import { publish, sharesPublishedGraphs } from '@scriptc/threads';
import { lastNodeIdValue } from './ast.js';
import { Diagnostic, DiagnosticFile } from './diagnostics.js';
import { useLazyJSDocTable } from './parser.js';
import type { CheckedProgram } from './program-checker.js';
import type { Program } from './program.js';
import { lastSymbolIdValue } from './symbol.js';

/**
 * Starts checker thread `index` (main.ts owns the worker entry point). `program` is the shared,
 * published program in scriptc builds and `undefined` under Node.js; ids continue above `nodeIds` and
 * `symbolIds`.
 */
export type CheckerSpawn = (
  program: Program | undefined,
  index: number,
  counter: SharedArrayBuffer,
  nodeIds: number,
  symbolIds: number,
) => Worker;

export class ParallelCheck {
  /** Set where checker threads can be started. */
  spawn: CheckerSpawn | undefined = undefined;
}

export const parallelCheck = new ParallelCheck();

/** What a checker thread sends back: the files it checked (indices) with their diagnostics. */
export class CheckerResult {
  constructor(
    readonly index: number,
    readonly files: number[],
    readonly diagnostics: Diagnostic[][],
    readonly globals: Diagnostic[],
    readonly checkTime: number,
  ) {}
}

/**
 * The number of checker threads for `checkers` (`--checkers`), or 1 to check on this thread. Without
 * the option, native builds use tsgo's four checkers; under Node.js, where every thread builds its own
 * copy of the program, tsc-ts checks on one thread.
 */
export function checkerThreads(checkers: number | undefined, singleThreaded: boolean | undefined): number {
  if (parallelCheck.spawn === undefined || singleThreaded === true) return 1;
  const count = checkers ?? (sharesPublishedGraphs ? 4 : 1);
  return count > 1 ? Math.min(Math.floor(count), 256) : 1;
}

/** The files to check, largest first (by text length), ties in program order. */
function checkOrder(checked: CheckedProgram): number[] {
  const files = checked.program.getSourceFiles();
  const order: number[] = [];
  for (let i = 0; i < files.length; i++) if (!checked.skipTypeChecking(files[i]!)) order.push(i);
  order.sort((a, b) => files[b]!.text.length - files[a]!.text.length || a - b);
  return order;
}

/** Checks files from the shared queue until it is empty; the main thread and checker threads alike. */
export function checkFromQueue(checked: CheckedProgram, index: number, counter: Int32Array): CheckerResult {
  const start = performance.now();
  const order = checkOrder(checked);
  const files = checked.program.getSourceFiles();
  const done: number[] = [];
  const diagnostics: Diagnostic[][] = [];
  for (;;) {
    const k = Atomics.add(counter, 0, 1);
    if (k >= order.length) break;
    const i = order[k]!;
    done.push(i);
    diagnostics.push(checked.semanticDiagnosticsOfFile(files[i]!));
  }
  // The main thread reports its own global diagnostics (CheckedProgram.getGlobalDiagnostics).
  const globals = index === 0 ? [] : checked.getGlobalDiagnostics().slice();
  return new CheckerResult(index, done, diagnostics, globals, performance.now() - start);
}

/**
 * Checks `checked` with `count` checkers, this thread included, and calls `done` with the wall time
 * once `checked` holds every file's diagnostics.
 */
export function startParallelCheck(checked: CheckedProgram, count: number, done: (checkTime: number) => void): void {
  const start = performance.now();
  const program = checked.program;
  const files = program.getSourceFiles();
  const trace = process.env.TSC_TS_CHECKERS_TRACE !== undefined;
  const shared = sharesPublishedGraphs;
  if (shared) {
    program.prepareForSharing();
    publish(program);
    // The program is immutable now; lazily parsed JSDoc goes to a table of this thread.
    useLazyJSDocTable();
    if (trace) process.stderr.write(`checkers: published the program in ${(performance.now() - start).toFixed(1)}ms\n`);
  }
  const counter = new SharedArrayBuffer(4);
  const perFile: (Diagnostic[] | undefined)[] = [];
  for (let i = 0; i < files.length; i++) perFile.push(undefined);
  const revival = shared ? undefined : new Revival(program);
  let remaining = count - 1;
  let ownDone = false;
  const finish = (): void => {
    // A thread that failed may have taken files it never checked: check them here.
    const order = checkOrder(checked);
    for (const i of order) if (perFile[i] === undefined) perFile[i] = checked.semanticDiagnosticsOfFile(files[i]!);
    checked.checkedInParallel = perFile;
    done(performance.now() - start);
  };
  const record = (result: CheckerResult): void => {
    for (let k = 0; k < result.files.length; k++) perFile[result.files[k]!] = result.diagnostics[k]!;
    for (const d of result.globals) checked.parallelGlobalDiagnostics.push(d);
    if (trace)
      process.stderr.write(
        `checkers: thread ${result.index} checked ${result.files.length} files in ${result.checkTime.toFixed(1)}ms, done at ${(performance.now() - start).toFixed(1)}ms\n`,
      );
  };
  const threadDone = (): void => {
    remaining--;
    if (remaining === 0 && ownDone) finish();
  };
  for (let i = 1; i < count; i++) {
    const worker = parallelCheck.spawn!(
      shared ? program : undefined,
      i,
      counter,
      lastNodeIdValue(),
      lastSymbolIdValue(),
    );
    worker.on('message', (message: unknown) => {
      const result = (message as { result: CheckerResult }).result;
      record(revival === undefined ? publish(result) : revival.result(result));
      threadDone();
    });
    worker.on('error', (error: unknown) => {
      if (trace) process.stderr.write(`checkers: thread ${i} failed: ${String(error)}\n`);
      threadDone();
    });
  }
  record(checkFromQueue(checked, 0, new Int32Array(counter)));
  ownDone = true;
  if (remaining === 0) finish();
}

/** Diagnostics copied from another thread (Node.js), attached to this program's files again. */
class Revival {
  private readonly files = new Map<string, DiagnosticFile>();

  constructor(program: Program) {
    for (const file of program.getSourceFiles()) this.files.set(file.fileName, file.diagnosticFile());
  }

  result(copy: CheckerResult): CheckerResult {
    return new CheckerResult(
      copy.index,
      copy.files,
      copy.diagnostics.map((diagnostics) => diagnostics.map((d) => this.diagnostic(d))),
      copy.globals.map((d) => this.diagnostic(d)),
      copy.checkTime,
    );
  }

  private diagnostic(copy: Diagnostic): Diagnostic {
    let file: DiagnosticFile | undefined = undefined;
    const copied = copy.file;
    if (copied !== undefined) {
      file = this.files.get(copied.fileName);
      if (file === undefined) {
        file = new DiagnosticFile(copied.fileName, copied.text);
        this.files.set(copied.fileName, file);
      }
    }
    const result = new Diagnostic(file, copy.pos, copy.end, copy.message, copy.args);
    result.code = copy.code;
    result.category = copy.category;
    result.skippedOnNoEmit = copy.skippedOnNoEmit;
    result.messageChain = copy.messageChain.map((d) => this.diagnostic(d));
    result.relatedInformation = copy.relatedInformation.map((d) => this.diagnostic(d));
    return result;
  }
}
