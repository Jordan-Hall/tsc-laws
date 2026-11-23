import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import { lowerLawFile, usesLegacySyntax, type Lowered } from './lower.ts';
import { readConfig } from './coverage.ts';
import { installLawRuntime, runtimeFile, type LawRuntime } from './lawRuntime.ts';
import { commonRoot, readResolution, resolutionCompilerOptions, type Resolution } from './tsconfigResolve.ts';
import { importMetaEnvGlobal } from './runtimeEnv.ts';
import { sealLaws } from './seal.ts';
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
  // A caller outside the CLI (the API, a test) can reach here with no compiler resolved; say so, not a TypeError from dirname.
  if (typeof compiler !== 'string') throw new Error(noCompiler('none'));
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

const noCompiler = (compiler: string): string =>
  `no tsc-laws compiler found (${compiler}): install the tslaws-compiler package for this platform, or set TSC_LAWS_BIN / --compiler to the compiler executable`;

/** Lists the laws of `files` with the problems that stop them running. */
/** Says what to do when the compiler cannot start, in particular when none was found at all. */
function cannotRun(compiler: string, error: Error): string {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return noCompiler(compiler);
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

/**
 * Whether the file holds laws: a `.laws.ts` name, or any file the project points at (a "laws" glob, a proposal in
 * `.tslaws/proposals`) whose text declares a law, as a call or with the keyword.
 */
function isLawFile(file: string, cwd: string): boolean {
  if (/\.laws\.tsx?$/.test(file)) return true;
  if (!existsSync(join(cwd, file))) return false;
  const text = readFileSync(join(cwd, file), 'utf8');
  return /\blaw\b/.test(text) && (usesLegacySyntax(text) || lowerFile(file, cwd).laws.length > 0);
}

/**
 * Whether these files go through the built-in path. An explicit `builtin` always does; otherwise a project that
 * still writes `law name(...)` keeps using the tsc-laws compiler, the only parser of that syntax.
 */
export function usesBuiltin(compiler: string, files: string[], cwd: string): boolean {
  if (compiler === builtinCompiler) return true;
  return !files.some(
    (f) => isLawFile(f, cwd) && existsSync(join(cwd, f)) && usesLegacySyntax(readFileSync(join(cwd, f), 'utf8')),
  );
}

/**
 * The tsc-laws compiler runs a project that uses the keyword syntax (`export law name(...)`) and does not know
 * `law('name', ...)` calls, so a project holding both would silently lose the calls. Say so instead.
 */
function assertOneSyntax(files: string[], cwd: string): void {
  const present = files.filter((f) => isLawFile(f, cwd) && existsSync(join(cwd, f)));
  const keyword = present.filter((f) => usesLegacySyntax(readFileSync(join(cwd, f), 'utf8')));
  if (keyword.length === 0) return;
  const calls = present.filter((f) => lowerFile(f, cwd).laws.length > 0);
  if (calls.length === 0) return;
  throw new Error(
    `this project mixes the two ways of writing a law: ${keyword.join(', ')} use the keyword syntax (\`export law name(...)\`, which needs the tsc-laws compiler) and ${calls.join(', ')} call \`law('name', ...)\`. ` +
      'Write every law one way: convert the keyword laws to calls to drop the custom compiler, or keep the keyword syntax throughout.',
  );
}

export function readManifest(compiler: string, files: string[], cwd: string): ManifestLaw[] {
  if (usesBuiltin(compiler, files, cwd))
    return sealLaws(
      cwd,
      files.filter((f) => isLawFile(f, cwd)).flatMap((f) => (existsSync(join(cwd, f)) ? lowerFile(f, cwd).laws : [])),
    );
  assertOneSyntax(files, cwd);
  const run = launch(compiler, ['--laws-manifest', ...files], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    env: compilerEnv(cwd, compiler),
  });
  if (run.error !== undefined) throw new Error(cannotRun(compiler, run.error));
  const text = (run.stdout ?? '').trim();
  if (text === '') throw new Error(`${compiler} --laws-manifest printed nothing: ${run.stderr ?? ''}`);
  return sealLaws(cwd, (JSON.parse(text) as { laws: ManifestLaw[] }).laws);
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

/** Turns emitted ES modules (with `import.meta` already rewritten) into CommonJS. */
function lowerModule(text: string, sourcefile: string): string {
  return transformSync(text, { format: 'cjs', target: 'es2022', sourcefile, logLevel: 'silent' }).code;
}

/** Where a compiled file came from: the source it mirrors under `root`, which is what `import.meta` should name. */
function sourceOfOutput(file: string, outDir: string, root: string): string {
  const mirrored = join(root, relative(outDir, file));
  const endings = file.endsWith('.mjs')
    ? ['.mts', '.mjs']
    : file.endsWith('.cjs')
      ? ['.cts', '.cjs']
      : ['.ts', '.tsx', '.js', '.jsx'];
  const stem = mirrored.replace(/\.[cm]?js$/, '');
  return endings.map((ending) => `${stem}${ending}`).find((candidate) => existsSync(candidate)) ?? mirrored;
}

/** The first top-level `await` of a module (an `await` expression or `for await` outside every function), if any. */
function topLevelAwait(source: ts.SourceFile): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined || ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier !== undefined)) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Laws and the modules they load run as CommonJS (see `build`), where a module cannot wait at its top level. Said once,
 * in terms of the way out, instead of as the loader's syntax error.
 */
