// The compiler behind the API server. This is the only module that touches
// the translated TypeScript-Go sources; everything it exports is plain data
// or an opaque reference that callers pass back in.
import * as api_encoder from '../../../tsgo/src/tsgo/api_encoder.js';
import * as ast from '../../../tsgo/src/tsgo/ast.js';
import * as astnav from '../../../tsgo/src/tsgo/astnav.js';
import * as checker from '../../../tsgo/src/tsgo/checker.js';
import * as checkhost from '../../../tsgo/src/tsgo/checkhost.js';
import * as classes from '../../../tsgo/src/tsgo/classes.js';
import * as core from '../../../tsgo/src/tsgo/core.js';
import * as locale from '../../../tsgo/src/tsgo/locale.js';
import * as printer from '../../../tsgo/src/tsgo/printer.js';
import type * as tsoptions from '../../../tsgo/src/tsgo/tsoptions.js';
import { fromBytes, initDone, keepClasses, toPanic } from '../../../tsgo/src/go/base.js';
import { initHost } from '../../../tsgo/src/drivers/host.js';
import type { ClientFileSystem } from './fs.js';

// Lets scriptc lower every class before use; never runs.
if (keepClasses()) classes.keepAll();
initDone();

// Opaque references. Callers compare them by identity and pass them back.
export type Type = checker.Type;
export type Symbol = ast.Symbol_;
export type Signature = checker.Signature;
export type Node = ast.Node;
export type SourceFile = ast.SourceFile;

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
  private constructor(private readonly project: checkhost.APIProject) {}

  static open(host: ProjectHost, configFileName: string): Project {
    return new Project(checkhost.OpenAPIProject(apiHost(host), goString(configFileName))!);
  }

  // The project of open files that no config file contains.
  static openInferred(host: ProjectHost, rootFileNames: string[]): Project {
    return new Project(checkhost.OpenInferredAPIProject(apiHost(host), rootFileNames.map(goString))!);
  }

  private get checker(): checker.Checker {
    return this.project.Checker_!;
  }

  rootFiles(): string[] {
    return this.project.Config!.FileNames().map(hostString);
  }

  compilerOptions(): CompilerOptions {
    return compilerOptionsOf(this.project.Config!);
  }

  sourceFiles(): SourceFile[] {
    return defined(this.project.Program_!.GetSourceFiles());
  }

  sourceFile(fileName: string): SourceFile | undefined {
    return this.project.Program_!.GetSourceFile(goString(fileName));
  }

  sourceFileByPath(path: string): SourceFile | undefined {
    return this.project.Program_!.GetSourceFileByPath(goString(path));
  }

  sourceFileMetadata(file: SourceFile): SourceFileMetadata {
    const program = this.project.Program_!;
    const path = file.Path$m();
    const metadata = program.GetSourceFileMetaData(path);
    return {
      isDefaultLibrary: program.IsSourceFileDefaultLibrary(path),
      isFromExternalLibrary: program.IsSourceFileFromExternalLibrary(file),
      packageJsonType: hostString(metadata.PackageJsonType),
      packageJsonDirectory: hostString(metadata.PackageJsonDirectory),
      impliedNodeFormat: metadata.ImpliedNodeFormat,
    };
  }

  diagnostics(kind: DiagnosticKind, file: SourceFile | undefined): Diagnostic[] {
    return defined(this.project.Diagnostics(goString(kind), file)).map(diagnosticOf);
  }

  // The node at a UTF-16 position: the touching property name or token.
  nodeAtPosition(file: SourceFile, position: number): Node | undefined {
    return astnav.GetTouchingPropertyName(file, file.GetPositionMap()!.UTF16ToUTF8(position));
  }

  symbolAtLocation(node: Node): Symbol | undefined {
    return this.checker.GetSymbolAtLocation(node);
  }

  typeOfSymbol(symbol: Symbol): Type | undefined {
    return this.checker.GetTypeOfSymbol(symbol);
  }

  declaredTypeOfSymbol(symbol: Symbol): Type | undefined {
    return this.checker.GetDeclaredTypeOfSymbol(symbol);
  }

  resolveName(name: string, location: Node | undefined, meaning: number, excludeGlobals: boolean): Symbol | undefined {
    return this.checker.ResolveName(goString(name), location, meaning, excludeGlobals);
  }

  signaturesOfType(type: Type, kind: SignatureKind): Signature[] {
    return defined(this.checker.GetSignaturesOfType(type, kind));
  }

  resolvedSignature(node: Node): Signature | undefined {
    return this.checker.GetResolvedSignature(node);
  }

  typeAtLocation(node: Node): Type | undefined {
    return this.checker.GetTypeAtLocation(node);
  }

  contextualType(node: Node): Type | undefined {
    return this.checker.GetContextualType(node, 0);
  }

  baseTypeOfLiteralType(type: Type): Type | undefined {
    return this.checker.GetBaseTypeOfLiteralType(type);
  }

  nonNullableType(type: Type): Type | undefined {
    return this.checker.GetNonNullableType(type);
  }

  typeFromTypeNode(node: Node): Type | undefined {
    return this.checker.GetTypeFromTypeNode(node);
  }

  widenedType(type: Type): Type | undefined {
    return this.checker.GetWidenedType(type);
  }

  typeAtPosition(signature: Signature, index: number): Type | undefined {
    return this.checker.GetTypeAtPosition(signature, index);
  }

  isArrayLikeType(type: Type): boolean {
    return this.checker.IsArrayLikeType(type);
  }

  isTypeAssignableTo(source: Type, target: Type): boolean {
    return this.checker.IsTypeAssignableTo(source, target);
  }

  shorthandAssignmentValueSymbol(node: Node): Symbol | undefined {
    return this.checker.GetShorthandAssignmentValueSymbol(node);
  }

  typeOfSymbolAtLocation(symbol: Symbol, node: Node): Type | undefined {
    return this.checker.GetTypeOfSymbolAtLocation(symbol, node);
  }

  // Encodes the type node TypeScript would write for type.
  typeToTypeNode(type: Type, enclosing: Node | undefined, flags: number): Uint8Array | undefined {
    const node = this.checker.TypeToTypeNode(type, enclosing, flags, undefined);
    return node === undefined ? undefined : encodeNode(node);
  }

  signatureToSignatureDeclaration(
    signature: Signature,
    kind: number,
    enclosing: Node | undefined,
    flags: number,
  ): Uint8Array | undefined {
    const node = this.checker.SignatureToSignatureDeclaration(signature, kind, enclosing, flags);
    return node === undefined ? undefined : encodeNode(node);
  }

  typeToString(type: Type, enclosing: Node | undefined, flags: number): string {
    return hostString(this.checker.TypeToStringEx(type, enclosing, flags, undefined));
  }

  isContextSensitive(node: Node): boolean {
    return this.checker.IsContextSensitive(node);
  }

  returnTypeOfSignature(signature: Signature): Type | undefined {
    return this.checker.GetReturnTypeOfSignature(signature);
  }

  restTypeOfSignature(signature: Signature): Type | undefined {
    return this.checker.GetRestTypeOfSignature(signature);
  }

  typePredicateOfSignature(signature: Signature): TypePredicate | undefined {
    const predicate = this.checker.GetTypePredicateOfSignature(signature);
    if (predicate === undefined) return undefined;
    return {
      kind: predicate.Kind(),
      parameterIndex: predicate.ParameterIndex(),
      parameterName: hostString(predicate.ParameterName()),
      type: predicate.Type$m(),
    };
  }

  isArrayType(type: Type): boolean {
    return this.checker.IsArrayType(type);
  }

  baseTypes(type: Type): Type[] {
    return defined(this.checker.GetBaseTypes(type));
  }

  propertiesOfType(type: Type): Symbol[] {
    return defined(this.checker.GetPropertiesOfType(type));
  }

  apparentType(type: Type): Type | undefined {
    return this.checker.GetApparentType(type);
  }

  indexInfosOfType(type: Type): IndexInfo[] {
    const infos: IndexInfo[] = [];
    for (const info of this.checker.GetIndexInfosOfType(type)) {
      if (info === undefined) continue;
      infos.push({
        keyType: info.KeyType()!,
        valueType: info.ValueType()!,
        isReadonly: info.IsReadonly(),
        declaration: info.Declaration(),
      });
    }
    return infos;
  }

  constraintOfTypeParameter(type: Type): Type | undefined {
    return this.checker.GetConstraintOfTypeParameter(type);
  }

  baseConstraintOfType(type: Type): Type | undefined {
    return this.checker.GetBaseConstraintOfType(type);
  }

  propertyOfType(type: Type, name: string): Symbol | undefined {
    return this.checker.GetPropertyOfType(type, goString(name));
  }

  constantValue(node: Node): LiteralValue {
    return literalValue(checkhost.ConstantValue(this.checker, node));
  }

  signatureFromDeclaration(node: Node): Signature | undefined {
    return this.checker.GetSignatureFromDeclaration(node);
  }

  exportSpecifierLocalTargetSymbol(node: Node): Symbol | undefined {
    return this.checker.GetExportSpecifierLocalTargetSymbol(node);
  }

  aliasedSymbol(symbol: Symbol): Symbol | undefined {
    return this.checker.GetAliasedSymbol(symbol);
  }

  immediateAliasedSymbol(symbol: Symbol): Symbol | undefined {
    return this.checker.GetImmediateAliasedSymbol(symbol);
  }

  exportsOfModule(symbol: Symbol): Symbol[] {
    return this.sortSymbols(defined(this.checker.GetExportsOfModule(symbol)));
  }

  memberInModuleExports(symbol: Symbol, name: string): Symbol | undefined {
    return this.checker.TryGetMemberInModuleExports(goString(name), symbol);
  }

  typeArguments(type: Type): Type[] {
    return defined(this.checker.GetTypeArguments(type));
  }

  trueTypeOfConditionalType(type: Type): Type | undefined {
    return this.checker.GetTrueTypeOfConditionalType(type);
  }

  falseTypeOfConditionalType(type: Type): Type | undefined {
    return this.checker.GetFalseTypeOfConditionalType(type);
  }

  intrinsicType(name: IntrinsicTypeName): Type | undefined {
    const c = this.checker;
    switch (name) {
      case 'any':
        return c.GetAnyType();
      case 'string':
        return c.GetStringType();
      case 'number':
        return c.GetNumberType();
      case 'boolean':
        return c.GetBooleanType();
      case 'void':
        return c.GetVoidType();
      case 'undefined':
        return c.GetUndefinedType();
      case 'null':
        return c.GetNullType();
      case 'never':
        return c.GetNeverType();
      case 'unknown':
        return c.GetUnknownType();
      case 'bigint':
        return c.GetBigIntType();
      case 'symbol':
        return c.GetESSymbolType();
    }
  }

  unknownSymbol(): Symbol {
    return this.checker.GetUnknownSymbol()!;
  }

  undefinedSymbol(): Symbol {
    return this.checker.GetUndefinedSymbol()!;
  }

  argumentsSymbol(): Symbol {
    return this.checker.GetArgumentsSymbol()!;
  }

  // Sorts symbols in the checker's declaration order.
  sortSymbols(symbols: Symbol[]): Symbol[] {
    const c = this.checker;
    return symbols.sort((a, b) => c.CompareSymbols(a, b));
  }
}

