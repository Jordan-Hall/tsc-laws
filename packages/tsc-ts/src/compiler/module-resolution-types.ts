/**
 * Options, host and result types for module resolution.
 */

import * as Messages from './module-resolution-messages.js';
import type { DiagnosticMessage, MessageWithArgs } from './module-resolution-messages.js';
import { combinePaths, getDirectoryPath, normalizePath } from './path.js';

export enum ModuleKind {
  None = 0,
  CommonJS = 1,
  AMD = 2,
  UMD = 3,
  System = 4,
  ES2015 = 5,
  ES2020 = 6,
  ES2022 = 7,
  ESNext = 99,
  Node16 = 100,
  Node18 = 101,
  Node20 = 102,
  NodeNext = 199,
  Preserve = 200,
}

/** The module format a specifier is resolved for: `None`, `CommonJS` or `ESNext`. */
export type ResolutionMode = ModuleKind;

export enum ModuleResolutionKind {
  Unknown = 0,
  Classic = 1,
  Node10 = 2,
  Node16 = 3,
  NodeNext = 99,
  Bundler = 100,
}

export enum ScriptTarget {
  None = 0,
  ES5 = 1,
  ES2015 = 2,
  ES2016 = 3,
  ES2017 = 4,
  ES2018 = 5,
  ES2019 = 6,
  ES2020 = 7,
  ES2021 = 8,
  ES2022 = 9,
  ES2023 = 10,
  ES2024 = 11,
  ES2025 = 12,
  ESNext = 99,
  JSON = 100,
}

export enum JsxEmit {
  None = 0,
  Preserve = 1,
  ReactNative = 2,
  React = 3,
  ReactJSX = 4,
  ReactJSXDev = 5,
}

/** The compiler options module resolution reads. Absent booleans are "not set". */
export interface ModuleResolutionOptions {
  moduleResolution?: ModuleResolutionKind;
  module?: ModuleKind;
  target?: ScriptTarget;
  allowJs?: boolean;
  checkJs?: boolean;
  resolveJsonModule?: boolean;
  resolvePackageJsonExports?: boolean;
  resolvePackageJsonImports?: boolean;
  noDtsResolution?: boolean;
  preserveSymlinks?: boolean;
  traceResolution?: boolean;
  customConditions?: readonly string[];
  moduleSuffixes?: readonly string[];
  rootDirs?: readonly string[];
  /** Set (even empty) means type roots come from configuration. */
  typeRoots?: readonly string[];
  types?: readonly string[];
  /** In declaration order. */
  paths?: ReadonlyMap<string, readonly string[]>;
  /** Directory `paths` are relative to; defaults to the current directory. */
  pathsBasePath?: string;
  configFilePath?: string;
  outDir?: string;
  declarationDir?: string;
  rootDir?: string;
  jsx?: JsxEmit;
  strict?: boolean;
  noImplicitAny?: boolean;
  allowArbitraryExtensions?: boolean;
}

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
  readonly options: ModuleResolutionOptions | undefined;
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
  resolutionDiagnostics: readonly MessageWithArgs[];
}

export interface ResolvedTypeReferenceDirective {
  /** `''` when unresolved. */
  resolvedFileName: string;
  originalPath: string;
  /** Found in a type root rather than `node_modules`. */
  primary: boolean;
  packageId: PackageId | undefined;
  isExternalLibraryImport: boolean;
  resolutionDiagnostics: readonly MessageWithArgs[];
}

export const inferredTypesContainingFile = '__inferred type names__.ts';

//// Option defaults

export function getEmitScriptTarget(options: ModuleResolutionOptions): ScriptTarget {
  return options.target !== undefined && options.target !== ScriptTarget.None ? options.target : ScriptTarget.ES2025;
}

export function getEmitModuleKind(options: ModuleResolutionOptions): ModuleKind {
  if (options.module !== undefined && options.module !== ModuleKind.None) return options.module;
  const target = getEmitScriptTarget(options);
  if (target === ScriptTarget.ESNext) return ModuleKind.ESNext;
  if (target >= ScriptTarget.ES2022) return ModuleKind.ES2022;
  if (target >= ScriptTarget.ES2020) return ModuleKind.ES2020;
  if (target >= ScriptTarget.ES2015) return ModuleKind.ES2015;
  return ModuleKind.CommonJS;
}

/** The effective kind; `classic` and `node10` are no longer supported and fall back like an unset option. */
export function getModuleResolutionKind(options: ModuleResolutionOptions): ModuleResolutionKind {
  const kind = options.moduleResolution ?? ModuleResolutionKind.Unknown;
  if (
    kind !== ModuleResolutionKind.Unknown &&
    kind !== ModuleResolutionKind.Classic &&
    kind !== ModuleResolutionKind.Node10
  ) {
    return kind;
  }
  switch (getEmitModuleKind(options)) {
    case ModuleKind.Node16:
    case ModuleKind.Node18:
    case ModuleKind.Node20:
      return ModuleResolutionKind.Node16;
    case ModuleKind.NodeNext:
      return ModuleResolutionKind.NodeNext;
    default:
      return ModuleResolutionKind.Bundler;
  }
}

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

export function getResolveJsonModule(options: ModuleResolutionOptions): boolean {
  if (options.resolveJsonModule !== undefined) return options.resolveJsonModule;
  const module = getEmitModuleKind(options);
  if (module === ModuleKind.Node20 || module === ModuleKind.NodeNext) return true;
  return getModuleResolutionKind(options) === ModuleResolutionKind.Bundler;
}

export function getAllowJs(options: ModuleResolutionOptions): boolean {
  return options.allowJs ?? options.checkJs === true;
}

/** Configured `typeRoots`, or every ancestor `node_modules/@types` of the config directory. */
export function getEffectiveTypeRoots(options: ModuleResolutionOptions, currentDirectory: string): readonly string[] {
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
export function getConditions(options: ModuleResolutionOptions, mode: ResolutionMode): string[] {
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
  options: ModuleResolutionOptions,
  resolved: ResolvedModule,
  isDeclarationFile: boolean,
): DiagnosticMessage | undefined {
  const needJsx = options.jsx === undefined || options.jsx === JsxEmit.None;
  const needAllowJs = !getAllowJs(options) && (options.noImplicitAny ?? options.strict) === true;
  switch (resolved.extension) {
    case '.ts':
    case '.d.ts':
    case '.mts':
    case '.d.mts':
    case '.cts':
    case '.d.cts':
      return undefined;
    case '.tsx':
      return needJsx ? Messages.Module_0_was_resolved_to_1_but_jsx_is_not_set : undefined;
    case '.jsx':
      if (needJsx) return Messages.Module_0_was_resolved_to_1_but_jsx_is_not_set;
      return needAllowJs
        ? Messages.Could_not_find_a_declaration_file_for_module_0_1_implicitly_has_an_any_type
        : undefined;
    case '.js':
    case '.mjs':
    case '.cjs':
      return needAllowJs
        ? Messages.Could_not_find_a_declaration_file_for_module_0_1_implicitly_has_an_any_type
        : undefined;
    case '.json':
      return getResolveJsonModule(options)
        ? undefined
        : Messages.Module_0_was_resolved_to_1_but_resolveJsonModule_is_not_used;
    default:
      return isDeclarationFile || options.allowArbitraryExtensions === true
        ? undefined
        : Messages.Module_0_was_resolved_to_1_but_allowArbitraryExtensions_is_not_set;
  }
}
