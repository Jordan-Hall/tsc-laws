/**
 * Parsing and binding on several threads, before checking on several threads (`--checkers N` in
 * scriptc builds).
 *
 * Before the main thread creates the Program, it predicts the files the program will load: the
 * config's root files, the default libraries with their `/// <reference lib>` closure, and the
 * declaration files of the config's `types` packages and their dependencies. It splits them by size
 * into one share per thread, starts a thread for every share but its own, and parses and binds its
 * share. Each thread parses and binds its share and publishes the bound source files with
 * `@scriptc/threads`, which reach the main thread by reference. Node and symbol ids come in chunks
 * from one shared counter, so they stay unique in the program. The FileLoader then takes a prepared
 * file instead of parsing when the file name, canonical path and module-indicator options match;
 * anything else (a file that was not predicted, or that is parsed with other options) is parsed as
 * usual.
 */
import { statSync } from 'node:fs';
import type { Worker } from 'node:worker_threads';
import { publish } from '@scriptc/threads';
import {
  ExternalModuleIndicatorOptions,
  ParseOptions,
  ScriptKind,
  type SourceFile,
  lastNodeIdValue,
  shareNodeIds,
} from './ast.js';
import { bindSourceFile } from './binder.js';
import type { DirectoryEntries } from './file-system.js';
import { type CompilerOptions, getModuleResolutionKind, ModuleKind, ModuleResolutionKind } from './options.js';
import { parseSourceFile, useLazyJSDocTable } from './parser.js';
import {
  combinePaths,
  fileExtensionIsOneOf,
  getDirectoryPath,
  getNormalizedAbsolutePath,
  isDeclarationFileName,
  toPath,
} from './path.js';
import {
  getDefaultLibFileName,
  getExternalModuleIndicatorOptions,
  getImpliedNodeFormatForFile,
  getLibFileName,
  SourceFileMetadata,
} from './program-utilities.js';
import { assignSymbolIdsAtCreation, lastSymbolIdValue, shareSymbolIds } from './symbol.js';

/** A file to parse: name, canonical path and the module-indicator options it is parsed with. */
export class ParseJob {
  constructor(
    readonly fileName: string,
    readonly path: string,
    readonly jsx: boolean,
    readonly force: boolean,
    readonly size: number,
  ) {}
}

/** A parsed and bound source file, with the inputs it was parsed from. */
export class PreparedFile {
  constructor(
    readonly fileName: string,
    readonly path: string,
    readonly jsx: boolean,
    readonly force: boolean,
    readonly file: SourceFile,
  ) {}
}

/** What a parse worker sends back. */
export class PreparedBatch {
  constructor(
    readonly files: PreparedFile[],
    readonly parseMs: number,
  ) {}
}

/** Reads a file like the program's file system; `undefined` if it cannot be read. */
export type ReadFile = (fileName: string) => string | undefined;
/** The file and directory names in a directory. */
export type ListDirectory = (path: string) => DirectoryEntries;

/** Starts a parse thread over the files `fileNames` (main.ts owns the worker entry point). */
export type ParserSpawn = (fileNames: string[], paths: string[], flags: number[], counter: SharedArrayBuffer) => Worker;

export class ParallelParse {
  /** Set where parse threads can be started and share what they parse (scriptc builds). */
  spawn: ParserSpawn | undefined = undefined;
  /** Prepared files by file name, taken by the FileLoader. */
  readonly files = new Map<string, PreparedFile>();
  used = 0;
  missed = 0;
}

export const parallelParse = new ParallelParse();

/** The FileLoader's lookup: the prepared file for these parse inputs, or `undefined`. */
export function takePreparedFile(
  fileName: string,
  path: string,
  options: ExternalModuleIndicatorOptions,
): SourceFile | undefined {
  const prepared = parallelParse.files.get(fileName);
  if (prepared === undefined) return undefined;
  if (prepared.path !== path || prepared.jsx !== options.jsx || prepared.force !== options.force) {
    parallelParse.missed++;
    return undefined;
  }
  parallelParse.used++;
  return prepared.file;
}