export interface ParsedConfig {
  fileNames: string[];
  options: CompilerOptions;
}

// Parses a config file without loading its program; undefined if it can't
// be read.
export function parseConfigFile(host: ProjectHost, configFileName: string): ParsedConfig | undefined {
  const config = checkhost.ParseAPIConfigFile(apiHost(host), goString(configFileName));
  if (config === undefined) return undefined;
  return { fileNames: config.FileNames().map(hostString), options: compilerOptionsOf(config) };
}

function apiHost(host: ProjectHost): checkhost.APIHost {
  const h = new checkhost.APIHost();
  h.Cwd = goString(host.currentDirectory);
  h.LibPath = goString(host.defaultLibraryPath);
  h.UseCaseSensitive = host.useCaseSensitiveFileNames;
  const fs = host.fs;
  h.ReadFile = (path: string): [string, boolean] => {
    const text = fs.readFile(hostString(path));
    return text === undefined ? ['', false] : [goString(text), true];
  };
  h.FileExists = (path: string): boolean => fs.fileExists(hostString(path));
  h.DirectoryExists = (path: string): boolean => fs.directoryExists(hostString(path));
  h.GetAccessibleEntries = (path: string): [string[], string[]] => {
    const entries = fs.getAccessibleEntries(hostString(path));
    return [entries.files.map(goString), entries.directories.map(goString)];
  };
  h.Realpath = (path: string): string => goString(fs.realpath(hostString(path)));
  h.Stat = (path: string): [number, number, number] => {
    const stat = fs.stat(hostString(path));
    if (stat === undefined) return [0, 0, 0];
    return [stat.isDirectory ? 2 : 1, stat.size, stat.mtimeMs];
  };
  return h;
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
  return hostString(file.FileName());
}

