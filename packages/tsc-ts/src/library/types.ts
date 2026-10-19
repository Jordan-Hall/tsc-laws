// The program, checker, symbol, type and signature types of tsc-ts's public API. They follow TypeScript 7's
// API (`typescript/unstable/sync`): the same names, and the same answers for the same program. The objects
// are tsc-ts's own: one object per symbol, type and signature in a program, so they can be compared with
// `===` and used as Map keys. Everything here is read-only: nothing the API does changes what tsc-ts
// reports for the program.

import type { Expression, Identifier, Node, SourceFile, TypeNode } from './ast.js';
import type { CompilerOptions } from './compiler-options.generated.js';
import type {
  DiagnosticCategory,
  ElementFlags,
  ModuleKind,
  ObjectFlags,
  SignatureFlags,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
  TypeFormatFlags,
  TypePredicateKind,
} from './enums.generated.js';

/**
 * The escaped form of a symbol name, the key of member and export tables: internal names start with
 * `__` (`__call`, `__type`), and names that already start with `__` have one more `_`.
 */
export type __String = string & { readonly __escapedIdentifier: void };

/**
 * A symbol. Its name, as TypeScript 7's API gives it, is `symbolName(symbol)`; `escapedName` is the key
 * of the tables it is a member or export of.
 */
export interface Symbol {
  /** Unique in the process. */
  readonly id: number;
  readonly escapedName: __String;
  readonly flags: SymbolFlags;
  readonly checkFlags: number;
  readonly declarations: readonly Node[];
  readonly valueDeclaration: Node | undefined;
  getParent(): Symbol | undefined;
  /** The symbol's export symbol, or the symbol itself if it has none. */
  getExportSymbol(): Symbol;
  /** The members, by escaped name. */
  getMembers(): ReadonlyMap<__String, Symbol>;
  /** The exports, by escaped name. */
  getExports(): ReadonlyMap<__String, Symbol>;
}

/**
 * A type. Its flags give its kind; the accessors answer undefined, or an empty list, where a kind has no
 * such part. Type ids are unique within the program's checker.
 */
export interface Type {
  readonly flags: TypeFlags;
  /**
   * The object flags of an object type (TypeFlags.Object). Other types carry flags the checker keeps for
   * itself, such as ObjectFlags.PrimitiveUnion, where TypeScript 7's API gives 0. Flags the checker
   * caches, such as ObjectFlags.MembersResolved, are set as queries compute them.
   */
  readonly objectFlags: ObjectFlags;
  readonly id: number;
  getSymbol(): Symbol | undefined;
  getAliasSymbol(): Symbol | undefined;
  getAliasTypeArguments(): readonly Type[];
  /** The target of a type reference, index type (`keyof T`) or string mapping type. */
  getTarget(): Type | undefined;
  /** The members of a union or intersection, or the types of a template literal type. */
  getTypes(): readonly Type[];
  getFreshType(): Type | undefined;
  getRegularType(): Type | undefined;
  getObjectType(): Type | undefined;
  getIndexType(): Type | undefined;
  getCheckType(): Type | undefined;
  getExtendsType(): Type | undefined;
  getTrueType(): Type | undefined;
  getFalseType(): Type | undefined;
  /** The base type of a substitution type. */
  getBaseType(): Type | undefined;
  /** The constraint of a substitution type. */
  getConstraint(): Type | undefined;
  getTypeParameters(): readonly TypeParameter[];
  getOuterTypeParameters(): readonly TypeParameter[];
  getLocalTypeParameters(): readonly TypeParameter[];
  /** The base types of a class or interface type, or undefined for any other type. */
  getBaseTypes(): readonly Type[] | undefined;
  isClassOrInterface(): this is InterfaceType;
  isUnionType(): this is UnionType;
  isIntersectionType(): this is IntersectionType;
  isObjectType(): this is ObjectType;
  isIntrinsicType(): this is IntrinsicType;
  /** Whether this is the error type, which the checker gives where a type can't be determined. */
  isErrorType(): boolean;
  isLiteralType(): this is LiteralType;
  isStringLiteralType(): this is StringLiteralType;
  isNumberLiteralType(): this is NumberLiteralType;
  isBigIntLiteralType(): this is BigIntLiteralType;
  isBooleanLiteralType(): this is BooleanLiteralType;
  isTypeReference(): this is TypeReference;
  isTupleType(): this is TupleType;
  isIndexType(): this is IndexType;
  isIndexedAccessType(): this is IndexedAccessType;
  isConditionalType(): this is ConditionalType;
  isSubstitutionType(): this is SubstitutionType;
  isTemplateLiteralType(): this is TemplateLiteralType;
  isStringMappingType(): this is StringMappingType;
  isTypeParameter(): this is TypeParameter;
}

