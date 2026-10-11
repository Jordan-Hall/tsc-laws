/**
 * Checking on several threads (`--checkers N`).
 *
 * The main thread is checker 0; it starts N-1 checker threads. Every checker creates its own checker
 * over the program and takes files until none are left (`planSchedule`): the costliest files first,
 * and groups of files that share costly declarations as a whole (`checkGroups`), then a range of
 * neighboring files of its own, then the end of other checkers' ranges where that makes them finish
 * earlier (`takePosition`). The threads send back the semantic
 * diagnostics of their files (and under `noEmit` with declarations, their declaration diagnostics)
 * and their global diagnostics, and the main thread reports them like a single checker would. Which
 * checker checks a file does not change its diagnostics.
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
import { availableParallelism, totalmem } from 'node:os';

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
 * How the number of checkers is chosen without `--checkers`: `auto` (the default) uses every CPU
 * this process may run on (`os.availableParallelism()`, at most `maxAutoCheckers`), and at least
 * tsgo's four; fewer than the CPUs, but never fewer than four, when the estimated peak memory of more
 * checkers would not fit (`memoryCheckers`). `fixed` (TSC_TS_CHECKERS=fixed) uses tsgo's four.
 */
export const checkerPolicy: 'fixed' | 'auto' = process.env.TSC_TS_CHECKERS === 'fixed' ? 'fixed' : 'auto';

/** tsgo's number of checkers, and the fewest `auto` starts. */
const tsgoCheckers = 4;

/** The most checkers `auto` starts (measured up to 16 CPUs). */
const maxAutoCheckers = 16;

/**
 * The number of checker threads for `checkers` (`--checkers`), or 1 to check on this thread. Without
 * the option, native builds follow `checkerPolicy` (with `program`, the memory estimate of `auto`
 * applies); under Node.js, where every thread builds its own copy of the program, tsc-ts checks on
 * one thread.
 */
export function checkerThreads(
  checkers: number | undefined,
  singleThreaded: boolean | undefined,
  program?: Program,
): number {
  if (parallelCheck.spawn === undefined || singleThreaded === true) return 1;
  const count = checkers ?? defaultCheckers(program);
  return count > 1 ? Math.min(Math.floor(count), 256) : 1;
}

function defaultCheckers(program: Program | undefined): number {
  if (!sharesPublishedGraphs) return 1;
  if (checkerPolicy === 'fixed') return tsgoCheckers;
  const cpus = Math.min(availableParallelism(), maxAutoCheckers);
  return autoCheckers(cpus, program === undefined ? Number.MAX_SAFE_INTEGER : memoryCheckers(program));
}

/** `auto` with `cpus` CPUs when the memory estimate fits `fit` checkers: tsgo's four at least. */
export function autoCheckers(cpus: number, fit: number): number {
  return Math.max(tsgoCheckers, Math.min(cpus, fit));
}

/**
 * The number of threads that parse ahead of a program checked by `checkers` checkers: every CPU this
 * process may run on, as tsgo parses on every core whatever its checker count (parse threads hand
 * their files to the shared program; what else they allocate is reused by the checker threads).
 */
export function parseThreads(checkers: number): number {
  return Math.max(checkers, Math.min(availableParallelism(), maxAutoCheckers));
}

/**
 * Peak memory with one checker, per character of source text: measured 44-107 bytes on the
 * benchmark apps (the shared program 28-38, one checker's heap the rest; most where checking
 * instantiates many types, as in Sentry and T3 Code's Effect code, least for tRPC and VS Code).
 */
const peakBytesPerChar = 110;

/**
 * What each further checker adds, per character of declaration files: measured 0.3-31 bytes (every
 * checker resolves the declarations its files use; most for T3 Code's Effect-based projects, 6 for
 * VS Code, under 1 for tRPC).
 */
const checkerBytesPerDeclarationChar = 32;

/**
 * The most checkers whose estimated peak memory (`peakBytesPerChar`,
 * `checkerBytesPerDeclarationChar`) fits 80% of the memory limit, of `memory` bytes; at least 1.
 */