export function filePath(file: SourceFile): string {
  return hostString(file.Path$m());
}

// Whether two versions of a file have the same contents.
export function sameFileContent(a: SourceFile, b: SourceFile): boolean {
  return a === b || a.Text() === b.Text();
}

// Encodes a source file in the API's binary AST format.
export function encodeSourceFile(file: SourceFile): Uint8Array {
  const [data, , err] = api_encoder.EncodeSourceFile(file);
  if (err !== undefined) throw new Error('failed to encode source file');
  return Uint8Array.from(data);
}

function encodeNode(node: Node): Uint8Array {
  const [data, , err] = api_encoder.EncodeNode(node, undefined);
  if (err !== undefined) throw new Error('failed to encode node');
  return Uint8Array.from(data);
}

// Prints nodes decoded from the API's binary AST format.
export function printNode(
  data: Uint8Array,
  preserveSourceNewlines: boolean,
  neverAsciiEscape: boolean,
  terminateUnterminatedLiterals: boolean,
): string {
  const [node, err] = api_encoder.DecodeNodes(Array.from(data));
  if (err !== undefined || node === undefined) throw new Error('failed to decode AST');
  const options = new printer.PrinterOptions();
  options.PreserveSourceNewlines = preserveSourceNewlines;
  options.NeverAsciiEscape = neverAsciiEscape;
  options.TerminateUnterminatedLiterals = terminateUnterminatedLiterals;
  const p = printer.NewPrinter(options, new printer.PrintHandlers(), undefined);
  return hostString(p!.Emit(node, undefined));
}

