// The compiler behind the API server. Everything it exports is plain data or
// an opaque reference that callers pass back in.
import type { Node as AstNode, SourceFile as AstSourceFile } from '../compiler/ast.js';
import { getTouchingPropertyName } from '../compiler/astnav.js';
import { getSourceFileOfNode } from '../compiler/binder-utilities.js';
import type { Checker } from '../compiler/checker.js';
import {
  getBaseTypes,
  getConstraintOfTypeParameter,
  getDeclaredTypeOfSymbol,
} from '../compiler/checker-declared-types.js';
import { getNonNullableType } from '../compiler/checker-flow.js';
import { isContextSensitive } from '../compiler/checker-functions.js';
import {
  getApparentType,
  getBaseConstraintOfType,
  getIndexInfosOfType,
  getPropertiesOfType,
  getPropertyOfType,
  getSignaturesOfType,
  isArrayLikeType,
} from '../compiler/checker-members.js';
import {
  getConstantValue,
  getExportSpecifierLocalTargetSymbol,
  getExportsOfModuleAsArray,
  getImmediateAliasedSymbol,
  getRestTypeOfSignature,
  getShorthandAssignmentValueSymbol,
  getSymbolAtLocation,
  getTypeAtLocation,
  getTypeOfSymbolAtLocation,
  queryContextualType,
  queryResolvedSignature,
  querySignatureFromDeclaration,
  tryGetMemberInModuleExports,
} from '../compiler/checker-services.js';
import {
  getReturnTypeOfSignature,
  getTypeAtPosition,
  getTypePredicateOfSignature,
} from '../compiler/checker-signatures.js';
import { getTypeOfSymbol, getWidenedType } from '../compiler/checker-symbol-types.js';
import { resolveAlias, resolveName as checkerResolveName } from '../compiler/checker-symbols.js';
import {
  getBaseTypeOfLiteralType,
  compareSymbols,
  getTypeArguments,
  isArrayType as checkerIsArrayType,
  isTupleType as checkerIsTupleType,
} from '../compiler/checker-type-factory.js';
import { getTypeFromTypeNode } from '../compiler/checker-type-nodes.js';
import { getFalseTypeFromConditionalType, getTrueTypeFromConditionalType } from '../compiler/checker-type-operators.js';
import {
  type ConditionalType,
  type IndexedAccessType,
  type InterfaceType,
  type IntrinsicType,
  type LiteralType,
  ObjectFlags,
  type Signature as CheckerSignature,
  SignatureKind as CheckerSignatureKind,
  type StringMappingType,
  type SubstitutionType,
  type TemplateLiteralType,
  type TupleType,
  type Type as CheckerType,
  TypeFlags,
  type TypeParameter,
  type TypeReference,
  type IndexType,
  type UnionOrIntersectionType,
} from '../compiler/checker-types.js';
import { decodeNodes } from '../compiler/decoder.js';
import { type Diagnostic as CompilerDiagnostic, Locale } from '../compiler/diagnostics.js';
import { encodeNode, encodeSourceFile as encodeFile, NodeIndexTable } from '../compiler/encoder.js';
import { CompilerHost } from '../compiler/file-loader.js';
import { CachedFileSystem, DirectoryEntries, FileSystem } from '../compiler/file-system.js';
import { signatureToSignatureDeclaration, typeToStringFromTypeNode, typeToTypeNode } from '../compiler/node-builder.js';
import {
  type CompilerOptions as CompilerOptionsValue,
  JsxEmit,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
} from '../compiler/options.js';
import { EmitContext } from '../compiler/printer/emit-context.js';
import { Printer, PrinterOptions } from '../compiler/printer/printer.js';
import { Program, sortAndDeduplicateDiagnostics } from '../compiler/program.js';
import { CheckedProgram } from '../compiler/program-checker.js';
import { getSymbolId, type Symbol as CompilerSymbol, type SymbolTable } from '../compiler/symbol.js';
import type { SyntaxKind } from '../compiler/syntax-kind.js';
import { ConfigParser, ParsedCommandLine } from '../compiler/tsconfig.js';
import { isTypeAssignableTo } from '../compiler/relations.js';
import { typeToString } from '../compiler/type-printer.js';
import { type CompletionList, getCompletionsAtPosition } from '../services/completions.js';
import {
  getReferencedSymbolsForNode,
  getReferencesToSymbolInFile,
  getSignatureUsages,
} from '../services/find-references.js';
import { getSymbolDocumentationComment, getSymbolJSDocTags, type JSDocTagInfo } from '../services/jsdoc.js';
import type { ClientFileSystem } from './fs.js';

