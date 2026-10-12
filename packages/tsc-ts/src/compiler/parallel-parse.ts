/**
 * Parsing and binding on several threads, before checking on several threads (`--checkers N` in
 * scriptc builds).
 *
 * Before the main thread creates the Program, N parse threads load the program's files ahead of it,
 * the way tsgo's loader does: the main thread queues the root files, the default libraries and the
 * automatic type directives, and hands the queue out to the threads in small chunks. Each thread
 * parses and binds the files of a chunk through a FileLoader of its own (parse-thread.ts), which
 * resolves their references, imports and type directives exactly as the program's FileLoader will,
 * and sends back the bound source files, published with `@scriptc/threads` so that they reach the
 * main thread by reference, together with the files they add. The main thread queues the files it
 * has not seen yet, and loading ends when the queue is empty and every thread is idle. Node and
 * symbol ids come in chunks from one shared counter, so they stay unique in the program.
 *
 * The FileLoader then takes a prepared file instead of parsing when the file name, canonical path and
 * module-indicator options match; anything else (a file that was not loaded ahead, or that is parsed
 * with other options) is parsed as usual, so the program does not depend on what was loaded ahead.
 */
import type { Worker } from 'node:worker_threads';
import { publish } from '@scriptc/threads';
import { type SourceFile, type ExternalModuleIndicatorOptions, lastNodeIdValue, shareNodeIds } from './ast.js';
import type { LoadedFile } from './file-loader.js';
import type { CompilerOptions } from './options.js';
import { useThreadTextCaches } from './diagnostics.js';
import { useLazyJSDocTable } from './parser.js';
import { getNormalizedAbsolutePath } from './path.js';
import { getDefaultLibFileName, getLibFileName } from './program-utilities.js';
import { lastSymbolIdValue, shareSymbolIds } from './symbol.js';
import { mark, timeline } from './timeline.js';

/** What a queued file is. */
export const enum LoadKind {
  /** A root file of the config, as the config names it. */
  Root = 0,
  /** A file another file adds, by normalized file name. */
  File = 1,
  /** A library file, by its name (`lib.es2020.d.ts`). */
  Library = 2,
  /** The automatic type directives (`types`, or every package in `node_modules/@types`). */
  AutomaticTypes = 3,
}

/**
 * Files to load: kind, name and `maxNodeModuleJsDepth` depth of each, and the size in bytes of the
 * files a parse thread adds (0 where unknown).
 */
export class LoadJobs {
  readonly kinds: number[] = [];
  readonly names: string[] = [];
  readonly depths: number[] = [];
  readonly sizes: number[] = [];

  push(kind: LoadKind, name: string, depth: number, size = 0): void {
    this.kinds.push(kind);
    this.names.push(name);
    this.depths.push(depth);
    this.sizes.push(size);
  }
}

/**
 * A parsed and bound source file, with the inputs it was parsed from and what the parse thread's
 * FileLoader found loading it (its references and their resolutions), which the program's
 * FileLoader takes instead of resolving them again.
 */
export class PreparedFile {
  loaded: LoadedFile | undefined = undefined;

  constructor(
    readonly fileName: string,
    readonly path: string,
    readonly jsx: boolean,
    readonly force: boolean,
    readonly file: SourceFile,
  ) {}
}

/** What a parse thread's FileLoader found loading `fileName`, if the thread prepared it. */
export function preparedLoad(fileName: string): LoadedFile | undefined {
  if (parallelParse.files.size === 0) return undefined;
  return parallelParse.files.get(fileName)?.loaded;
}

/** What a parse thread sends back for a chunk: its bound files and the files they add. */
export class PreparedBatch {
  constructor(
    readonly files: PreparedFile[],
    readonly added: LoadJobs,
    readonly parseMs: number,
  ) {}
}

/**
 * What the main thread posts a parse thread: a chunk of files to load, or `stop`. A plain object:
 * posting copies it.
 */
export type LoadMessage = {
  readonly stop: boolean;
  readonly kinds: number[];
  readonly names: string[];
  readonly depths: number[];
};

/**
 * Starts a parse thread (main.ts owns the worker entry point). It reads the config `configFileName`
 * (`''` for none) with the command line of this run, takes ids from `counter`, and loads the chunks
 * posted to it (`LoadMessage`) until it is told to stop.
 */
export type ParserSpawn = (configFileName: string, counter: SharedArrayBuffer, index: number) => Worker;

