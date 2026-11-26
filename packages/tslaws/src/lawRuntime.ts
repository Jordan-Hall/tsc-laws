// Node resolution for compiled laws. The compiler leaves `require('@app/x')` as written, so Node must find what the type
// checker found: tsconfig `paths`, and packages whose `exports` or `types` point at TypeScript source. Two hooks, put in
// once per process (and once per property worker): a resolver that asks TypeScript when Node cannot resolve a name, and
// a loader for `.ts` files that no compiler wrote out (a workspace package's source).
import { existsSync as fsExists, readFileSync, realpathSync, statSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { ontoSpelling, plainPath } from './canonicalPath.ts';
import { installPluginHooks, pluginExtensionNeeded } from './pluginHooks.ts';
import { transformPluginFile } from './pluginHost.ts';
import { transformSync } from 'esbuild';
import type ts from 'typescript';
import { importMetaDefines } from './runtimeEnv.ts';
import { nearestTsconfig, readResolutionOf, resolutionCompilerOptions } from './tsconfigResolve.ts';
import type { ResolutionOptions } from './tsconfigResolve.ts';

/** What a project registers: its root and the resolution options of its tsconfig (none when it has none or opts out). */
export interface LawRuntime {
  cwd: string;
  options?: ResolutionOptions;
  /**
   * Where the project's compiled files are. Under `.tslaws/out`, but deeper when the output mirrors a tree above the
   * project (sources outside it were compiled too): files then sit at the same depth as in the source tree.
   */
  outDir?: string;
  /** The project's `bundlerPlugins` (absolute module paths): they load the source formats Node cannot (see pluginHost.ts). */
  bundlerPlugins?: string[];
}

/** Whether `path` exists. A path the sandbox may not read is answered with no, as a missing one is. */
function existsSync(path: string): boolean {
  try {
    return fsExists(path);
  } catch {
    return false;
  }
}

interface Internals {
  _resolveFilename: (request: string, parent: Parent | undefined, ...rest: unknown[]) => string;
  _extensions: Record<string, (module: { _compile(code: string, file: string): void }, file: string) => void>;
}
type Parent = { filename?: string } | null;

/**
 * How a file Node cannot load as written becomes something it can: TypeScript source (esbuild) and a project format (the
 * `bundlerPlugins`). Both start a helper (a child process, a thread), which a sandboxed law process may not do, so
 * there the parent transforms the reviewed files up front and the process looks the result up (see lawHost.ts).
 */
export interface Transforms {
  source(file: string, extension: string): string;
  plugin(file: string, cwd: string, plugins: readonly string[], format: 'cjs' | 'esm'): string;
}

/** The TypeScript source of `file` as CommonJS, the way a law loads it. */
export function transformSource(file: string, extension: string): string {
  return transformSync(readFileSync(file, 'utf8'), {
    loader: extension === '.tsx' ? 'tsx' : 'ts',
    format: 'cjs',
    target: 'es2022',
    sourcefile: file,
    sourcemap: 'inline',
    define: importMetaDefines(file),
  }).code;
}

let transforms: Transforms = {
  source: transformSource,
  plugin: transformPluginFile,
};

/** Replaces how this thread transforms files; used by the sandboxed law process, which cannot run the real ones. */
export function useTransforms(next: Transforms): void {
  transforms = next;
}

/** The project files a `bundlerPlugins` hook loaded in this thread: they sit outside the output directory. */
const pluginLoaded = new Set<string>();

/** Runs the plugin transform and remembers the file, so the next run can drop it from the module cache. */
function transformPlugin(...args: Parameters<Transforms['plugin']>): string {
  pluginLoaded.add(args[0]);
  return transforms.plugin(...args);
}

/**
 * Drops from `cache` what a run must load again: every file under `outDir` (the build may have recompiled it) and every
 * file the plugin hooks loaded. A template keeps the modules it imported; left cached it would share them with no one
 * once the law's own copies are fresh.
 */
export function evictLoaded(cache: Record<string, unknown>, outDir: string): void {
  for (const file of Object.keys(cache)) if (file.startsWith(outDir)) delete cache[file];
  for (const file of pluginLoaded) delete cache[file];
  pluginLoaded.clear();
}

/** The runtime a project registered, as the last build left it. */
export function runtimeOf(cwd: string): LawRuntime | undefined {
  return projects.get(outDirOf(cwd));
}

const projects = new Map<string, LawRuntime>();
const byConfig = new Map<string, ResolutionOptions>();
/** `realpath` of a directory this process has already asked about. A failure is remembered as the path itself. */
const actualOfCache = new Map<string, string>();

/**
 * Where `dir` really is. The permission model answers a path it has not been given with an error, which is the same
 * answer as a directory that is not there: the path we were given is then the one to use.
 */
function actualOf(dir: string): string {
  const known = actualOfCache.get(dir);
  if (known !== undefined) return known;
  let actual = dir;
  try {
    actual = plainPath(realpathSync.native(dir));
  } catch {
    // The directory cannot be resolved from here. Later reads keep using `dir`.
  }
  actualOfCache.set(dir, actual);
  return actual;
}

/** `file` written with the same directory names as `owner.cwd`. An 8.3 name and a long name are one directory. */
function asProject(file: string, owner: LawRuntime): string {
  return ontoSpelling(file, owner.cwd, actualOf(owner.cwd));
}

/** Whether `file` is `dir` or a file under it, including when the two use different names for one directory. */
function underDir(dir: string, file: string): boolean {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  if (file === dir || file.startsWith(prefix)) return true;
  const opened = ontoSpelling(file, dir, actualOf(dir));
  return opened === dir || opened.startsWith(prefix);
}

/**
 * The other name of `path`, when a registered project is reached by an 8.3 name or a junction and `path` uses one of
 * the two. Undefined when every project has a single name, or `path` is under neither name.
 */
function otherOf(path: string): string | undefined {
  for (const project of projects.values()) {
    const actual = actualOf(project.cwd);
    if (actual.toLowerCase() === project.cwd.toLowerCase()) continue;
    const opened = ontoSpelling(path, project.cwd, actual);
    if (opened !== path) return opened;
    const closed = ontoSpelling(path, actual, project.cwd);
    if (closed !== path) return closed;
  }
  return undefined;
}

// Compiled laws are CommonJS (see `build` in compile.ts), and these hooks are the CommonJS loader's own (`_resolveFilename`,
// `_extensions`), so `createRequire` is unavoidable: it loads TypeScript lazily, inside the synchronous resolver hook.
const load = createRequire(import.meta.url);
let hooked = false;

/**
 * TypeScript, which the resolver asks when Node cannot find a module. It needs Node modules a law may not load, and the
 * guard refuses a module that a law's code is waiting on, so a law process loads it before the first law runs (`loadResolver`).
 */
let typescriptModule: typeof ts | undefined;
const typescriptOf = (): typeof ts => (typescriptModule ??= load('typescript') as typeof ts);

/** Loads what the resolver needs, while no law is running. A law process calls it once its project is installed. */
export function loadResolver(): void {
  typescriptOf();
}

const outDirOf = (cwd: string): string => join(cwd, '.tslaws', 'out');

/** The file the build leaves beside the output, so a property worker can put the same resolution in place. */
export const runtimeFile = 'tslaws-runtime.json';

const compiledRoot = (project: LawRuntime): string => project.outDir ?? outDirOf(project.cwd);

/** The options for a program over the declarations in `outDir`: `base` plus the project's resolution. */
export function withResolution(outDir: string, base: ts.CompilerOptions): ts.CompilerOptions {
  const project = [...projects.values()].find((p) => compiledRoot(p) === outDir);
  return { ...resolutionCompilerOptions(project?.options), ...base };
}

/** The directory holding the project's compiled files, as the last build left it. */
export function compiledDirOf(cwd: string): string {
  const project = projects.get(outDirOf(cwd));
  return project === undefined ? outDirOf(cwd) : compiledRoot(project);
}

/** Registers a project's resolution for compiled laws and, on first use, puts the hooks in. */
export function installLawRuntime(runtime: LawRuntime): void {
  projects.set(outDirOf(runtime.cwd), runtime);
  if (hooked) return;
  hooked = true;
  installPluginHooks({
    ownerOf,
    beside,
    twin: twinOf,
    twinOfSpecifier,
    transform: transformPlugin,
  });
  const internals = Module as unknown as Internals;
  const original = internals._resolveFilename;
  internals._resolveFilename = function (request, parent, ...rest) {
    const bare = !/^(\.{0,2}[\\/]|\w:|node:)/.test(request) && !Module.isBuiltin(request);
    // An alias that shares its name with an installed package must run what the type checker saw, not the package.
    const mapped = bare && namedInPaths(request, parent) ? resolveThroughTypeScript(request, parent) : undefined;
    if (mapped !== undefined) return mapped;
    let found: string;
    try {
      found = original.call(this, request, parent, ...rest);
    } catch (error) {
      const other = bare
        ? resolveThroughTypeScript(request, parent)
        : (beside(request, parent) ?? twinOfSpecifier(request, parent?.filename));
      if (other === undefined) throw error;
      found = other;
    }
    return twinOf(found, parent?.filename) ?? found;
  };
  // Node loads an unknown extension as JavaScript. A project format (`.tsrx`) goes through its `bundlerPlugins` instead.
  const plain = internals._extensions['.js']!;
  internals._extensions['.js'] = function (module, file) {
    const extension = extname(file).toLowerCase();
    if (!pluginExtensionNeeded(extension)) return plain.call(this, module, file);
    const owner = ownerOf(file);
    module._compile(transformPlugin(file, owner?.cwd ?? process.cwd(), owner?.bundlerPlugins ?? [], 'cjs'), file);
  };
  for (const extension of ['.ts', '.tsx', '.mts', '.cts'])
    internals._extensions[extension] = (module, file) => {
      module._compile(transforms.source(file, extension), file);
    };
}

/** The project a file belongs to: the one with the deepest directory holding it, else the most recently registered. */
function ownerOf(file: string): LawRuntime | undefined {
  const all = [...projects.values()];
  const holding = all.filter((p) => underDir(p.cwd, file)).sort((a, b) => b.cwd.length - a.cwd.length);
  return holding[0] ?? all.at(-1);
}

/**
 * The compiled copy of a project `.ts` file that a file in a project format (`.tsrx`) imports. The plugin's output keeps
 * its imports as written, so `../i18n` finds the source, which the sandbox does not serve and which would be a second
 * instance beside the one the law gets. The build's copy is the same module the law's own imports reach, and it is
 * already in the reviewed set (the build's tree). Nothing else is remapped: undefined when `importer` is not such a
 * file, `file` is not a source the build compiled, or no copy exists.
 */
function twinOf(file: string, importer: string | undefined): string | undefined {
  if (importer === undefined || !pluginExtensionNeeded(extname(importer))) return undefined;
  if (!/\.[cm]?tsx?$/.test(file) || /\.d\.[cm]?ts$/.test(file)) return undefined;
  const owner = ownerOf(importer);
  if (owner === undefined || !underDir(owner.cwd, file)) return undefined;
  const root = compiledRoot(owner);
  const opened = asProject(file, owner);
  if (opened.startsWith(root + sep)) return undefined;
  const twin = resolve(root, relative(owner.cwd, opened)).replace(/\.[cm]?tsx?$/, '.js');
  return existsSync(twin) ? twin : undefined;
}

const jsToTs: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/**
 * The twin for a NodeNext-style specifier a plugin's output keeps (`./i18n.js` for `i18n.ts`): Node finds no `.js` file
 * beside the source, so the specifier names the source it stands for, and that source's compiled copy is used.
 */
function twinOfSpecifier(request: string, importer: string | undefined): string | undefined {
  if (importer === undefined || !request.startsWith('.')) return undefined;
  const named = resolve(dirname(importer), request);
  const extension = extname(named);
  for (const replacement of jsToTs[extension] ?? []) {
    const source = named.slice(0, -extension.length) + replacement;
    if (!existsSync(source)) continue;
    const twin = twinOf(source, importer);
    if (twin !== undefined) return twin;
  }
  return undefined;
}

/**
 * A relative import of a file the compiler does not write out (a template, a stylesheet) names the file beside the
 * source, not beside the compiled output.
 */
function beside(request: string, parent: Parent | undefined): string | undefined {
  const from = parent?.filename;
  if (from === undefined || !request.startsWith('.')) return undefined;
  const owner = [...projects].find(([top]) => underDir(top, from))?.[1];
  if (owner === undefined) return undefined;
  const file = resolve(owner.cwd, relative(compiledRoot(owner), dirname(asProject(from, owner))), request);
  return existsSync(file) && statSync(file).isFile() ? file : undefined;
}

/** The options for a file that is not a compiled law: those of the nearest tsconfig, as the package would resolve. */
function optionsAround(file: string): ResolutionOptions | undefined {
  const config = nearestTsconfig(dirname(file));
  if (config === undefined) return undefined;
  let options = byConfig.get(config);
  if (options === undefined) {
    options = readResolutionOf(config, false);
    byConfig.set(config, options);
  }
  return options;
}

/** Whether a `paths` entry other than the catch-all `*` (`baseUrl`'s fallback) names the request. */
function namedInPaths(request: string, parent: Parent | undefined): boolean {
  const from = parent?.filename;
  if (from === undefined) return false;
  const owner = [...projects].find(([top]) => underDir(top, from))?.[1];
  const options = owner === undefined ? optionsAround(from) : owner.options;
  return Object.keys((options?.paths ?? {}) as Record<string, unknown>).some((pattern) => {
    if (pattern === '*') return false;
    const star = pattern.indexOf('*');
    if (star < 0) return pattern === request;
    const [head, tail] = [pattern.slice(0, star), pattern.slice(star + 1)];
    return request.length >= head.length + tail.length && request.startsWith(head) && request.endsWith(tail);
  });
}

/**
 * `sys` for a sandboxed process: the permission model answers a probe outside the readable trees (the directories above the
 * project, which module resolution looks through) with an error, where it needs "no such file".
 */
function readableSys(sys: ts.System): ts.ModuleResolutionHost {
  const safe =
    <A extends unknown[], R>(call: (...args: A) => R, otherwise: R) =>
    (...args: A): R => {
      try {
        return call(...args);
      } catch {
        return otherwise;
      }
    };
  // `fileExists` and `readFile` answer from either name of a directory. The path map is written with the name the
  // build opened, and a grant is the name `realpath` reports; on Windows those two differ for an 8.3 directory.
  return {
    fileExists: (path) => {
      if (sys.fileExists(path)) return true;
      const other = otherOf(path);
      return other !== undefined && sys.fileExists(other);
    },
    // `sys` answers "no" for a directory the process may not read. TypeScript then skips the files under it, and a file the
    // process may read (one granted by name, outside the project) sits in one: such a directory is taken to exist.
    directoryExists: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch (error) {
        return (error as { code?: string }).code === 'ERR_ACCESS_DENIED';
      }
    },
    readFile: (path) => {
      const text = sys.readFile(path);
      const other = otherOf(path);
      return text !== undefined || other === undefined ? text : sys.readFile(other);
    },
    // A path it may not resolve is taken as it is: resolving walks the directories above, which the process may not read.
    // A path it can resolve is put back into the name the project was opened with, so the compiled file sits beside it.
    realpath: (path) => {
      const reported = plainPath(sys.realpath?.(path) ?? path);
      const other = reported === path ? otherOf(path) : undefined;
      const found = other === undefined ? reported : plainPath(sys.realpath?.(other) ?? reported);
      for (const project of projects.values()) {
        const opened = ontoSpelling(found, project.cwd, actualOf(project.cwd));
        if (opened !== found) return opened;
      }
      return found;
    },
    getCurrentDirectory: () => sys.getCurrentDirectory(),
    getDirectories: safe(sys.getDirectories, []),
  };
}