export type { CompletionEntry, CompletionList } from '../services/completions.js';
export { NeedsAutoImports } from '../services/completions.js';

// Opaque references. Callers compare them by identity and pass them back.
export type Type = CheckerType;
export type Symbol = CompilerSymbol;
export type Signature = CheckerSignature;
export type Node = AstNode;
export type SourceFile = AstSourceFile;

// Where projects are loaded from.
export interface ProjectHost {
  fs: ClientFileSystem;
  currentDirectory: string;
  defaultLibraryPath: string;
  useCaseSensitiveFileNames: boolean;
}

// A literal type's value, as sent to API clients.
export type LiteralValue = string | number | boolean | BigIntLiteral | null;

// A bigint literal, sent as decimal text.
export interface BigIntLiteral {
  bigint: string;
}

export interface ReferencedSymbol {
  definition: Node;
  symbol: Symbol | undefined;
  references: Node[];
}

export interface SignatureUsage {
  name: Node;
  call: Node | undefined;
}

export interface SourceFileMetadata {
  isDefaultLibrary: boolean;
  isFromExternalLibrary: boolean;
  packageJsonType: string;
  packageJsonDirectory: string;
  impliedNodeFormat: number;
}

export interface Diagnostic {
  fileName: string | undefined;
  pos: number;
  end: number;
  code: number;
  category: number;
  text: string;
  reportsUnnecessary: boolean;
  reportsDeprecated: boolean;
  messageChain: Diagnostic[];
  relatedInformation: Diagnostic[];
}

export type DiagnosticKind =
  | 'config'
  | 'program'
  | 'global'
  | 'syntactic'
  | 'bind'
  | 'semantic'
  | 'suggestion'
  | 'declaration';

export interface IndexInfo {
  keyType: Type;
  valueType: Type;
  isReadonly: boolean;
  declaration: Node | undefined;
}

export interface TypePredicate {
  kind: number;
  parameterIndex: number;
  parameterName: string;
  type: Type | undefined;
}

export interface TupleInfo {
  elementFlags: number[];
  fixedLength: number;
  readonly: boolean;
}

// Compiler options in tsconfig.json form, in TypeScript-Go's field order.
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

export const enum SignatureKind {
  Call = 0,
  Construct = 1,
}

// A configured project: a tsconfig.json, its program and a type checker for
// queries. Diagnostics come from a separate checker, as in tsc --api.
export class Project {
  private readonly checked: CheckedProgram;
  private readonly checker: Checker;

  private constructor(
    private readonly config: ParsedCommandLine,
    host: ProjectHost,
  ) {
    const fs = new CachedFileSystem(new HostFileSystem(host));
    const program = new Program(config, new CompilerHost(fs, host.currentDirectory, host.defaultLibraryPath));
    this.checked = new CheckedProgram(program);
    this.checker = this.checked.createChecker();
  }

  static open(host: ProjectHost, configFileName: string): Project {
    const errors: CompilerDiagnostic[] = [];
    const fs = new HostFileSystem(host);
    const config =
      new ConfigParser(fs, host.currentDirectory).parseConfigFile(configFileName, undefined, undefined, errors) ??
      new ParsedCommandLine(
        {},
        undefined,
        [],
        [],
        undefined,
        errors,
        host.currentDirectory,
        host.useCaseSensitiveFileNames,
        0,
      );
    return new Project(config, host);
  }