/** Literal types (TypeFlags.Literal) and computed enum types (TypeFlags.Enum). */
export interface FreshableType extends Type {
  getFreshType(): FreshableType | undefined;
  getRegularType(): FreshableType | undefined;
}

export interface LiteralType extends FreshableType {
  readonly value: string | number | boolean | bigint;
}

export interface StringLiteralType extends LiteralType {
  readonly value: string;
}

export interface NumberLiteralType extends LiteralType {
  readonly value: number;
}

export interface BigIntLiteralType extends LiteralType {
  readonly value: bigint;
}

export interface BooleanLiteralType extends LiteralType {
  readonly value: boolean;
}

export interface ObjectType extends Type {}

export interface TypeReference extends ObjectType {
  getTarget(): Type;
}

/** Classes and interfaces (ObjectFlags.ClassOrInterface). */
export interface InterfaceType extends TypeReference {
  getBaseTypes(): readonly Type[];
}

/** Tuple targets (ObjectFlags.Tuple). */
export interface TupleType extends InterfaceType {
  readonly elementFlags: readonly ElementFlags[];
  /** The number of initial required or optional elements. */
  readonly fixedLength: number;
  readonly readonly: boolean;
}

export interface UnionOrIntersectionType extends Type {}

export interface UnionType extends UnionOrIntersectionType {}

export interface IntersectionType extends UnionOrIntersectionType {}

export interface TypeParameter extends Type {
  /** Whether this is the `this` type of a class, interface or tuple. */
  readonly isThisType: boolean;
}

export interface IndexType extends Type {
  getTarget(): Type;
}

export interface IndexedAccessType extends Type {
  getObjectType(): Type;
  getIndexType(): Type;
}

export interface ConditionalType extends Type {
  getCheckType(): Type;
  getExtendsType(): Type;
  getTrueType(): Type;
  getFalseType(): Type;
}

export interface SubstitutionType extends Type {
  getBaseType(): Type;
  getConstraint(): Type;
}

export interface TemplateLiteralType extends Type {
  /** The text segments, one more than the types between them. */
  readonly texts: readonly string[];
}

export interface StringMappingType extends Type {
  getTarget(): Type;
}

/** any, unknown, string, number, bigint, symbol, void, undefined, null, never, object and the error type. */
export interface IntrinsicType extends Type {
  readonly intrinsicName: string;
}

export interface Signature {
  /** Unique within the program's checker. */
  readonly id: number;
  /** Has a rest parameter, is a construct signature, is abstract (SignatureFlags). */
  readonly flags: SignatureFlags;
  readonly declaration: Node | undefined;
  getTypeParameters(): readonly TypeParameter[];
  getParameters(): readonly Symbol[];
  getThisParameter(): Symbol | undefined;
  /** The signature this one was instantiated from. */
  getTarget(): Signature | undefined;
}

export interface IndexInfo {
  readonly keyType: Type;
  readonly type: Type;
  readonly isReadonly: boolean;
  readonly declaration: Node | undefined;
}

export interface TypePredicate {
  readonly kind: TypePredicateKind;
  /** The parameter an identifier predicate names; undefined for a `this` predicate. */
  readonly parameterName: string | undefined;
  readonly parameterIndex: number | undefined;
  /** The asserted type; undefined for `asserts x`. */
  readonly type: Type | undefined;
}

/**
 * A diagnostic, with its text and positions as TypeScript 7's API returns them. `fileName` is undefined
 * for global and program diagnostics.
 */
export interface Diagnostic {
  readonly fileName: string | undefined;
  readonly pos: number;
  readonly end: number;
  readonly code: number;
  readonly category: DiagnosticCategory;
  readonly text: string;
  readonly reportsUnnecessary: boolean;
  readonly reportsDeprecated: boolean;
  readonly messageChain: readonly Diagnostic[];
  readonly relatedInformation: readonly Diagnostic[];
}

export interface SourceFileMetadata {
  readonly isDefaultLibrary: boolean;
  readonly isFromExternalLibrary: boolean;
  /** The `type` field of the file's nearest package.json, or '' if it has none. */
  readonly packageJsonType: string;
  /** The directory of the file's nearest package.json, or ''. */
  readonly packageJsonDirectory: string;
  readonly impliedNodeFormat: ModuleKind;
}

