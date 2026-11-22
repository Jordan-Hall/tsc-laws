// The module resolution a package's own tsconfig describes (`paths`, `baseUrl`, `rootDirs`, ...), so laws can import
// the way the package's code does. Only resolution options are taken: tslaws picks the law files and decides what and
// how to emit, so `include`, `files`, `outDir`, `noEmit`, `module` and `moduleResolution` are never read from it.
import { existsSync as fsExists, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { readConfig } from './coverage.ts';

/** Resolution options as JSON: every path absolute, no `baseUrl` (it is folded into `paths`). */
export type ResolutionOptions = Record<string, unknown>;

export interface Resolution {
  /** The tsconfig the options come from. */
  file: string;
  options: ResolutionOptions;
}

const slash = (path: string): string => path.replaceAll(String.fromCharCode(92), '/');

/** Options copied as they are. `allowImportingTsExtensions` is handled apart: it cannot be combined with emit. */
const copied = [
  'customConditions',
  'resolveJsonModule',
  'allowArbitraryExtensions',
  'moduleSuffixes',
  'resolvePackageJsonExports',
  'resolvePackageJsonImports',
] as const;

/** Whether `path` exists. A path the sandbox may not read (the directories above the project) is answered with no. */
function existsSync(path: string): boolean {
  try {
    return fsExists(path);
  } catch {
    return false;
  }
}

/** `entry` made absolute against `base`, forward slashes, a trailing slash and any `*` kept. */
function absolute(entry: string, base: string): string {
  const full = slash(resolve(base, entry));
  return /[\\/]$/.test(entry) && !full.endsWith('/') ? `${full}/` : full;
}

/**
 * `paths` with every target absolute. A `baseUrl` is folded in rather than passed on: targets are relative to it when it
 * is set, and the base itself becomes the final `*` fallback, which is what `baseUrl` means. The TypeScript 7 compiler
 * has no `baseUrl` at all.
 */
function foldPaths(
  paths: Record<string, string[]> | undefined,
  baseUrl: string | undefined,
  pathsBase: string,
): Record<string, string[]> | undefined {
  if (paths === undefined && baseUrl === undefined) return undefined;
  const base = baseUrl ?? pathsBase;
  const out: Record<string, string[]> = {};
  for (const [pattern, targets] of Object.entries(paths ?? {}))
    out[pattern] = targets.map((target) => absolute(target, base));
  if (baseUrl !== undefined) out['*'] = [...(out['*'] ?? []), `${slash(baseUrl)}/*`];
  return out;
}

/** The nearest `tsconfig.json` in `dir` or above it. */
export function nearestTsconfig(dir: string): string | undefined {
  for (let current = resolve(dir); ; current = dirname(current)) {
    const candidate = join(current, 'tsconfig.json');
    if (existsSync(candidate)) return candidate;
    if (dirname(current) === current) return undefined;
  }
}

/** The resolution options of `file` and everything it extends (relative files and packages in node_modules). */
export function readResolutionOf(file: string, strict: boolean): ResolutionOptions {
  const read = ts.readConfigFile(file, ts.sys.readFile);
  const message = (diagnostic: ts.Diagnostic): string => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
  if (read.error !== undefined) {
    if (strict) throw new Error(`tslaws.json "tsconfig": ${slash(file)}: ${message(read.error)}`);
    return {};
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      // Tslaws picks the files itself; never walk the tree for `include`.
      readDirectory: () => [],
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
    },
    dirname(file),
    undefined,
    file,
  );
  // A missing `extends` target (6053) or an unreadable one (5083) is the only problem that changes what resolves.
  const broken = parsed.errors.find((diagnostic) => diagnostic.code === 6053 || diagnostic.code === 5083);
  if (broken !== undefined && strict) throw new Error(`tslaws.json "tsconfig": ${slash(file)}: ${message(broken)}`);
  const found = parsed.options;
  const out: ResolutionOptions = {};
  for (const key of copied) if (found[key] !== undefined) out[key] = found[key];
  // Emit is on, so the extension-importing option becomes the one that rewrites `.ts` specifiers in the output.
  if (found.allowImportingTsExtensions === true || found.rewriteRelativeImportExtensions === true)
    out.rewriteRelativeImportExtensions = true;
  if (found.rootDirs !== undefined) out.rootDirs = found.rootDirs.map((dir) => slash(dir));
  const paths = foldPaths(
    found.paths as Record<string, string[]> | undefined,
    found.baseUrl,
    (found.pathsBasePath as string | undefined) ?? dirname(file),
  );
  if (paths !== undefined) out.paths = paths;
  return out;
}

/**
 * The tsconfig a project's laws are compiled with: `"tsconfig": "<path>"` in tslaws.json, else the nearest tsconfig.json
 * above the project; none for `"tsconfig": false` or when there is no file. An explicit path that is missing or broken is
 * an error; a discovered file that cannot be read is skipped.
 */
export function readResolution(cwd: string): Resolution | undefined {
  const setting = readConfig(cwd).tsconfig;
  if (setting === false) return undefined;
  let file: string | undefined;
  if (setting === undefined) file = nearestTsconfig(cwd);
  else {
    const given = resolve(cwd, setting);
    file = existsSync(given) && statSync(given).isDirectory() ? join(given, 'tsconfig.json') : given;
    if (!existsSync(file)) throw new Error(`tslaws.json "tsconfig": no such file: ${slash(relative(cwd, file))}`);
  }
  if (file === undefined) return undefined;
  const options = readResolutionOf(file, setting !== undefined);
  return Object.keys(options).length === 0 ? undefined : { file, options };
}

/** The same options as compiler options for the API (every value is plain JSON, so nothing needs converting). */
export function resolutionCompilerOptions(options: ResolutionOptions | undefined): ts.CompilerOptions {
  return { ...options } as ts.CompilerOptions;
}

/** Whether `file` lies inside `dir`. */
export function isInside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * The directory the compiler's `rootDir` must be so that every source file a `paths` target can reach lies under it: the
 * deepest common ancestor of the project and the directories the targets name (up to the first `*`). Targets on another
 * drive are left out; the project itself when no target leaves it.
 */
export function commonRoot(cwd: string, options: ResolutionOptions | undefined): string {
  let root = resolve(cwd);
  const paths = (options?.paths ?? {}) as Record<string, string[]>;
  for (const target of Object.values(paths).flat()) {
    const fixed = target.split('*')[0] ?? '';
    const dir = /[\\/]$/.test(fixed) ? fixed : dirname(fixed);
    // Another drive has no path from here: nothing to widen to.
    while (!isAbsolute(relative(root, dir)) && relative(root, dir).startsWith('..') && dirname(root) !== root)
      root = dirname(root);
  }
  return root;
}