  // The project of open files that no config file contains, with tsgo's
  // default inferred project options.
  static openInferred(host: ProjectHost, rootFileNames: string[]): Project {
    const options: CompilerOptionsValue = {
      allowJs: true,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      target: ScriptTarget.LatestStandard,
      jsx: JsxEmit.ReactJSX,
      allowImportingTsExtensions: true,
      strictNullChecks: true,
      strictFunctionTypes: true,
      sourceMap: true,
      allowNonTsExtensions: true,
      resolveJsonModule: true,
    };
    const config = new ParsedCommandLine(
      options,
      undefined,
      rootFileNames,
      [],
      undefined,
      [],
      host.currentDirectory,
      host.useCaseSensitiveFileNames,
      rootFileNames.length,
    );
    return new Project(config, host);
  }

  private get program(): Program {
    return this.checked.program;
  }

  rootFiles(): string[] {
    return this.config.fileNames.slice();
  }

  compilerOptions(): CompilerOptions {
    return compilerOptionsOf(this.config.options);
  }

  sourceFiles(): SourceFile[] {
    return this.program.getSourceFiles().slice();
  }

  sourceFile(fileName: string): SourceFile | undefined {
    return this.program.getSourceFile(fileName);
  }

  sourceFileByPath(path: string): SourceFile | undefined {
    return this.program.getSourceFileByPath(path);
  }

  sourceFileMetadata(file: SourceFile): SourceFileMetadata {
    const program = this.program;
    const metadata = program.sourceFileMetadata(file.path);
    return {
      isDefaultLibrary: program.isSourceFileDefaultLibrary(file.path),
      isFromExternalLibrary: program.isSourceFileFromExternalLibrary(file),
      packageJsonType: metadata.packageJsonType,
      packageJsonDirectory: metadata.packageJsonDirectory,
      impliedNodeFormat: metadata.impliedNodeFormat,
    };
  }

  diagnostics(kind: DiagnosticKind, file: SourceFile | undefined): Diagnostic[] {
    return this.compilerDiagnostics(kind, file).map(diagnosticOf);
  }

  private compilerDiagnostics(kind: DiagnosticKind, file: SourceFile | undefined): readonly CompilerDiagnostic[] {
    const checked = this.checked;
    const program = this.program;
    switch (kind) {
      case 'config':
        return program.getConfigFileParsingDiagnostics();
      case 'program':
        return program.getProgramDiagnostics();
      case 'global': {
        checked.getSemanticDiagnostics(undefined);
        const all = [
          ...program.getConfigFileParsingDiagnostics(),
          ...program.getProgramDiagnostics(),
          ...checked.getGlobalDiagnostics(),
        ];
        return sortAndDeduplicateDiagnostics(all).filter((d) => d.file === undefined);
      }
      case 'syntactic':
        return program.getSyntacticDiagnostics(file);
      case 'bind':
        return checked.getBindDiagnostics(file);
      case 'semantic':
        return checked.getSemanticDiagnostics(file);
      case 'suggestion':
        return checked.getSuggestionDiagnostics(file);
      case 'declaration':
        return [];
    }
  }

  /** Completions at a UTF-16 position; throws `NeedsAutoImports` where tsgo needs its auto-import registry. */
  completionsAtPosition(
    file: SourceFile,
    position: number,
    triggerCharacter: string | undefined,
    includeSymbols: boolean,
  ): CompletionList | undefined {
    return getCompletionsAtPosition(this.checker, this.program, file, position, triggerCharacter, includeSymbols);
  }

  // The node at a UTF-16 position: the touching property name or token.
  nodeAtPosition(file: SourceFile, position: number): Node | undefined {
    return getTouchingPropertyName(file, position);
  }