/** Parses and binds `jobs` on this thread. */
export function parseJobs(jobs: readonly ParseJob[], readFile: ReadFile): PreparedFile[] {
  const out: PreparedFile[] = [];
  for (const job of jobs) {
    const text = readFile(job.fileName);
    if (text === undefined) continue;
    const file = parseSourceFile(
      job.fileName,
      text,
      new ParseOptions(job.path, ScriptKind.Unknown, new ExternalModuleIndicatorOptions(job.jsx, job.force)),
    );
    bindSourceFile(file);
    out.push(new PreparedFile(job.fileName, job.path, job.jsx, job.force, file));
  }
  return out;
}

/** A parse thread: shares the id counters, parses and binds its files, and publishes them. */
export function runParseWorker(
  fileNames: readonly string[],
  paths: readonly string[],
  flags: readonly number[],
  counter: SharedArrayBuffer,
  readFile: ReadFile,
): PreparedBatch {
  const start = performance.now();
  shareNodeIds(new Int32Array(counter, 0, 1));
  shareSymbolIds(new Int32Array(counter, 4, 1));
  assignSymbolIdsAtCreation();
  const jobs: ParseJob[] = [];
  for (let i = 0; i < fileNames.length; i++)
    jobs.push(new ParseJob(fileNames[i]!, paths[i]!, (flags[i]! & 1) !== 0, (flags[i]! & 2) !== 0, 0));
  return publish(new PreparedBatch(parseJobs(jobs, readFile), performance.now() - start));
}

/**
 * Main thread: predicts the program's files, parses them with `count` threads, this one included,
 * and calls `done` once every prepared file is available to the FileLoader.
 */