// Nodes.

export function nodeKind(node: Node): number {
  return node.Kind_;
}

export function sourceFileOfNode(node: Node): SourceFile {
  return ast.GetSourceFileOfNode(node)!;
}

// The node's position in its file's node index table; node handles use it.
export function nodeIndex(node: Node): number {
  return api_encoder.GetNodeIndexTable(ast.GetSourceFileOfNode(node))!.GetIndex(node);
}

export function nodeAtIndex(file: SourceFile, index: number): Node | undefined {
  const table = api_encoder.GetNodeIndexTable(file);
  if (table === undefined || index >= table.Nodes.length) return undefined;
  return table.Nodes[index];
}

// Symbols.

export function symbolId(symbol: Symbol): number {
  return ast.GetSymbolId(symbol);
}

export function symbolName(symbol: Symbol): string {
  return hostString(ast.EscapeSymbolName(symbol.Name));
}

export function symbolFlags(symbol: Symbol): number {
  return symbol.Flags >>> 0;
}

export function symbolCheckFlags(symbol: Symbol): number {
  return symbol.CheckFlags_ >>> 0;
}

export function symbolDeclarations(symbol: Symbol): Node[] {
  return defined(symbol.Declarations);
}

export function symbolValueDeclaration(symbol: Symbol): Node | undefined {
  return symbol.ValueDeclaration;
}