export function checkersFittingMemory(chars: number, declarationChars: number, memory: number): number {
  const peak = chars * peakBytesPerChar;
  const perChecker = Math.max(1, declarationChars * checkerBytesPerDeclarationChar);
  return Math.max(1, 1 + Math.floor((0.8 * memory - peak) / perChecker));
}

/** The most checkers whose estimated peak memory fits (`checkersFittingMemory`), for `program`. */
export function memoryCheckers(program: Program): number {
  let chars = 0;
  let declarationChars = 0;
  for (const file of program.getSourceFiles()) {
    chars += file.text.length;
    if (file.isDeclarationFile) declarationChars += file.text.length;
  }
  const constrained = process.constrainedMemory();
  const memory = constrained > 0 ? Math.min(constrained, totalmem()) : totalmem();
  const fit = checkersFittingMemory(chars, declarationChars, memory);
  if (process.env.TSC_TS_CHECKERS_TRACE !== undefined)
    process.stderr.write(
      `checkers: ${chars} source chars (${declarationChars} in declaration files), memory ${Math.round(memory / 1048576)}MB fits ${fit} checkers\n`,
    );
  return fit;
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
  return costOrder(checked).order;
}

/** The estimated costs of checking a program's files (`checkOrder`). */
class CheckCosts {
  constructor(
    /** The files to check (indices into the program files), costliest first. */
    readonly order: number[],
    /** The estimated cost of each file, by index. */
    readonly cost: number[],
    /** The libraries (indices) each file of `order` imports, by index. */
    readonly libraries: number[][],
    /** What resolving a library costs a checker the first time (`libraryCostShare` of the text it reaches), by index. */
    readonly libraryCost: number[],
  ) {}
}

function costOrder(checked: CheckedProgram): CheckCosts {
  const files = checked.program.getSourceFiles();
  const order: number[] = [];
  for (let i = 0; i < files.length; i++) if (!checked.skipTypeChecking(files[i]!)) order.push(i);
  const costs = checkCosts(checked, order);
  const cost = costs.cost;
  order.sort((a, b) => cost[b]! - cost[a]! || a - b);
  return costs;
}

/** How much of a library's text counts as checking cost of the files importing it. */
const libraryCostShare = 0.25;

/** The estimated cost of checking each file of `order` (indices into the program files). */
function checkCosts(checked: CheckedProgram, order: number[]): CheckCosts {
  const program = checked.program;
  const files = program.getSourceFiles();
  const cost: number[] = [];
  const librariesOf: number[][] = [];
  const libraryCost: number[] = [];
  for (let i = 0; i < files.length; i++) {
    cost.push(0);
    librariesOf.push([]);
    libraryCost.push(0);
  }
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
  for (const i of order) {
    const libraries: number[] = [];
    for (const k of edgesOf(i)) if (isLibrary(k) && libraries.indexOf(k) < 0) libraries.push(k);
    librariesOf[i] = libraries;
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
    const i = order[n]!;
    let share = 0;
    for (const k of librariesOf[i]!) {
      libraryCost[k] = libraryCostShare * reachOf(k);
      share += reachOf(k) / importers.get(k)!;
    }
    cost[i] = cost[i]! + libraryCostShare * share;
  }
  return new CheckCosts(order, cost, librariesOf, libraryCost);
}

function isExternalModuleFile(file: SourceFile): boolean {
  return file.externalModuleIndicator !== undefined;
}

/**
 * The shared schedule (an Int32Array over a SharedArrayBuffer). Header: [0] the cursor of the
 * shared queue, [1] a lock, [2] the number of leading positions of the order that every checker
 * takes from the shared queue first, or -1 when the whole order is one shared queue, [3] the number
 * of checkers, [4] the number of positions with costs (0 for none), [5] the number of libraries, [6]
 * the words of a set of libraries, [7] the number of library references. Then, for each checker, the
 * start and end of its range of positions; with costs, for each position the text length of its file
 * and the start of its libraries in the library references (one more start at the end), the library
 * references, for each library what resolving it costs, and for each checker the set of libraries it
 * has resolved (one bit per library), and for each position the number of files of the group starting
 * there (0 or 1 for a file of its own).
 *
 * The leading positions are the shared queue: the costliest files, and groups of files that a
 * checker takes as a whole (`checkGroups`), which no other checker takes from it.
 *
 * With ranges, each checker checks a contiguous run of the program's files (files next to each
 * other in program order tend to use the same declarations, so its checker resolves fewer of them),
 * and a checker whose range is empty takes the end of another checker's range: the part that brings
 * the later of the two checkers' estimated finishing times furthest forward, counting for itself the
 * libraries it has not resolved yet. It takes nothing when that would not finish earlier: the end of
 * a range is often a few files that are cheap only to the checker that resolved their libraries.
 * Without costs, it takes the back half of the largest remaining range.
 */