  symbolAtLocation(node: Node): Symbol | undefined {
    return getSymbolAtLocation(this.checker, node);
  }

  typeOfSymbol(symbol: Symbol): Type | undefined {
    return getTypeOfSymbol(this.checker, symbol);
  }

  declaredTypeOfSymbol(symbol: Symbol): Type | undefined {
    return getDeclaredTypeOfSymbol(this.checker, symbol);
  }

  resolveName(name: string, location: Node | undefined, meaning: number, excludeGlobals: boolean): Symbol | undefined {
    return checkerResolveName(this.checker, location, name, meaning, undefined, false, excludeGlobals);
  }

  signaturesOfType(type: Type, kind: SignatureKind): Signature[] {
    return getSignaturesOfType(
      this.checker,
      type,
      kind === SignatureKind.Call ? CheckerSignatureKind.Call : CheckerSignatureKind.Construct,
    ).slice();
  }

  resolvedSignature(node: Node): Signature | undefined {
    return queryResolvedSignature(this.checker, node);
  }

  typeAtLocation(node: Node): Type | undefined {
    return getTypeAtLocation(this.checker, node);
  }

  contextualType(node: Node): Type | undefined {
    return queryContextualType(this.checker, node);
  }

  baseTypeOfLiteralType(type: Type): Type | undefined {
    return getBaseTypeOfLiteralType(this.checker, type);
  }

  nonNullableType(type: Type): Type | undefined {
    return getNonNullableType(this.checker, type);
  }

  typeFromTypeNode(node: Node): Type | undefined {
    return getTypeFromTypeNode(this.checker, node);
  }

  widenedType(type: Type): Type | undefined {
    return getWidenedType(this.checker, type);
  }

  typeAtPosition(signature: Signature, index: number): Type | undefined {
    return getTypeAtPosition(this.checker, signature, index);
  }

  isArrayLikeType(type: Type): boolean {
    return isArrayLikeType(this.checker, type);
  }

  isTypeAssignableTo(source: Type, target: Type): boolean {
    return isTypeAssignableTo(this.checker, source, target);
  }

  shorthandAssignmentValueSymbol(node: Node): Symbol | undefined {
    return getShorthandAssignmentValueSymbol(this.checker, node);
  }

  typeOfSymbolAtLocation(symbol: Symbol, node: Node): Type | undefined {
    return getTypeOfSymbolAtLocation(this.checker, symbol, node);
  }

  // Encodes the type node TypeScript would write for type.
  typeToTypeNode(type: Type, enclosing: Node | undefined, flags: number): Uint8Array | undefined {
    const node = typeToTypeNode(this.checker, type, enclosing, flags);
    return node === undefined ? undefined : encodeNode(node);
  }

  signatureToSignatureDeclaration(
    signature: Signature,
    kind: number,
    enclosing: Node | undefined,
    flags: number,
  ): Uint8Array | undefined {
    const node = signatureToSignatureDeclaration(this.checker, signature, kind as SyntaxKind, enclosing, flags);
    return node === undefined ? undefined : encodeNode(node);
  }

  typeToString(type: Type, enclosing: Node | undefined, flags: number): string {
    return (
      typeToStringFromTypeNode(this.checker, type, enclosing, flags) ??
      typeToString(this.checker, type, enclosing, flags)
    );
  }

  isContextSensitive(node: Node): boolean {
    return isContextSensitive(this.checker, node);
  }

  returnTypeOfSignature(signature: Signature): Type | undefined {
    return getReturnTypeOfSignature(this.checker, signature);
  }

  restTypeOfSignature(signature: Signature): Type | undefined {
    return getRestTypeOfSignature(this.checker, signature);
  }

