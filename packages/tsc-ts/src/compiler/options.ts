/**
 * Compiler, watch, build and type acquisition options.
 *
 * Unset options are `undefined`; booleans are tristates (`undefined`, `false`, `true`).
 * Enum values match tsgo's, so `0` never appears in a set option.
 */

export enum ScriptTarget {
  /** @deprecated Accepted for parsing and validation only. */
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
  Latest = ESNext,
  LatestStandard = ES2025,
}

export enum ModuleKind {
  CommonJS = 1,
  /** @deprecated Accepted for parsing and validation only. */
  AMD = 2,
  /** @deprecated Accepted for parsing and validation only. */
  UMD = 3,
  /** @deprecated Accepted for parsing and validation only. */
  System = 4,
  // ES module kinds stay contiguous from ES2015 to ESNext.
  ES2015 = 5,
  ES2020 = 6,
  ES2022 = 7,
  ESNext = 99,
  Node16 = 100,
  Node18 = 101,
  Node20 = 102,
  NodeNext = 199,
  /** Emit imports and exports as written. */
  Preserve = 200,
}

export enum ModuleResolutionKind {
  /** @deprecated Accepted for parsing and validation only. */
  Classic = 1,
  /** @deprecated Accepted for parsing and validation only. */
  Node10 = 2,
  Node16 = 3,
  NodeNext = 99,
  Bundler = 100,
}

export enum ModuleDetectionKind {
  Auto = 1,
  Legacy = 2,
  Force = 3,
}

export enum JsxEmit {
  Preserve = 1,
  ReactNative = 2,
  React = 3,
  ReactJSX = 4,
  ReactJSXDev = 5,
}

export enum NewLineKind {
  CRLF = 1,
  LF = 2,
}

export enum WatchFileKind {
  FixedPollingInterval = 1,
  PriorityPollingInterval = 2,
  DynamicPriorityPolling = 3,
  FixedChunkSizePolling = 4,
  UseFsEvents = 5,
  UseFsEventsOnParentDirectory = 6,
}

export enum WatchDirectoryKind {
  UseFsEvents = 1,
  FixedPollingInterval = 2,
  DynamicPriorityPolling = 3,
  FixedChunkSizePolling = 4,
}

export enum PollingKind {
  FixedInterval = 1,
  PriorityInterval = 2,
  DynamicPriority = 3,
  FixedChunkSize = 4,
}

/**
 * Compiler options, in tsgo's field order (which `--showConfig` follows).
 *
 * `lib` holds bundled file names (`lib.es2015.d.ts`), not `--lib` names.
 */