export class ParallelParse {
  /** Set where parse threads can be started and share what they parse (scriptc builds). */
  spawn: ParserSpawn | undefined = undefined;
  /** Prepared files by file name, taken by the FileLoader. */
  readonly files = new Map<string, PreparedFile>();
  /** Files the FileLoader took, found with other parse inputs, and did not find. */
  used = 0;
  missed = 0;
  unprepared = 0;
}

export const parallelParse = new ParallelParse();

/** The FileLoader's lookup: the prepared file for these parse inputs, or `undefined`. */
export function takePreparedFile(
  fileName: string,
  path: string,
  options: ExternalModuleIndicatorOptions,
): SourceFile | undefined {
  if (parallelParse.files.size === 0) return undefined;
  const prepared = parallelParse.files.get(fileName);
  if (prepared === undefined) {
    parallelParse.unprepared++;
    return undefined;
  }
  if (prepared.path !== path || prepared.jsx !== options.jsx || prepared.force !== options.force) {
    parallelParse.missed++;
    return undefined;
  }
  parallelParse.used++;
  return prepared.file;
}

/** Files per chunk at most: small enough that the files a chunk adds are queued again soon. */
const maxChunk = 16;

/** Files from this size (bytes) on take a parse thread 25 ms or more, and go out ahead of others. */
const largeFile = 256 * 1024;

/**
 * The files to hand out to parse threads, each queued once. Library files go out first, one per
 * chunk, also those found later through `/// <reference lib>`: a large one (`lib.dom.d.ts`) takes a
 * thread 100–150 ms, and queued behind other files it would be the last file the program waits for.
 * Then, for the same reason, large files the parse threads found (`csstype`'s 0.9 MB of
 * declarations, found through React's), one per chunk. The other files go out in program order, in
 * chunks of up to `maxChunk`.
 */
export class ParseQueue {
  private readonly libraries = new LoadJobs();
  private readonly large = new LoadJobs();
  private readonly others = new LoadJobs();
  private libraryHead = 0;
  private largeHead = 0;
  private head = 0;
  private readonly seen = new Set<string>();

  push(kind: LoadKind, name: string, depth: number, size = 0): void {
    const key = kind === LoadKind.Library ? 'lib:' + name : kind === LoadKind.AutomaticTypes ? 'types:' : name;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const jobs =
      kind === LoadKind.Library
        ? this.libraries
        : kind === LoadKind.File && size >= largeFile
          ? this.large
          : this.others;
    jobs.push(kind, name, depth, size);
  }

  /** Files queued so far. */
  queued(): number {
    return this.seen.size;
  }

  /** Files not handed out yet. */
  left(): number {
    return (
      this.libraries.names.length -
      this.libraryHead +
      this.large.names.length -
      this.largeHead +
      this.others.names.length -
      this.head
    );
  }

  /** The next chunk for one of `threads` parse threads, or `undefined` when nothing is left. */
  next(threads: number): LoadMessage | undefined {
    const libraries = this.libraries;
    if (this.libraryHead < libraries.names.length) {
      const k = this.libraryHead++;
      return {
        stop: false,
        kinds: [libraries.kinds[k]!],
        names: [libraries.names[k]!],
        depths: [libraries.depths[k]!],
      };
    }
    const large = this.large;
    if (this.largeHead < large.names.length) {
      const k = this.largeHead++;
      return {
        stop: false,
        kinds: [large.kinds[k]!],
        names: [large.names[k]!],
        depths: [large.depths[k]!],
      };
    }
    const queue = this.others;
    const left = queue.names.length - this.head;
    if (left <= 0) return undefined;
    const size = Math.min(maxChunk, Math.max(1, Math.floor(left / threads)));
    const start = this.head;
    const end = start + size;
    this.head = end;
    return {
      stop: false,
      kinds: queue.kinds.slice(start, end),
      names: queue.names.slice(start, end),
      depths: queue.depths.slice(start, end),
    };
  }
}

/**
 * Main thread: loads the program's files ahead of it on `count` parse threads, and calls `done` once
 * every prepared file is available to the FileLoader.
 */