export interface FileSystemEntries {
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

/**
 * Where a program reads files. Each callback may answer undefined to fall back to the real file system;
 * `readFile` answers null for a file that doesn't exist.
 */
export interface ProgramHost {
  readFile?(fileName: string): string | null | undefined;
  fileExists?(fileName: string): boolean | undefined;
  directoryExists?(directoryName: string): boolean | undefined;
  realpath?(path: string): string | undefined;
  getAccessibleEntries?(directoryName: string): FileSystemEntries | undefined;
  getCurrentDirectory(): string;
  useCaseSensitiveFileNames(): boolean;
  /** The directory with TypeScript 7's `lib.*.d.ts` files. */
  getDefaultLibraryDirectory(): string;
}

export interface CreateProgramOptions {
  readonly rootNames: readonly string[];
  readonly options: CompilerOptions;
  readonly host: ProgramHost;
}

/** A config file's options and files, as `tsc-ts --api`'s parseConfigFile returns them. */
export interface ParsedConfigFile {
  readonly options: CompilerOptions;
  readonly fileNames: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface Program {
  getCompilerOptions(): CompilerOptions;
  getSourceFile(fileName: string): SourceFile | undefined;
  getSourceFiles(): readonly SourceFile[];
  getSourceFileNames(): readonly string[];
  getSourceFileMetadata(fileName: string): SourceFileMetadata | undefined;
  isSourceFileDefaultLibrary(file: SourceFile): boolean;
  isSourceFileFromExternalLibrary(file: SourceFile): boolean;
  /** The program's checker for queries. Queries don't change the diagnostics the program reports. */
  getTypeChecker(): TypeChecker;
  getSyntacticDiagnostics(file?: SourceFile): readonly Diagnostic[];
  getBindDiagnostics(file?: SourceFile): readonly Diagnostic[];
  getSemanticDiagnostics(file?: SourceFile): readonly Diagnostic[];
  getSuggestionDiagnostics(file?: SourceFile): readonly Diagnostic[];
  getDeclarationDiagnostics(file?: SourceFile): readonly Diagnostic[];
  getProgramDiagnostics(): readonly Diagnostic[];
  getGlobalDiagnostics(): readonly Diagnostic[];
  getConfigFileParsingDiagnostics(): readonly Diagnostic[];
  /** Frees the program's checkers. The program and its objects must not be used after. */
  dispose(): void;
}

export interface TypeChecker {
  getSymbolAtLocation(node: Node): Symbol | undefined;
  getTypeAtLocation(node: Node): Type | undefined;
  getTypeOfSymbol(symbol: Symbol): Type | undefined;
  getDeclaredTypeOfSymbol(symbol: Symbol): Type;
  /** The type of a symbol as narrowed at `location`. */
  getTypeOfSymbolAtLocation(symbol: Symbol, location: Node): Type;
  getTypeArguments(type: TypeReference): readonly Type[];
  /** The target of an alias (SymbolFlags.Alias); throws an InternalCompilerError for any other symbol. */
  getAliasedSymbol(symbol: Symbol): Symbol;
  getPropertyOfType(type: Type, name: string): Symbol | undefined;
  getPropertiesOfType(type: Type): readonly Symbol[];
  getSignaturesOfType(type: Type, kind: SignatureKind): readonly Signature[];
  getIndexInfosOfType(type: Type): readonly IndexInfo[];
  getReturnTypeOfSignature(signature: Signature): Type | undefined;
  getTypePredicateOfSignature(signature: Signature): TypePredicate | undefined;
  getSignatureFromDeclaration(node: Node): Signature | undefined;
  getResolvedSignature(node: Node): Signature | undefined;
  getContextualType(node: Expression): Type | undefined;
  getShorthandAssignmentValueSymbol(node: Node): Symbol | undefined;
  getTypeFromTypeNode(node: TypeNode): Type | undefined;
  getBaseTypeOfLiteralType(type: Type): Type | undefined;
  getNonNullableType(type: Type): Type | undefined;
  getBaseTypes(type: InterfaceType): readonly Type[];
  getConstantValue(node: Node): string | number | undefined;
  isArrayType(type: Type): boolean;
  isTupleType(type: Type): boolean;
  isArrayLikeType(type: Type): boolean;
  isTypeAssignableTo(source: Type, target: Type): boolean;
  resolveName(name: string, meaning: SymbolFlags, location?: Node, excludeGlobals?: boolean): Symbol | undefined;
  /** The value `node` names where it is: `resolveName(node.text, SymbolFlags.Value | SymbolFlags.ExportValue, node)`. */
  getResolvedSymbol(node: Identifier): Symbol | undefined;
  /**
   * The text TypeScript 7's API gives for `type`, printed in `enclosingDeclaration` with `flags`; without
   * flags, or with 0, with TypeFormatFlags.AllowUniqueESSymbolType and UseAliasDefinedOutsideCurrentScope.
   */
  typeToString(type: Type, enclosingDeclaration?: Node, flags?: TypeFormatFlags): string;
  getAnyType(): Type;
  getUnknownType(): Type;
  getNeverType(): Type;
  getStringType(): Type;
  getNumberType(): Type;
  getBigIntType(): Type;
  getBooleanType(): Type;
}