export interface CompilerOptions {
  allowJs?: boolean;
  allowArbitraryExtensions?: boolean;
  allowImportingTsExtensions?: boolean;
  allowNonTsExtensions?: boolean;
  allowUmdGlobalAccess?: boolean;
  allowUnreachableCode?: boolean;
  allowUnusedLabels?: boolean;
  assumeChangesOnlyAffectDirectDependencies?: boolean;
  checkJs?: boolean;
  customConditions?: string[];
  composite?: boolean;
  emitDeclarationOnly?: boolean;
  emitBOM?: boolean;
  emitDecoratorMetadata?: boolean;
  declaration?: boolean;
  declarationDir?: string;
  declarationMap?: boolean;
  deduplicatePackages?: boolean;
  disableSizeLimit?: boolean;
  disableSourceOfProjectReferenceRedirect?: boolean;
  disableSolutionSearching?: boolean;
  disableReferencedProjectLoad?: boolean;
  erasableSyntaxOnly?: boolean;
  exactOptionalPropertyTypes?: boolean;
  experimentalDecorators?: boolean;
  forceConsistentCasingInFileNames?: boolean;
  isolatedModules?: boolean;
  isolatedDeclarations?: boolean;
  ignoreConfig?: boolean;
  ignoreDeprecations?: string;
  importHelpers?: boolean;
  inlineSourceMap?: boolean;
  inlineSources?: boolean;
  init?: boolean;
  incremental?: boolean;
  jsx?: JsxEmit;
  jsxFactory?: string;
  jsxFragmentFactory?: string;
  jsxImportSource?: string;
  lib?: string[];
  libReplacement?: boolean;
  locale?: string;
  mapRoot?: string;
  module?: ModuleKind;
  moduleResolution?: ModuleResolutionKind;
  moduleSuffixes?: string[];
  moduleDetection?: ModuleDetectionKind;
  newLine?: NewLineKind;
  noEmit?: boolean;
  noCheck?: boolean;
  noErrorTruncation?: boolean;
  noFallthroughCasesInSwitch?: boolean;
  noImplicitAny?: boolean;
  noImplicitThis?: boolean;
  noImplicitReturns?: boolean;
  noEmitHelpers?: boolean;
  noLib?: boolean;
  noPropertyAccessFromIndexSignature?: boolean;
  noUncheckedIndexedAccess?: boolean;
  noEmitOnError?: boolean;
  noUnusedLocals?: boolean;
  noUnusedParameters?: boolean;
  noResolve?: boolean;
  noImplicitOverride?: boolean;
  noUncheckedSideEffectImports?: boolean;
  outDir?: string;
  paths?: Map<string, string[]>;
  preserveConstEnums?: boolean;
  preserveSymlinks?: boolean;
  project?: string;
  resolveJsonModule?: boolean;
  resolvePackageJsonExports?: boolean;
  resolvePackageJsonImports?: boolean;
  removeComments?: boolean;
  rewriteRelativeImportExtensions?: boolean;
  reactNamespace?: string;
  rootDir?: string;
  rootDirs?: string[];
  skipLibCheck?: boolean;
  stableTypeOrdering?: boolean;
  strict?: boolean;
  strictBindCallApply?: boolean;
  strictBuiltinIteratorReturn?: boolean;
  strictFunctionTypes?: boolean;
  strictNullChecks?: boolean;
  strictPropertyInitialization?: boolean;
  stripInternal?: boolean;
  skipDefaultLibCheck?: boolean;
  sourceMap?: boolean;
  sourceRoot?: string;
  suppressOutputPathCheck?: boolean;
  target?: ScriptTarget;
  traceResolution?: boolean;
  tsBuildInfoFile?: string;
  typeRoots?: string[];
  types?: string[];
  useDefineForClassFields?: boolean;
  useUnknownInCatchVariables?: boolean;
  verbatimModuleSyntax?: boolean;
  maxNodeModuleJsDepth?: number;
  allowSyntheticDefaultImports?: boolean;
  alwaysStrict?: boolean;
  baseUrl?: string;
  downlevelIteration?: boolean;
  esModuleInterop?: boolean;
  outFile?: string;
  configFilePath?: string;
  noDtsResolution?: boolean;
  pathsBasePath?: string;
  diagnostics?: boolean;
  extendedDiagnostics?: boolean;
  generateCpuProfile?: string;
  generateTrace?: string;
  listEmittedFiles?: boolean;
  listFiles?: boolean;
  explainFiles?: boolean;
  listFilesOnly?: boolean;
  noEmitForJsFiles?: boolean;
  preserveWatchOutput?: boolean;
  pretty?: boolean;
  version?: boolean;
  watch?: boolean;
  showConfig?: boolean;
  build?: boolean;
  help?: boolean;
  all?: boolean;
  pprofDir?: string;
  singleThreaded?: boolean;
  quiet?: boolean;
  checkers?: number;
}

export interface WatchOptions {
  watchInterval?: number;
  watchFile?: WatchFileKind;
  watchDirectory?: WatchDirectoryKind;
  fallbackPolling?: PollingKind;
  synchronousWatchDirectory?: boolean;
  excludeDirectories?: string[];
  excludeFiles?: string[];
}

export interface BuildOptions {
  dry?: boolean;
  force?: boolean;
  verbose?: boolean;
  builders?: number;
  stopBuildOnErrors?: boolean;
  clean?: boolean;
}

export interface TypeAcquisition {
  enable?: boolean;
  include?: string[];
  exclude?: string[];
  disableFilenameBasedTypeAcquisition?: boolean;
}

/**
 * An option value as parsed from the command line or tsconfig.json.
 *
 * Enum options hold their numeric value; `null` resets an option.
 */
export type OptionValue = boolean | number | string | string[] | null;

/** A compiler option value as stored in `CompilerOptions`, except `paths`. */
export type CompilerOptionValue = boolean | number | string | string[];