function resolveThroughTypeScript(request: string, parent: Parent | undefined): string | undefined {
  const from = parent?.filename;
  if (from === undefined) return undefined;
  const owner = [...projects].find(([top]) => underDir(top, from))?.[1];
  // A compiled law resolves as its source does; the source is what imports are relative to.
  const containing =
    owner === undefined
      ? from
      : join(owner.cwd, relative(compiledRoot(owner), asProject(from, owner))).replace(/\.js$/, '.ts');
  const options = owner === undefined ? optionsAround(from) : owner.options;
  if (options === undefined) return undefined;
  const typescript = typescriptOf();
  const compilerOptions: ts.CompilerOptions = {
    ...resolutionCompilerOptions(options),
    module: typescript.ModuleKind.ESNext,
    moduleResolution: typescript.ModuleResolutionKind.Bundler,
  };
  // `require` first, since that is how the code loads; a package may only offer an `import` entry.
  const modes: ts.ResolutionMode[] = [typescript.ModuleKind.CommonJS, typescript.ModuleKind.ESNext];
  for (const mode of modes) {
    const found = typescript.resolveModuleName(
      request,
      containing,
      compilerOptions,
      readableSys(typescript.sys),
      undefined,
      undefined,
      mode,
    ).resolvedModule;
    const file = found === undefined ? undefined : runnableFile(found.resolvedFileName, owner);
    if (file !== undefined) return file;
  }
  return undefined;
}

/**
 * The file Node can run for the file the type checker found: for a source file of the project, or one outside it that
 * the compiler also wrote out, the compiled output at the same place in the tree; the `.js` beside a `.d.ts`; else the
 * file itself (TypeScript source loads through the hook above).
 */
function runnableFile(found: string, owner: LawRuntime | undefined): string | undefined {
  const declaration = /\.d\.([cm]?)ts$/.exec(found);
  if (declaration !== null) {
    const js = found.replace(/\.d\.[cm]?ts$/, `.${declaration[1] ?? ''}js`);
    return existsSync(js) ? js : undefined;
  }
  if (owner !== undefined && /\.[cm]?tsx?$/.test(found) && !/[\\/]node_modules[\\/]/.test(found)) {
    const compiled = resolve(compiledRoot(owner), relative(owner.cwd, asProject(found, owner))).replace(
      /\.[cm]?tsx?$/,
      '.js',
    );
    if (existsSync(compiled)) return compiled;
  }
  if (existsSync(found)) return found;
  // The name the type checker built may be the one the process was not granted. The other name is the same file.
  const other = otherOf(found);
  return other !== undefined && existsSync(other) ? other : undefined;
}