const awaitAdvice =
  'top-level await is not supported in a law or in a module a law imports, because laws load as CommonJS; move the ' +
  'await into an async function (or into the law body, which may be async)';
const awaitProblem = (file: string): string => `${file}: error: ${awaitAdvice}`;
/** What replaces such a module in the output, so the law that loads it fails with the reason and not a syntax error. */
const awaitStub = (file: string): string => `throw new Error(${JSON.stringify(`${file}: ${awaitAdvice}`)});\n`;

/**
 * `import.meta` for a module that is not run as written: `env` is the global the runner sets before any law loads (see
 * runtimeEnv.ts), `url`, `filename` and `dirname` name the source file (not the copy in `.tslaws/out`), and any other
 * use of `import.meta` is an object holding those four. Found as syntax so that a string or comment that says the same
 * words is left alone. Returns the new text and whether the module waits at its top level.
 */
function rewriteImportMeta(text: string, file: string, source: string): { text: string; awaits: boolean } {
  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, false, ts.ScriptKind.JS);
  const edits: { start: number; end: number; text: string }[] = [];
  const env = `globalThis.${importMetaEnvGlobal}`;
  const known: Record<string, string> = {
    url: JSON.stringify(pathToFileURL(source).href),
    filename: JSON.stringify(source),
    dirname: JSON.stringify(dirname(source)),
    env,
  };
  const isMeta = (node: ts.Node): boolean =>
    ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === 'meta';
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isMeta(node.expression) && node.name.text in known)
      edits.push({ start: node.getStart(parsed), end: node.end, text: known[node.name.text]! });
    else if (isMeta(node)) {
      const members = Object.entries(known).map(([key, value]) => `${key}: ${value}`);
      edits.push({ start: node.getStart(parsed), end: node.end, text: `({ ${members.join(', ')} })` });
    } else ts.forEachChild(node, visit);
  };
  visit(parsed);
  const rewritten = edits.reduceRight((out, e) => out.slice(0, e.start) + e.text + out.slice(e.end), text);
  return { text: rewritten, awaits: topLevelAwait(parsed) !== undefined };
}

/**
 * CommonJS for ES module text, with `import.meta` rewritten as above. TypeScript does the lowering, not esbuild, so the
 * comments stay: the coverage analysis reads `@tslaws-exempt` from this output.
 */