export function startParallelParse(
  count: number,
  fileNames: readonly string[],
  options: CompilerOptions,
  currentDirectory: string,
  defaultLibraryPath: string,
  useCaseSensitiveFileNames: boolean,
  readFile: ReadFile,
  listDirectory: ListDirectory,
  done: () => void,
): void {
  const start = performance.now();
  const trace = process.env.TSC_TS_CHECKERS_TRACE !== undefined;
  // Prepared files are published (immutable): this thread keeps lazily parsed JSDoc in a table.
  useLazyJSDocTable();
  const jobs = predictJobs(
    fileNames,
    options,
    currentDirectory,
    defaultLibraryPath,
    useCaseSensitiveFileNames,
    readFile,
    listDirectory,
  );
  if (trace)
    process.stderr.write(`parsers: predicted ${jobs.length} files in ${(performance.now() - start).toFixed(1)}ms\n`);
  // Largest first onto the least loaded share.
  jobs.sort((a, b) => b.size - a.size || (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
  const shares: ParseJob[][] = [];
  const loads: number[] = [];
  for (let i = 0; i < count; i++) {
    shares.push([]);
    loads.push(0);
  }
  for (const job of jobs) {
    let best = 0;
    for (let i = 1; i < count; i++) if (loads[i]! < loads[best]!) best = i;
    shares[best]!.push(job);
    loads[best] = loads[best]! + job.size + 2048;
  }
  const counter = new SharedArrayBuffer(8);
  const ids = new Int32Array(counter);
  ids[0] = lastNodeIdValue();
  ids[1] = lastSymbolIdValue();
  shareNodeIds(new Int32Array(counter, 0, 1));
  shareSymbolIds(new Int32Array(counter, 4, 1));
  let remaining = count - 1;
  const finish = (): void => {
    shareNodeIds(undefined);
    shareSymbolIds(undefined);
    if (trace)
      process.stderr.write(`parsers: ${jobs.length} files prepared in ${(performance.now() - start).toFixed(1)}ms\n`);
    done();
  };
  for (let i = 1; i < count; i++) {
    const share = shares[i]!;
    const worker = parallelParse.spawn!(
      share.map((j) => j.fileName),
      share.map((j) => j.path),
      share.map((j) => (j.jsx ? 1 : 0) | (j.force ? 2 : 0)),
      counter,
    );
    worker.on('message', (message: unknown) => {
      const batch = publish((message as { batch: PreparedBatch }).batch);
      for (const prepared of batch.files) parallelParse.files.set(prepared.fileName, prepared);
      if (trace)
        process.stderr.write(
          `parsers worker: ${batch.files.length} files in ${batch.parseMs.toFixed(1)}ms, at ${(performance.now() - start).toFixed(1)}ms\n`,
        );
      remaining--;
      if (remaining === 0) finish();
    });
  }
  const ownStart = performance.now();
  for (const prepared of parseJobs(shares[0]!, readFile)) parallelParse.files.set(prepared.fileName, prepared);
  if (trace)
    process.stderr.write(
      `parsers main: ${shares[0]!.length} files in ${(performance.now() - ownStart).toFixed(1)}ms\n`,
    );
  if (remaining === 0) finish();
}

/** The files the program is expected to load (see the module comment). */
function predictJobs(
  fileNames: readonly string[],
  options: CompilerOptions,
  currentDirectory: string,
  defaultLibraryPath: string,
  useCaseSensitiveFileNames: boolean,
  readFile: ReadFile,
  listDirectory: ListDirectory,
): ParseJob[] {
  const jobs: ParseJob[] = [];
  const seen = new Set<string>();
  const add = (fileName: string, size: number): void => {
    const path = toPath(fileName, currentDirectory, useCaseSensitiveFileNames);
    const indicator = getExternalModuleIndicatorOptions(fileName, options, metadataOf(fileName, options, readFile));
    jobs.push(new ParseJob(fileName, path, indicator.jsx, indicator.force, size));
  };
  // Sizes only steer the split; a file that cannot be read is skipped by its parser.
  const addBySize = (fileName: string): void => {
    let size = -1;
    try {
      size = statSync(fileName).size;
    } catch {
      size = -1;
    }
    if (size >= 0) add(fileName, size);
  };
  for (const name of fileNames) {
    const fileName = getNormalizedAbsolutePath(name, currentDirectory);
    if (seen.has(fileName)) continue;
    seen.add(fileName);
    if (fileExtensionIsOneOf(fileName, ['.ts', '.tsx', '.mts', '.cts'])) addBySize(fileName);
  }
  if (options.noLib !== true) {
    const libDirectory = getNormalizedAbsolutePath(defaultLibraryPath, currentDirectory);
    const pending: string[] = [];
    const lib = options.lib;
    if (lib === undefined) pending.push(getDefaultLibFileName(options));
    else for (const name of lib) pending.push(getLibFileName(name));
    const reference = /\/\/\/\s*<reference\s+lib\s*=\s*["']([^"']+)["']/g;
    while (pending.length > 0) {
      const name = pending.pop()!;
      if (name === '') continue;
      const fileName = combinePaths(libDirectory, name);
      if (seen.has(fileName)) continue;
      seen.add(fileName);
      const text = readFile(fileName);
      if (text === undefined) continue;
      add(fileName, text.length);
      for (const match of text.matchAll(reference)) pending.push(getLibFileName(match[1]!));
    }
  }
  // The declaration files of the `types` packages and of their dependencies (version-specific
  // subdirectories excluded).
  const types = options.types;
  if (types !== undefined) {
    const base = getNormalizedAbsolutePath(
      options.configFilePath !== undefined ? getDirectoryPath(options.configFilePath) : currentDirectory,
      currentDirectory,
    );
    const packages = new Set<string>();
    const addPackage = (directory: string): void => {
      if (packages.has(directory)) return;
      packages.add(directory);
      const pending = [directory];
      while (pending.length > 0) {
        const dir = pending.pop()!;
        const entries = listDirectory(dir);
        for (const file of entries.files) {
          if (!file.endsWith('.d.ts')) continue;
          const fileName = combinePaths(dir, file);
          if (seen.has(fileName)) continue;
          seen.add(fileName);
          addBySize(fileName);
        }
        for (const sub of entries.directories)
          if (sub !== 'node_modules' && !/^ts\d/.test(sub)) pending.push(combinePaths(dir, sub));
      }
      let dependencies: unknown = undefined;
      try {
        dependencies = (JSON.parse(readPackageJson(directory, readFile)) as { dependencies?: unknown }).dependencies;
      } catch {
        dependencies = undefined;
      }
      if (typeof dependencies === 'object' && dependencies !== null)
        for (const name of Object.keys(dependencies)) {
          const found = findPackage(directory, name, readFile);
          if (found !== '') addPackage(found);
        }
    };
    for (const name of types) {
      const found = findPackage(base, '@types/' + name, readFile);
      if (found !== '') addPackage(found);
    }
  }
  return jobs;
}

/** The directory of package `name` visible from `directory` (Node's lookup), or `''`. */
function findPackage(directory: string, name: string, readFile: ReadFile): string {
  for (;;) {
    const candidate = combinePaths(combinePaths(directory, 'node_modules'), name);
    if (readPackageJson(candidate, readFile) !== '') return candidate;
    const parent = getDirectoryPath(directory);
    if (parent === directory) return '';
    directory = parent;
  }
}

/** package.json text by directory (`''` for none), shared by every file of a prediction. */
const packageJsonTexts = new Map<string, string>();

function readPackageJson(directory: string, readFile: ReadFile): string {
  let text = packageJsonTexts.get(directory);
  if (text === undefined) {
    text = readFile(combinePaths(directory, 'package.json')) ?? '';
    packageJsonTexts.set(directory, text);
  }
  return text;
}

/** The FileLoader's `loadSourceFileMetadata`, reading `package.json` files directly. */
function metadataOf(fileName: string, options: CompilerOptions, readFile: ReadFile): SourceFileMetadata {
  // Declaration files never depend on it (getExternalModuleIndicatorOptions).
  if (isDeclarationFileName(fileName)) return new SourceFileMetadata('', '', ModuleKind.CommonJS);
  let packageJsonType = '';
  let packageJsonDirectory = '';
  let directory = getDirectoryPath(fileName);
  for (;;) {
    const text = readPackageJson(directory, readFile);
    if (text !== '') {
      packageJsonDirectory = directory;
      let type: unknown = undefined;
      try {
        type = (JSON.parse(text) as { type?: unknown }).type;
      } catch {
        type = undefined;
      }
      const kind = getModuleResolutionKind(options);
      if (
        typeof type === 'string' &&
        ((!fileExtensionIsOneOf(fileName, ['.mts', '.cts', '.mjs', '.cjs']) &&
          ModuleResolutionKind.Node16 <= kind &&
          kind <= ModuleResolutionKind.NodeNext) ||
          fileName.includes('/node_modules/'))
      )
        packageJsonType = type;
      break;
    }
    const parent = getDirectoryPath(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return new SourceFileMetadata(
    packageJsonType,
    packageJsonDirectory,
    getImpliedNodeFormatForFile(fileName, packageJsonType),
  );
}

/** With TSC_TS_CHECKERS_TRACE: how many prepared files the program took, and how many it parsed. */
export function reportPreparedFiles(fileNames: readonly string[]): void {
  const trace = process.env.TSC_TS_CHECKERS_TRACE;
  if (trace === undefined || parallelParse.files.size === 0) return;
  process.stderr.write(
    `parsers: program took ${parallelParse.used} prepared files, ${parallelParse.missed} mismatched, ${fileNames.length - parallelParse.used} parsed on the main thread\n`,
  );
  if (trace === '2')
    for (const fileName of fileNames)
      if (!parallelParse.files.has(fileName)) process.stderr.write(`  not prepared: ${fileName}\n`);
}
