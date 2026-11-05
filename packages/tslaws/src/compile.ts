import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import { lowerLawFile, usesLegacySyntax, type Lowered } from './lower.ts';
import { readConfig } from './coverage.ts';
import type { ManifestLaw } from './types.ts';

export interface BuildResult {
  outDir: string;
  /** Diagnostics the compiler printed; empty when the files type-check. */
  diagnostics: string;
  ok: boolean;
  /** Names this exact build (laws, options, every file read); set when the compiler ran in-process, so derived results can be kept. */
  key?: string;
  /** The program the in-process compiler built, still holding its type checker; not stored with the build cache. */
  program?: ts.Program;
}

/**
 * Runs the compiler, trying again when the system could not start it. On Windows a freshly built executable can be
 * briefly unavailable (a scanner holds it, the machine is out of handles), which surfaces as ENOENT or UNKNOWN.
 */
function launch(
  compiler: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
  let run = spawnSync(compiler, args, options);
  for (
    let attempt = 0;
    attempt < 4 && run.error !== undefined && /UNKNOWN|EBUSY|EAGAIN|EMFILE/.test(String(run.error));
    attempt += 1
  ) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * (attempt + 1));
    run = spawnSync(compiler, args, options);
  }
  return run;
}

/** The compiler finds its lib files in TSC_TS_LIB_DIR; without it, use the TypeScript 7 libs scriptc ships. */
function compilerEnv(cwd: string, compiler: string): NodeJS.ProcessEnv {
  if (process.env.TSC_TS_LIB_DIR !== undefined) return process.env;
  // The npm compiler package keeps the lib files beside the executable.
  const beside = dirname(compiler);
  if (existsSync(join(beside, 'lib.d.ts'))) return { ...process.env, TSC_TS_LIB_DIR: beside };
  for (let dir = cwd; ; dir = dirname(dir)) {
    const scope = join(dir, 'node_modules', '@scriptc');
    if (existsSync(scope)) {
      for (const entry of readdirSync(scope)) {
        const lib = join(scope, entry, 'dist', 'lib', 'typescript', 'lib');
        if (existsSync(join(lib, 'lib.d.ts'))) return { ...process.env, TSC_TS_LIB_DIR: lib };
      }
    }
    if (dirname(dir) === dir) return process.env;
  }
}

/** Lists the laws of `files` with the problems that stop them running. */
/** Says what to do when the compiler cannot start, in particular when none was found at all. */
function cannotRun(compiler: string, error: Error): string {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT')
    return `no tsc-laws compiler found (${compiler}): install the tslaws-compiler package for this platform, or set TSC_LAWS_BIN / --compiler to the compiler executable`;
  return `cannot run ${compiler}: ${error.message}`;
}

/** The compiler name that selects the built-in path: stock TypeScript, with laws written as `law(...)` calls. */
export const builtinCompiler = 'builtin';

const slash = (path: string): string => path.replaceAll(String.fromCharCode(92), '/');
const lowered = new Map<string, { text: string; result: Lowered }>();

/** Lowers `file` (project-relative), reusing the last result while its text is unchanged. */
function lowerFile(file: string, cwd: string): Lowered {
  const text = readFileSync(join(cwd, file), 'utf8');
  const key = slash(resolve(cwd, file));
  const cached = lowered.get(key);
  if (cached?.text === text) return cached.result;
  const result = lowerLawFile(slash(file), text);
  lowered.set(key, { text, result });
  return result;
}

const isLawFile = (file: string): boolean => /\.laws\.tsx?$/.test(file);

/**
 * Whether these files go through the built-in path. An explicit `builtin` always does; otherwise a project that
 * still writes `law name(...)` keeps using the tsc-laws compiler, the only parser of that syntax.
 */
export function usesBuiltin(compiler: string, files: string[], cwd: string): boolean {
  if (compiler === builtinCompiler) return true;
  return !files.some((f) => isLawFile(f) && existsSync(join(cwd, f)) && usesLegacySyntax(readFileSync(join(cwd, f), 'utf8')));
}

export function readManifest(compiler: string, files: string[], cwd: string): ManifestLaw[] {
  if (usesBuiltin(compiler, files, cwd))
    return files.filter(isLawFile).flatMap((f) => (existsSync(join(cwd, f)) ? lowerFile(f, cwd).laws : []));
  const run = launch(compiler, ['--laws-manifest', ...files], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    env: compilerEnv(cwd, compiler),
  });
  if (run.error !== undefined) throw new Error(cannotRun(compiler, run.error));
  const text = (run.stdout ?? '').trim();
  if (text === '') throw new Error(`${compiler} --laws-manifest printed nothing: ${run.stderr ?? ''}`);
  return (JSON.parse(text) as { laws: ManifestLaw[] }).laws;
}

