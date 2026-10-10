/**
 * Checking on several threads (`--checkers N`).
 *
 * The main thread is checker 0; it starts N-1 checker threads. Every checker creates its own checker
 * over the program and takes files until none are left (`planSchedule`): the costliest files first,
 * then a range of neighboring files of its own, then the cheap end of other checkers' ranges. The
 * threads send back the semantic diagnostics of their files (and under `noEmit` with declarations,
 * their declaration diagnostics) and their global diagnostics, and the main thread reports them like
 * a single checker would. Which checker checks a file does not change its diagnostics.
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
import { declarationDiagnosticsOfFile, ProgramEmitter } from './compile-program.js';
import { Diagnostic, DiagnosticFile } from './diagnostics.js';
import { getEmitDeclarations } from './options.js';
import { useLazyJSDocTable } from './parser.js';
import type { CheckedProgram } from './program-checker.js';
import type { Program } from './program.js';
import type { SourceFile } from './ast.js';
import { lastSymbolIdValue } from './symbol.js';
import { readFileSync } from 'node:fs';

/** With TSC_TS_CHECKERS_TRACE: the process's resident and peak resident set in MB (Linux), else 0. */
export function residentMB(): number[] {
  try {
    const status = readFileSync('/proc/self/status', 'utf8');
    const rss = /VmRSS:\s+(\d+)/.exec(status);
    const hwm = /VmHWM:\s+(\d+)/.exec(status);
    return [rss === null ? 0 : Math.round(Number(rss[1]) / 1024), hwm === null ? 0 : Math.round(Number(hwm[1]) / 1024)];
  } catch {
    return [0, 0];
  }
}

/**
 * Starts checker thread `index` (main.ts owns the worker entry point). `program` is the shared,
 * published program in scriptc builds and `undefined` under Node.js; ids continue above `nodeIds` and
 * `symbolIds`.
 */
export type CheckerSpawn = (
  program: Program | undefined,
  index: number,
  counter: SharedArrayBuffer,
  order: number[],
  nodeIds: number,
  symbolIds: number,
) => Worker;

export class ParallelCheck {
  /** Set where checker threads can be started. */
  spawn: CheckerSpawn | undefined = undefined;
}

export const parallelCheck = new ParallelCheck();

/**
 * What a checker thread sends back: the files it checked (indices) with their semantic diagnostics,
 * and their declaration diagnostics when the program reports them without emitting.
 */
export class CheckerResult {
  constructor(
    readonly index: number,
    readonly files: number[],
    readonly diagnostics: Diagnostic[][],
    readonly declarations: Diagnostic[][],
    readonly globals: Diagnostic[],
    readonly checkTime: number,
    /**
     * With TSC_TS_CHECKERS_TRACE: wall clock (ms since the epoch) when the thread started, when its
     * checker was ready and when it finished; types and instantiations it created; thread CPU ms
     * (user, system); process RSS MB when it finished.
     */
    readonly stats: number[],
  ) {}
}

/**
 * Whether checkers also compute declaration diagnostics: under `noEmit` with declarations, reporting
 * collects them for every file (getDiagnosticsOfProgram), and tsgo computes them per file on its
 * checkers too. Otherwise they come from emitting.
 */