  typePredicateOfSignature(signature: Signature): TypePredicate | undefined {
    const predicate = getTypePredicateOfSignature(this.checker, signature);
    if (predicate === undefined) return undefined;
    return {
      kind: predicate.kind,
      parameterIndex: predicate.parameterIndex,
      parameterName: predicate.parameterName,
      type: predicate.type,
    };
  }

  isArrayType(type: Type): boolean {
    return checkerIsArrayType(this.checker, type);
  }

  baseTypes(type: Type): Type[] {
    return getBaseTypes(this.checker, type).slice();
  }

  propertiesOfType(type: Type): Symbol[] {
    return getPropertiesOfType(this.checker, type).slice();
  }

  apparentType(type: Type): Type | undefined {
    return getApparentType(this.checker, type);
  }

  indexInfosOfType(type: Type): IndexInfo[] {
    return getIndexInfosOfType(this.checker, type).map((info) => ({
      keyType: info.keyType,
      valueType: info.valueType,
      isReadonly: info.isReadonly,
      declaration: info.declaration,
    }));
  }

  constraintOfTypeParameter(type: Type): Type | undefined {
    return getConstraintOfTypeParameter(this.checker, type);
  }

  baseConstraintOfType(type: Type): Type | undefined {
    return getBaseConstraintOfType(this.checker, type);
  }

  propertyOfType(type: Type, name: string): Symbol | undefined {
    return getPropertyOfType(this.checker, type, name);
  }

  constantValue(node: Node): LiteralValue {
    const value = getConstantValue(this.checker, node);
    return value === undefined ? null : value;
  }

  signatureFromDeclaration(node: Node): Signature | undefined {
    return querySignatureFromDeclaration(this.checker, node);
  }

  exportSpecifierLocalTargetSymbol(node: Node): Symbol | undefined {
    return getExportSpecifierLocalTargetSymbol(this.checker, node);
  }

  aliasedSymbol(symbol: Symbol): Symbol | undefined {
    return resolveAlias(this.checker, symbol);
  }

  immediateAliasedSymbol(symbol: Symbol): Symbol | undefined {
    return getImmediateAliasedSymbol(this.checker, symbol);
  }

  exportsOfModule(symbol: Symbol): Symbol[] {
    return this.sortSymbols(getExportsOfModuleAsArray(this.checker, symbol));
  }

  memberInModuleExports(symbol: Symbol, name: string): Symbol | undefined {
    return tryGetMemberInModuleExports(this.checker, name, symbol);
  }

  typeArguments(type: Type): Type[] {
    return getTypeArguments(this.checker, type).slice();
  }

  trueTypeOfConditionalType(type: Type): Type | undefined {
    return getTrueTypeFromConditionalType(this.checker, type as ConditionalType);
  }

  falseTypeOfConditionalType(type: Type): Type | undefined {
    return getFalseTypeFromConditionalType(this.checker, type as ConditionalType);
  }

  intrinsicType(name: IntrinsicTypeName): Type | undefined {
    const c = this.checker;
    switch (name) {
      case 'any':
        return c.anyType;
      case 'string':
        return c.stringType;
      case 'number':
        return c.numberType;
      case 'boolean':
        return c.booleanType;
      case 'void':
        return c.voidType;
      case 'undefined':
        return c.undefinedType;
      case 'null':
        return c.nullType;
      case 'never':
        return c.neverType;
      case 'unknown':
        return c.unknownType;
      case 'bigint':
        return c.bigintType;
      case 'symbol':
        return c.esSymbolType;
    }
  }

  jsDocTags(symbol: Symbol): JSDocTagInfo[] {
    return getSymbolJSDocTags(symbol);
  }

  documentationComment(symbol: Symbol): string {
    return getSymbolDocumentationComment(this.checker, symbol);
  }

  referencesToSymbolInFile(file: SourceFile, symbol: Symbol): Node[] {
    return getReferencesToSymbolInFile(this.checker, file, symbol);
  }

