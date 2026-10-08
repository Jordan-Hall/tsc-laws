/**
 * Options, host and result types for module resolution.
 */

import { Diagnostics, type Diagnostic, type DiagnosticMessage } from './diagnostics.js';
import {
  getAllowJS,
  getModuleResolutionKind,
  getResolveJsonModule,
  ModuleKind,
  ModuleResolutionKind,
  type CompilerOptions,
} from './options.js';
import { combinePaths, getDirectoryPath, normalizePath } from './path.js';

export { ModuleKind, ModuleResolutionKind } from './options.js';

/** The module format a specifier is resolved for: `None`, `CommonJS` or `ESNext`. */
export type ResolutionMode = ModuleKind;

/** File system access for resolution. Paths passed in are absolute and use `/`. */
export abstract class ModuleResolutionHost {
  abstract useCaseSensitiveFileNames(): boolean;
  abstract getCurrentDirectory(): string;
  abstract fileExists(path: string): boolean;
  abstract directoryExists(path: string): boolean;
  abstract readFile(path: string): string | undefined;
  /** The path with symlinks resolved, or `path` itself if it does not exist. */
  abstract realpath(path: string): string;
  /** Names of the directories (including symlinked ones) directly inside `path`, sorted. */
  abstract getDirectories(path: string): readonly string[];
}

/** A referenced project whose options apply to files it contains. */
export interface ResolvedProjectReference {
  readonly configName: string;
  readonly options: CompilerOptions | undefined;
}

export interface PackageId {
  readonly name: string;
  /** Path of the resolved file inside the package. */
  readonly subModuleName: string;
  readonly version: string;
  /** `+name@version` for each installed peer dependency. */
  readonly peerDependencies: string;
}

export function packageIdToString(id: PackageId): string {
  return packageIdName(id) + '@' + id.version + id.peerDependencies;
}

export function packageIdName(id: PackageId): string {
  return id.subModuleName !== '' ? id.name + '/' + id.subModuleName : id.name;
}

export interface ResolvedModule {
  /** `''` when unresolved. */
  resolvedFileName: string;
  /** The symlink path when `resolvedFileName` is its real path; otherwise `''`. */
  originalPath: string;
  extension: string;
  resolvedUsingTsExtension: boolean;
  packageId: PackageId | undefined;
  isExternalLibraryImport: boolean;
  /** A file found with `exports` ignored, when the real resolution only found JavaScript. */
  alternateResult: string;
  resolutionDiagnostics: readonly Diagnostic[];
}

export interface ResolvedTypeReferenceDirective {
  /** `''` when unresolved. */
  resolvedFileName: string;
  originalPath: string;
  /** Found in a type root rather than `node_modules`. */
  primary: boolean;
  packageId: PackageId | undefined;
  isExternalLibraryImport: boolean;
  resolutionDiagnostics: readonly Diagnostic[];
}

export const inferredTypesContainingFile = '__inferred type names__.ts';

//// Option defaults

export function moduleResolutionKindName(kind: ModuleResolutionKind): string {
  switch (kind) {
    case ModuleResolutionKind.Classic:
      return 'Classic';
    case ModuleResolutionKind.Node10:
      return 'Node10';
    case ModuleResolutionKind.Node16:
      return 'Node16';
    case ModuleResolutionKind.NodeNext:
      return 'NodeNext';
    case ModuleResolutionKind.Bundler:
      return 'Bundler';
    default:
      throw new Error('unexpected module resolution kind');
  }
}

/** Configured `typeRoots`, or every ancestor `node_modules/@types` of the config directory. */
export function getEffectiveTypeRoots(options: CompilerOptions, currentDirectory: string): readonly string[] {
  if (options.typeRoots !== undefined) return options.typeRoots;
  let directory =
    options.configFilePath !== undefined && options.configFilePath !== ''
      ? getDirectoryPath(options.configFilePath)
      : currentDirectory;
  if (directory === '')
    throw new Error('cannot get effective type roots without a config file path or current directory');
  const roots: string[] = [];
  for (;;) {
    roots.push(combinePaths(combinePaths(directory, 'node_modules'), '@types'));
    const parent = getDirectoryPath(directory);
    if (parent === directory) return roots;
    directory = parent;
  }
}

/** Export/import conditions in priority order. */
export function getConditions(options: CompilerOptions, mode: ResolutionMode): string[] {
  const kind = getModuleResolutionKind(options);
  if (mode === ModuleKind.None && kind === ModuleResolutionKind.Bundler) mode = ModuleKind.ESNext;
  const conditions = [mode === ModuleKind.ESNext ? 'import' : 'require'];
  if (options.noDtsResolution !== true) conditions.push('types');
  if (kind !== ModuleResolutionKind.Bundler) conditions.push('node');
  if (options.customConditions !== undefined) for (const c of options.customConditions) conditions.push(c);
  return conditions;
}

