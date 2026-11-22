// Node resolution for compiled laws. The compiler leaves `require('@app/x')` as written, so Node must find what the type
// checker found: tsconfig `paths`, and packages whose `exports` or `types` point at TypeScript source. Two hooks, put in
// once per process (and once per property worker): a resolver that asks TypeScript when Node cannot resolve a name, and
// a loader for `.ts` files that no compiler wrote out (a workspace package's source).
import { existsSync, readFileSync, statSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { installPluginHooks, pluginExtensionNeeded } from './pluginHooks.ts';
import { transformPluginFile } from './pluginHost.ts';
import { transformSync } from 'esbuild';
import type ts from 'typescript';
import { importMetaEnvGlobal } from './runtimeEnv.ts';
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

interface Internals {
  _resolveFilename: (request: string, parent: Parent | undefined, ...rest: unknown[]) => string;
  _extensions: Record<string, (module: { _compile(code: string, file: string): void }, file: string) => void>;
}
type Parent = { filename?: string } | null;

const projects = new Map<string, LawRuntime>();
const byConfig = new Map<string, ResolutionOptions>();
const load = createRequire(import.meta.url);
let hooked = false;

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
  installPluginHooks({ ownerOf, beside });
  const internals = Module as unknown as Internals;
  const original = internals._resolveFilename;
  internals._resolveFilename = function (request, parent, ...rest) {
    const bare = !/^(\.{0,2}[\\/]|\w:|node:)/.test(request) && !Module.isBuiltin(request);
    // An alias that shares its name with an installed package must run what the type checker saw, not the package.
    const mapped = bare && namedInPaths(request, parent) ? resolveThroughTypeScript(request, parent) : undefined;
    if (mapped !== undefined) return mapped;
    try {
      return original.call(this, request, parent, ...rest);
    } catch (error) {
      const found = bare ? resolveThroughTypeScript(request, parent) : beside(request, parent);
      if (found === undefined) throw error;
      return found;
    }
  };
  // Node loads an unknown extension as JavaScript. A project format (`.tsrx`) goes through its `bundlerPlugins` instead.
  const plain = internals._extensions['.js']!;
  internals._extensions['.js'] = function (module, file) {
    const extension = extname(file).toLowerCase();
    if (!pluginExtensionNeeded(extension)) return plain.call(this, module, file);
    const owner = ownerOf(file);
    module._compile(transformPluginFile(file, owner?.cwd ?? process.cwd(), owner?.bundlerPlugins ?? []), file);
  };
  for (const extension of ['.ts', '.tsx', '.mts', '.cts'])
    internals._extensions[extension] = (module, file) => {
      const { code } = transformSync(readFileSync(file, 'utf8'), {
        loader: extension === '.tsx' ? 'tsx' : 'ts',
        format: 'cjs',
        target: 'es2022',
        sourcefile: file,
        sourcemap: 'inline',
        define: { 'import.meta.env': `globalThis.${importMetaEnvGlobal}` },
      });
      module._compile(code, file);
    };
}

/** The project a file belongs to: the one with the deepest directory holding it, else the most recently registered. */
function ownerOf(file: string): LawRuntime | undefined {
  const all = [...projects.values()];
  const holding = all.filter((p) => file.startsWith(p.cwd + sep)).sort((a, b) => b.cwd.length - a.cwd.length);
  return holding[0] ?? all.at(-1);
}

/**
 * A relative import of a file the compiler does not write out (a template, a stylesheet) names the file beside the
 * source, not beside the compiled output.
 */
function beside(request: string, parent: Parent | undefined): string | undefined {
  const from = parent?.filename;
  if (from === undefined || !request.startsWith('.')) return undefined;
  const owner = [...projects].find(([top]) => from.startsWith(top + sep))?.[1];
  if (owner === undefined) return undefined;
  const file = resolve(owner.cwd, relative(compiledRoot(owner), dirname(from)), request);
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
  const owner = [...projects].find(([top]) => from.startsWith(top + sep))?.[1];
  const options = owner === undefined ? optionsAround(from) : owner.options;
  return Object.keys((options?.paths ?? {}) as Record<string, unknown>).some((pattern) => {
    if (pattern === '*') return false;
    const star = pattern.indexOf('*');
    if (star < 0) return pattern === request;
    const [head, tail] = [pattern.slice(0, star), pattern.slice(star + 1)];
    return request.length >= head.length + tail.length && request.startsWith(head) && request.endsWith(tail);
  });
}

function resolveThroughTypeScript(request: string, parent: Parent | undefined): string | undefined {
  const from = parent?.filename;
  if (from === undefined) return undefined;
  const owner = [...projects].find(([top]) => from.startsWith(top + sep))?.[1];
  // A compiled law resolves as its source does; the source is what imports are relative to.
  const containing =
    owner === undefined ? from : join(owner.cwd, relative(compiledRoot(owner), from)).replace(/\.js$/, '.ts');
  const options = owner === undefined ? optionsAround(from) : owner.options;
  if (options === undefined) return undefined;
  const typescript = load('typescript') as typeof ts;
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
      typescript.sys,
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
    const compiled = resolve(compiledRoot(owner), relative(owner.cwd, found)).replace(/\.[cm]?tsx?$/, '.js');
    if (existsSync(compiled)) return compiled;
  }
  return existsSync(found) ? found : undefined;
}
