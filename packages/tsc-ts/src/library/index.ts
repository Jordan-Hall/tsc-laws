// tsc-ts's public API (`tsc-ts/api`): the types of programs, checkers, nodes, symbols, types and
// signatures, and the enums that number their kinds and flags as TypeScript 7's API does.

export * from './ast.js';
export * from './enums.generated.js';
export type { CompilerOptions } from './compiler-options.generated.js';
export { symbolName } from './symbols.js';
export type {
  __String,
  BigIntLiteralType,
  BooleanLiteralType,
  ConditionalType,
  CreateProgramOptions,
  Diagnostic,
  FileSystemEntries,
  FreshableType,
  IndexedAccessType,
  IndexInfo,
  IndexType,
  InterfaceType,
  IntersectionType,
  IntrinsicType,
  LiteralType,
  NumberLiteralType,
  ObjectType,
  ParsedConfigFile,
  Program,
  ProgramHost,
  Signature,
  SourceFileMetadata,
  StringLiteralType,
  StringMappingType,
  SubstitutionType,
  Symbol,
  TemplateLiteralType,
  TupleType,
  Type,
  TypeChecker,
  TypeParameter,
  TypePredicate,
  TypeReference,
  UnionOrIntersectionType,
  UnionType,
} from './types.js';

/** The kind of an index signature's key, as TypeScript 5 numbers it. */
export enum IndexKind {
  String = 0,
  Number = 1,
}