function lowerToCommonJs(text: string, file: string): string {
  return ts.transpileModule(text, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      allowJs: true,
    },
  }).outputText;
}

/**
 * Lowers what the native compiler emitted into `dir` as ES modules, which is how `import.meta` is allowed: `.js` becomes
 * CommonJS and the `import.meta` of a `.mjs` (from a `.mts`, kept as an ES module Node can load) is rewritten in place.
 * `outDir` and `root` say where `dir` sits and what it mirrors, so `import.meta` can name the source. Returns one line
 * per module that cannot be lowered.
 */
export function lowerEmittedModules(dir: string, where: { outDir?: string; root?: string } = {}): string[] {
  const problems: string[] = [];
  const outDir = where.outDir ?? dir;
  const root = where.root ?? dir;
  const lowerIn = (current: string): void => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) lowerIn(path);
      else if (/\.m?js$/.test(entry.name)) {
        try {
          const { text, awaits } = rewriteImportMeta(
            readFileSync(path, 'utf8'),
            path,
            sourceOfOutput(path, outDir, root),
          );
          if (awaits) {
            problems.push(awaitProblem(slash(relative(outDir, path))));
            writeFileSync(path, awaitStub(slash(relative(outDir, path))));
          } else writeFileSync(path, entry.name.endsWith('.mjs') ? text : lowerToCommonJs(text, path));
        } catch {
          // Output that does not parse (JSX kept because the project sets no `jsx`): the compiler's diagnostics say why.
        }
      }
    }
  };
  lowerIn(dir);
  return problems;
}

/** The ambient `ImportMeta.env` declaration that ships with tslaws; also importable as `tslaws/env`. */
const envTypes = fileURLToPath(new URL('../env.d.ts', import.meta.url));

/** Whether `text` (compiler output) says `import.meta.env` has no declaration. */
const lacksEnvTypes = (text: string): boolean => /TS2339.*'ImportMeta'/.test(text);

/** Whether `text` (compiler output) says a module waits at its top level while the output is CommonJS (TS1378). */
const hasTopLevelAwaitError = (text: string): boolean => /TS1378/.test(text);

/** Whether `text` (compiler output) says the project uses `import.meta`, which CommonJS output does not allow. */
const usesImportMeta = (text: string): boolean => /TS1343/.test(text);

/**
 * Compiles `files` to CommonJS plus declarations in `.tslaws/out` under `cwd`, so `node_modules` still resolves.
 * Module resolution follows the project's tsconfig (see tsconfigResolve.ts), for the compiler and, through the runtime
 * hooks, for Node when it loads the output. The built-in compiler always reads the project as ES modules and lowers the
 * output. The native compiler does so only for a project that uses `import.meta` (it reports TS1343 as CommonJS), so
 * every other project builds exactly as before.
 */
export function build(compiler: string, files: string[], cwd: string): BuildResult {
  const resolution = readResolution(cwd);
  const result = compile(compiler, files, cwd, resolution);
  const bundlerPlugins = (readConfig(cwd).bundlerPlugins ?? []).map((path) => resolve(cwd, path));
  const runtime: LawRuntime = { cwd, options: resolution?.options, outDir: result.outDir, bundlerPlugins };
  installLawRuntime(runtime);
  try {
    writeFileSync(join(result.outDir, runtimeFile), JSON.stringify(runtime));
  } catch {
    // A worker then loads the output without the aliases; the error it reports names the import.
  }
  return result;
}