  referencedSymbolsForNode(node: Node, position: number): ReferencedSymbol[] {
    const result: ReferencedSymbol[] = [];
    for (const entry of getReferencedSymbolsForNode(
      this.checker,
      this.program,
      position,
      node,
      this.program.getSourceFiles(),
    )) {
      const definition = entry.definitionNode();
      if (definition === undefined) continue;
      const references: Node[] = [];
      for (const ref of entry.references) if (ref.node !== undefined) references.push(ref.node);
      result.push({ definition, symbol: entry.definition.symbol, references });
    }
    return result;
  }

  signatureUsages(declaration: Node): SignatureUsage[] {
    return getSignatureUsages(this.checker, this.program, declaration);
  }

  unknownSymbol(): Symbol {
    return this.checker.unknownSymbol;
  }

  undefinedSymbol(): Symbol {
    return this.checker.undefinedSymbol;
  }

  argumentsSymbol(): Symbol {
    return this.checker.argumentsSymbol;
  }

  // Sorts symbols in the checker's declaration order.
  sortSymbols(symbols: Symbol[]): Symbol[] {
    const c = this.checker;
    return symbols.sort((a, b) => compareSymbols(c, a, b));
  }
}

export interface ParsedConfig {
  fileNames: string[];
  options: CompilerOptions;
}

// Parses a config file without loading its program; undefined if it can't
// be read.
export function parseConfigFile(host: ProjectHost, configFileName: string): ParsedConfig | undefined {
  const config = new ConfigParser(new HostFileSystem(host), host.currentDirectory).parseConfigFile(
    configFileName,
    undefined,
    undefined,
    [],
  );
  if (config === undefined) return undefined;
  return { fileNames: config.fileNames.slice(), options: compilerOptionsOf(config.options) };
}

// The client's file system, as the compiler reads it.
class HostFileSystem extends FileSystem {
  private readonly fs: ClientFileSystem;

  constructor(host: ProjectHost) {
    super(host.useCaseSensitiveFileNames);
    this.fs = host.fs;
  }

  fileExists(path: string): boolean {
    return this.fs.fileExists(path);
  }

  directoryExists(path: string): boolean {
    return this.fs.directoryExists(path);
  }

  readFile(path: string): string | undefined {
    return this.fs.readFile(path);
  }

  getAccessibleEntries(path: string): DirectoryEntries {
    const entries = this.fs.getAccessibleEntries(path);
    return new DirectoryEntries(entries.files, entries.directories, undefined);
  }

  realpath(path: string): string {
    return this.fs.realpath(path);
  }
}

export type IntrinsicTypeName =
  | 'any'
  | 'string'
  | 'number'
  | 'boolean'
  | 'void'
  | 'undefined'
  | 'null'
  | 'never'
  | 'unknown'
  | 'bigint'
  | 'symbol';

// Source files.

export function fileName(file: SourceFile): string {
  return file.fileName;
}

export function filePath(file: SourceFile): string {
  return file.path;
}

// Whether two versions of a file have the same contents.
export function sameFileContent(a: SourceFile, b: SourceFile): boolean {
  return a === b || a.text === b.text;
}

// Encodes a source file in the API's binary AST format.
export function encodeSourceFile(file: SourceFile): Uint8Array {
  return encodeFile(file);
}

// Decodes a node from the API's binary AST format; throws on malformed data.
export function decodeNode(data: Uint8Array): Node {
  return decodeNodes(data);
}

// Prints a decoded node.
export function printNode(
  node: Node,
  preserveSourceNewlines: boolean,
  neverAsciiEscape: boolean,
  terminateUnterminatedLiterals: boolean,
): string {
  const options = new PrinterOptions();
  options.preserveSourceNewlines = preserveSourceNewlines;
  options.neverAsciiEscape = neverAsciiEscape;
  options.terminateUnterminatedLiterals = terminateUnterminatedLiterals;
  return new Printer(options, new EmitContext()).emit(node, undefined);
}