const scheduleHeader = 8;

export function newSchedule(count: number, positions = 0, libraries = 0, references = 0): SharedArrayBuffer {
  const words = (libraries + 31) >> 5;
  const plan = positions === 0 ? 0 : 3 * positions + 1 + references + libraries + count * words;
  const buffer = new SharedArrayBuffer(4 * (scheduleHeader + 2 * count + plan));
  const schedule = new Int32Array(buffer);
  schedule[3] = count;
  if (positions > 0) {
    schedule[4] = positions;
    schedule[5] = libraries;
    schedule[6] = words;
    schedule[7] = references;
  }
  return buffer;
}

/** Where the parts of a schedule with costs start (`newSchedule`). */
class PlanLayout {
  readonly lengths: number;
  readonly starts: number;
  readonly references: number;
  readonly costs: number;
  readonly groups: number;
  readonly resolved: number;
  readonly words: number;

  constructor(schedule: Int32Array) {
    const positions = schedule[4]!;
    this.lengths = scheduleHeader + 2 * schedule[3]!;
    this.starts = this.lengths + positions;
    this.references = this.starts + positions + 1;
    this.costs = this.references + schedule[7]!;
    this.groups = this.costs + schedule[5]!;
    this.resolved = this.groups + positions;
    this.words = schedule[6]!;
  }
}

/**
 * The costs of a schedule, copied out of the shared buffer once per checker: they do not change, and
 * in scriptc builds every access to a shared buffer takes a process-wide lock, which the checkers
 * waiting for the schedule's own lock also take.
 */
export class SchedulePlan {
  readonly layout: PlanLayout;
  /** The schedule from its first length up to the sets of resolved libraries. */
  private readonly data: Int32Array;

  constructor(schedule: Int32Array) {
    this.layout = new PlanLayout(schedule);
    this.data = schedule.slice(this.layout.lengths, this.layout.resolved);
  }

  length(position: number): number {
    return this.data[position]!;
  }

  /** The start of the libraries of `position` in the references (`referenceStart(position + 1)` is its end). */
  referenceStart(position: number): number {
    return this.data[this.layout.starts - this.layout.lengths + position]!;
  }

  reference(k: number): number {
    return this.data[this.layout.references - this.layout.lengths + k]!;
  }

  cost(library: number): number {
    return this.data[this.layout.costs - this.layout.lengths + library]!;
  }

  /** The number of files of the group starting at `position` (0 or 1 for a file of its own). */
  group(position: number): number {
    return this.data[this.layout.groups - this.layout.lengths + position]!;
  }

  /** A copy of the set of libraries `checker` has resolved. */
  resolvedBy(schedule: Int32Array, checker: number): number[] {
    const words: number[] = [];
    const at = this.layout.resolved + checker * this.layout.words;
    for (let w = 0; w < this.layout.words; w++) words.push(Atomics.load(schedule, at + w));
    return words;
  }
}

/** The costs of `schedule`, or `undefined` if it has none. */
export function schedulePlan(schedule: Int32Array): SchedulePlan | undefined {
  return Atomics.load(schedule, 4) > 0 ? new SchedulePlan(schedule) : undefined;
}

function isResolved(words: readonly number[], library: number): boolean {
  return (words[library >> 5]! & (1 << (library & 31))) !== 0;
}

/**
 * Fills the costs of a schedule from `newSchedule(count, lengths.length, libraryCosts.length, R)`:
 * the text length of the file at each position, the libraries (0 to `libraryCosts.length - 1`) it
 * imports, R in total, what resolving each library costs, and the number of files of the group
 * starting at each position (`groups`, by default none).
 */
