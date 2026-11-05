import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // The output is CommonJS whatever the project's own package.json says.
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
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
  if (usesBuiltin(compiler, files, cwd)) return buildBuiltin(args, files, cwd, outDir);
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
  const program = ts.createProgram(parsed.fileNames.map((f) => resolve(cwd, f)), options, host);
  program.emit(undefined, (name, text) => {
    mkdirSync(dirname(name), { recursive: true });
    const code = name.endsWith('.js')
      ? transformSync(text, { format: 'cjs', target: 'es2022', sourcefile: name }).code
      : text;
    writeFileSync(name, code);
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const text = ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => cwd,
    getNewLine: () => String.fromCharCode(10),
  });
  return { outDir, diagnostics: text.trim(), ok: diagnostics.every((d) => d.category !== ts.DiagnosticCategory.Error) };
}