/** Compiler option names in field order. */
export const compilerOptionNames: readonly string[] = [
  'allowJs',
  'allowArbitraryExtensions',
  'allowImportingTsExtensions',
  'allowNonTsExtensions',
  'allowUmdGlobalAccess',
  'allowUnreachableCode',
  'allowUnusedLabels',
  'assumeChangesOnlyAffectDirectDependencies',
  'checkJs',
  'customConditions',
  'composite',
  'emitDeclarationOnly',
  'emitBOM',
  'emitDecoratorMetadata',
  'declaration',
  'declarationDir',
  'declarationMap',
  'deduplicatePackages',
  'disableSizeLimit',
  'disableSourceOfProjectReferenceRedirect',
  'disableSolutionSearching',
  'disableReferencedProjectLoad',
  'erasableSyntaxOnly',
  'exactOptionalPropertyTypes',
  'experimentalDecorators',
  'forceConsistentCasingInFileNames',
  'isolatedModules',
  'isolatedDeclarations',
  'ignoreConfig',
  'ignoreDeprecations',
  'importHelpers',
  'inlineSourceMap',
  'inlineSources',
  'init',
  'incremental',
  'jsx',
  'jsxFactory',
  'jsxFragmentFactory',
  'jsxImportSource',
  'lib',
  'libReplacement',
  'locale',
  'mapRoot',
  'module',
  'moduleResolution',
  'moduleSuffixes',
  'moduleDetection',
  'newLine',
  'noEmit',
  'noCheck',
  'noErrorTruncation',
  'noFallthroughCasesInSwitch',
  'noImplicitAny',
  'noImplicitThis',
  'noImplicitReturns',
  'noEmitHelpers',
  'noLib',
  'noPropertyAccessFromIndexSignature',
  'noUncheckedIndexedAccess',
  'noEmitOnError',
  'noUnusedLocals',
  'noUnusedParameters',
  'noResolve',
  'noImplicitOverride',
  'noUncheckedSideEffectImports',
  'outDir',
  'paths',
  'preserveConstEnums',
  'preserveSymlinks',
  'project',
  'resolveJsonModule',
  'resolvePackageJsonExports',
  'resolvePackageJsonImports',
  'removeComments',
  'rewriteRelativeImportExtensions',
  'reactNamespace',
  'rootDir',
  'rootDirs',
  'skipLibCheck',
  'stableTypeOrdering',
  'strict',
  'strictBindCallApply',
  'strictBuiltinIteratorReturn',
  'strictFunctionTypes',
  'strictNullChecks',
  'strictPropertyInitialization',
  'stripInternal',
  'skipDefaultLibCheck',
  'sourceMap',
  'sourceRoot',
  'suppressOutputPathCheck',
  'target',
  'traceResolution',
  'tsBuildInfoFile',
  'typeRoots',
  'types',
  'useDefineForClassFields',
  'useUnknownInCatchVariables',
  'verbatimModuleSyntax',
  'maxNodeModuleJsDepth',
  'allowSyntheticDefaultImports',
  'alwaysStrict',
  'baseUrl',
  'downlevelIteration',
  'esModuleInterop',
  'outFile',
  'configFilePath',
  'noDtsResolution',
  'pathsBasePath',
  'diagnostics',
  'extendedDiagnostics',
  'generateCpuProfile',
  'generateTrace',
  'listEmittedFiles',
  'listFiles',
  'explainFiles',
  'listFilesOnly',
  'noEmitForJsFiles',
  'preserveWatchOutput',
  'pretty',
  'version',
  'watch',
  'showConfig',
  'build',
  'help',
  'all',
  'pprofDir',
  'singleThreaded',
  'quiet',
  'checkers',
];