export function fillScheduleCosts(
  schedule: Int32Array,
  lengths: readonly number[],
  libraries: readonly (readonly number[])[],
  libraryCosts: readonly number[],
  groups: readonly number[] = [],
): void {
  const layout = new PlanLayout(schedule);
  for (let p = 0; p < groups.length; p++) schedule[layout.groups + p] = groups[p]!;
  let reference = 0;
  for (let p = 0; p < lengths.length; p++) {
    schedule[layout.lengths + p] = lengths[p]!;
    schedule[layout.starts + p] = reference;
    for (const library of libraries[p]!) schedule[layout.references + reference++] = library;
  }
  schedule[layout.starts + lengths.length] = reference;
  for (let k = 0; k < libraryCosts.length; k++) schedule[layout.costs + k] = Math.round(libraryCosts[k]!);
}

/** Records that `checker` resolves the libraries of the file at `position`. */
function markResolved(schedule: Int32Array, plan: SchedulePlan | undefined, checker: number, position: number): void {
  if (plan === undefined) return;
  const set = plan.layout.resolved + checker * plan.layout.words;
  const end = plan.referenceStart(position + 1);
  for (let r = plan.referenceStart(position); r < end; r++) {
    const library = plan.reference(r);
    Atomics.or(schedule, set + (library >> 5), 1 << (library & 31));
  }
}

/**
 * The next position of the order for checker `index`, or -1 when every file is taken. `plan` is
 * `schedulePlan(schedule)`, which a checker reads once.
 */
export function takePosition(
  schedule: Int32Array,
  length: number,
  index: number,
  plan: SchedulePlan | undefined = schedulePlan(schedule),
): number {
  const reserved = reservedBy(index);
  if (reserved.length > 0) return reserved.shift()!;
  const heavy = Atomics.load(schedule, 2);
  if (heavy < 0) {
    const k = Atomics.add(schedule, 0, 1);
    return k < length ? k : -1;
  }
  for (;;) {
    // The shared queue: a group goes to one checker as a whole.
    const k = Atomics.load(schedule, 0);
    if (k >= heavy) break;
    const files = plan === undefined ? 1 : Math.max(1, plan.group(k));
    if (Atomics.compareExchange(schedule, 0, k, k + files) !== k) continue;
    for (let j = k; j < k + files; j++) {
      markResolved(schedule, plan, index, j);
      if (j > k) reserved.push(j);
    }
    return k;
  }
  while (Atomics.compareExchange(schedule, 1, 0, 1) !== 0) {
    // Another checker is taking a file; this takes nanoseconds, or microseconds to take a range.
  }
  const own = scheduleHeader + 2 * index;
  let lo = Atomics.load(schedule, own);
  let hi = Atomics.load(schedule, own + 1);
  if (lo >= hi) {
    const taken = plan !== undefined ? takeCheapestEnd(schedule, plan, index) : takeBackHalf(schedule);
    if (taken === undefined) {
      Atomics.store(schedule, 1, 0);
      return -1;
    }
    lo = taken[0]!;
    hi = taken[1]!;
  }
  Atomics.store(schedule, own, lo + 1);
  Atomics.store(schedule, own + 1, hi);
  markResolved(schedule, plan, index, lo);
  Atomics.store(schedule, 1, 0);
  return lo;
}

/** The rest of a group that checker `index` took from the shared queue, by checker index. */
const reservedPositions = new Map<number, number[]>();

function reservedBy(index: number): number[] {
  let reserved = reservedPositions.get(index);
  if (reserved === undefined) {
    reserved = [];
    reservedPositions.set(index, reserved);
  }
  return reserved;
}

/** Takes the back half of the largest remaining range: its positions, or `undefined` if none is left. */
function takeBackHalf(schedule: Int32Array): number[] | undefined {
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
  if (victim < 0) return undefined;
  const at = scheduleHeader + 2 * victim;
  const hi = Atomics.load(schedule, at + 1);
  const lo = Atomics.load(schedule, at) + (most >> 1);
  Atomics.store(schedule, at + 1, lo);
  return [lo, hi];
}