const stringOptions = ['jsx', 'jsxFactory', 'jsxFragmentFactory', 'jsxImportSource'];
const booleanOptions = [
  'experimentalDecorators',
  'emitDecoratorMetadata',
  'useDefineForClassFields',
  'strict',
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'allowJs',
  'checkJs',
];
const listOptions = ['lib', 'types'];
const jsxModes = ['react', 'react-jsx', 'react-jsxdev', 'preserve'];
const supportedOptions = [...stringOptions, ...booleanOptions, ...listOptions];

/**
 * The compiler flags for the `compilerOptions` of tslaws.json. Only the supported keys pass; anything else is an
 * error rather than an arbitrary flag handed to the compiler. `strict` is the one default these can override.
 */
export function compilerFlags(options: Record<string, unknown> | undefined): string[] {
  const flags: string[] = [];
  for (const [key, value] of Object.entries(options ?? {})) {
    if (!supportedOptions.includes(key))
      throw new Error(
        `tslaws.json compilerOptions: unsupported option "${key}"; supported options are ${supportedOptions.join(', ')}`,
      );
    const bad = (expected: string): Error =>
      new Error(`tslaws.json compilerOptions: "${key}" must be ${expected}, got ${JSON.stringify(value)}`);
    if (stringOptions.includes(key)) {
      if (typeof value !== 'string' || value === '') throw bad('a string');
      if (key === 'jsx' && !jsxModes.includes(value)) throw bad(`one of ${jsxModes.join(', ')}`);
      flags.push(`--${key}`, value);
    } else if (booleanOptions.includes(key)) {
      if (typeof value !== 'boolean') throw bad('true or false');
      flags.push(`--${key}`);
      if (!value) flags.push('false');
    } else {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw bad('an array of strings');
      flags.push(`--${key}`, value.join(','));
    }
  }
  return flags;
}