export function symbolParent(symbol: Symbol): Symbol | undefined {
  return symbol.Parent;
}

export function symbolExportSymbol(symbol: Symbol): Symbol | undefined {
  return symbol.ExportSymbol;
}

export function symbolMembers(symbol: Symbol): Symbol[] {
  return tableSymbols(symbol.Members);
}

export function symbolExports(symbol: Symbol): Symbol[] {
  return tableSymbols(symbol.Exports);
}

function tableSymbols(table: ast.SymbolTable): Symbol[] {
  const symbols: Symbol[] = [];
  if (table === undefined) return symbols;
  for (const symbol of table.values()) if (symbol !== undefined) symbols.push(symbol);
  return symbols;
}

// Types.

export function typeId(type: Type): number {
  return type.Id();
}

export function typeFlags(type: Type): number {
  return type.Flags() >>> 0;
}

export function objectFlags(type: Type): number {
  return type.ObjectFlags$m() >>> 0;
}

export function typeSymbol(type: Type): Symbol | undefined {
  return type.Symbol$m();
}

export function aliasSymbol(type: Type): Symbol | undefined {
  return type.Alias()?.Symbol$m();
}

export function aliasTypeArguments(type: Type): Type[] {
  const alias = type.Alias();
  return alias === undefined ? [] : defined(alias.TypeArguments());
}

export function literalTypeValue(type: Type): LiteralValue {
  return literalValue(checkhost.LiteralTypeValue(type));
}

export function freshType(type: Type): Type | undefined {
  return type.AsLiteralType()!.FreshType();
}

export function regularType(type: Type): Type | undefined {
  return type.AsLiteralType()!.RegularType();
}

// The target of a type reference, index type or string mapping type.
export function typeTarget(type: Type): Type | undefined {
  return type.Target();
}

export function referenceTarget(type: Type): Type | undefined {
  return type.AsTypeReference()!.Target();
}

export function tupleInfo(type: Type): TupleInfo {
  const tuple = type.AsTupleType()!;
  return { elementFlags: tuple.ElementFlags$m(), fixedLength: tuple.FixedLength(), readonly: tuple.IsReadonly() };
}

export function typeParameters(type: Type): Type[] {
  return defined(type.AsInterfaceType()!.TypeParameters());
}

export function outerTypeParameters(type: Type): Type[] {
  return defined(type.AsInterfaceType()!.OuterTypeParameters());
}

export function localTypeParameters(type: Type): Type[] {
  return defined(type.AsInterfaceType()!.LocalTypeParameters());
}

// The members of a union, intersection or template literal type.
export function typesOfType(type: Type): Type[] {
  return defined(type.Types());
}

export function indexedAccessObjectType(type: Type): Type | undefined {
  return type.AsIndexedAccessType()!.ObjectType();
}

export function indexedAccessIndexType(type: Type): Type | undefined {
  return type.AsIndexedAccessType()!.IndexType();
}

export function conditionalCheckType(type: Type): Type | undefined {
  return type.AsConditionalType()!.CheckType();
}

export function conditionalExtendsType(type: Type): Type | undefined {
  return type.AsConditionalType()!.ExtendsType();
}

export function substitutionBaseType(type: Type): Type | undefined {
  return type.AsSubstitutionType()!.BaseType();
}

export function substitutionConstraint(type: Type): Type | undefined {
  return type.AsSubstitutionType()!.SubstConstraint();
}

export function templateLiteralTexts(type: Type): string[] {
  return type.AsTemplateLiteralType()!.Texts().map(hostString);
}

export function isThisType(type: Type): boolean {
  return type.AsTypeParameter()!.IsThisType();
}

export function intrinsicName(type: Type): string {
  return hostString(type.AsIntrinsicType()!.IntrinsicName());
}

export function isTupleType(type: Type): boolean {
  return checker.IsTupleType(type);
}

// Signatures.