/**
 * For checker `thief`: takes the end of another checker's range that brings the later of the two
 * estimated finishing times furthest forward (its positions), or nothing (`undefined`) if every part
 * would make it later. The owner's remaining cost counts its files and, once, the libraries they import that it
 * has not resolved; the thief's cost of an end counts its files and the libraries they import that
 * the thief has not resolved.
 */
/** With TSC_TS_CHECKERS_TRACE=3: what each idle checker takes. */
const traceSteals = process.env.TSC_TS_CHECKERS_TRACE === '3';

function takeCheapestEnd(schedule: Int32Array, plan: SchedulePlan, thief: number): number[] | undefined {
  const count = Atomics.load(schedule, 3);
  const thiefResolved = plan.resolvedBy(schedule, thief);
  let bestVictim = -1;
  let bestStart = 0;
  // Even taking what changes nothing helps when the owner is busy with a long file, or never starts.
  let bestGain = -1;
  let bestRemaining = 0;
  let bestThiefCost = 0;
  for (let v = 0; v < count; v++) {
    if (v === thief) continue;
    const at = scheduleHeader + 2 * v;
    const lo = Atomics.load(schedule, at);
    const hi = Atomics.load(schedule, at + 1);
    if (lo >= hi) continue;
    const ownerResolved = plan.resolvedBy(schedule, v);
    let remaining = 0;
    const counted = new Set<number>();
    for (let p = lo; p < hi; p++) {
      remaining += plan.length(p);
      const end = plan.referenceStart(p + 1);
      for (let r = plan.referenceStart(p); r < end; r++) {
        const library = plan.reference(r);
        if (!counted.has(library) && !isResolved(ownerResolved, library)) {
          counted.add(library);
          remaining += plan.cost(library);
        }
      }
    }
    // The thief takes [start, hi): the owner keeps the rest, the thief pays for libraries it lacks.
    let taken = 0;
    let thiefCost = 0;
    const lacking = new Set<number>();
    for (let start = hi - 1; start >= lo; start--) {
      const length = plan.length(start);
      taken += length;
      thiefCost += length;
      const end = plan.referenceStart(start + 1);
      for (let r = plan.referenceStart(start); r < end; r++) {
        const library = plan.reference(r);
        if (!lacking.has(library) && !isResolved(thiefResolved, library)) {
          lacking.add(library);
          thiefCost += plan.cost(library);
        }
      }
      const gain = remaining - Math.max(remaining - taken, thiefCost);
      if (gain > bestGain) {
        bestGain = gain;
        bestVictim = v;
        bestStart = start;
        bestRemaining = remaining;
        bestThiefCost = thiefCost;
      }
      // Taking more only makes the thief finish later.
      if (thiefCost >= remaining - taken) break;
    }
  }
  if (bestVictim < 0) {
    if (traceSteals) process.stderr.write(`checkers: steal ${thief} none at ${Date.now()}\n`);
    return undefined;
  }
  const at = scheduleHeader + 2 * bestVictim;
  const hi = Atomics.load(schedule, at + 1);
  if (traceSteals)
    process.stderr.write(
      `checkers: steal ${thief} from ${bestVictim} [${bestStart},${hi}) of [${Atomics.load(schedule, at)},${hi}) remaining ${bestRemaining} thief ${bestThiefCost} at ${Date.now()}\n`,
    );
  Atomics.store(schedule, at + 1, bestStart);
  return [bestStart, hi];
}

/**
 * A plan for checking a program with several checkers (`planSchedule`): the order of its files, the
 * number of leading positions every checker takes from the shared queue (-1 for all), the start and
 * end of each checker's range, and the costs of each position (`fillScheduleCosts`).
 */
export class CheckPlan {
  constructor(
    readonly order: number[],
    readonly heavy: number,
    readonly ranges: number[],
    readonly lengths: number[],
    readonly libraries: number[][],
    readonly libraryCosts: number[],
    readonly references: number,
    /** For each position, the number of files of the group starting there (0 elsewhere). */
    readonly groups: number[] = [],
  ) {}
}