function checkersReportDeclarations(checked: CheckedProgram): boolean {
  const options = checked.program.options;
  return options.noEmit === true && getEmitDeclarations(options);
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

/**
 * The files to check, costliest first, ties in program order. A file's estimated cost is its text
 * length plus a share of the declaration files it makes its checker resolve: for each unchecked
 * declaration file it imports, the text length of everything that file reaches through imports,
 * divided by the number of checked files importing it (each checker resolves a library once, so a
 * library many files import costs little per file, while one only a single small file imports, like
 * a server framework's types under an adapter, makes that file one of the most expensive).
 */
export function checkOrder(checked: CheckedProgram): number[] {
  return costOrder(checked)[0];
}

/** The files to check, costliest first (`checkOrder`), and the estimated cost of each file by index. */
function costOrder(checked: CheckedProgram): [number[], number[]] {
  const files = checked.program.getSourceFiles();
  const order: number[] = [];
  for (let i = 0; i < files.length; i++) if (!checked.skipTypeChecking(files[i]!)) order.push(i);
  const cost = checkCosts(checked, order);
  order.sort((a, b) => cost[b]! - cost[a]! || a - b);
  return [order, cost];
}

/** How much of a library's text counts as checking cost of the files importing it. */
const libraryCostShare = 0.25;

/** The estimated cost of checking each file of `order` (indices into the program files), by index. */
function checkCosts(checked: CheckedProgram, order: number[]): number[] {
  const program = checked.program;
  const files = program.getSourceFiles();
  const cost: number[] = [];
  for (let i = 0; i < files.length; i++) cost.push(0);
  for (const i of order) cost[i] = files[i]!.text.length;
  const indexOf = new Map<SourceFile, number>();
  for (let i = 0; i < files.length; i++) indexOf.set(files[i]!, i);
  const checkedFile: boolean[] = [];
  for (let i = 0; i < files.length; i++) checkedFile.push(false);
  for (const i of order) checkedFile[i] = true;
  // Libraries: unchecked modules that are not default libraries (globals every checker has).
  const isLibrary = (i: number): boolean =>
    !checkedFile[i]! && !program.isSourceFileDefaultLibrary(files[i]!.path) && isExternalModuleFile(files[i]!);
  const edges: (number[] | undefined)[] = [];
  const edgesOf = (i: number): number[] => {
    let result = edges[i];
    if (result === undefined) {
      result = [];
      for (const target of program.getResolvedFilesOf(files[i]!)) {
        const k = indexOf.get(target);
        if (k !== undefined && k !== i) result.push(k);
      }
      edges[i] = result;
    }
    return result;
  };
  const importers = new Map<number, number>();
  const imports: number[][] = [];
  for (const i of order) {
    const libraries: number[] = [];
    for (const k of edgesOf(i)) if (isLibrary(k) && libraries.indexOf(k) < 0) libraries.push(k);
    imports.push(libraries);
    for (const k of libraries) importers.set(k, (importers.get(k) ?? 0) + 1);
  }
  // The text length of the libraries each library reaches (itself included).
  const reach = new Map<number, number>();
  const reachOf = (root: number): number => {
    let total = reach.get(root);
    if (total !== undefined) return total;
    total = 0;
    const seen = new Set<number>([root]);
    const stack = [root];
    while (stack.length > 0) {
      const k = stack.pop()!;
      total += files[k]!.text.length;
      for (const t of edgesOf(k))
        if (!seen.has(t) && isLibrary(t)) {
          seen.add(t);
          stack.push(t);
        }
    }
    reach.set(root, total);
    return total;
  };
  for (let n = 0; n < order.length; n++) {
    let share = 0;
    for (const k of imports[n]!) share += reachOf(k) / importers.get(k)!;
    cost[order[n]!] += libraryCostShare * share;
  }
  return cost;
}

function isExternalModuleFile(file: SourceFile): boolean {
  return file.externalModuleIndicator !== undefined;
}

/**
 * The shared schedule (an Int32Array over a SharedArrayBuffer): [0] the cursor of the shared queue,
 * [1] a lock, [2] the number of leading positions of the order that every checker takes from the
 * shared queue first, or -1 when the whole order is one shared queue, [3] the number of checkers,
 * then for each checker the start and end of its range of positions.
 *
 * With ranges, each checker checks a contiguous run of the program's files (files next to each
 * other in program order tend to use the same declarations, so its checker resolves fewer of them),
 * and a checker whose range is empty takes the back half of the largest remaining range.
 */
const scheduleHeader = 4;

export function newSchedule(count: number): SharedArrayBuffer {
  return new SharedArrayBuffer(4 * (scheduleHeader + 2 * count));
}

/** The next position of the order for checker `index`, or -1 when every file is taken. */
export function takePosition(schedule: Int32Array, length: number, index: number): number {
  const heavy = Atomics.load(schedule, 2);
  if (heavy < 0) {
    const k = Atomics.add(schedule, 0, 1);
    return k < length ? k : -1;
  }
  if (Atomics.load(schedule, 0) < heavy) {
    const k = Atomics.add(schedule, 0, 1);
    if (k < heavy) return k;
  }
  while (Atomics.compareExchange(schedule, 1, 0, 1) !== 0) {
    // Another checker is taking a file; this takes nanoseconds.
  }
  const own = scheduleHeader + 2 * index;
  let lo = Atomics.load(schedule, own);
  let hi = Atomics.load(schedule, own + 1);
  if (lo >= hi) {
    const count = Atomics.load(schedule, 3);
    let victim = -1;
    let most = 0;
    for (let v = 0; v < count; v++) {
      const at = scheduleHeader + 2 * v;
      const left = Atomics.load(schedule, at + 1) - Atomics.load(schedule, at);
      if (left > most) {
        most = left;
        victim = v;
      }
    }
    if (victim < 0) {
      Atomics.store(schedule, 1, 0);
      return -1;
    }
    const at = scheduleHeader + 2 * victim;
    hi = Atomics.load(schedule, at + 1);
    lo = Atomics.load(schedule, at) + (most >> 1);
    Atomics.store(schedule, at + 1, lo);
  }
  Atomics.store(schedule, own, lo + 1);
  Atomics.store(schedule, own + 1, hi);
  Atomics.store(schedule, 1, 0);
  return lo;
}

/**
 * Fills the schedule for `count` checkers and returns the order to check files in: the costliest
 * files first (at least `count`, and every file costing more than a 32nd of a checker's share), from
 * the shared queue; then the others split, in program order, into one range of about equal cost per
 * checker, each costliest first.
 */
export function planSchedule(checked: CheckedProgram, schedule: Int32Array, count: number): number[] {
  const [order, cost] = costOrder(checked);
  Atomics.store(schedule, 3, count);
  if (order.length <= count) {
    Atomics.store(schedule, 2, -1);
    return order;
  }
  let all = 0;
  for (const i of order) all += cost[i]!;
  // Files that cost more than a 32nd of a checker's share go first, costliest first: at the end of
  // a range they would make its checker finish last.
  let heavyCount = count;
  while (heavyCount < order.length && cost[order[heavyCount]!]! * count * 32 >= all) heavyCount++;
  const heavy = order.slice(0, heavyCount);
  const rest = order.slice(heavyCount).sort((a, b) => a - b);
  let total = 0;
  for (const i of rest) total += cost[i]!;
  const planned = heavy.concat(rest);
  Atomics.store(schedule, 2, heavyCount);
  let position = heavyCount;
  let sum = 0;
  for (let c = 0; c < count; c++) {
    const start = position;
    const target = (total * (c + 1)) / count;
    while (position < planned.length && (c === count - 1 || sum + cost[planned[position]!]! / 2 <= target)) {
      sum += cost[planned[position]!]!;
      position++;
    }
    Atomics.store(schedule, scheduleHeader + 2 * c, start);
    Atomics.store(schedule, scheduleHeader + 2 * c + 1, position);
    // A range is the files of a checker; within it, costliest first, so that the files other
    // checkers steal from its end, and the last files anyone checks, are cheap.
    const range = planned.slice(start, position).sort((a, b) => cost[b]! - cost[a]! || a - b);
    for (let k = 0; k < range.length; k++) planned[start + k] = range[k]!;
  }
  return planned;
}

/** With TSC_TS_CHECKERS_TRACE: the single-threaded checker's statistics, like a checker thread's. */
export function traceSingleChecker(checked: CheckedProgram): void {
  if (process.env.TSC_TS_CHECKERS_TRACE === undefined) return;
  const c = checked.checker;
  const relations =
    c.subtypeRelation.size() +
    c.strictSubtypeRelation.size() +
    c.assignableRelation.size() +
    c.comparableRelation.size() +
    c.identityRelation.size();
  const cpu = process.threadCpuUsage();
  process.stderr.write(
    `checkers: single types ${c.typeCount} inst ${c.totalInstantiations} user ${Math.round(cpu.user / 1000)} sys ${Math.round(cpu.system / 1000)} rss ${residentMB().join('/')}MB symlinks ${c.symbolLinkStore.size} nodelinks ${c.nodeLinkStore.size} sigs ${c.signatureCount} rel ${relations}\n`,
  );
}

/** Checks files from the shared queue until it is empty; the main thread and checker threads alike. */
export function checkFromQueue(
  checked: CheckedProgram,
  index: number,
  counter: Int32Array,
  order: number[],
  startedAt: number = Date.now(),
): CheckerResult {
  const start = performance.now();
  const readyAt = Date.now();
  const verbose = process.env.TSC_TS_CHECKERS_TRACE === '3';
  const files = checked.program.getSourceFiles();
  const done: number[] = [];
  const diagnostics: Diagnostic[][] = [];
  const declarations: Diagnostic[][] = [];
  // Declaration emit of a file right after checking it, with this checker.
  const emitter = checkersReportDeclarations(checked) ? new ProgramEmitter(checked) : undefined;
  for (;;) {
    const k = takePosition(counter, order.length, index);
    if (k < 0) break;
    const i = order[k]!;
    done.push(i);
    const fileStart = verbose ? performance.now() : 0;
    diagnostics.push(checked.semanticDiagnosticsOfFile(files[i]!));
    if (verbose)
      process.stderr.write(
        `checkers: file ${index} ${(performance.now() - fileStart).toFixed(1)}ms ${files[i]!.text.length} ${files[i]!.fileName}\n`,
      );
    if (emitter !== undefined) declarations.push(declarationDiagnosticsOfFile(emitter, files[i]!));
  }
  // The main thread reports its own global diagnostics (CheckedProgram.getGlobalDiagnostics).
  const globals = index === 0 ? [] : checked.getGlobalDiagnostics().slice();
  let stats: number[] = [];
  if (process.env.TSC_TS_CHECKERS_TRACE !== undefined) {
    const cpu = process.threadCpuUsage();
    const checker = checked.checker;
    const relations =
      checker.subtypeRelation.size() +
      checker.strictSubtypeRelation.size() +
      checker.assignableRelation.size() +
      checker.comparableRelation.size() +
      checker.identityRelation.size();
    stats = [
      startedAt,
      readyAt,
      Date.now(),
      checker.typeCount,
      checker.totalInstantiations,
      cpu.user / 1000,
      cpu.system / 1000,
      residentMB()[0]!,
      checker.symbolLinkStore.size,
      checker.nodeLinkStore.size,
      checker.signatureCount,
      relations,
    ];
  }
  return new CheckerResult(index, done, diagnostics, declarations, globals, performance.now() - start, stats);
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
  const epoch = Date.now();
  if (trace) process.stderr.write(`checkers: start at ${epoch} rss ${residentMB().join('/')}MB\n`);
  if (shared) {
    program.prepareForSharing();
    publish(program);
    // The program is immutable now; lazily parsed JSDoc goes to a table of this thread.
    useLazyJSDocTable();
    if (trace)
      process.stderr.write(
        `checkers: published the program in ${(performance.now() - start).toFixed(1)}ms rss ${residentMB().join('/')}MB\n`,
      );
  }
  const counter = newSchedule(count);
  const orderStart = performance.now();
  const order = planSchedule(checked, new Int32Array(counter), count);
  if (trace) {
    let top = '';
    for (let k = 0; k < Math.min(5, order.length); k++) top += ' ' + files[order[k]!]!.fileName;
    process.stderr.write(
      `checkers: ordered ${order.length} files in ${(performance.now() - orderStart).toFixed(1)}ms, first:${top}\n`,
    );
  }
  if (shared) publish(order);
  const perFile: (Diagnostic[] | undefined)[] = [];
  const perFileDeclarations: (Diagnostic[] | undefined)[] = [];
  for (let i = 0; i < files.length; i++) {
    perFile.push(undefined);
    perFileDeclarations.push(undefined);
  }
  const revival = shared ? undefined : new Revival(program);
  let remaining = count - 1;
  let ownDone = false;
  const finish = (): void => {
    // A thread that failed may have taken files it never checked: check them here.
    for (const i of order) if (perFile[i] === undefined) perFile[i] = checked.semanticDiagnosticsOfFile(files[i]!);
    checked.checkedInParallel = perFile;
    if (trace)
      process.stderr.write(
        `checkers: finished at ${(performance.now() - start).toFixed(1)}ms rss ${residentMB().join('/')}MB\n`,
      );
    // Files without declaration diagnostics here get them on this thread (PlainProgram).
    if (checkersReportDeclarations(checked)) checked.declarationsInParallel = perFileDeclarations;
    done(performance.now() - start);
  };
  const record = (result: CheckerResult): void => {
    for (let k = 0; k < result.files.length; k++) perFile[result.files[k]!] = result.diagnostics[k]!;
    for (let k = 0; k < result.declarations.length; k++)
      perFileDeclarations[result.files[k]!] = result.declarations[k]!;
    for (const d of result.globals) checked.parallelGlobalDiagnostics.push(d);
    if (trace) {
      const st = result.stats;
      const rel = (t: number | undefined): string => (t === undefined ? '?' : String(t - epoch));
      process.stderr.write(
        `checkers: thread ${result.index} checked ${result.files.length} files in ${result.checkTime.toFixed(1)}ms, done at ${(performance.now() - start).toFixed(1)}ms` +
          ` [start ${rel(st[0])} ready ${rel(st[1])} end ${rel(st[2])} types ${st[3]} inst ${st[4]} user ${Math.round(st[5] ?? 0)} sys ${Math.round(st[6] ?? 0)} rss ${st[7]}MB symlinks ${st[8]} nodelinks ${st[9]} sigs ${st[10]} rel ${st[11]}]\n`,
      );
    }
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
      order,
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
  record(checkFromQueue(checked, 0, new Int32Array(counter), order, epoch));
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
      copy.declarations.map((diagnostics) => diagnostics.map((d) => this.diagnostic(d))),
      copy.globals.map((d) => this.diagnostic(d)),
      copy.checkTime,
      copy.stats,
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
