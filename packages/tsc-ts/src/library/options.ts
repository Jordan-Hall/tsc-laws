// Compiler options of tsc-ts's public API and `tsc-ts --api`: tsc-ts's options as tsgo's API returns them,
// and back.

import type { CompilerOptions as CompilerOptionsValue } from '../compiler/options.js';
import { getLibFileName } from '../compiler/program-utilities.js';

/**
 * Compiler options as `tsc-ts --api` returns them, in TypeScript-Go's field order: the public
 * CompilerOptions, and the options tsgo's API returns besides those.
 */
export interface ApiCompilerOptions {
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
  jsx?: number;
  jsxFactory?: string;
  jsxFragmentFactory?: string;
  jsxImportSource?: string;
  lib?: string[];
  libReplacement?: boolean;
  locale?: string;
  mapRoot?: string;
  module?: number;
  moduleResolution?: number;
  moduleSuffixes?: string[];
  moduleDetection?: number;
  newLine?: number;
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
  paths?: Record<string, string[]>;
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
  target?: number;
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

/** Compiler options as `tsc-ts --api` returns them: unset strings, enums and path mappings are undefined. */
export function compilerOptionsOf(o: CompilerOptionsValue): ApiCompilerOptions {
  return {
    allowJs: o.allowJs,
    allowArbitraryExtensions: o.allowArbitraryExtensions,
    allowImportingTsExtensions: o.allowImportingTsExtensions,
    allowNonTsExtensions: o.allowNonTsExtensions,
    allowUmdGlobalAccess: o.allowUmdGlobalAccess,
    allowUnreachableCode: o.allowUnreachableCode,
    allowUnusedLabels: o.allowUnusedLabels,
    assumeChangesOnlyAffectDirectDependencies: o.assumeChangesOnlyAffectDirectDependencies,
    checkJs: o.checkJs,
    customConditions: o.customConditions,
    composite: o.composite,
    emitDeclarationOnly: o.emitDeclarationOnly,
    emitBOM: o.emitBOM,
    emitDecoratorMetadata: o.emitDecoratorMetadata,
    declaration: o.declaration,
    declarationDir: text(o.declarationDir),
    declarationMap: o.declarationMap,
    deduplicatePackages: o.deduplicatePackages,
    disableSizeLimit: o.disableSizeLimit,
    disableSourceOfProjectReferenceRedirect: o.disableSourceOfProjectReferenceRedirect,
    disableSolutionSearching: o.disableSolutionSearching,
    disableReferencedProjectLoad: o.disableReferencedProjectLoad,
    erasableSyntaxOnly: o.erasableSyntaxOnly,
    exactOptionalPropertyTypes: o.exactOptionalPropertyTypes,
    experimentalDecorators: o.experimentalDecorators,
    forceConsistentCasingInFileNames: o.forceConsistentCasingInFileNames,
    isolatedModules: o.isolatedModules,
    isolatedDeclarations: o.isolatedDeclarations,
    ignoreConfig: o.ignoreConfig,
    ignoreDeprecations: text(o.ignoreDeprecations),
    importHelpers: o.importHelpers,
    inlineSourceMap: o.inlineSourceMap,
    inlineSources: o.inlineSources,
    init: o.init,
    incremental: o.incremental,
    jsx: enumValue(o.jsx),
    jsxFactory: text(o.jsxFactory),
    jsxFragmentFactory: text(o.jsxFragmentFactory),
    jsxImportSource: text(o.jsxImportSource),
    lib: o.lib,
    libReplacement: o.libReplacement,
    locale: text(o.locale),
    mapRoot: text(o.mapRoot),
    module: enumValue(o.module),
    moduleResolution: enumValue(o.moduleResolution),
    moduleSuffixes: o.moduleSuffixes,
    moduleDetection: enumValue(o.moduleDetection),
    newLine: enumValue(o.newLine),
    noEmit: o.noEmit,
    noCheck: o.noCheck,
    noErrorTruncation: o.noErrorTruncation,
    noFallthroughCasesInSwitch: o.noFallthroughCasesInSwitch,
    noImplicitAny: o.noImplicitAny,
    noImplicitThis: o.noImplicitThis,
    noImplicitReturns: o.noImplicitReturns,
    noEmitHelpers: o.noEmitHelpers,
    noLib: o.noLib,
    noPropertyAccessFromIndexSignature: o.noPropertyAccessFromIndexSignature,
    noUncheckedIndexedAccess: o.noUncheckedIndexedAccess,
    noEmitOnError: o.noEmitOnError,
    noUnusedLocals: o.noUnusedLocals,
    noUnusedParameters: o.noUnusedParameters,
    noResolve: o.noResolve,
    noImplicitOverride: o.noImplicitOverride,
    noUncheckedSideEffectImports: o.noUncheckedSideEffectImports,
    outDir: text(o.outDir),
    paths: pathMappings(o.paths),
    preserveConstEnums: o.preserveConstEnums,
    preserveSymlinks: o.preserveSymlinks,
    project: text(o.project),
    resolveJsonModule: o.resolveJsonModule,
    resolvePackageJsonExports: o.resolvePackageJsonExports,
    resolvePackageJsonImports: o.resolvePackageJsonImports,
    removeComments: o.removeComments,
    rewriteRelativeImportExtensions: o.rewriteRelativeImportExtensions,
    reactNamespace: text(o.reactNamespace),
    rootDir: text(o.rootDir),
    rootDirs: o.rootDirs,
    skipLibCheck: o.skipLibCheck,
    stableTypeOrdering: o.stableTypeOrdering,
    strict: o.strict,
    strictBindCallApply: o.strictBindCallApply,
    strictBuiltinIteratorReturn: o.strictBuiltinIteratorReturn,
    strictFunctionTypes: o.strictFunctionTypes,
    strictNullChecks: o.strictNullChecks,
    strictPropertyInitialization: o.strictPropertyInitialization,
    stripInternal: o.stripInternal,
    skipDefaultLibCheck: o.skipDefaultLibCheck,
    sourceMap: o.sourceMap,
    sourceRoot: text(o.sourceRoot),
    suppressOutputPathCheck: o.suppressOutputPathCheck,
    target: enumValue(o.target),
    traceResolution: o.traceResolution,
    tsBuildInfoFile: text(o.tsBuildInfoFile),
    typeRoots: o.typeRoots,
    types: o.types,
    useDefineForClassFields: o.useDefineForClassFields,
    useUnknownInCatchVariables: o.useUnknownInCatchVariables,
    verbatimModuleSyntax: o.verbatimModuleSyntax,
    maxNodeModuleJsDepth: o.maxNodeModuleJsDepth,
    allowSyntheticDefaultImports: o.allowSyntheticDefaultImports,
    alwaysStrict: o.alwaysStrict,
    baseUrl: text(o.baseUrl),
    downlevelIteration: o.downlevelIteration,
    esModuleInterop: o.esModuleInterop,
    outFile: text(o.outFile),
    configFilePath: text(o.configFilePath),
    noDtsResolution: o.noDtsResolution,
    pathsBasePath: text(o.pathsBasePath),
    diagnostics: o.diagnostics,
    extendedDiagnostics: o.extendedDiagnostics,
    generateCpuProfile: text(o.generateCpuProfile),
    generateTrace: text(o.generateTrace),
    listEmittedFiles: o.listEmittedFiles,
    listFiles: o.listFiles,
    explainFiles: o.explainFiles,
    listFilesOnly: o.listFilesOnly,
    noEmitForJsFiles: o.noEmitForJsFiles,
    preserveWatchOutput: o.preserveWatchOutput,
    pretty: o.pretty,
    version: o.version,
    watch: o.watch,
    showConfig: o.showConfig,
    build: o.build,
    help: o.help,
    all: o.all,
    pprofDir: text(o.pprofDir),
    singleThreaded: o.singleThreaded,
    quiet: o.quiet,
    checkers: o.checkers,
  };
}

function text(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}

function enumValue(value: number | undefined): number | undefined {
  return value === 0 ? undefined : value;
}

function pathMappings(paths: Map<string, string[] | undefined> | undefined): Record<string, string[]> | undefined {
  if (paths === undefined) return undefined;
  const mappings: Record<string, string[]> = {};
  for (const [pattern, substitutions] of paths) mappings[pattern] = substitutions ?? [];
  return mappings;
}

/**
 * tsc-ts's compiler options for options in the form tsgo's API returns them (`compilerOptionsOf`). `lib`
 * may name libraries as in tsconfig.json (`es2025`) or by file name (`lib.es2025.d.ts`).
 */
export function compilerOptionsFromApi(o: ApiCompilerOptions): CompilerOptionsValue {
  return {
    allowJs: o.allowJs,
    allowArbitraryExtensions: o.allowArbitraryExtensions,
    allowImportingTsExtensions: o.allowImportingTsExtensions,
    allowNonTsExtensions: o.allowNonTsExtensions,
    allowUmdGlobalAccess: o.allowUmdGlobalAccess,
    allowUnreachableCode: o.allowUnreachableCode,
    allowUnusedLabels: o.allowUnusedLabels,
    assumeChangesOnlyAffectDirectDependencies: o.assumeChangesOnlyAffectDirectDependencies,
    checkJs: o.checkJs,
    customConditions: o.customConditions,
    composite: o.composite,
    emitDeclarationOnly: o.emitDeclarationOnly,
    emitBOM: o.emitBOM,
    emitDecoratorMetadata: o.emitDecoratorMetadata,
    declaration: o.declaration,
    declarationDir: o.declarationDir,
    declarationMap: o.declarationMap,
    deduplicatePackages: o.deduplicatePackages,
    disableSizeLimit: o.disableSizeLimit,
    disableSourceOfProjectReferenceRedirect: o.disableSourceOfProjectReferenceRedirect,
    disableSolutionSearching: o.disableSolutionSearching,
    disableReferencedProjectLoad: o.disableReferencedProjectLoad,
    erasableSyntaxOnly: o.erasableSyntaxOnly,
    exactOptionalPropertyTypes: o.exactOptionalPropertyTypes,
    experimentalDecorators: o.experimentalDecorators,
    forceConsistentCasingInFileNames: o.forceConsistentCasingInFileNames,
    isolatedModules: o.isolatedModules,
    isolatedDeclarations: o.isolatedDeclarations,
    ignoreConfig: o.ignoreConfig,
    ignoreDeprecations: o.ignoreDeprecations,
    importHelpers: o.importHelpers,
    inlineSourceMap: o.inlineSourceMap,
    inlineSources: o.inlineSources,
    init: o.init,
    incremental: o.incremental,
    jsx: o.jsx,
    jsxFactory: o.jsxFactory,
    jsxFragmentFactory: o.jsxFragmentFactory,
    jsxImportSource: o.jsxImportSource,
    lib: libFileNames(o.lib),
    libReplacement: o.libReplacement,
    locale: o.locale,
    mapRoot: o.mapRoot,
    module: o.module,
    moduleResolution: o.moduleResolution,
    moduleSuffixes: o.moduleSuffixes,
    moduleDetection: o.moduleDetection,
    newLine: o.newLine,
    noEmit: o.noEmit,
    noCheck: o.noCheck,
    noErrorTruncation: o.noErrorTruncation,
    noFallthroughCasesInSwitch: o.noFallthroughCasesInSwitch,
    noImplicitAny: o.noImplicitAny,
    noImplicitThis: o.noImplicitThis,
    noImplicitReturns: o.noImplicitReturns,
    noEmitHelpers: o.noEmitHelpers,
    noLib: o.noLib,
    noPropertyAccessFromIndexSignature: o.noPropertyAccessFromIndexSignature,
    noUncheckedIndexedAccess: o.noUncheckedIndexedAccess,
    noEmitOnError: o.noEmitOnError,
    noUnusedLocals: o.noUnusedLocals,
    noUnusedParameters: o.noUnusedParameters,
    noResolve: o.noResolve,
    noImplicitOverride: o.noImplicitOverride,
    noUncheckedSideEffectImports: o.noUncheckedSideEffectImports,
    outDir: o.outDir,
    paths: pathMap(o.paths),
    preserveConstEnums: o.preserveConstEnums,
    preserveSymlinks: o.preserveSymlinks,
    project: o.project,
    resolveJsonModule: o.resolveJsonModule,
    resolvePackageJsonExports: o.resolvePackageJsonExports,
    resolvePackageJsonImports: o.resolvePackageJsonImports,
    removeComments: o.removeComments,
    rewriteRelativeImportExtensions: o.rewriteRelativeImportExtensions,
    reactNamespace: o.reactNamespace,
    rootDir: o.rootDir,
    rootDirs: o.rootDirs,
    skipLibCheck: o.skipLibCheck,
    stableTypeOrdering: o.stableTypeOrdering,
    strict: o.strict,
    strictBindCallApply: o.strictBindCallApply,
    strictBuiltinIteratorReturn: o.strictBuiltinIteratorReturn,
    strictFunctionTypes: o.strictFunctionTypes,
    strictNullChecks: o.strictNullChecks,
    strictPropertyInitialization: o.strictPropertyInitialization,
    stripInternal: o.stripInternal,
    skipDefaultLibCheck: o.skipDefaultLibCheck,
    sourceMap: o.sourceMap,
    sourceRoot: o.sourceRoot,
    suppressOutputPathCheck: o.suppressOutputPathCheck,
    target: o.target,
    traceResolution: o.traceResolution,
    tsBuildInfoFile: o.tsBuildInfoFile,
    typeRoots: o.typeRoots,
    types: o.types,
    useDefineForClassFields: o.useDefineForClassFields,
    useUnknownInCatchVariables: o.useUnknownInCatchVariables,
    verbatimModuleSyntax: o.verbatimModuleSyntax,
    maxNodeModuleJsDepth: o.maxNodeModuleJsDepth,
    allowSyntheticDefaultImports: o.allowSyntheticDefaultImports,
    alwaysStrict: o.alwaysStrict,
    baseUrl: o.baseUrl,
    downlevelIteration: o.downlevelIteration,
    esModuleInterop: o.esModuleInterop,
    outFile: o.outFile,
    configFilePath: o.configFilePath,
    noDtsResolution: o.noDtsResolution,
    pathsBasePath: o.pathsBasePath,
    diagnostics: o.diagnostics,
    extendedDiagnostics: o.extendedDiagnostics,
    generateCpuProfile: o.generateCpuProfile,
    generateTrace: o.generateTrace,
    listEmittedFiles: o.listEmittedFiles,
    listFiles: o.listFiles,
    explainFiles: o.explainFiles,
    listFilesOnly: o.listFilesOnly,
    noEmitForJsFiles: o.noEmitForJsFiles,
    preserveWatchOutput: o.preserveWatchOutput,
    pretty: o.pretty,
    version: o.version,
    watch: o.watch,
    showConfig: o.showConfig,
    build: o.build,
    help: o.help,
    all: o.all,
    pprofDir: o.pprofDir,
    singleThreaded: o.singleThreaded,
    quiet: o.quiet,
    checkers: o.checkers,
  };
}

function pathMap(paths: Record<string, string[]> | undefined): Map<string, string[] | undefined> | undefined {
  if (paths === undefined) return undefined;
  const map = new Map<string, string[] | undefined>();
  for (const pattern of Object.keys(paths)) map.set(pattern, paths[pattern]!.slice());
  return map;
}

function libFileNames(lib: string[] | undefined): string[] | undefined {
  if (lib === undefined) return undefined;
  const fileNames: string[] = [];
  for (const name of lib) {
    const fileName = getLibFileName(name);
    fileNames.push(fileName !== '' ? fileName : name);
  }
  return fileNames;
}