//// Package names

/** Splits `@scope/name/rest` or `name/rest` into the package name and the rest. */
export function parsePackageName(moduleName: string): { readonly packageName: string; readonly rest: string } {
  let index = moduleName.indexOf('/');
  if (moduleName.length > 0 && moduleName.charCodeAt(0) === 0x40) {
    const next = moduleName.indexOf('/', index + 1);
    index = next;
  }
  if (index === -1) return { packageName: moduleName, rest: '' };
  return { packageName: moduleName.slice(0, index), rest: moduleName.slice(index + 1) };
}

/** `@scope/name` becomes `scope__name`, as published under `@types`. */
export function mangleScopedPackageName(packageName: string): string {
  if (packageName.length > 0 && packageName.charCodeAt(0) === 0x40) {
    const index = packageName.indexOf('/');
    if (index === -1) return packageName;
    return packageName.slice(1, index) + '__' + packageName.slice(index + 1);
  }
  return packageName;
}

export function unmangleScopedPackageName(packageName: string): string {
  const index = packageName.indexOf('__');
  return index === -1 ? packageName : '@' + packageName.slice(0, index) + '/' + packageName.slice(index + 2);
}

export function getTypesPackageName(packageName: string): string {
  return '@types/' + mangleScopedPackageName(packageName);
}

export function getPackageNameFromTypesPackageName(mangledName: string): string {
  return mangledName.startsWith('@types/') ? unmangleScopedPackageName(mangledName.slice(7)) : mangledName;
}

function nextSeparatorIndex(path: string, previous: number, isFolder: boolean): number {
  const next = previous + 1 <= path.length ? path.indexOf('/', previous + 1) : -1;
  if (next === -1) return isFolder ? path.length : previous;
  return next;
}

/** The package directory of a path inside `node_modules`, or `''`. */
export function parseNodeModuleFromPath(resolved: string, isFolder: boolean): string {
  const path = normalizePath(resolved);
  const index = path.lastIndexOf('/node_modules/');
  if (index === -1) return '';
  const afterNodeModules = index + 14;
  let afterPackageName = nextSeparatorIndex(path, afterNodeModules, isFolder);
  if (path.charCodeAt(afterNodeModules) === 0x40) {
    afterPackageName = nextSeparatorIndex(path, afterPackageName, isFolder);
  }
  return path.slice(0, afterPackageName);
}

/** Orders `exports`/`imports` pattern keys from most to least specific. */
export function comparePatternKeys(a: string, b: string): number {
  const aStar = a.indexOf('*');
  const bStar = b.indexOf('*');
  const aBase = aStar === -1 ? a.length : aStar + 1;
  const bBase = bStar === -1 ? b.length : bStar + 1;
  if (aBase > bBase) return -1;
  if (bBase > aBase) return 1;
  if (aStar === -1) return 1;
  if (bStar === -1) return -1;
  if (a.length > b.length) return -1;
  if (b.length > a.length) return 1;
  return 0;
}

/**
 * The error for using a resolved module whose extension the options don't allow, or `undefined`.
 * Arguments are the module name and the resolved file name.
 */
export function getResolutionDiagnostic(
  options: CompilerOptions,
  resolved: ResolvedModule,
  isDeclarationFile: boolean,
): DiagnosticMessage | undefined {
  const needJsx = options.jsx === undefined;
  const needAllowJs = !getAllowJS(options) && (options.noImplicitAny ?? options.strict) === true;
  switch (resolved.extension) {
    case '.ts':
    case '.d.ts':
    case '.mts':
    case '.d.mts':
    case '.cts':
    case '.d.cts':
      return undefined;
    case '.tsx':
      return needJsx ? Diagnostics.Module_0_was_resolved_to_1_but_jsx_is_not_set : undefined;
    case '.jsx':
      if (needJsx) return Diagnostics.Module_0_was_resolved_to_1_but_jsx_is_not_set;
      return needAllowJs
        ? Diagnostics.Could_not_find_a_declaration_file_for_module_0_1_implicitly_has_an_any_type
        : undefined;
    case '.js':
    case '.mjs':
    case '.cjs':
      return needAllowJs
        ? Diagnostics.Could_not_find_a_declaration_file_for_module_0_1_implicitly_has_an_any_type
        : undefined;
    case '.json':
      return getResolveJsonModule(options)
        ? undefined
        : Diagnostics.Module_0_was_resolved_to_1_but_resolveJsonModule_is_not_used;
    default:
      return isDeclarationFile || options.allowArbitraryExtensions === true
        ? undefined
        : Diagnostics.Module_0_was_resolved_to_1_but_allowArbitraryExtensions_is_not_set;
  }
}