// Nodes.

export function nodeKind(node: Node): number {
  return node.kind;
}

export function sourceFileOfNode(node: Node): SourceFile {
  return getSourceFileOfNode(node);
}

const nodeIndexTables = new Map<SourceFile, NodeIndexTable>();

function nodeIndexTable(file: SourceFile): NodeIndexTable {
  let table = nodeIndexTables.get(file);
  if (table === undefined) {
    table = new NodeIndexTable(file);
    nodeIndexTables.set(file, table);
  }
  return table;
}

// The node's position in its file's node index table; node handles use it.
export function nodeIndex(node: Node): number {
  return nodeIndexTable(getSourceFileOfNode(node)).indexOf(node);
}

export function nodeAtIndex(file: SourceFile, index: number): Node | undefined {
  const nodes = nodeIndexTable(file).nodes;
  return index < nodes.length ? nodes[index] : undefined;
}

// Symbols.

export function symbolId(symbol: Symbol): number {
  return getSymbolId(symbol);
}

export function symbolName(symbol: Symbol): string {
  return escapeSymbolName(symbol.name);
}

// Internal names start with U+FFFE; the API writes them with `__`, and doubles
// the leading underscore of names that already start with `__`.
function escapeSymbolName(name: string): string {
  if (name.charCodeAt(0) === 0xfffe) return '__' + name.slice(1);
  if (name.startsWith('__')) return '_' + name;
  return name;
}

export function symbolFlags(symbol: Symbol): number {
  return symbol.flags >>> 0;
}

export function symbolCheckFlags(symbol: Symbol): number {
  return symbol.checkFlags >>> 0;
}

export function symbolDeclarations(symbol: Symbol): Node[] {
  return symbol.declarations.slice();
}

export function symbolValueDeclaration(symbol: Symbol): Node | undefined {
  return symbol.valueDeclaration;
}

export function symbolParent(symbol: Symbol): Symbol | undefined {
  return symbol.parent;
}

export function symbolExportSymbol(symbol: Symbol): Symbol | undefined {
  return symbol.exportSymbol;
}

export function symbolMembers(symbol: Symbol): Symbol[] {
  return tableSymbols(symbol.members);
}

export function symbolExports(symbol: Symbol): Symbol[] {
  return tableSymbols(symbol.exports);
}

function tableSymbols(table: SymbolTable | undefined): Symbol[] {
  return table === undefined ? [] : Array.from(table.values());
}

// Types.

export function typeId(type: Type): number {
  return type.id;
}

export function typeFlags(type: Type): number {
  return type.flags >>> 0;
}

export function objectFlags(type: Type): number {
  return type.objectFlags >>> 0;
}

export function typeSymbol(type: Type): Symbol | undefined {
  return type.symbol;
}

export function aliasSymbol(type: Type): Symbol | undefined {
  return type.alias?.symbol;
}

export function aliasTypeArguments(type: Type): Type[] {
  const alias = type.alias;
  return alias === undefined ? [] : alias.typeArguments.slice();
}

export function literalTypeValue(type: Type): LiteralValue {
  const literal = type as LiteralType;
  const flags = type.flags;
  if ((flags & TypeFlags.StringLiteral) !== 0) return literal.stringValue;
  if ((flags & TypeFlags.NumberLiteral) !== 0) return literal.numberValue;
  if ((flags & TypeFlags.BigIntLiteral) !== 0) return { bigint: literal.stringValue };
  if ((flags & TypeFlags.BooleanLiteral) !== 0) return literal.stringValue === 'true';
  return null;
}

export function freshType(type: Type): Type | undefined {
  return (type as LiteralType).freshType;
}

export function regularType(type: Type): Type | undefined {
  return (type as LiteralType).regularType;
}