function stringValue(value: OptionValue): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberValue(value: OptionValue): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function stringList(value: OptionValue): string[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** Sets compiler option `name` (a declaration name) from a parsed value. `null` and unknown names are ignored. */
export function setCompilerOption(options: CompilerOptions, name: string, value: OptionValue): void {
  if (value === null) return;
  switch (name) {
    case 'allowJs':
      options.allowJs = value === true;
      break;
    case 'allowArbitraryExtensions':
      options.allowArbitraryExtensions = value === true;
      break;
    case 'allowImportingTsExtensions':
      options.allowImportingTsExtensions = value === true;
      break;
    case 'allowNonTsExtensions':
      options.allowNonTsExtensions = value === true;
      break;
    case 'allowUmdGlobalAccess':
      options.allowUmdGlobalAccess = value === true;
      break;
    case 'allowUnreachableCode':
      options.allowUnreachableCode = value === true;
      break;
    case 'allowUnusedLabels':
      options.allowUnusedLabels = value === true;
      break;
    case 'assumeChangesOnlyAffectDirectDependencies':
      options.assumeChangesOnlyAffectDirectDependencies = value === true;
      break;
    case 'checkJs':
      options.checkJs = value === true;
      break;
    case 'customConditions':
      options.customConditions = stringList(value);
      break;
    case 'composite':
      options.composite = value === true;
      break;
    case 'emitDeclarationOnly':
      options.emitDeclarationOnly = value === true;
      break;
    case 'emitBOM':
      options.emitBOM = value === true;
      break;
    case 'emitDecoratorMetadata':
      options.emitDecoratorMetadata = value === true;
      break;
    case 'declaration':
      options.declaration = value === true;
      break;
    case 'declarationDir':
      options.declarationDir = stringValue(value);
      break;
    case 'declarationMap':
      options.declarationMap = value === true;
      break;
    case 'deduplicatePackages':
      options.deduplicatePackages = value === true;
      break;
    case 'disableSizeLimit':
      options.disableSizeLimit = value === true;
      break;
    case 'disableSourceOfProjectReferenceRedirect':
      options.disableSourceOfProjectReferenceRedirect = value === true;
      break;
    case 'disableSolutionSearching':
      options.disableSolutionSearching = value === true;
      break;
    case 'disableReferencedProjectLoad':
      options.disableReferencedProjectLoad = value === true;
      break;
    case 'erasableSyntaxOnly':
      options.erasableSyntaxOnly = value === true;
      break;
    case 'exactOptionalPropertyTypes':
      options.exactOptionalPropertyTypes = value === true;
      break;
    case 'experimentalDecorators':
      options.experimentalDecorators = value === true;
      break;
    case 'forceConsistentCasingInFileNames':
      options.forceConsistentCasingInFileNames = value === true;
      break;
    case 'isolatedModules':
      options.isolatedModules = value === true;
      break;
    case 'isolatedDeclarations':
      options.isolatedDeclarations = value === true;
      break;
    case 'ignoreConfig':
      options.ignoreConfig = value === true;
      break;
    case 'ignoreDeprecations':
      options.ignoreDeprecations = stringValue(value);
      break;
    case 'importHelpers':
      options.importHelpers = value === true;
      break;
    case 'inlineSourceMap':
      options.inlineSourceMap = value === true;
      break;
    case 'inlineSources':
      options.inlineSources = value === true;
      break;
    case 'init':
      options.init = value === true;
      break;
    case 'incremental':
      options.incremental = value === true;
      break;
    case 'jsx':
      options.jsx = numberValue(value);
      break;
    case 'jsxFactory':
      options.jsxFactory = stringValue(value);
      break;
    case 'jsxFragmentFactory':
      options.jsxFragmentFactory = stringValue(value);
      break;
    case 'jsxImportSource':
      options.jsxImportSource = stringValue(value);
      break;
    case 'lib':
      options.lib = stringList(value);
      break;
    case 'libReplacement':
      options.libReplacement = value === true;
      break;
    case 'locale':
      options.locale = stringValue(value);
      break;
    case 'mapRoot':
      options.mapRoot = stringValue(value);
      break;
    case 'module':
      options.module = numberValue(value);
      break;
    case 'moduleResolution':
      options.moduleResolution = numberValue(value);
      break;
    case 'moduleSuffixes':
      options.moduleSuffixes = stringList(value);
      break;
    case 'moduleDetection':
      options.moduleDetection = numberValue(value);
      break;
    case 'newLine':
      options.newLine = numberValue(value);
      break;
    case 'noEmit':
      options.noEmit = value === true;
      break;
    case 'noCheck':
      options.noCheck = value === true;
      break;
    case 'noErrorTruncation':
      options.noErrorTruncation = value === true;
      break;
    case 'noFallthroughCasesInSwitch':
      options.noFallthroughCasesInSwitch = value === true;
      break;
    case 'noImplicitAny':
      options.noImplicitAny = value === true;
      break;
    case 'noImplicitThis':
      options.noImplicitThis = value === true;
      break;
    case 'noImplicitReturns':
      options.noImplicitReturns = value === true;
      break;
    case 'noEmitHelpers':
      options.noEmitHelpers = value === true;
      break;
    case 'noLib':
      options.noLib = value === true;
      break;
    case 'noPropertyAccessFromIndexSignature':
      options.noPropertyAccessFromIndexSignature = value === true;
      break;
    case 'noUncheckedIndexedAccess':
      options.noUncheckedIndexedAccess = value === true;
      break;
    case 'noEmitOnError':
      options.noEmitOnError = value === true;
      break;
    case 'noUnusedLocals':
      options.noUnusedLocals = value === true;
      break;
    case 'noUnusedParameters':
      options.noUnusedParameters = value === true;
      break;
    case 'noResolve':
      options.noResolve = value === true;
      break;
    case 'noImplicitOverride':
      options.noImplicitOverride = value === true;
      break;
    case 'noUncheckedSideEffectImports':
      options.noUncheckedSideEffectImports = value === true;
      break;
    case 'outDir':
      options.outDir = stringValue(value);
      break;
    case 'preserveConstEnums':
      options.preserveConstEnums = value === true;
      break;
    case 'preserveSymlinks':
      options.preserveSymlinks = value === true;
      break;
    case 'project':
      options.project = stringValue(value);
      break;
    case 'resolveJsonModule':
      options.resolveJsonModule = value === true;
      break;
    case 'resolvePackageJsonExports':
      options.resolvePackageJsonExports = value === true;
      break;
    case 'resolvePackageJsonImports':
      options.resolvePackageJsonImports = value === true;
      break;
    case 'removeComments':
      options.removeComments = value === true;
      break;
    case 'rewriteRelativeImportExtensions':
      options.rewriteRelativeImportExtensions = value === true;
      break;
    case 'reactNamespace':
      options.reactNamespace = stringValue(value);
      break;
    case 'rootDir':
      options.rootDir = stringValue(value);
      break;
    case 'rootDirs':
      options.rootDirs = stringList(value);
      break;
    case 'skipLibCheck':
      options.skipLibCheck = value === true;
      break;
    case 'stableTypeOrdering':
      options.stableTypeOrdering = value === true;
      break;
    case 'strict':
      options.strict = value === true;
      break;
    case 'strictBindCallApply':
      options.strictBindCallApply = value === true;
      break;
    case 'strictBuiltinIteratorReturn':
      options.strictBuiltinIteratorReturn = value === true;
      break;
    case 'strictFunctionTypes':
      options.strictFunctionTypes = value === true;
      break;
    case 'strictNullChecks':
      options.strictNullChecks = value === true;
      break;
    case 'strictPropertyInitialization':
      options.strictPropertyInitialization = value === true;
      break;
    case 'stripInternal':
      options.stripInternal = value === true;
      break;
    case 'skipDefaultLibCheck':
      options.skipDefaultLibCheck = value === true;
      break;
    case 'sourceMap':
      options.sourceMap = value === true;
      break;
    case 'sourceRoot':
      options.sourceRoot = stringValue(value);
      break;
    case 'suppressOutputPathCheck':
      options.suppressOutputPathCheck = value === true;
      break;
    case 'target':
      options.target = numberValue(value);
      break;
    case 'traceResolution':
      options.traceResolution = value === true;
      break;
    case 'tsBuildInfoFile':
      options.tsBuildInfoFile = stringValue(value);
      break;
    case 'typeRoots':
      options.typeRoots = stringList(value);
      break;
    case 'types':
      options.types = stringList(value);
      break;
    case 'useDefineForClassFields':
      options.useDefineForClassFields = value === true;
      break;
    case 'useUnknownInCatchVariables':
      options.useUnknownInCatchVariables = value === true;
      break;
    case 'verbatimModuleSyntax':
      options.verbatimModuleSyntax = value === true;
      break;
    case 'maxNodeModuleJsDepth':
      options.maxNodeModuleJsDepth = numberValue(value);
      break;
    case 'allowSyntheticDefaultImports':
      options.allowSyntheticDefaultImports = value === true;
      break;
    case 'alwaysStrict':
      options.alwaysStrict = value === true;
      break;
    case 'baseUrl':
      options.baseUrl = stringValue(value);
      break;
    case 'downlevelIteration':
      options.downlevelIteration = value === true;
      break;
    case 'esModuleInterop':
      options.esModuleInterop = value === true;
      break;
    case 'outFile':
      options.outFile = stringValue(value);
      break;
    case 'configFilePath':
      options.configFilePath = stringValue(value);
      break;
    case 'noDtsResolution':
      options.noDtsResolution = value === true;
      break;
    case 'pathsBasePath':
      options.pathsBasePath = stringValue(value);
      break;
    case 'diagnostics':
      options.diagnostics = value === true;
      break;
    case 'extendedDiagnostics':
      options.extendedDiagnostics = value === true;
      break;
    case 'generateCpuProfile':
      options.generateCpuProfile = stringValue(value);
      break;
    case 'generateTrace':
      options.generateTrace = stringValue(value);
      break;
    case 'listEmittedFiles':
      options.listEmittedFiles = value === true;
      break;
    case 'listFiles':
      options.listFiles = value === true;
      break;
    case 'explainFiles':
      options.explainFiles = value === true;
      break;
    case 'listFilesOnly':
      options.listFilesOnly = value === true;
      break;
    case 'noEmitForJsFiles':
      options.noEmitForJsFiles = value === true;
      break;
    case 'preserveWatchOutput':
      options.preserveWatchOutput = value === true;
      break;
    case 'pretty':
      options.pretty = value === true;
      break;
    case 'version':
      options.version = value === true;
      break;
    case 'watch':
      options.watch = value === true;
      break;
    case 'showConfig':
      options.showConfig = value === true;
      break;
    case 'build':
      options.build = value === true;
      break;
    case 'help':
      options.help = value === true;
      break;
    case 'all':
      options.all = value === true;
      break;
    case 'pprofDir':
      options.pprofDir = stringValue(value);
      break;
    case 'singleThreaded':
      options.singleThreaded = value === true;
      break;
    case 'quiet':
      options.quiet = value === true;
      break;
    case 'checkers':
      options.checkers = numberValue(value);
      break;
  }
}

export function getCompilerOption(options: CompilerOptions, name: string): CompilerOptionValue | undefined {
  switch (name) {
    case 'allowJs':
      return options.allowJs;
    case 'allowArbitraryExtensions':
      return options.allowArbitraryExtensions;
    case 'allowImportingTsExtensions':
      return options.allowImportingTsExtensions;
    case 'allowNonTsExtensions':
      return options.allowNonTsExtensions;
    case 'allowUmdGlobalAccess':
      return options.allowUmdGlobalAccess;
    case 'allowUnreachableCode':
      return options.allowUnreachableCode;
    case 'allowUnusedLabels':
      return options.allowUnusedLabels;
    case 'assumeChangesOnlyAffectDirectDependencies':
      return options.assumeChangesOnlyAffectDirectDependencies;
    case 'checkJs':
      return options.checkJs;
    case 'customConditions':
      return options.customConditions;
    case 'composite':
      return options.composite;
    case 'emitDeclarationOnly':
      return options.emitDeclarationOnly;
    case 'emitBOM':
      return options.emitBOM;
    case 'emitDecoratorMetadata':
      return options.emitDecoratorMetadata;
    case 'declaration':
      return options.declaration;
    case 'declarationDir':
      return options.declarationDir;
    case 'declarationMap':
      return options.declarationMap;
    case 'deduplicatePackages':
      return options.deduplicatePackages;
    case 'disableSizeLimit':
      return options.disableSizeLimit;
    case 'disableSourceOfProjectReferenceRedirect':
      return options.disableSourceOfProjectReferenceRedirect;
    case 'disableSolutionSearching':
      return options.disableSolutionSearching;
    case 'disableReferencedProjectLoad':
      return options.disableReferencedProjectLoad;
    case 'erasableSyntaxOnly':
      return options.erasableSyntaxOnly;
    case 'exactOptionalPropertyTypes':
      return options.exactOptionalPropertyTypes;
    case 'experimentalDecorators':
      return options.experimentalDecorators;
    case 'forceConsistentCasingInFileNames':
      return options.forceConsistentCasingInFileNames;
    case 'isolatedModules':
      return options.isolatedModules;
    case 'isolatedDeclarations':
      return options.isolatedDeclarations;
    case 'ignoreConfig':
      return options.ignoreConfig;
    case 'ignoreDeprecations':
      return options.ignoreDeprecations;
    case 'importHelpers':
      return options.importHelpers;
    case 'inlineSourceMap':
      return options.inlineSourceMap;
    case 'inlineSources':
      return options.inlineSources;
    case 'init':
      return options.init;
    case 'incremental':
      return options.incremental;
    case 'jsx':
      return options.jsx;
    case 'jsxFactory':
      return options.jsxFactory;
    case 'jsxFragmentFactory':
      return options.jsxFragmentFactory;
    case 'jsxImportSource':
      return options.jsxImportSource;
    case 'lib':
      return options.lib;
    case 'libReplacement':
      return options.libReplacement;
    case 'locale':
      return options.locale;
    case 'mapRoot':
      return options.mapRoot;
    case 'module':
      return options.module;
    case 'moduleResolution':
      return options.moduleResolution;
    case 'moduleSuffixes':
      return options.moduleSuffixes;
    case 'moduleDetection':
      return options.moduleDetection;
    case 'newLine':
      return options.newLine;
    case 'noEmit':
      return options.noEmit;
    case 'noCheck':
      return options.noCheck;
    case 'noErrorTruncation':
      return options.noErrorTruncation;
    case 'noFallthroughCasesInSwitch':
      return options.noFallthroughCasesInSwitch;
    case 'noImplicitAny':
      return options.noImplicitAny;
    case 'noImplicitThis':
      return options.noImplicitThis;
    case 'noImplicitReturns':
      return options.noImplicitReturns;
    case 'noEmitHelpers':
      return options.noEmitHelpers;
    case 'noLib':
      return options.noLib;
    case 'noPropertyAccessFromIndexSignature':
      return options.noPropertyAccessFromIndexSignature;
    case 'noUncheckedIndexedAccess':
      return options.noUncheckedIndexedAccess;
    case 'noEmitOnError':
      return options.noEmitOnError;
    case 'noUnusedLocals':
      return options.noUnusedLocals;
    case 'noUnusedParameters':
      return options.noUnusedParameters;
    case 'noResolve':
      return options.noResolve;
    case 'noImplicitOverride':
      return options.noImplicitOverride;
    case 'noUncheckedSideEffectImports':
      return options.noUncheckedSideEffectImports;
    case 'outDir':
      return options.outDir;
    case 'preserveConstEnums':
      return options.preserveConstEnums;
    case 'preserveSymlinks':
      return options.preserveSymlinks;
    case 'project':
      return options.project;
    case 'resolveJsonModule':
      return options.resolveJsonModule;
    case 'resolvePackageJsonExports':
      return options.resolvePackageJsonExports;
    case 'resolvePackageJsonImports':
      return options.resolvePackageJsonImports;
    case 'removeComments':
      return options.removeComments;
    case 'rewriteRelativeImportExtensions':
      return options.rewriteRelativeImportExtensions;
    case 'reactNamespace':
      return options.reactNamespace;
    case 'rootDir':
      return options.rootDir;
    case 'rootDirs':
      return options.rootDirs;
    case 'skipLibCheck':
      return options.skipLibCheck;
    case 'stableTypeOrdering':
      return options.stableTypeOrdering;
    case 'strict':
      return options.strict;
    case 'strictBindCallApply':
      return options.strictBindCallApply;
    case 'strictBuiltinIteratorReturn':
      return options.strictBuiltinIteratorReturn;
    case 'strictFunctionTypes':
      return options.strictFunctionTypes;
    case 'strictNullChecks':
      return options.strictNullChecks;
    case 'strictPropertyInitialization':
      return options.strictPropertyInitialization;
    case 'stripInternal':
      return options.stripInternal;
    case 'skipDefaultLibCheck':
      return options.skipDefaultLibCheck;
    case 'sourceMap':
      return options.sourceMap;
    case 'sourceRoot':
      return options.sourceRoot;
    case 'suppressOutputPathCheck':
      return options.suppressOutputPathCheck;
    case 'target':
      return options.target;
    case 'traceResolution':
      return options.traceResolution;
    case 'tsBuildInfoFile':
      return options.tsBuildInfoFile;
    case 'typeRoots':
      return options.typeRoots;
    case 'types':
      return options.types;
    case 'useDefineForClassFields':
      return options.useDefineForClassFields;
    case 'useUnknownInCatchVariables':
      return options.useUnknownInCatchVariables;
    case 'verbatimModuleSyntax':
      return options.verbatimModuleSyntax;
    case 'maxNodeModuleJsDepth':
      return options.maxNodeModuleJsDepth;
    case 'allowSyntheticDefaultImports':
      return options.allowSyntheticDefaultImports;
    case 'alwaysStrict':
      return options.alwaysStrict;
    case 'baseUrl':
      return options.baseUrl;
    case 'downlevelIteration':
      return options.downlevelIteration;
    case 'esModuleInterop':
      return options.esModuleInterop;
    case 'outFile':
      return options.outFile;
    case 'configFilePath':
      return options.configFilePath;
    case 'noDtsResolution':
      return options.noDtsResolution;
    case 'pathsBasePath':
      return options.pathsBasePath;
    case 'diagnostics':
      return options.diagnostics;
    case 'extendedDiagnostics':
      return options.extendedDiagnostics;
    case 'generateCpuProfile':
      return options.generateCpuProfile;
    case 'generateTrace':
      return options.generateTrace;
    case 'listEmittedFiles':
      return options.listEmittedFiles;
    case 'listFiles':
      return options.listFiles;
    case 'explainFiles':
      return options.explainFiles;
    case 'listFilesOnly':
      return options.listFilesOnly;
    case 'noEmitForJsFiles':
      return options.noEmitForJsFiles;
    case 'preserveWatchOutput':
      return options.preserveWatchOutput;
    case 'pretty':
      return options.pretty;
    case 'version':
      return options.version;
    case 'watch':
      return options.watch;
    case 'showConfig':
      return options.showConfig;
    case 'build':
      return options.build;
    case 'help':
      return options.help;
    case 'all':
      return options.all;
    case 'pprofDir':
      return options.pprofDir;
    case 'singleThreaded':
      return options.singleThreaded;
    case 'quiet':
      return options.quiet;
    case 'checkers':
      return options.checkers;
  }
  return undefined;
}

export function setWatchOption(options: WatchOptions, name: string, value: OptionValue): void {
  switch (name) {
    case 'watchInterval':
      options.watchInterval = numberValue(value);
      break;
    case 'watchFile':
      if (value !== null) options.watchFile = numberValue(value);
      break;
    case 'watchDirectory':
      if (value !== null) options.watchDirectory = numberValue(value);
      break;
    case 'fallbackPolling':
      if (value !== null) options.fallbackPolling = numberValue(value);
      break;
    case 'synchronousWatchDirectory':
      options.synchronousWatchDirectory = value === null ? undefined : value === true;
      break;
    case 'excludeDirectories':
      options.excludeDirectories = stringList(value);
      break;
    case 'excludeFiles':
      options.excludeFiles = stringList(value);
      break;
  }
}

export function setBuildOption(options: BuildOptions, name: string, value: OptionValue): void {
  if (value === null) return;
  switch (name) {
    case 'clean':
      options.clean = value === true;
      break;
    case 'dry':
      options.dry = value === true;
      break;
    case 'force':
      options.force = value === true;
      break;
    case 'builders':
      options.builders = numberValue(value);
      break;
    case 'stopBuildOnErrors':
      options.stopBuildOnErrors = value === true;
      break;
    case 'verbose':
      options.verbose = value === true;
      break;
  }
}

export function setTypeAcquisitionOption(options: TypeAcquisition, name: string, value: OptionValue): void {
  if (value === null) return;
  switch (name) {
    case 'enable':
      options.enable = value === true;
      break;
    case 'include':
      options.include = stringList(value);
      break;
    case 'exclude':
      options.exclude = stringList(value);
      break;
    case 'disableFilenameBasedTypeAcquisition':
      options.disableFilenameBasedTypeAcquisition = value === true;
      break;
  }
}

// Effective values of options with computed defaults.

export function getEmitScriptTarget(options: CompilerOptions): ScriptTarget {
  return options.target ?? ScriptTarget.LatestStandard;
}

export function getEmitModuleKind(options: CompilerOptions): ModuleKind {
  if (options.module !== undefined) return options.module;
  const target = getEmitScriptTarget(options);
  if (target === ScriptTarget.ESNext) return ModuleKind.ESNext;
  if (target >= ScriptTarget.ES2022) return ModuleKind.ES2022;
  if (target >= ScriptTarget.ES2020) return ModuleKind.ES2020;
  if (target >= ScriptTarget.ES2015) return ModuleKind.ES2015;
  return ModuleKind.CommonJS;
}

export function getModuleResolutionKind(options: CompilerOptions): ModuleResolutionKind {
  const resolution = options.moduleResolution;
  if (
    resolution !== undefined &&
    resolution !== ModuleResolutionKind.Classic &&
    resolution !== ModuleResolutionKind.Node10
  ) {
    return resolution;
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

export function getEmitModuleDetectionKind(options: CompilerOptions): ModuleDetectionKind {
  if (options.moduleDetection !== undefined) return options.moduleDetection;
  const module = getEmitModuleKind(options);
  return ModuleKind.Node16 <= module && module <= ModuleKind.NodeNext
    ? ModuleDetectionKind.Force
    : ModuleDetectionKind.Auto;
}

export function getResolvePackageJsonExports(options: CompilerOptions): boolean {
  return options.resolvePackageJsonExports !== false;
}

export function getResolvePackageJsonImports(options: CompilerOptions): boolean {
  return options.resolvePackageJsonImports !== false;
}

export function getAllowImportingTsExtensions(options: CompilerOptions): boolean {
  return options.allowImportingTsExtensions === true || options.rewriteRelativeImportExtensions === true;
}

export function getResolveJsonModule(options: CompilerOptions): boolean {
  if (options.resolveJsonModule !== undefined) return options.resolveJsonModule;
  const module = getEmitModuleKind(options);
  if (module === ModuleKind.Node20 || module === ModuleKind.NodeNext) return true;
  return getModuleResolutionKind(options) === ModuleResolutionKind.Bundler;
}

export function getIsolatedModules(options: CompilerOptions): boolean {
  return options.isolatedModules === true || options.verbatimModuleSyntax === true;
}

export function shouldPreserveConstEnums(options: CompilerOptions): boolean {
  return options.preserveConstEnums === true || getIsolatedModules(options);
}

export function getAllowJS(options: CompilerOptions): boolean {
  return options.allowJs ?? options.checkJs === true;
}

export function getStrictOptionValue(options: CompilerOptions, value: boolean | undefined): boolean {
  return value ?? options.strict !== false;
}

export function isIncremental(options: CompilerOptions): boolean {
  return options.incremental === true || options.composite === true;
}

export function getUseDefineForClassFields(options: CompilerOptions): boolean {
  return options.useDefineForClassFields ?? getEmitScriptTarget(options) >= ScriptTarget.ES2022;
}

export function getEmitDeclarations(options: CompilerOptions): boolean {
  return options.declaration === true || options.composite === true;
}

export function getAreDeclarationMapsEnabled(options: CompilerOptions): boolean {
  return options.declarationMap === true && getEmitDeclarations(options);
}
