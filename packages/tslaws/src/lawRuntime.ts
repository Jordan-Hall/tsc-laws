// Node resolution for compiled laws. The compiler leaves `require('@app/x')` as written, so Node must find what the type
// checker found: tsconfig `paths`, and packages whose `exports` or `types` point at TypeScript source. Two hooks, put in
// once per process (and once per property worker): a resolver that asks TypeScript when Node cannot resolve a name, and
// a loader for `.ts` files that no compiler wrote out (a workspace package's source).
import { existsSync, readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { transformSync } from 'esbuild';
import type ts from 'typescript';
import { isInside, nearestTsconfig, readResolutionOf, resolutionCompilerOptions } from './tsconfigResolve.ts';
import type { ResolutionOptions } from './tsconfigResolve.ts';

/** What a project registers: its root and the resolution options of its tsconfig (none when it has none or opts out). */
export interface LawRuntime {
  cwd: string;
  options?: ResolutionOptions;
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

/** The options for a program over the declarations in `outDir`: `base` plus the project's resolution. */
export function withResolution(outDir: string, base: ts.CompilerOptions): ts.CompilerOptions {
  return { ...resolutionCompilerOptions(projects.get(outDir)?.options), ...base };
}

/** What the property workers need to put the same resolution in place. */
export function runtimeOf(outDir: string): LawRuntime | undefined {
  return projects.get(outDir);
}

/** Registers a project's resolution for compiled laws and, on first use, puts the hooks in. */
export function installLawRuntime(runtime: LawRuntime): void {
  projects.set(outDirOf(runtime.cwd), runtime);
  if (hooked) return;
  hooked = true;
  const internals = Module as unknown as Internals;
  const original = internals._resolveFilename;
  internals._resolveFilename = function (request, parent, ...rest) {
    try {
      return original.call(this, request, parent, ...rest);
    } catch (error) {
      const found = /^(\.{0,2}[\\/]|\w:)/.test(request) ? undefined : resolveThroughTypeScript(request, parent);
      if (found === undefined) throw error;
      return found;
    }
  };
  for (const extension of ['.ts', '.tsx', '.mts', '.cts'])
    internals._extensions[extension] = (module, file) => {
      const { code } = transformSync(readFileSync(file, 'utf8'), {
        loader: extension === '.tsx' ? 'tsx' : 'ts',
        format: 'cjs',
        target: 'es2022',
        sourcefile: file,
        sourcemap: 'inline',
      });
      module._compile(code, file);
    };
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

function resolveThroughTypeScript(request: string, parent: Parent | undefined): string | undefined {
  const from = parent?.filename;
  if (from === undefined) return undefined;
  const owner = [...projects].find(([outDir]) => from.startsWith(outDir + sep));
  // A compiled law resolves as its source does; the source is what imports are relative to.
  const containing = owner === undefined ? from : join(owner[1].cwd, relative(owner[0], from)).replace(/\.js$/, '.ts');
  const options = owner === undefined ? optionsAround(from) : owner[1].options;
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
    const file = found === undefined ? undefined : runnableFile(found.resolvedFileName, projects, containing);
    if (file !== undefined) return file;
  }
  return undefined;
}

/** The file Node can run for the file the type checker found: compiled output for project source, `.js` beside a `.d.ts`. */
function runnableFile(found: string, all: Map<string, LawRuntime>, containing: string): string | undefined {
  const declaration = /\.d\.([cm]?)ts$/.exec(found);
  if (declaration !== null) {
    const js = found.replace(/\.d\.[cm]?ts$/, `.${declaration[1] ?? ''}js`);
    return existsSync(js) ? js : undefined;
  }
  if (/\.[cm]?tsx?$/.test(found)) {
    for (const [outDir, project] of all) {
      if (!isInside(project.cwd, containing) || !isInside(project.cwd, found) || /[\\/]node_modules[\\/]/.test(found))
        continue;
      const compiled = resolve(outDir, relative(project.cwd, found)).replace(/\.[cm]?tsx?$/, '.js');
      if (existsSync(compiled)) return compiled;
    }
  }
  return existsSync(found) ? found : undefined;
}