/** The shared schedule of `plan` for `count` checkers. */
export function scheduleOf(plan: CheckPlan, count: number): SharedArrayBuffer {
  const buffer = newSchedule(count, plan.lengths.length, plan.libraryCosts.length, plan.references);
  const schedule = new Int32Array(buffer);
  if (plan.lengths.length > 0)
    fillScheduleCosts(schedule, plan.lengths, plan.libraries, plan.libraryCosts, plan.groups);
  Atomics.store(schedule, 2, plan.heavy);
  for (let k = 0; k < plan.ranges.length; k++) Atomics.store(schedule, scheduleHeader + k, plan.ranges[k]!);
  return buffer;
}

/** The most checked files that may import a file that starts a group (`checkGroups`), and the most files joining it from its importers. */
const groupImporters = 16;

/** The least load (`checkGroups`) of a file that starts a group, in characters. */
const groupLoad = 1_000_000;

/**
 * Groups of checked files (`order`, with estimated costs `cost`) that one of `count` checkers should
 * check together, each costliest first. A checker resolving the declarations of a file pays for much
 * of what the files it imports declare, and so does every checker checking a file that imports it:
 * a large generated schema and the files importing it, or a module that composes a server from
 * everything else, can cost each checker seconds. So a file whose load, its own text and the text
 * of the checked files it imports directly, is at least a sixteenth of all checked text and
 * `least` characters, and that 1 to `groupImporters` checked files import, starts a group. Such files
 * join the groups of those they import or that import them, and the files importing one directly
 * or indirectly join its group when there are at most `groupImporters` of them. Only groups of small
 * files around one large file form: the text of the others may be at most a quarter of a checker's
 * share, so that checking them together costs little more than their shared declarations (a group
 * of large components, each mostly its own work, would only make its checker finish last).
 */
export function checkGroups(
  checked: CheckedProgram,
  order: readonly number[],
  cost: readonly number[],
  count: number,
  least: number = groupLoad,
): number[][] {
  const program = checked.program;
  const files = program.getSourceFiles();
  const indexOf = new Map<SourceFile, number>();
  for (const i of order) indexOf.set(files[i]!, i);
  const imports = new Map<number, number[]>();
  const importers = new Map<number, number[]>();
  for (const i of order) {
    imports.set(i, []);
    importers.set(i, []);
  }
  let total = 0;
  for (const i of order) {
    total += files[i]!.text.length;
    const own = imports.get(i)!;
    for (const target of program.getResolvedFilesOf(files[i]!)) {
      const k = indexOf.get(target);
      if (k === undefined || k === i || own.indexOf(k) >= 0) continue;
      own.push(k);
      importers.get(k)!.push(i);
    }
  }
  const threshold = Math.max(least, total / 16);
  const starts = new Set<number>();
  for (const i of order) {
    const by = importers.get(i)!.length;
    if (by < 1 || by > groupImporters) continue;
    let load = files[i]!.text.length;
    for (const k of imports.get(i)!) load += files[k]!.text.length;
    if (load >= threshold) starts.add(i);
  }
  if (starts.size === 0) return [];
  // Union-find over the files of groups.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const start of starts) {
    find(start);
    for (const k of imports.get(start)!) if (starts.has(k)) union(start, k);
    for (const k of importers.get(start)!) if (starts.has(k)) union(start, k);
    const closure = [start];
    const seen = new Set<number>(closure);
    let complete = true;
    for (let q = 0; q < closure.length && complete; q++)
      for (const k of importers.get(closure[q]!)!) {
        if (seen.has(k)) continue;
        seen.add(k);
        closure.push(k);
        if (closure.length > groupImporters + 1) {
          complete = false;
          break;
        }
      }
    if (complete) for (const k of closure) union(start, k);
  }
  const members = new Map<number, number[]>();
  for (const i of order) {
    if (!parent.has(i)) continue;
    const root = find(i);
    let group = members.get(root);
    if (group === undefined) members.set(root, (group = []));
    group.push(i);
  }
  const groups: number[][] = [];
  for (const group of members.values()) {
    if (group.length < 2) continue;
    let largest = 0;
    let text = 0;
    for (const i of group) {
      text += files[i]!.text.length;
      largest = Math.max(largest, files[i]!.text.length);
    }
    if (text - largest > total / count / 4) continue;
    group.sort((a, b) => cost[b]! - cost[a]! || a - b);
    groups.push(group);
  }
  return groups;
}