export function startParallelParse(
  count: number,
  rootNames: readonly string[],
  options: CompilerOptions,
  currentDirectory: string,
  configFileName: string,
  done: () => void,
): void {
  const start = performance.now();
  mark(`parse start, ${count} threads`);
  const trace = process.env.TSC_TS_CHECKERS_TRACE !== undefined;
  const verbose = process.env.TSC_TS_CHECKERS_TRACE === '3';
  // Prepared files are published (immutable): this thread keeps lazily parsed JSDoc, and the text
  // caches of declaration files, in tables.
  useLazyJSDocTable();
  useThreadTextCaches();

  const queue = new ParseQueue();
  const enqueue = (kind: LoadKind, name: string, depth: number, size = 0): void => queue.push(kind, name, depth, size);
  // The FileLoader's root tasks.
  for (const name of rootNames) enqueue(LoadKind.Root, getNormalizedAbsolutePath(name, currentDirectory), 0);
  if (rootNames.length > 0) {
    if (options.noLib !== true) {
      const lib = options.lib;
      if (lib === undefined) enqueue(LoadKind.Library, getDefaultLibFileName(options), 0);
      else
        for (const name of lib) {
          const fileName = getLibFileName(name);
          if (fileName !== '') enqueue(LoadKind.Library, fileName, 0);
        }
    }
    enqueue(LoadKind.AutomaticTypes, '', 0);
  }

  const counter = new SharedArrayBuffer(8);
  const ids = new Int32Array(counter);
  ids[0] = lastNodeIdValue();
  ids[1] = lastSymbolIdValue();
  shareNodeIds(new Int32Array(counter, 0, 1));
  shareSymbolIds(new Int32Array(counter, 4, 1));

  const workers: Worker[] = [];
  // Parse threads waiting for a chunk; `busy` counts those loading one.
  const idle: number[] = [];
  const alive: boolean[] = [];
  let busy = 0;
  let chunks = 0;
  let finished = false;
  const finish = (): void => {
    finished = true;
    const stop: LoadMessage = { stop: true, kinds: [], names: [], depths: [] };
    for (let i = 0; i < workers.length; i++) if (alive[i]!) workers[i]!.postMessage(stop);
    shareNodeIds(undefined);
    shareSymbolIds(undefined);
    mark(`parse done, ${parallelParse.files.size} files, ${chunks} chunks`);
    if (trace)
      process.stderr.write(
        `parsers: ${parallelParse.files.size} files prepared in ${(performance.now() - start).toFixed(1)}ms (${chunks} chunks, ${queue.queued()} queued, ${queue.left()} left)\n`,
      );
    done();
  };
  const dispatch = (): void => {
    while (idle.length > 0) {
      const chunk = queue.next(count);
      if (chunk === undefined) break;
      workers[idle.pop()!]!.postMessage(chunk);
      busy++;
      chunks++;
    }
    // Every thread is idle (or failed) and nothing is left to hand out: what is not prepared now is
    // parsed by the program's FileLoader.
    if (busy === 0 && !finished) finish();
  };
  for (let i = 0; i < count; i++) {
    const worker = parallelParse.spawn!(configFileName, counter, i);
    workers.push(worker);
    alive.push(true);
    idle.push(i);
    worker.on('message', (message: unknown) => {
      const batch = publish((message as { batch: PreparedBatch }).batch);
      if (timeline) mark(`chunk from p${i}: ${batch.files.length} files, ${queue.left()} left, ${busy - 1} busy`);
      for (const prepared of batch.files) parallelParse.files.set(prepared.fileName, prepared);
      const added = batch.added;
      for (let k = 0; k < added.names.length; k++)
        enqueue(added.kinds[k]!, added.names[k]!, added.depths[k]!, added.sizes[k]!);
      if (verbose)
        process.stderr.write(
          `parsers: thread ${i} loaded ${batch.files.length} files in ${batch.parseMs.toFixed(1)}ms, at ${(performance.now() - start).toFixed(1)}ms\n`,
        );
      busy--;
      idle.push(i);
      dispatch();
    });
    worker.on('error', (error: unknown) => {
      // The files of its chunk are parsed by the program's FileLoader.
      if (trace) process.stderr.write(`parsers: thread ${i} failed: ${String(error)}\n`);
      alive[i] = false;
      const waiting = idle.indexOf(i);
      if (waiting >= 0) idle.splice(waiting, 1);
      else busy--;
      if (!finished) dispatch();
    });
  }
  mark('parse threads spawned');
  dispatch();
}

/** With TSC_TS_CHECKERS_TRACE: how many prepared files the program took, and how many it parsed. */
export function reportPreparedFiles(fileNames: readonly string[]): void {
  const trace = process.env.TSC_TS_CHECKERS_TRACE;
  if (trace === undefined || parallelParse.files.size === 0) return;
  process.stderr.write(
    `parsers: program took ${parallelParse.used} prepared files, ${parallelParse.missed} mismatched, ${parallelParse.missed + parallelParse.unprepared} parsed on the main thread, ${parallelParse.files.size - parallelParse.used} prepared but not taken (${fileNames.length} files)\n`,
  );
  if (trace === '2')
    for (const fileName of fileNames)
      if (!parallelParse.files.has(fileName)) process.stderr.write(`  not prepared: ${fileName}\n`);
}