/** Compiles `files` to CommonJS plus declarations in `.tslaws/out` under `cwd`, so `node_modules` still resolves. */
export function build(compiler: string, files: string[], cwd: string): BuildResult {
  const outDir = join(cwd, '.tslaws', 'out');
  const extra = compilerFlags(readConfig(cwd).compilerOptions);
  const args = [
    '--ignoreConfig',
    '--target',
    'es2022',
    '--module',
    'commonjs',
    '--moduleResolution',
    'bundler',
    ...(extra.includes('--strict') ? [] : ['--strict']),
    '--skipLibCheck',
    '--esModuleInterop',
    '--declaration',
    '--rootDir',
    cwd,
    '--outDir',
    outDir,
    ...extra,
    ...files,
  ];
  const builtin = usesBuiltin(compiler, files, cwd);
  const reused = builtin ? cachedBuild(args, files, cwd, outDir) : undefined;
  if (reused !== undefined) return reused;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // The output is CommonJS whatever the project's own package.json says.
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  if (builtin) return buildBuiltin(args, files, cwd, outDir);
  let run = launch(compiler, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, env: compilerEnv(cwd, compiler) });
  // A compiler that dies without a word (out of memory on a busy machine) is run again; a type error always says so.
  for (
    let attempt = 0;
    attempt < 2 &&
    run.error === undefined &&
    run.status !== 0 &&
    `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() === '';
    attempt += 1
  )
    run = launch(compiler, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, env: compilerEnv(cwd, compiler) });
  if (run.error !== undefined) throw new Error(cannotRun(compiler, run.error));
  return { outDir, diagnostics: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim(), ok: run.status === 0 };
}

/** Every `node_modules/@types` from `cwd` upwards: where the compiler looks for global declarations by default. */
function typeRootsOf(cwd: string): string[] {
  const roots: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', '@types');
    if (existsSync(candidate)) roots.push(candidate);
    if (dirname(dir) === dir) return roots;
  }
}

/** Compiles in-process with stock TypeScript: law files are lowered in memory, nothing is written next to them. */
function buildBuiltin(args: string[], files: string[], cwd: string, outDir: string): BuildResult {
  const at = args.indexOf('--moduleResolution');
  const parsed = ts.parseCommandLine(at < 0 ? args : [...args.slice(0, at), ...args.slice(at + 2)]);
  // Types resolve the bundler way, so package `exports` (tslaws/browser) work; the ES output is made CommonJS below.
  const options: ts.CompilerOptions = {
    ...parsed.options,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmitOnError: false,
    // Every @types package in the tree is a parse the laws rarely need; none is read unless `types` says so or the laws fail
    // to compile without them (below).
    ...(parsed.options.types === undefined ? { types: [] } : {}),
    // The DOM declarations are a megabyte to parse; only laws that run in a page (or an `lib` setting) ask for them.
    ...(parsed.options.lib === undefined && !files.some((f) => /\.(browser|e2e)\.laws\.[cm]?ts$/.test(f))
      ? { lib: ['lib.es2022.d.ts'] }
      : {}),
  };
  const overrides = new Map<string, string>();
  for (const file of files)
    if (isLawFile(file) && existsSync(join(cwd, file))) overrides.set(slash(resolve(cwd, file)), lowerFile(file, cwd).text);
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
    const text = overrides.get(slash(resolve(name)));
    return text === undefined
      ? getSourceFile(name, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(name, text, languageVersion, true);
  };
  const roots = parsed.fileNames.map((f) => resolve(cwd, f));
  let program = ts.createProgram(roots, options, host);
  let diagnostics = ts.getPreEmitDiagnostics(program);
  // An error may only be a global the narrow setup left out (`process`, `document`, a test runner's types): check again
  // with exactly what the compiler's own defaults include before reporting it, so no law is judged on less than before.
  if (
    (options.types !== parsed.options.types || options.lib !== parsed.options.lib) &&
    diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error)
  ) {
    // `@types` is looked up from the project, not from wherever the process happens to be (the compiler remembers the first directory it saw).
    const typeRoots = parsed.options.typeRoots ?? typeRootsOf(cwd);
    const full: ts.CompilerOptions = { ...options, types: parsed.options.types, lib: parsed.options.lib, typeRoots };
    program = ts.createProgram(roots, full, host);
    diagnostics = ts.getPreEmitDiagnostics(program);
  }
  program.emit(undefined, (name, text) => {
    mkdirSync(dirname(name), { recursive: true });
    const code = name.endsWith('.js')
      ? transformSync(text, { format: 'cjs', target: 'es2022', sourcefile: name }).code
      : text;
    writeFileSync(name, code);
  });
  const text = ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => cwd,
    getNewLine: () => String.fromCharCode(10),
  });
  const result: BuildResult = {
    outDir,
    diagnostics: text.trim(),
    ok: diagnostics.every((d) => d.category !== ts.DiagnosticCategory.Error),
  };
  Object.defineProperty(result, 'program', { value: program, enumerable: false });
  saveBuildCache(args, files, cwd, result, program.getSourceFiles().map((f) => f.fileName).filter((f) => !overrides.has(slash(resolve(f)))));
  return result;
}

// A build is reused when the laws, the options and every file the compiler read are as they were: the same answer, without
// parsing the standard library and the dependencies again.
interface BuildCache {
  /** What the laws and options alone make of it. */
  base: string;
  result: BuildResult;
  /** Every file the compiler read, with its size and modification time. */
  files: Record<string, [number, number]>;
}

const buildCachePath = (cwd: string): string => join(cwd, '.tslaws', 'build-cache.json');

function buildKey(args: string[], files: string[], cwd: string): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([args, ts.version, toolStamp]));
  for (const file of files)
    if (isLawFile(file) && existsSync(join(cwd, file))) hash.update(`
${file}
${lowerFile(file, cwd).text}`);
  return hash.digest('hex');
}

/** Changes whenever this compiler code does, so a new tslaws never reuses output made by an old one. */
const toolStamp = ((): number => {
  try {
    return statSync(new URL(import.meta.url)).mtimeMs;
  } catch {
    return 0;
  }
})();

function cachedBuild(args: string[], files: string[], cwd: string, outDir: string): BuildResult | undefined {
  try {
    const cache = JSON.parse(readFileSync(buildCachePath(cwd), 'utf8')) as BuildCache;
    if (cache.base !== buildKey(args, files, cwd) || !existsSync(join(outDir, 'package.json'))) return undefined;
    for (const [file, [size, mtime]] of Object.entries(cache.files)) {
      const stat = statSync(file);
      if (stat.size !== size || stat.mtimeMs !== mtime) return undefined;
    }
    return cache.result;
  } catch {
    return undefined;
  }
}

function saveBuildCache(args: string[], files: string[], cwd: string, result: BuildResult, read: string[]): void {
  try {
    const stats: Record<string, [number, number]> = {};
    for (const file of read) {
      const stat = statSync(file);
      stats[file] = [stat.size, stat.mtimeMs];
    }
    const base = buildKey(args, files, cwd);
    // The key also names the files read, so anything worked out from this build is dropped when one of them changes.
    result.key = createHash('sha256').update(base).update(JSON.stringify(stats)).digest('hex');
    const cache: BuildCache = { base, result, files: stats };
    writeFileSync(buildCachePath(cwd), JSON.stringify(cache));
  } catch {
    // No cache is only slower.
  }
}