// The target of a type reference, index type or string mapping type.
export function typeTarget(type: Type): Type | undefined {
  const flags = type.flags;
  if ((flags & TypeFlags.Index) !== 0) return (type as IndexType).target;
  if ((flags & TypeFlags.StringMapping) !== 0) return (type as StringMappingType).target;
  if ((flags & TypeFlags.Object) !== 0 && (type.objectFlags & ObjectFlags.Reference) !== 0) {
    return (type as TypeReference).target;
  }
  return undefined;
}

export function referenceTarget(type: Type): Type | undefined {
  return (type as TypeReference).target;
}

export function tupleInfo(type: Type): TupleInfo {
  const tuple = type as TupleType;
  return {
    elementFlags: tuple.elementInfos.map((info) => info.flags),
    fixedLength: tuple.fixedLength,
    readonly: tuple.readonly,
  };
}

export function typeParameters(type: Type): Type[] {
  return (type as InterfaceType).typeParameters();
}

export function outerTypeParameters(type: Type): Type[] {
  return (type as InterfaceType).outerTypeParameters();
}

export function localTypeParameters(type: Type): Type[] {
  return (type as InterfaceType).localTypeParameters();
}

// The members of a union, intersection or template literal type.
export function typesOfType(type: Type): Type[] {
  if ((type.flags & TypeFlags.TemplateLiteral) !== 0) return (type as TemplateLiteralType).types.slice();
  return (type as UnionOrIntersectionType).types.slice();
}

export function indexedAccessObjectType(type: Type): Type | undefined {
  return (type as IndexedAccessType).objectType;
}

export function indexedAccessIndexType(type: Type): Type | undefined {
  return (type as IndexedAccessType).indexType;
}

export function conditionalCheckType(type: Type): Type | undefined {
  return (type as ConditionalType).checkType;
}

export function conditionalExtendsType(type: Type): Type | undefined {
  return (type as ConditionalType).extendsType;
}

export function substitutionBaseType(type: Type): Type | undefined {
  return (type as SubstitutionType).baseType;
}

export function substitutionConstraint(type: Type): Type | undefined {
  return (type as SubstitutionType).constraint;
}

export function templateLiteralTexts(type: Type): string[] {
  return (type as TemplateLiteralType).texts.slice();
}

export function isThisType(type: Type): boolean {
  return (type as TypeParameter).isThisType;
}

export function intrinsicName(type: Type): string {
  return (type as IntrinsicType).intrinsicName;
}

export function isTupleType(type: Type): boolean {
  return checkerIsTupleType(type);
}

// Signatures.

export function signatureId(signature: Signature): number {
  return signature.id;
}

export function signatureFlags(signature: Signature): number {
  return signature.flags >>> 0;
}

export function signatureDeclaration(signature: Signature): Node | undefined {
  return signature.declaration;
}

export function signatureTypeParameters(signature: Signature): Type[] {
  return signature.typeParameters.slice();
}

export function signatureParameters(signature: Signature): Symbol[] {
  return signature.parameters.slice();
}

export function signatureThisParameter(signature: Signature): Symbol | undefined {
  return signature.thisParameter;
}

export function signatureTarget(signature: Signature): Signature | undefined {
  return signature.target;
}

// Conversions.

function diagnosticOf(d: CompilerDiagnostic): Diagnostic {
  return {
    fileName: d.file?.fileName,
    pos: d.pos,
    end: d.end,
    code: d.code,
    category: d.category,
    text: d.localize(Locale.Default),
    reportsUnnecessary: d.reportsUnnecessary,
    reportsDeprecated: d.reportsDeprecated,
    messageChain: d.messageChain.map(diagnosticOf),
    relatedInformation: d.relatedInformation.map(diagnosticOf),
  };
}

function compilerOptionsOf(o: CompilerOptionsValue): CompilerOptions {
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

// Describes an exception thrown by the compiler, like a Go panic message.
export function panicMessage(e: unknown): string {
  return 'panic: ' + (e instanceof Error ? e.message : String(e));
}