export function signatureId(signature: Signature): number {
  return signature.Id();
}

export function signatureFlags(signature: Signature): number {
  return signature.Flags() >>> 0;
}

export function signatureDeclaration(signature: Signature): Node | undefined {
  return signature.Declaration();
}

export function signatureTypeParameters(signature: Signature): Type[] {
  return defined(signature.TypeParameters());
}

export function signatureParameters(signature: Signature): Symbol[] {
  return defined(signature.Parameters());
}

export function signatureThisParameter(signature: Signature): Symbol | undefined {
  return signature.ThisParameter();
}

export function signatureTarget(signature: Signature): Signature | undefined {
  return signature.Target();
}

// Conversions.

function literalValue(value: checkhost.LiteralValue): LiteralValue {
  switch (value.Kind) {
    case 1:
      return hostString(value.Text);
    case 2:
      return value.Number;
    case 3:
      return value.Bool;
    case 4:
      return { bigint: hostString(value.Text) };
  }
  return null;
}

function diagnosticOf(d: ast.Diagnostic): Diagnostic {
  let pos = d.Pos();
  let end = d.End();
  const file = d.File();
  if (file !== undefined) {
    const map = file.GetPositionMap()!;
    pos = map.UTF8ToUTF16(pos);
    end = map.UTF8ToUTF16(end);
  }
  return {
    fileName: file === undefined ? undefined : hostString(file.FileName()),
    pos,
    end,
    code: d.Code(),
    category: d.Category$m(),
    text: hostString(d.Localize(locale.Default)),
    reportsUnnecessary: d.ReportsUnnecessary(),
    reportsDeprecated: d.ReportsDeprecated(),
    messageChain: defined(d.MessageChain()).map(diagnosticOf),
    relatedInformation: defined(d.RelatedInformation()).map(diagnosticOf),
  };
}