function compile(compiler: string, files: string[], cwd: string, resolution: Resolution | undefined): BuildResult {
  const outDir = join(cwd, '.tslaws', 'out');
  const builtin = usesBuiltin(compiler, files, cwd);
  // The compiler wants every source file under one root, and `paths` can lead out of the project (a sibling package),
  // so the root is the common ancestor and the output mirrors the tree from there. The built-in path writes only what
  // is inside the project, so it keeps the project as the root.
  const root = builtin ? cwd : commonRoot(cwd, resolution?.options);
  const extra = compilerFlags(readConfig(cwd).compilerOptions);
  const flags = [
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
    root,
    '--outDir',
    outDir,
    ...extra,
  ];
  const args = ['--ignoreConfig', ...flags, ...files];
  // What the options say is part of what was built.
  const keyArgs = [...args, JSON.stringify(resolution?.options ?? null)];
  const reused = builtin ? cachedBuild(keyArgs, files, cwd, outDir) : undefined;
  if (reused !== undefined) return reused;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // The output is CommonJS whatever the project's own package.json says.
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  if (builtin) return buildBuiltin(args, keyArgs, files, cwd, outDir, resolution);
  // `paths` is not a command line option, so the compiler gets the resolution options in a generated tsconfig that names
  // the files; everything else stays a flag, and flags win over the file. Without any, the flags alone do as before.
  const project = join(cwd, '.tslaws', 'resolution.tsconfig.json');
  const argsFor = (flagList: string[], more: string[] = []): string[] => {
    if (resolution === undefined) return ['--ignoreConfig', ...flagList, ...files, ...more];
    writeFileSync(
      project,
      JSON.stringify({
        compilerOptions: { ...resolution.options, rootDir: root },
        files: [...files, ...more].map((f) => resolve(cwd, f)),
      }),
    );
    return ['-p', project, ...flagList];
  };
  const given = argsFor(flags);
  let run = launch(compiler, given, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, env: compilerEnv(cwd, compiler) });
  // A compiler that dies without a word (out of memory on a busy machine) is run again; a type error always says so.
  for (
    let attempt = 0;
    attempt < 2 &&
    run.error === undefined &&
    run.status !== 0 &&
    `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() === '';
    attempt += 1
  )
    run = launch(compiler, given, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, env: compilerEnv(cwd, compiler) });
  if (run.error !== undefined) throw new Error(cannotRun(compiler, run.error));
  const output = (): string => `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const again = (next: string[]): void => {
    const rerun = launch(compiler, next, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
      env: compilerEnv(cwd, compiler),
    });
    if (rerun.error === undefined) run = rerun;
  };
  // CommonJS output does not allow `import.meta` or a top-level await: read the project as ES modules instead, and lower
  // the output below, where a module that waits at its top level is replaced by a stub that says so.
  let lowering = false;
  let used = flags;
  if (usesImportMeta(output()) || hasTopLevelAwaitError(output())) {
    used = flags.map((flag, i) => (flags[i - 1] === '--module' ? 'preserve' : flag));
    lowering = true;
    again(argsFor(used));
  }
  // A project without an `ImportMeta.env` declaration gets the one that ships with tslaws, and the build runs again.
  if (lacksEnvTypes(output())) again(argsFor(used, [envTypes]));
  const problems = lowering ? lowerEmittedModules(outDir, { outDir, root }) : [];
  // The project's own files sit where they do under the root, so its output is that deep in `outDir`.
  return {
    outDir: join(outDir, relative(root, cwd)),
    diagnostics: [output().trim(), ...problems].filter((part) => part !== '').join('\n'),
    ok: run.status === 0 && problems.length === 0,
  };
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
function buildBuiltin(
  args: string[],
  keyArgs: string[],
  files: string[],
  cwd: string,
  outDir: string,
  resolution: Resolution | undefined,
): BuildResult {
  const at = args.indexOf('--moduleResolution');
  const parsed = ts.parseCommandLine(at < 0 ? args : [...args.slice(0, at), ...args.slice(at + 2)]);
  // Types resolve the bundler way, so package `exports` (tslaws/browser) work; the ES output is made CommonJS below.
  const options: ts.CompilerOptions = {
    // The tsconfig's resolution first, so the project's own compilerOptions win over it.
    ...resolutionCompilerOptions(resolution?.options),
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
    if (isLawFile(file, cwd) && existsSync(join(cwd, file)))
      overrides.set(slash(resolve(cwd, file)), lowerFile(file, cwd).text);
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
    const text = overrides.get(slash(resolve(name)));
    return text === undefined
      ? getSourceFile(name, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(name, text, languageVersion, true);
  };
  const roots = parsed.fileNames.map((f) => resolve(cwd, f));
  let used = options;
  let program = ts.createProgram(roots, options, host);
  let diagnostics: readonly ts.Diagnostic[] = ts.getPreEmitDiagnostics(program);
  // An error may only be a global the narrow setup left out (`process`, `document`, a test runner's types): check again
  // with exactly what the compiler's own defaults include before reporting it, so no law is judged on less than before.
  if (
    (options.types !== parsed.options.types || options.lib !== parsed.options.lib) &&
    diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error)
  ) {
    // `@types` is looked up from the project, not from wherever the process happens to be (the compiler remembers the first directory it saw).
    const typeRoots = parsed.options.typeRoots ?? typeRootsOf(cwd);
    const full: ts.CompilerOptions = { ...options, types: parsed.options.types, lib: parsed.options.lib, typeRoots };
    used = full;
    program = ts.createProgram(roots, full, host);
    diagnostics = ts.getPreEmitDiagnostics(program);
  }
  // A project without an `ImportMeta.env` declaration gets the one that ships with tslaws, checked the same way.
  if (
    diagnostics.some(
      (d) => d.code === 2339 && ts.flattenDiagnosticMessageText(d.messageText, ' ').includes("'ImportMeta'"),
    )
  ) {
    program = ts.createProgram([...roots, envTypes], used, host);
    diagnostics = ts.getPreEmitDiagnostics(program);
  }
  const problems: string[] = [];
  program.emit(undefined, (name, text) => {
    // A source file outside the project (reached through `paths`) is checked and loaded in place, never written here.
    const under = relative(outDir, name);
    if (under.startsWith('..') || isAbsolute(under)) return;
    mkdirSync(dirname(name), { recursive: true });
    if (!/\.m?js$/.test(name)) return void writeFileSync(name, text);
    const rewritten = rewriteImportMeta(text, name, sourceOfOutput(name, outDir, cwd));
    if (rewritten.awaits) {
      problems.push(awaitProblem(slash(under)));
      writeFileSync(name, awaitStub(slash(under)));
    } else writeFileSync(name, name.endsWith('.mjs') ? rewritten.text : lowerModule(rewritten.text, name));
  });
  // Such a file is outside the root directory by design (TS6059).
  diagnostics = diagnostics.filter((d) => d.code !== 6059);
  const text = ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => cwd,
    getNewLine: () => String.fromCharCode(10),
  });
  const result: BuildResult = {
    outDir,
    diagnostics: [text.trim(), ...problems].filter((part) => part !== '').join('\n'),
    ok: problems.length === 0 && diagnostics.every((d) => d.category !== ts.DiagnosticCategory.Error),
  };
  Object.defineProperty(result, 'program', { value: program, enumerable: false });
  saveBuildCache(
    keyArgs,
    files,
    cwd,
    result,
    program
      .getSourceFiles()
      .map((f) => f.fileName)
      .filter((f) => !overrides.has(slash(resolve(f)))),
  );
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
  hash.update(JSON.stringify([args, ts.version, toolStamp, importMetaEnvGlobal, envTypes]));
  for (const file of files)
    if (isLawFile(file, cwd) && existsSync(join(cwd, file)))
      hash.update(`
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
    // A failed build is not kept: the file it could not find is not among the files read, so creating it would not
    // invalidate the entry and the failure would be served again.
    if (!result.ok) return;
    const cache: BuildCache = { base, result, files: stats };
    writeFileSync(buildCachePath(cwd), JSON.stringify(cache));
  } catch {
    // No cache is only slower.
  }
}