/**
 * Plans checking with `count` checkers: the order to check files in, the costliest files and the
 * groups (`checkGroups`; at least `count` entries, and every file costing more than a 32nd of a
 * checker's share), costliest first, from the shared queue; then the others split, in program
 * order, into one range of about equal cost per checker, each costliest first.
 */
export function planSchedule(checked: CheckedProgram, count: number): CheckPlan {
  const costs = costOrder(checked);
  const order = costs.order;
  const cost = costs.cost;
  if (order.length <= count) return new CheckPlan(order, -1, [], [], [], [], 0);
  let all = 0;
  for (const i of order) all += cost[i]!;
  // Files that cost more than a 32nd of a checker's share go first, costliest first: at the end of
  // a range they would make its checker finish last.
  let heavyCount = count;
  while (heavyCount < order.length && cost[order[heavyCount]!]! * count * 32 >= all) heavyCount++;
  // The groups go to the shared queue as one entry each, among the costliest files, by total cost.
  const groups = checkGroups(checked, order, cost, count);
  const grouped = new Set<number>();
  for (const group of groups) for (const i of group) grouped.add(i);
  const entries: number[][] = groups.slice();
  for (const i of order.slice(0, heavyCount)) if (!grouped.has(i)) entries.push([i]);
  const entryCost = (entry: number[]): number => {
    let sum = 0;
    for (const i of entry) sum += cost[i]!;
    return sum;
  };
  entries.sort((a, b) => entryCost(b) - entryCost(a) || a[0]! - b[0]!);
  const heavy: number[] = [];
  const groupAt: number[] = [];
  for (const entry of entries)
    for (let k = 0; k < entry.length; k++) {
      heavy.push(entry[k]!);
      groupAt.push(k === 0 && entry.length > 1 ? entry.length : 0);
    }
  const rest = order
    .slice(heavyCount)
    .filter((i) => !grouped.has(i))
    .sort((a, b) => a - b);
  heavyCount = heavy.length;
  let total = 0;
  for (const i of rest) total += cost[i]!;
  const planned = heavy.concat(rest);
  const ranges: number[] = [];
  let position = heavyCount;
  let sum = 0;
  for (let c = 0; c < count; c++) {
    const start = position;
    const target = (total * (c + 1)) / count;
    while (position < planned.length && (c === count - 1 || sum + cost[planned[position]!]! / 2 <= target)) {
      sum += cost[planned[position]!]!;
      position++;
    }
    ranges.push(start, position);
    // A range is the files of a checker; within it, costliest first, so that the files other
    // checkers take from its end, and the last files anyone checks, are cheap.
    const range = planned.slice(start, position).sort((a, b) => cost[b]! - cost[a]! || a - b);
    for (let k = 0; k < range.length; k++) planned[start + k] = range[k]!;
  }
  // The costs of each position, with the libraries numbered in order of first use.
  const files = checked.program.getSourceFiles();
  const libraryIds = new Map<number, number>();
  const libraryCosts: number[] = [];
  const lengths: number[] = [];
  const libraries: number[][] = [];
  let references = 0;
  for (const i of planned) {
    lengths.push(files[i]!.text.length);
    const ids: number[] = [];
    for (const k of costs.libraries[i]!) {
      let id = libraryIds.get(k);
      if (id === undefined) {
        id = libraryCosts.length;
        libraryIds.set(k, id);
        libraryCosts.push(costs.libraryCost[k]!);
      }
      ids.push(id);
    }
    libraries.push(ids);
    references += ids.length;
  }
  while (groupAt.length < planned.length) groupAt.push(0);
  if (process.env.TSC_TS_CHECKERS_TRACE !== undefined)
    for (const group of groups)
      process.stderr.write(
        `checkers: group of ${group.length}: ${group.map((i) => files[i]!.fileName.split('/').slice(-2).join('/')).join(' ')}\n`,
      );
  return new CheckPlan(planned, heavyCount, ranges, lengths, libraries, libraryCosts, references, groupAt);
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
  const plan = schedulePlan(counter);
  for (;;) {
    const k = takePosition(counter, order.length, index, plan);
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
  const orderStart = performance.now();
  const plan = planSchedule(checked, count);
  const order = plan.order;
  const counter = scheduleOf(plan, count);
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