function compilerOptionsOf(config: tsoptions.ParsedCommandLine): CompilerOptions {
  const o = config.CompilerOptions$m()!;
  // An empty list is written only when the config file sets it.
  const list = (name: string, values: string[]): string[] | undefined =>
    values.length > 0 || checkhost.RawCompilerOption(config, goString(name)) ? values.map(hostString) : undefined;
  return {
    allowJs: tristate(o.AllowJs),
    allowArbitraryExtensions: tristate(o.AllowArbitraryExtensions),
    allowImportingTsExtensions: tristate(o.AllowImportingTsExtensions),
    allowNonTsExtensions: tristate(o.AllowNonTsExtensions),
    allowUmdGlobalAccess: tristate(o.AllowUmdGlobalAccess),
    allowUnreachableCode: tristate(o.AllowUnreachableCode),
    allowUnusedLabels: tristate(o.AllowUnusedLabels),
    assumeChangesOnlyAffectDirectDependencies: tristate(o.AssumeChangesOnlyAffectDirectDependencies),
    checkJs: tristate(o.CheckJs),
    customConditions: list('customConditions', o.CustomConditions),
    composite: tristate(o.Composite),
    emitDeclarationOnly: tristate(o.EmitDeclarationOnly),
    emitBOM: tristate(o.EmitBOM),
    emitDecoratorMetadata: tristate(o.EmitDecoratorMetadata),
    declaration: tristate(o.Declaration),
    declarationDir: text(o.DeclarationDir),
    declarationMap: tristate(o.DeclarationMap),
    deduplicatePackages: tristate(o.DeduplicatePackages),
    disableSizeLimit: tristate(o.DisableSizeLimit),
    disableSourceOfProjectReferenceRedirect: tristate(o.DisableSourceOfProjectReferenceRedirect),
    disableSolutionSearching: tristate(o.DisableSolutionSearching),
    disableReferencedProjectLoad: tristate(o.DisableReferencedProjectLoad),
    erasableSyntaxOnly: tristate(o.ErasableSyntaxOnly),
    exactOptionalPropertyTypes: tristate(o.ExactOptionalPropertyTypes),
    experimentalDecorators: tristate(o.ExperimentalDecorators),
    forceConsistentCasingInFileNames: tristate(o.ForceConsistentCasingInFileNames),
    isolatedModules: tristate(o.IsolatedModules),
    isolatedDeclarations: tristate(o.IsolatedDeclarations),
    ignoreConfig: tristate(o.IgnoreConfig),
    ignoreDeprecations: text(o.IgnoreDeprecations),
    importHelpers: tristate(o.ImportHelpers),
    inlineSourceMap: tristate(o.InlineSourceMap),
    inlineSources: tristate(o.InlineSources),
    init: tristate(o.Init),
    incremental: tristate(o.Incremental),
    jsx: enumValue(o.Jsx),
    jsxFactory: text(o.JsxFactory),
    jsxFragmentFactory: text(o.JsxFragmentFactory),
    jsxImportSource: text(o.JsxImportSource),
    lib: list('lib', o.Lib),
    libReplacement: tristate(o.LibReplacement),
    locale: text(o.Locale),
    mapRoot: text(o.MapRoot),
    module: enumValue(o.Module),
    moduleResolution: enumValue(o.ModuleResolution),
    moduleSuffixes: list('moduleSuffixes', o.ModuleSuffixes),
    moduleDetection: enumValue(o.ModuleDetection),
    newLine: enumValue(o.NewLine),
    noEmit: tristate(o.NoEmit),
    noCheck: tristate(o.NoCheck),
    noErrorTruncation: tristate(o.NoErrorTruncation),
    noFallthroughCasesInSwitch: tristate(o.NoFallthroughCasesInSwitch),
    noImplicitAny: tristate(o.NoImplicitAny),
    noImplicitThis: tristate(o.NoImplicitThis),
    noImplicitReturns: tristate(o.NoImplicitReturns),
    noEmitHelpers: tristate(o.NoEmitHelpers),
    noLib: tristate(o.NoLib),
    noPropertyAccessFromIndexSignature: tristate(o.NoPropertyAccessFromIndexSignature),
    noUncheckedIndexedAccess: tristate(o.NoUncheckedIndexedAccess),
    noEmitOnError: tristate(o.NoEmitOnError),
    noUnusedLocals: tristate(o.NoUnusedLocals),
    noUnusedParameters: tristate(o.NoUnusedParameters),
    noResolve: tristate(o.NoResolve),
    noImplicitOverride: tristate(o.NoImplicitOverride),
    noUncheckedSideEffectImports: tristate(o.NoUncheckedSideEffectImports),
    outDir: text(o.OutDir),
    paths: pathMappings(o.Paths),
    preserveConstEnums: tristate(o.PreserveConstEnums),
    preserveSymlinks: tristate(o.PreserveSymlinks),
    project: text(o.Project),
    resolveJsonModule: tristate(o.ResolveJsonModule),
    resolvePackageJsonExports: tristate(o.ResolvePackageJsonExports),
    resolvePackageJsonImports: tristate(o.ResolvePackageJsonImports),
    removeComments: tristate(o.RemoveComments),
    rewriteRelativeImportExtensions: tristate(o.RewriteRelativeImportExtensions),
    reactNamespace: text(o.ReactNamespace),
    rootDir: text(o.RootDir),
    rootDirs: list('rootDirs', o.RootDirs),
    skipLibCheck: tristate(o.SkipLibCheck),
    stableTypeOrdering: tristate(o.StableTypeOrdering),
    strict: tristate(o.Strict),
    strictBindCallApply: tristate(o.StrictBindCallApply),
    strictBuiltinIteratorReturn: tristate(o.StrictBuiltinIteratorReturn),
    strictFunctionTypes: tristate(o.StrictFunctionTypes),
    strictNullChecks: tristate(o.StrictNullChecks),
    strictPropertyInitialization: tristate(o.StrictPropertyInitialization),
    stripInternal: tristate(o.StripInternal),
    skipDefaultLibCheck: tristate(o.SkipDefaultLibCheck),
    sourceMap: tristate(o.SourceMap),
    sourceRoot: text(o.SourceRoot),
    suppressOutputPathCheck: tristate(o.SuppressOutputPathCheck),
    target: enumValue(o.Target),
    traceResolution: tristate(o.TraceResolution),
    tsBuildInfoFile: text(o.TsBuildInfoFile),
    typeRoots: list('typeRoots', o.TypeRoots),
    types: list('types', o.Types),
    useDefineForClassFields: tristate(o.UseDefineForClassFields),
    useUnknownInCatchVariables: tristate(o.UseUnknownInCatchVariables),
    verbatimModuleSyntax: tristate(o.VerbatimModuleSyntax),
    maxNodeModuleJsDepth: o.MaxNodeModuleJsDepth?.v,
    allowSyntheticDefaultImports: tristate(o.AllowSyntheticDefaultImports),
    alwaysStrict: tristate(o.AlwaysStrict),
    baseUrl: text(o.BaseUrl),
    downlevelIteration: tristate(o.DownlevelIteration),
    esModuleInterop: tristate(o.ESModuleInterop),
    outFile: text(o.OutFile),
    configFilePath: text(o.ConfigFilePath),
    noDtsResolution: tristate(o.NoDtsResolution),
    pathsBasePath: text(o.PathsBasePath),
    diagnostics: tristate(o.Diagnostics),
    extendedDiagnostics: tristate(o.ExtendedDiagnostics),
    generateCpuProfile: text(o.GenerateCpuProfile),
    generateTrace: text(o.GenerateTrace),
    listEmittedFiles: tristate(o.ListEmittedFiles),
    listFiles: tristate(o.ListFiles),
    explainFiles: tristate(o.ExplainFiles),
    listFilesOnly: tristate(o.ListFilesOnly),
    noEmitForJsFiles: tristate(o.NoEmitForJsFiles),
    preserveWatchOutput: tristate(o.PreserveWatchOutput),
    pretty: tristate(o.Pretty),
    version: tristate(o.Version),
    watch: tristate(o.Watch),
    showConfig: tristate(o.ShowConfig),
    build: tristate(o.Build),
    help: tristate(o.Help),
    all: tristate(o.All),
    pprofDir: text(o.PprofDir),
    singleThreaded: tristate(o.SingleThreaded),
    quiet: tristate(o.Quiet),
    checkers: o.Checkers?.v,
  };
}

function tristate(value: core.Tristate): boolean | undefined {
  return value === 0 ? undefined : value === 2;
}

function text(value: string): string | undefined {
  return value === '' ? undefined : hostString(value);
}

function enumValue(value: number): number | undefined {
  return value === 0 ? undefined : value;
}

function pathMappings(paths: core.CompilerOptions['Paths']): Record<string, string[]> | undefined {
  if (paths === undefined) return undefined;
  const mappings: Record<string, string[]> = {};
  for (const pattern of paths.keys) {
    const [substitutions] = paths.Get(pattern);
    mappings[hostString(pattern)] = substitutions.map(hostString);
  }
  return mappings;
}

function defined<T>(items: (T | undefined)[]): T[] {
  const out: T[] = [];
  for (const item of items) if (item !== undefined) out.push(item);
  return out;
}

// The translated compiler keeps strings as UTF-8 byte strings.

const encoder = new TextEncoder();

function goString(s: string): string {
  return isAscii(s) ? s : fromBytes(encoder.encode(s));
}

const decoder = new TextDecoder();

function hostString(s: string): string {
  if (isAscii(s)) return s;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return decoder.decode(bytes);
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0x80) return false;
  return true;
}

// Runs the tsc command line on the disk; returns the exit status.
export function runTsc(args: string[], defaultLibraryPath: string): number {
  const host = new checkhost.Host();
  initHost(host);
  host.LibPath = goString(defaultLibraryPath);
  return checkhost.RunTSC(host, args.map(goString));
}

// Describes an exception thrown by the compiler, like a Go panic message.
export function panicMessage(e: unknown): string {
  return toPanic(e).message();
}
