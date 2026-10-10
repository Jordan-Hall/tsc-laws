// The checker's type model: types, signatures, index infos, mappers and the links the checker
// caches per symbol and node. Flag values match tsgo, because union ordering depends on them.
import type { Node } from './ast.js';
import type { Symbol, SymbolTable } from './symbol.js';

export const enum TypeFlags {
  None = 0,
  Any = 1 << 0,
  Unknown = 1 << 1,
  Undefined = 1 << 2,
  Null = 1 << 3,
  Void = 1 << 4,
  String = 1 << 5,
  Number = 1 << 6,
  BigInt = 1 << 7,
  Boolean = 1 << 8,
  ESSymbol = 1 << 9,
  StringLiteral = 1 << 10,
  NumberLiteral = 1 << 11,
  BigIntLiteral = 1 << 12,
  BooleanLiteral = 1 << 13,
  UniqueESSymbol = 1 << 14,
  /** Always combined with StringLiteral, NumberLiteral, or Union. */
  EnumLiteral = 1 << 15,
  /** A numeric enum member with a computed value. */
  Enum = 1 << 16,
  NonPrimitive = 1 << 17,
  Never = 1 << 18,
  TypeParameter = 1 << 19,
  Object = 1 << 20,
  Index = 1 << 21,
  TemplateLiteral = 1 << 22,
  StringMapping = 1 << 23,
  Substitution = 1 << 24,
  IndexedAccess = 1 << 25,
  Conditional = 1 << 26,
  Union = 1 << 27,
  Intersection = 1 << 28,
  Reserved1 = 1 << 29,
  Reserved2 = 1 << 30,

  AnyOrUnknown = Any | Unknown,
  Nullable = Undefined | Null,
  Literal = StringLiteral | NumberLiteral | BigIntLiteral | BooleanLiteral,
  Unit = Enum | Literal | UniqueESSymbol | Nullable,
  Freshable = Enum | Literal,
  StringOrNumberLiteral = StringLiteral | NumberLiteral,
  StringOrNumberLiteralOrUnique = StringLiteral | NumberLiteral | UniqueESSymbol,
  DefinitelyFalsy = StringLiteral | NumberLiteral | BigIntLiteral | BooleanLiteral | Void | Undefined | Null,
  PossiblyFalsy = DefinitelyFalsy | String | Number | BigInt | Boolean,
  Intrinsic = Any | Unknown | String | Number | BigInt | ESSymbol | Void | Undefined | Null | Never | NonPrimitive,
  StringLike = String | StringLiteral | TemplateLiteral | StringMapping,
  NumberLike = Number | NumberLiteral | Enum,
  BigIntLike = BigInt | BigIntLiteral,
  BooleanLike = Boolean | BooleanLiteral,
  EnumLike = Enum | EnumLiteral,
  ESSymbolLike = ESSymbol | UniqueESSymbol,
  VoidLike = Void | Undefined,
  Primitive = StringLike | NumberLike | BigIntLike | BooleanLike | EnumLike | ESSymbolLike | VoidLike | Null,
  DefinitelyNonNullable = StringLike |
    NumberLike |
    BigIntLike |
    BooleanLike |
    EnumLike |
    ESSymbolLike |
    Object |
    NonPrimitive,
  DisjointDomains = NonPrimitive | StringLike | NumberLike | BigIntLike | BooleanLike | ESSymbolLike | VoidLike | Null,
  UnionOrIntersection = Union | Intersection,
  StructuredType = Object | Union | Intersection,
  TypeVariable = TypeParameter | IndexedAccess,
  InstantiableNonPrimitive = TypeVariable | Conditional | Substitution,
  InstantiablePrimitive = Index | TemplateLiteral | StringMapping,
  Instantiable = InstantiableNonPrimitive | InstantiablePrimitive,
  StructuredOrInstantiable = StructuredType | Instantiable,
  ObjectFlagsType = Any | Nullable | Never | Object | Union | Intersection,
  Simplifiable = IndexedAccess | Conditional | Index,
  Singleton = Any |
    Unknown |
    String |
    Number |
    Boolean |
    BigInt |
    ESSymbol |
    Void |
    Undefined |
    Null |
    Never |
    NonPrimitive,
  /** Types where narrowing actually narrows. */
  Narrowable = Any |
    Unknown |
    StructuredOrInstantiable |
    StringLike |
    NumberLike |
    BigIntLike |
    BooleanLike |
    ESSymbol |
    UniqueESSymbol |
    NonPrimitive,
  /** Aggregated during union and intersection construction. */
  IncludesMask = Any |
    Unknown |
    Primitive |
    Never |
    Object |
    Union |
    Intersection |
    NonPrimitive |
    TemplateLiteral |
    StringMapping,
  // Reused during union and intersection construction.
  IncludesMissingType = TypeParameter,
  IncludesNonWideningType = Index,
  IncludesWildcard = IndexedAccess,
  IncludesEmptyObject = Conditional,
  IncludesInstantiable = Substitution,
  IncludesConstrainedTypeVariable = Reserved1,
  IncludesError = Reserved2,
  NotPrimitiveUnion = Any | Unknown | Void | Never | Object | Intersection | IncludesInstantiable,
}

/** The sign bit, which TypeScript enums can't hold as a positive flag. */
export const typeFlagsReserved3 = -2147483648;

export const enum ObjectFlags {
  None = 0,
  Class = 1 << 0,
  Interface = 1 << 1,
  /** A generic type reference. */
  Reference = 1 << 2,
  Tuple = 1 << 3,
  Anonymous = 1 << 4,
  Mapped = 1 << 5,
  /** An instantiated anonymous or mapped type. */
  Instantiated = 1 << 6,
  ObjectLiteral = 1 << 7,
  EvolvingArray = 1 << 8,
  ObjectLiteralPatternWithComputedProperties = 1 << 9,
  ReverseMapped = 1 << 10,
  JsxAttributes = 1 << 11,
  /** Declared in JS: reads and writes of missing members are allowed. */
  JSLiteral = 1 << 12,
  FreshLiteral = 1 << 13,
  ArrayLiteral = 1 << 14,
  PrimitiveUnion = 1 << 15,
  ContainsWideningType = 1 << 16,
  ContainsObjectOrArrayLiteral = 1 << 17,
  /** Is or contains anyFunctionType or silentNeverType. */
  NonInferrableType = 1 << 18,
  CouldContainTypeVariablesComputed = 1 << 19,
  CouldContainTypeVariables = 1 << 20,
  MembersResolved = 1 << 21,

  ClassOrInterface = Class | Interface,
  RequiresWidening = ContainsWideningType | ContainsObjectOrArrayLiteral,
  PropagatingFlags = ContainsWideningType | ContainsObjectOrArrayLiteral | NonInferrableType,
  InstantiatedMapped = Mapped | Instantiated,

  // Object types only.
  ContainsSpread = 1 << 22,
  ObjectRestType = 1 << 23,
  InstantiationExpressionType = 1 << 24,
  SingleSignatureType = 1 << 25,
  IsClassInstanceClone = 1 << 26,
  // Type references only.
  IdenticalBaseTypeCalculated = 1 << 27,
  IdenticalBaseTypeExists = 1 << 28,
  UnresolvedMembers = 1 << 29,
  FromTypeNode = 1 << 30,
  // Unions, intersections and substitutions only.
  IsGenericTypeComputed = 1 << 22,
  IsGenericObjectType = 1 << 23,
  IsGenericIndexType = 1 << 24,
  IsGenericType = IsGenericObjectType | IsGenericIndexType,
  // Unions only.
  ContainsIntersections = 1 << 25,
  IsUnknownLikeUnionComputed = 1 << 26,
  IsUnknownLikeUnion = 1 << 27,
  // Intersections only.
  IsNeverIntersectionComputed = 1 << 25,
  IsNeverIntersection = 1 << 26,
  IsConstrainedTypeVariable = 1 << 27,

  ObjectTypeKindMask = ClassOrInterface |
    Reference |
    Tuple |
    Anonymous |
    Mapped |
    ReverseMapped |
    EvolvingArray |
    InstantiationExpressionType |
    SingleSignatureType,
}

export const enum ElementFlags {
  None = 0,
  Required = 1 << 0,
  Optional = 1 << 1,
  Rest = 1 << 2,
  Variadic = 1 << 3,
  Fixed = Required | Optional,
  Variable = Rest | Variadic,
  NonRequired = Optional | Rest | Variadic,
  NonRest = Required | Optional | Variadic,
}

export const enum SignatureFlags {
  None = 0,
  HasRestParameter = 1 << 0,
  HasLiteralTypes = 1 << 1,
  Construct = 1 << 2,
  Abstract = 1 << 3,
  IsInnerCallChain = 1 << 4,
  IsOuterCallChain = 1 << 5,
  IsUntypedSignatureInJSFile = 1 << 6,
  IsNonInferrable = 1 << 7,
  IsSignatureCandidateForOverloadFailure = 1 << 8,
  PropagatingFlags = HasRestParameter |
    HasLiteralTypes |
    Construct |
    Abstract |
    IsUntypedSignatureInJSFile |
    IsSignatureCandidateForOverloadFailure,
  CallChainFlags = IsInnerCallChain | IsOuterCallChain,
}

export const enum SignatureKind {
  Call = 0,
  Construct = 1,
}

export const enum IndexFlags {
  None = 0,
  StringsOnly = 1 << 0,
  NoIndexSignatures = 1 << 1,
  NoReducibleCheck = 1 << 2,
}

export const enum AccessFlags {
  None = 0,
  IncludeUndefined = 1 << 0,
  NoIndexSignatures = 1 << 1,
  Writing = 1 << 2,
  CacheSymbol = 1 << 3,
  AllowMissing = 1 << 4,
  ExpressionPosition = 1 << 5,
  ReportDeprecated = 1 << 6,
  SuppressNoImplicitAnyError = 1 << 7,
  Contextual = 1 << 8,
  Persistent = IncludeUndefined,
}

export const enum VarianceFlags {
  Invariant = 0,
  Covariant = 1 << 0,
  Contravariant = 1 << 1,
  Bivariant = Covariant | Contravariant,
  /** An unwitnessed type parameter. */
  Independent = 1 << 2,
  VarianceMask = Invariant | Covariant | Contravariant | Independent,
  /** Relies on structural comparisons not reflected in generic relationships. */
  Unmeasurable = 1 << 3,
  /** May produce false negatives, never false positives. */
  Unreliable = 1 << 4,
  AllowsStructuralFallback = Unmeasurable | Unreliable,
}

/** `x & y` picks the lesser in False < Unknown < Maybe < True; `x | y` the greater. */
export const enum Ternary {
  False = 0,
  Unknown = 1,
  Maybe = 3,
  True = -1,
}

export const enum TypePredicateKind {
  This = 0,
  Identifier = 1,
  AssertsThis = 2,
  AssertsIdentifier = 3,
}

export const enum NodeCheckFlags {
  None = 0,
  TypeChecked = 1 << 0,
  UnusedChecked = 1 << 1,
  ContextChecked = 1 << 6,
  EnumValuesComputed = 1 << 10,
  AssignmentsMarked = 1 << 17,
  ContainsClassWithPrivateIdentifiers = 1 << 20,
  ContainsSuperPropertyInStaticInitializer = 1 << 21,
  InCheckIdentifier = 1 << 22,
  InitializerIsUndefined = 1 << 24,
  InitializerIsUndefinedComputed = 1 << 25,
}

export const enum CheckMode {
  Normal = 0,
  Contextual = 1 << 0,
  Inferential = 1 << 1,
  SkipContextSensitive = 1 << 2,
  SkipGenericFunctions = 1 << 3,
  IsForSignatureHelp = 1 << 4,
  RestBindingElement = 1 << 5,
  TypeOnly = 1 << 6,
  ForceTuple = 1 << 7,
}

export const enum TypeFormatFlags {
  None = 0,
  NoTruncation = 1 << 0,
  WriteArrayAsGenericType = 1 << 1,
  UseStructuralFallback = 1 << 3,
  WriteTypeArgumentsOfSignature = 1 << 5,
  UseFullyQualifiedType = 1 << 6,
  SuppressAnyReturnType = 1 << 8,
  MultilineObjectLiterals = 1 << 10,
  WriteClassExpressionAsTypeLiteral = 1 << 11,
  UseTypeOfFunction = 1 << 12,
  OmitParameterModifiers = 1 << 13,
  UseAliasDefinedOutsideCurrentScope = 1 << 14,
  AllowUniqueESSymbolType = 1 << 20,
  AddUndefined = 1 << 17,
  WriteArrowStyleSignature = 1 << 18,
  InArrayType = 1 << 19,
  InElementType = 1 << 21,
  InFirstTypeArgument = 1 << 22,
  InTypeAlias = 1 << 23,
  OmitThisParameter = 1 << 25,
  WriteCallStyleSignature = 1 << 27,
  UseSingleQuotesForStringLiteralType = 1 << 28,
  NoTypeReduction = 1 << 29,
}

// ---- Types

/** An alias symbol and its type arguments, for types written through a type alias. */
export class TypeAlias {
  readonly symbol: Symbol;
  readonly typeArguments: Type[];

  constructor(symbol: Symbol, typeArguments: Type[]) {
    this.symbol = symbol;
    this.typeArguments = typeArguments;
  }
}

/**
 * The base of every type. Narrow by `flags` (and `objectFlags` for object types), then cast to
 * the subclass, as tsgo does with `AsUnionType()` etc.
 */
export class Type {
  flags: TypeFlags;
  objectFlags: ObjectFlags;
  readonly id: number;
  symbol: Symbol | undefined;
  alias: TypeAlias | undefined;
  /** For types with a computed base constraint (type variables, structured types, …). */
  resolvedBaseConstraint: Type | undefined;

  constructor(flags: TypeFlags, objectFlags: ObjectFlags, id: number, symbol: Symbol | undefined) {
    this.flags = flags;
    this.objectFlags = objectFlags;
    this.id = id;
    this.symbol = symbol;
    this.alias = undefined;
    this.resolvedBaseConstraint = undefined;
  }
}

export class IntrinsicType extends Type {
  readonly intrinsicName: string;

  constructor(flags: TypeFlags, objectFlags: ObjectFlags, id: number, intrinsicName: string) {
    super(flags, objectFlags, id, undefined);
    this.intrinsicName = intrinsicName;
  }
}

/**
 * A literal or enum member type. `value` is the string of string literals, the number of number
 * literals, `true`/`false` for booleans, the decimal digits (with a leading `-`) of bigints, and
 * unset for computed enum members.
 */
export class LiteralType extends Type {
  readonly stringValue: string;
  readonly numberValue: number;
  /** Created on first use, except for `true` and `false`. */
  freshType: LiteralType | undefined;
  regularType: LiteralType;

  constructor(flags: TypeFlags, id: number, symbol: Symbol | undefined, stringValue: string, numberValue: number) {
    super(flags, ObjectFlags.None, id, symbol);
    this.stringValue = stringValue;
    this.numberValue = numberValue;
    this.freshType = undefined;
    this.regularType = this;
  }
}

export class UniqueESSymbolType extends Type {
  readonly name: string;

  constructor(id: number, symbol: Symbol, name: string) {
    super(TypeFlags.UniqueESSymbol, ObjectFlags.None, id, symbol);
    this.name = name;
  }
}

/** A type with members: object types, unions and intersections. */
export class StructuredType extends Type {
  members: SymbolTable | undefined;
  properties: Symbol[];
  callSignatures: Signature[];
  constructSignatures: Signature[];
  indexInfos: IndexInfo[];
  objectTypeWithoutAbstractConstructSignatures: Type | undefined;

  constructor(flags: TypeFlags, objectFlags: ObjectFlags, id: number, symbol: Symbol | undefined) {
    super(flags, objectFlags, id, symbol);
    this.members = undefined;
    this.properties = emptySymbols;
    this.callSignatures = emptySignatures;
    this.constructSignatures = emptySignatures;
    this.indexInfos = emptyIndexInfos;
    this.objectTypeWithoutAbstractConstructSignatures = undefined;
  }
}

export class ObjectType extends StructuredType {
  /** The generic type this one instantiates. */
  target: Type | undefined;
  mapper: TypeMapper | undefined;
  instantiations: Map<string, Type> | undefined;

  constructor(objectFlags: ObjectFlags, id: number, symbol: Symbol | undefined) {
    super(TypeFlags.Object, objectFlags, id, symbol);
    this.target = undefined;
    this.mapper = undefined;
    this.instantiations = undefined;
  }
}

/** An instantiation of a generic class, interface or tuple type. */
export class TypeReference extends ObjectType {
  /** The type node of a deferred reference, else undefined. */
  node: Node | undefined;
  resolvedTypeArguments: Type[] | undefined;

  constructor(objectFlags: ObjectFlags, id: number, symbol: Symbol | undefined) {
    super(objectFlags, id, symbol);
    this.node = undefined;
    this.resolvedTypeArguments = undefined;
  }
}

/** A class or interface; when generic, also the reference to itself instantiated with its own type parameters. */
export class InterfaceType extends TypeReference {
  /** Outer, then local type parameters, then the `this` type. */
  allTypeParameters: Type[];
  outerTypeParameterCount: number;
  thisType: Type | undefined;
  baseTypesResolved: boolean;
  declaredMembersResolved: boolean;
  resolvedBaseConstructorType: Type | undefined;
  resolvedBaseTypes: Type[];
  declaredMembers: SymbolTable | undefined;
  declaredCallSignatures: Signature[];
  declaredConstructSignatures: Signature[];
  declaredIndexInfos: IndexInfo[];

  constructor(objectFlags: ObjectFlags, id: number, symbol: Symbol | undefined) {
    super(objectFlags, id, symbol);
    this.allTypeParameters = emptyTypes;
    this.outerTypeParameterCount = 0;
    this.thisType = undefined;
    this.baseTypesResolved = false;
    this.declaredMembersResolved = false;
    this.resolvedBaseConstructorType = undefined;
    this.resolvedBaseTypes = emptyTypes;
    this.declaredMembers = undefined;
    this.declaredCallSignatures = emptySignatures;
    this.declaredConstructSignatures = emptySignatures;
    this.declaredIndexInfos = emptyIndexInfos;
  }

  outerTypeParameters(): Type[] {
    return this.allTypeParameters.length === 0
      ? emptyTypes
      : this.allTypeParameters.slice(0, this.outerTypeParameterCount);
  }

  localTypeParameters(): Type[] {
    const all = this.allTypeParameters;
    return all.length === 0 ? emptyTypes : all.slice(this.outerTypeParameterCount, all.length - 1);
  }

  typeParameters(): Type[] {
    const all = this.allTypeParameters;
    return all.length === 0 ? emptyTypes : all.slice(0, all.length - 1);
  }
}

export class TupleElementInfo {
  readonly flags: ElementFlags;
  /** A NamedTupleMember or ParameterDeclaration, if labeled. */
  readonly labeledDeclaration: Node | undefined;

  constructor(flags: ElementFlags, labeledDeclaration: Node | undefined) {
    this.flags = flags;
    this.labeledDeclaration = labeledDeclaration;
  }
}

export class TupleType extends InterfaceType {
  elementInfos: TupleElementInfo[];
  /** Required or variadic elements. */
  minLength: number;
  /** Leading required or optional elements. */
  fixedLength: number;
  combinedFlags: ElementFlags;
  readonly: boolean;

  constructor(objectFlags: ObjectFlags, id: number) {
    super(objectFlags, id, undefined);
    this.elementInfos = [];
    this.minLength = 0;
    this.fixedLength = 0;
    this.combinedFlags = ElementFlags.None;
    this.readonly = false;
  }
}

export class InstantiationExpressionType extends ObjectType {
  node: Node | undefined;

  constructor(objectFlags: ObjectFlags, id: number, symbol: Symbol | undefined) {
    super(objectFlags, id, symbol);
    this.node = undefined;
  }
}

export class MappedType extends ObjectType {
  declaration: Node | undefined;
  typeParameter: Type | undefined;
  constraintType: Type | undefined;
  nameType: Type | undefined;
  templateType: Type | undefined;
  modifiersType: Type | undefined;
  resolvedApparentType: Type | undefined;
  containsError: boolean;

  constructor(objectFlags: ObjectFlags, id: number, symbol: Symbol | undefined) {
    super(objectFlags, id, symbol);
    this.declaration = undefined;
    this.typeParameter = undefined;
    this.constraintType = undefined;
    this.nameType = undefined;
    this.templateType = undefined;
    this.modifiersType = undefined;
    this.resolvedApparentType = undefined;
    this.containsError = false;
  }
}

export class ReverseMappedType extends ObjectType {
  source: Type | undefined;
  mappedType: Type | undefined;
  constraintType: Type | undefined;

  constructor(objectFlags: ObjectFlags, id: number) {
    super(objectFlags, id, undefined);
    this.source = undefined;
    this.mappedType = undefined;
    this.constraintType = undefined;
  }
}

export class EvolvingArrayType extends ObjectType {
  elementType: Type | undefined;
  finalArrayType: Type | undefined;

  constructor(objectFlags: ObjectFlags, id: number) {
    super(objectFlags, id, undefined);
    this.elementType = undefined;
    this.finalArrayType = undefined;
  }
}

export class UnionOrIntersectionType extends StructuredType {
  readonly types: Type[];
  propertyCache: SymbolTable | undefined;
  propertyCacheWithoutFunctionPropertyAugment: SymbolTable | undefined;
  resolvedProperties: Symbol[] | undefined;

  constructor(flags: TypeFlags, objectFlags: ObjectFlags, id: number, types: Type[]) {
    super(flags, objectFlags, id, undefined);
    this.types = types;
    this.propertyCache = undefined;
    this.propertyCacheWithoutFunctionPropertyAugment = undefined;
    this.resolvedProperties = undefined;
  }
}

export class UnionType extends UnionOrIntersectionType {
  resolvedReducedType: Type | undefined;
  regularType: Type | undefined;
  /** The denormalized union, intersection or index type the union came from. */
  origin: Type | undefined;
  /** A property with a unique unit type in every object of the union; '' if not computed, '\0' if none. */
  keyPropertyName: string;
  constituentMap: Map<Type, Type> | undefined;

  constructor(objectFlags: ObjectFlags, id: number, types: Type[]) {
    super(TypeFlags.Union, objectFlags, id, types);
    this.resolvedReducedType = undefined;
    this.regularType = undefined;
    this.origin = undefined;
    this.keyPropertyName = '';
    this.constituentMap = undefined;
  }
}

export class IntersectionType extends UnionOrIntersectionType {
  resolvedApparentType: Type | undefined;
  uniqueLiteralFilledInstantiation: Type | undefined;

  constructor(objectFlags: ObjectFlags, id: number, types: Type[]) {
    super(TypeFlags.Intersection, objectFlags, id, types);
    this.resolvedApparentType = undefined;
    this.uniqueLiteralFilledInstantiation = undefined;
  }
}

export class TypeParameter extends Type {
  constraint: Type | undefined;
  target: Type | undefined;
  mapper: TypeMapper | undefined;
  isThisType: boolean;
  resolvedDefaultType: Type | undefined;

  constructor(id: number, symbol: Symbol | undefined) {
    super(TypeFlags.TypeParameter, ObjectFlags.None, id, symbol);
    this.constraint = undefined;
    this.target = undefined;
    this.mapper = undefined;
    this.isThisType = false;
    this.resolvedDefaultType = undefined;
  }
}

/** `keyof T`. */
export class IndexType extends Type {
  readonly target: Type;
  readonly indexFlags: IndexFlags;

  constructor(id: number, target: Type, indexFlags: IndexFlags) {
    super(TypeFlags.Index, ObjectFlags.None, id, undefined);
    this.target = target;
    this.indexFlags = indexFlags;
  }
}

/** `T[K]`. */
export class IndexedAccessType extends Type {
  readonly objectType: Type;
  readonly indexType: Type;
  /** Only AccessFlags.Persistent. */
  readonly accessFlags: AccessFlags;

  constructor(id: number, objectType: Type, indexType: Type, accessFlags: AccessFlags) {
    super(TypeFlags.IndexedAccess, ObjectFlags.None, id, undefined);
    this.objectType = objectType;
    this.indexType = indexType;
    this.accessFlags = accessFlags;
  }
}

export class TemplateLiteralType extends Type {
  /** One longer than `types`. */
  readonly texts: string[];
  readonly types: Type[];

  constructor(id: number, texts: string[], types: Type[]) {
    super(TypeFlags.TemplateLiteral, ObjectFlags.None, id, undefined);
    this.texts = texts;
    this.types = types;
  }
}

/** `Uppercase<T>` and friends. */
export class StringMappingType extends Type {
  readonly target: Type;

  constructor(id: number, symbol: Symbol, target: Type) {
    super(TypeFlags.StringMapping, ObjectFlags.None, id, symbol);
    this.target = target;
  }
}

export class SubstitutionType extends Type {
  readonly baseType: Type;
  /** What the base type is known to satisfy. */
  readonly constraint: Type;

  constructor(id: number, baseType: Type, constraint: Type) {
    super(TypeFlags.Substitution, ObjectFlags.None, id, undefined);
    this.baseType = baseType;
    this.constraint = constraint;
  }
}

export class ConditionalRoot {
  readonly node: Node;
  readonly checkType: Type;
  readonly extendsType: Type;
  readonly isDistributive: boolean;
  readonly inferTypeParameters: Type[];
  readonly outerTypeParameters: Type[];
  readonly instantiations: Map<string, Type>;
  readonly alias: TypeAlias | undefined;

  constructor(
    node: Node,
    checkType: Type,
    extendsType: Type,
    isDistributive: boolean,
    inferTypeParameters: Type[],
    outerTypeParameters: Type[],
    alias: TypeAlias | undefined,
  ) {
    this.node = node;
    this.checkType = checkType;
    this.extendsType = extendsType;
    this.isDistributive = isDistributive;
    this.inferTypeParameters = inferTypeParameters;
    this.outerTypeParameters = outerTypeParameters;
    this.instantiations = new Map<string, Type>();
    this.alias = alias;
  }
}

export class ConditionalType extends Type {
  readonly root: ConditionalRoot;
  readonly checkType: Type;
  readonly extendsType: Type;
  resolvedTrueType: Type | undefined;
  resolvedFalseType: Type | undefined;
  resolvedInferredTrueType: Type | undefined;
  resolvedDefaultConstraint: Type | undefined;
  resolvedConstraintOfDistributive: Type | undefined;
  readonly mapper: TypeMapper | undefined;
  readonly combinedMapper: TypeMapper | undefined;

  constructor(
    id: number,
    root: ConditionalRoot,
    checkType: Type,
    extendsType: Type,
    mapper: TypeMapper | undefined,
    combinedMapper: TypeMapper | undefined,
  ) {
    super(TypeFlags.Conditional, ObjectFlags.None, id, undefined);
    this.root = root;
    this.checkType = checkType;
    this.extendsType = extendsType;
    this.resolvedTrueType = undefined;
    this.resolvedFalseType = undefined;
    this.resolvedInferredTrueType = undefined;
    this.resolvedDefaultConstraint = undefined;
    this.resolvedConstraintOfDistributive = undefined;
    this.mapper = mapper;
    this.combinedMapper = combinedMapper;
  }
}

// ---- Signatures and index infos

export class TypePredicate {
  readonly kind: TypePredicateKind;
  readonly parameterIndex: number;
  readonly parameterName: string;
  readonly type: Type | undefined;

  constructor(kind: TypePredicateKind, parameterName: string, parameterIndex: number, type: Type | undefined) {
    this.kind = kind;
    this.parameterIndex = parameterIndex;
    this.parameterName = parameterName;
    this.type = type;
  }
}

export class CompositeSignature {
  /** False for an intersection. */
  readonly isUnion: boolean;
  readonly signatures: Signature[];

  constructor(isUnion: boolean, signatures: Signature[]) {
    this.isUnion = isUnion;
    this.signatures = signatures;
  }
}

export class Signature {
  readonly id: number;
  flags: SignatureFlags;
  minArgumentCount: number;
  /** -1 until computed. */
  resolvedMinArgumentCount: number;
  declaration: Node | undefined;
  typeParameters: Type[];
  parameters: Symbol[];
  thisParameter: Symbol | undefined;
  resolvedReturnType: Type | undefined;
  resolvedTypePredicate: TypePredicate | undefined;
  target: Signature | undefined;
  mapper: TypeMapper | undefined;
  isolatedSignatureType: Type | undefined;
  composite: CompositeSignature | undefined;
  /** Caches of derived signatures. */
  erasedSignatureCache: Signature | undefined;
  canonicalSignatureCache: Signature | undefined;
  baseSignatureCache: Signature | undefined;
  optionalCallSignatureCache: Signature | undefined;
  instantiations: Map<string, Signature> | undefined;

  constructor(
    id: number,
    flags: SignatureFlags,
    declaration: Node | undefined,
    typeParameters: Type[],
    thisParameter: Symbol | undefined,
    parameters: Symbol[],
    resolvedReturnType: Type | undefined,
    resolvedTypePredicate: TypePredicate | undefined,
    minArgumentCount: number,
  ) {
    this.id = id;
    this.flags = flags;
    this.minArgumentCount = minArgumentCount;
    this.resolvedMinArgumentCount = -1;
    this.declaration = declaration;
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.thisParameter = thisParameter;
    this.resolvedReturnType = resolvedReturnType;
    this.resolvedTypePredicate = resolvedTypePredicate;
    this.target = undefined;
    this.mapper = undefined;
    this.isolatedSignatureType = undefined;
    this.composite = undefined;
    this.erasedSignatureCache = undefined;
    this.canonicalSignatureCache = undefined;
    this.baseSignatureCache = undefined;
    this.optionalCallSignatureCache = undefined;
    this.instantiations = undefined;
  }

  hasRestParameter(): boolean {
    return (this.flags & SignatureFlags.HasRestParameter) !== 0;
  }
}

export class IndexInfo {
  readonly keyType: Type;
  readonly valueType: Type;
  readonly isReadonly: boolean;
  /** The IndexSignatureDeclaration. */
  readonly declaration: Node | undefined;
  /** Elements with computed property names that make up the index signature. */
  readonly components: Node[];
  indexSymbol: Symbol | undefined;

  constructor(keyType: Type, valueType: Type, isReadonly: boolean, declaration: Node | undefined, components: Node[]) {
    this.keyType = keyType;
    this.valueType = valueType;
    this.isReadonly = isReadonly;
    this.declaration = declaration;
    this.components = components;
    this.indexSymbol = undefined;
  }
}

// Shared empty lists; never mutated.
export const emptyTypes: Type[] = [];
export const emptySymbols: Symbol[] = [];
export const emptySignatures: Signature[] = [];
export const emptyIndexInfos: IndexInfo[] = [];

// ---- Mappers

export const enum TypeMapperKind {
  Unknown = 0,
  Simple = 1,
  Array = 2,
  Merged = 3,
}

/** Maps type parameters to types. Subclasses replace tsgo's function mappers. */
export abstract class TypeMapper {
  abstract map(type: Type): Type;

  kind(): TypeMapperKind {
    return TypeMapperKind.Unknown;
  }

  /** Whether the mapper only maps a `this` type parameter. */
  mapsThisOnly(): boolean {
    return false;
  }
}

function isThisTypeParameter(type: Type): boolean {
  return (type.flags & TypeFlags.TypeParameter) !== 0 && (type as TypeParameter).isThisType;
}

export class SimpleTypeMapper extends TypeMapper {
  readonly source: Type;
  readonly target: Type;

  constructor(source: Type, target: Type) {
    super();
    this.source = source;
    this.target = target;
  }

  map(type: Type): Type {
    return type === this.source ? this.target : type;
  }

  kind(): TypeMapperKind {
    return TypeMapperKind.Simple;
  }

  mapsThisOnly(): boolean {
    return isThisTypeParameter(this.source);
  }
}

export class ArrayTypeMapper extends TypeMapper {
  readonly sources: Type[];
  readonly targets: Type[];

  constructor(sources: Type[], targets: Type[]) {
    super();
    this.sources = sources;
    this.targets = targets;
  }

  map(type: Type): Type {
    const sources = this.sources;
    for (let i = 0; i < sources.length; i++) if (type === sources[i]!) return this.targets[i]!;
    return type;
  }

  kind(): TypeMapperKind {
    return TypeMapperKind.Array;
  }

  mapsThisOnly(): boolean {
    return this.sources.length === 1 && isThisTypeParameter(this.sources[0]!);
  }
}

/** Maps each of `sources` to one target. */
export class ArrayToSingleTypeMapper extends TypeMapper {
  readonly sources: Type[];
  readonly target: Type;

  constructor(sources: Type[], target: Type) {
    super();
    this.sources = sources;
    this.target = target;
  }

  map(type: Type): Type {
    return this.sources.includes(type) ? this.target : type;
  }

  mapsThisOnly(): boolean {
    return this.sources.length === 1 && isThisTypeParameter(this.sources[0]!);
  }
}

/** Applies `m1`, then `m2`. */
export class MergedTypeMapper extends TypeMapper {
  readonly m1: TypeMapper;
  readonly m2: TypeMapper;

  constructor(m1: TypeMapper, m2: TypeMapper) {
    super();
    this.m1 = m1;
    this.m2 = m2;
  }

  map(type: Type): Type {
    return this.m2.map(this.m1.map(type));
  }

  kind(): TypeMapperKind {
    return TypeMapperKind.Merged;
  }
}

export function newTypeMapper(sources: Type[], targets: Type[]): TypeMapper {
  return sources.length === 1 ? new SimpleTypeMapper(sources[0]!, targets[0]!) : new ArrayTypeMapper(sources, targets);
}

export function mergeTypeMappers(m1: TypeMapper | undefined, m2: TypeMapper): TypeMapper {
  return m1 !== undefined ? new MergedTypeMapper(m1, m2) : m2;
}

export function prependTypeMapping(source: Type, target: Type, mapper: TypeMapper | undefined): TypeMapper {
  const simple = new SimpleTypeMapper(source, target);
  return mapper === undefined ? simple : new MergedTypeMapper(simple, mapper);
}

export function appendTypeMapping(mapper: TypeMapper | undefined, source: Type, target: Type): TypeMapper {
  const simple = new SimpleTypeMapper(source, target);
  return mapper === undefined ? simple : new MergedTypeMapper(mapper, simple);
}

// ---- Links

/** Fields of SymbolLinks that few symbol links set, allocated on first write. */
export class SymbolValueLinks {
  writeType: Type | undefined = undefined;
  /** Constituents of a deferred union/intersection property type. */
  deferralParent: Type | undefined = undefined;
  deferralConstituents: Type[] | undefined = undefined;
  deferralWriteConstituents: Type[] | undefined = undefined;
  /** For spread properties. */
  leftSpread: Symbol | undefined = undefined;
  rightSpread: Symbol | undefined = undefined;
  /** Bits of SymbolFlags for the meanings in which the symbol was referenced. */
  referenceKinds: number = 0;
}

/** Fields of SymbolLinks that few symbol links set, allocated on first write. */
export class SymbolRareLinks {
  functionOrConstructorChecked: boolean = false;
  immediateTarget: Symbol | undefined = undefined;
  aliasTarget: Symbol | undefined = undefined;
  aliasReferenced: boolean = false;
  typeOnlyDeclaration: Node | undefined = undefined;
  resolvedExports: SymbolTable | undefined = undefined;
  resolvedMembers: SymbolTable | undefined = undefined;
  /** Exports reached only through `export type *`, by name. */
  typeOnlyExportStarMap: Map<string, Node> | undefined = undefined;
  exportsChecked: boolean = false;
  lateSymbol: Symbol | undefined = undefined;
  declaredType: Type | undefined = undefined;
  /** Type parameters of a type alias. */
  typeParameters: Type[] | undefined = undefined;
  /** Instantiations of a generic type alias. */
  instantiations: Map<string, Type> | undefined = undefined;
  interfaceChecked: boolean = false;
  indexSignaturesChecked: boolean = false;
  typeParametersChecked: boolean = false;
  enumChecked: boolean = false;
  variances: VarianceFlags[] | undefined = undefined;
  lastAssignmentPos: number = 0;
  hasDefiniteAssignment: boolean = false;
  isConstructorDeclaredProperty: boolean = false;
  /** A `ThisAssignmentKind` plus one; zero until computed. */
  thisAssignmentKind: number = 0;
  thisAssignmentLocation: Node | undefined = undefined;
  reverseMappedPropertyType: Type | undefined = undefined;
  reverseMappedMappedType: Type | undefined = undefined;
  reverseMappedConstraintType: Type | undefined = undefined;
}

/** What the checker caches per symbol. */
export class SymbolLinks {
  type: Type | undefined;
  /** For instantiated and synthetic symbols, the symbol they come from. */
  target: Symbol | undefined;
  mapper: TypeMapper | undefined;
  nameType: Type | undefined;
  /** The mapped type of a mapped type property, or the union/intersection of a synthetic property. */
  containingType: Type | undefined;
  /** For mapped type properties. */
  keyType: Type | undefined;
  syntheticOrigin: Symbol | undefined;
  private symbolValueLinks: SymbolValueLinks | undefined;
  private symbolRareLinks: SymbolRareLinks | undefined;

  constructor() {
    this.type = undefined;
    this.target = undefined;
    this.mapper = undefined;
    this.nameType = undefined;
    this.containingType = undefined;
    this.keyType = undefined;
    this.syntheticOrigin = undefined;
    this.symbolValueLinks = undefined;
    this.symbolRareLinks = undefined;
  }

  private symbolValueLinksOrNew(): SymbolValueLinks {
    let group = this.symbolValueLinks;
    if (group === undefined) {
      group = new SymbolValueLinks();
      this.symbolValueLinks = group;
    }
    return group;
  }

  get writeType(): Type | undefined {
    const group = this.symbolValueLinks;
    return group === undefined ? undefined : group.writeType;
  }

  set writeType(value: Type | undefined) {
    if (value === undefined && this.symbolValueLinks === undefined) return;
    this.symbolValueLinksOrNew().writeType = value;
  }

  /** Constituents of a deferred union/intersection property type. */
  get deferralParent(): Type | undefined {
    const group = this.symbolValueLinks;
    return group === undefined ? undefined : group.deferralParent;
  }

  set deferralParent(value: Type | undefined) {
    if (value === undefined && this.symbolValueLinks === undefined) return;
    this.symbolValueLinksOrNew().deferralParent = value;
  }

  get deferralConstituents(): Type[] | undefined {
    const group = this.symbolValueLinks;
    return group === undefined ? undefined : group.deferralConstituents;
  }

  set deferralConstituents(value: Type[] | undefined) {
    if (value === undefined && this.symbolValueLinks === undefined) return;
    this.symbolValueLinksOrNew().deferralConstituents = value;
  }

  get deferralWriteConstituents(): Type[] | undefined {
    const group = this.symbolValueLinks;
    return group === undefined ? undefined : group.deferralWriteConstituents;
  }

  set deferralWriteConstituents(value: Type[] | undefined) {
    if (value === undefined && this.symbolValueLinks === undefined) return;
    this.symbolValueLinksOrNew().deferralWriteConstituents = value;
  }

  /** For spread properties. */
  get leftSpread(): Symbol | undefined {
    const group = this.symbolValueLinks;
    return group === undefined ? undefined : group.leftSpread;
  }

  set leftSpread(value: Symbol | undefined) {
    if (value === undefined && this.symbolValueLinks === undefined) return;
    this.symbolValueLinksOrNew().leftSpread = value;
  }

  get rightSpread(): Symbol | undefined {
    const group = this.symbolValueLinks;
    return group === undefined ? undefined : group.rightSpread;
  }

  set rightSpread(value: Symbol | undefined) {
    if (value === undefined && this.symbolValueLinks === undefined) return;
    this.symbolValueLinksOrNew().rightSpread = value;
  }

  /** Bits of SymbolFlags for the meanings in which the symbol was referenced. */
  get referenceKinds(): number {
    const group = this.symbolValueLinks;
    return group === undefined ? 0 : group.referenceKinds;
  }

  set referenceKinds(value: number) {
    if (value === 0 && this.symbolValueLinks === undefined) return;
    this.symbolValueLinksOrNew().referenceKinds = value;
  }

  private symbolRareLinksOrNew(): SymbolRareLinks {
    let group = this.symbolRareLinks;
    if (group === undefined) {
      group = new SymbolRareLinks();
      this.symbolRareLinks = group;
    }
    return group;
  }

  get functionOrConstructorChecked(): boolean {
    const group = this.symbolRareLinks;
    return group === undefined ? false : group.functionOrConstructorChecked;
  }

  set functionOrConstructorChecked(value: boolean) {
    if (value === false && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().functionOrConstructorChecked = value;
  }

  get immediateTarget(): Symbol | undefined {
    const group = this.symbolRareLinks;
    return group === undefined ? undefined : group.immediateTarget;
  }

  set immediateTarget(value: Symbol | undefined) {
    if (value === undefined && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().immediateTarget = value;
  }

  get aliasTarget(): Symbol | undefined {
    const group = this.symbolRareLinks;
    return group === undefined ? undefined : group.aliasTarget;
  }

  set aliasTarget(value: Symbol | undefined) {
    if (value === undefined && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().aliasTarget = value;
  }

  get aliasReferenced(): boolean {
    const group = this.symbolRareLinks;
    return group === undefined ? false : group.aliasReferenced;
  }

  set aliasReferenced(value: boolean) {
    if (value === false && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().aliasReferenced = value;
  }

  get typeOnlyDeclaration(): Node | undefined {
    const group = this.symbolRareLinks;
    return group === undefined ? undefined : group.typeOnlyDeclaration;
  }

  set typeOnlyDeclaration(value: Node | undefined) {
    if (value === undefined && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().typeOnlyDeclaration = value;
  }

  get resolvedExports(): SymbolTable | undefined {
    const group = this.symbolRareLinks;
    return group === undefined ? undefined : group.resolvedExports;
  }

  set resolvedExports(value: SymbolTable | undefined) {
    if (value === undefined && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().resolvedExports = value;
  }

  get resolvedMembers(): SymbolTable | undefined {
    const group = this.symbolRareLinks;
    return group === undefined ? undefined : group.resolvedMembers;
  }

  set resolvedMembers(value: SymbolTable | undefined) {
    if (value === undefined && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().resolvedMembers = value;
  }

  /** Exports reached only through `export type *`, by name. */
  get typeOnlyExportStarMap(): Map<string, Node> | undefined {
    const group = this.symbolRareLinks;
    return group === undefined ? undefined : group.typeOnlyExportStarMap;
  }

  set typeOnlyExportStarMap(value: Map<string, Node> | undefined) {
    if (value === undefined && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().typeOnlyExportStarMap = value;
  }

  get exportsChecked(): boolean {
    const group = this.symbolRareLinks;
    return group === undefined ? false : group.exportsChecked;
  }

  set exportsChecked(value: boolean) {
    if (value === false && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().exportsChecked = value;
  }

  get lateSymbol(): Symbol | undefined {
    const group = this.symbolRareLinks;
    return group === undefined ? undefined : group.lateSymbol;
  }

  set lateSymbol(value: Symbol | undefined) {
    if (value === undefined && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().lateSymbol = value;
  }

  get declaredType(): Type | undefined {
    const group = this.symbolRareLinks;
    return group === undefined ? undefined : group.declaredType;
  }

  set declaredType(value: Type | undefined) {
    if (value === undefined && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().declaredType = value;
  }

  /** Type parameters of a type alias. */
  get typeParameters(): Type[] | undefined {
    const group = this.symbolRareLinks;
    return group === undefined ? undefined : group.typeParameters;
  }

  set typeParameters(value: Type[] | undefined) {
    if (value === undefined && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().typeParameters = value;
  }

  /** Instantiations of a generic type alias. */
  get instantiations(): Map<string, Type> | undefined {
    const group = this.symbolRareLinks;
    return group === undefined ? undefined : group.instantiations;
  }

  set instantiations(value: Map<string, Type> | undefined) {
    if (value === undefined && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().instantiations = value;
  }

  get interfaceChecked(): boolean {
    const group = this.symbolRareLinks;
    return group === undefined ? false : group.interfaceChecked;
  }

  set interfaceChecked(value: boolean) {
    if (value === false && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().interfaceChecked = value;
  }

  get indexSignaturesChecked(): boolean {
    const group = this.symbolRareLinks;
    return group === undefined ? false : group.indexSignaturesChecked;
  }

  set indexSignaturesChecked(value: boolean) {
    if (value === false && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().indexSignaturesChecked = value;
  }

  get typeParametersChecked(): boolean {
    const group = this.symbolRareLinks;
    return group === undefined ? false : group.typeParametersChecked;
  }

  set typeParametersChecked(value: boolean) {
    if (value === false && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().typeParametersChecked = value;
  }

  get enumChecked(): boolean {
    const group = this.symbolRareLinks;
    return group === undefined ? false : group.enumChecked;
  }

  set enumChecked(value: boolean) {
    if (value === false && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().enumChecked = value;
  }

  get variances(): VarianceFlags[] | undefined {
    const group = this.symbolRareLinks;
    return group === undefined ? undefined : group.variances;
  }

  set variances(value: VarianceFlags[] | undefined) {
    if (value === undefined && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().variances = value;
  }

  get lastAssignmentPos(): number {
    const group = this.symbolRareLinks;
    return group === undefined ? 0 : group.lastAssignmentPos;
  }

  set lastAssignmentPos(value: number) {
    if (value === 0 && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().lastAssignmentPos = value;
  }

  get hasDefiniteAssignment(): boolean {
    const group = this.symbolRareLinks;
    return group === undefined ? false : group.hasDefiniteAssignment;
  }

  set hasDefiniteAssignment(value: boolean) {
    if (value === false && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().hasDefiniteAssignment = value;
  }

  get isConstructorDeclaredProperty(): boolean {
    const group = this.symbolRareLinks;
    return group === undefined ? false : group.isConstructorDeclaredProperty;
  }

  set isConstructorDeclaredProperty(value: boolean) {
    if (value === false && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().isConstructorDeclaredProperty = value;
  }

  /** A `ThisAssignmentKind` plus one; zero until computed. */
  get thisAssignmentKind(): number {
    const group = this.symbolRareLinks;
    return group === undefined ? 0 : group.thisAssignmentKind;
  }

  set thisAssignmentKind(value: number) {
    if (value === 0 && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().thisAssignmentKind = value;
  }

  get thisAssignmentLocation(): Node | undefined {
    const group = this.symbolRareLinks;
    return group === undefined ? undefined : group.thisAssignmentLocation;
  }

  set thisAssignmentLocation(value: Node | undefined) {
    if (value === undefined && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().thisAssignmentLocation = value;
  }

  get reverseMappedPropertyType(): Type | undefined {
    const group = this.symbolRareLinks;
    return group === undefined ? undefined : group.reverseMappedPropertyType;
  }

  set reverseMappedPropertyType(value: Type | undefined) {
    if (value === undefined && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().reverseMappedPropertyType = value;
  }

  get reverseMappedMappedType(): Type | undefined {
    const group = this.symbolRareLinks;
    return group === undefined ? undefined : group.reverseMappedMappedType;
  }

  set reverseMappedMappedType(value: Type | undefined) {
    if (value === undefined && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().reverseMappedMappedType = value;
  }

  get reverseMappedConstraintType(): Type | undefined {
    const group = this.symbolRareLinks;
    return group === undefined ? undefined : group.reverseMappedConstraintType;
  }

  set reverseMappedConstraintType(value: Type | undefined) {
    if (value === undefined && this.symbolRareLinks === undefined) return;
    this.symbolRareLinksOrNew().reverseMappedConstraintType = value;
  }
}

/** Fields of NodeLinks that few node links set, allocated on first write. */
export class NodeRareLinks {
  /** Outer type parameters of an anonymous object type node. */
  outerTypeParameters: Type[] | undefined = undefined;
  /** Type of an assertion's operand. */
  assertionExpressionType: Type | undefined = undefined;
  /** Context-free type of an expression. */
  contextFreeType: Type | undefined = undefined;
  /** Enum member value: a string, or a number when `enumValueIsNumber`. */
  enumStringValue: string = '';
  enumNumberValue: number = 0;
  enumValueKind: number = 0;
  hasReportedStatementInAmbientContext: boolean = false;
  declarationRequiresScopeChange: number = 0;
  /** For source files: whether the file has been checked, and its nodes waiting for a deferred check. */
  typeChecked: boolean = false;
  deferredNodes: Node[] | undefined = undefined;
  /** Case clause types of a switch statement. */
  switchTypes: Type[] | undefined = undefined;
  /** `typeof` case texts of a switch statement; '' for default and duplicates. */
  switchWitnesses: string[] | undefined = undefined;
  switchWitnessesValid: boolean = false;
  /** 0 unknown, 1 computing, 2 not exhaustive, 3 exhaustive. */
  exhaustiveState: number = 0;
  /** The signature the runtime calls a decorator of this declaration with. */
  decoratorSignature: Signature | undefined = undefined;
  /** Whether a function body references `arguments`: 0 until computed, 1 for no, 2 for yes. */
  containsArgumentsReference: number = 0;
}

/** What the checker caches per node. */
export class NodeLinks {
  flags: NodeCheckFlags;
  /** Resolved symbol of an identifier, entity name or call. */
  resolvedSymbol: Symbol | undefined;
  /** Resolved type of a type node or expression. */
  resolvedType: Type | undefined;
  resolvedSignature: Signature | undefined;
  effectsSignature: Signature | undefined;
  private nodeRareLinks: NodeRareLinks | undefined;

  constructor() {
    this.flags = NodeCheckFlags.None;
    this.resolvedSymbol = undefined;
    this.resolvedType = undefined;
    this.resolvedSignature = undefined;
    this.effectsSignature = undefined;
    this.nodeRareLinks = undefined;
  }

  private nodeRareLinksOrNew(): NodeRareLinks {
    let group = this.nodeRareLinks;
    if (group === undefined) {
      group = new NodeRareLinks();
      this.nodeRareLinks = group;
    }
    return group;
  }

  /** Outer type parameters of an anonymous object type node. */
  get outerTypeParameters(): Type[] | undefined {
    const group = this.nodeRareLinks;
    return group === undefined ? undefined : group.outerTypeParameters;
  }

  set outerTypeParameters(value: Type[] | undefined) {
    if (value === undefined && this.nodeRareLinks === undefined) return;
    this.nodeRareLinksOrNew().outerTypeParameters = value;
  }

  /** Type of an assertion's operand. */
  get assertionExpressionType(): Type | undefined {
    const group = this.nodeRareLinks;
    return group === undefined ? undefined : group.assertionExpressionType;
  }

  set assertionExpressionType(value: Type | undefined) {
    if (value === undefined && this.nodeRareLinks === undefined) return;
    this.nodeRareLinksOrNew().assertionExpressionType = value;
  }

  /** Context-free type of an expression. */
  get contextFreeType(): Type | undefined {
    const group = this.nodeRareLinks;
    return group === undefined ? undefined : group.contextFreeType;
  }

  set contextFreeType(value: Type | undefined) {
    if (value === undefined && this.nodeRareLinks === undefined) return;
    this.nodeRareLinksOrNew().contextFreeType = value;
  }

  /** Enum member value: a string, or a number when `enumValueIsNumber`. */
  get enumStringValue(): string {
    const group = this.nodeRareLinks;
    return group === undefined ? '' : group.enumStringValue;
  }

  set enumStringValue(value: string) {
    if (value === '' && this.nodeRareLinks === undefined) return;
    this.nodeRareLinksOrNew().enumStringValue = value;
  }

  get enumNumberValue(): number {
    const group = this.nodeRareLinks;
    return group === undefined ? 0 : group.enumNumberValue;
  }

  set enumNumberValue(value: number) {
    if (value === 0 && this.nodeRareLinks === undefined) return;
    this.nodeRareLinksOrNew().enumNumberValue = value;
  }

  get enumValueKind(): number {
    const group = this.nodeRareLinks;
    return group === undefined ? 0 : group.enumValueKind;
  }

  set enumValueKind(value: number) {
    if (value === 0 && this.nodeRareLinks === undefined) return;
    this.nodeRareLinksOrNew().enumValueKind = value;
  }

  get hasReportedStatementInAmbientContext(): boolean {
    const group = this.nodeRareLinks;
    return group === undefined ? false : group.hasReportedStatementInAmbientContext;
  }

  set hasReportedStatementInAmbientContext(value: boolean) {
    if (value === false && this.nodeRareLinks === undefined) return;
    this.nodeRareLinksOrNew().hasReportedStatementInAmbientContext = value;
  }

  get declarationRequiresScopeChange(): number {
    const group = this.nodeRareLinks;
    return group === undefined ? 0 : group.declarationRequiresScopeChange;
  }

  set declarationRequiresScopeChange(value: number) {
    if (value === 0 && this.nodeRareLinks === undefined) return;
    this.nodeRareLinksOrNew().declarationRequiresScopeChange = value;
  }

  /** For source files: whether the file has been checked, and its nodes waiting for a deferred check. */
  get typeChecked(): boolean {
    const group = this.nodeRareLinks;
    return group === undefined ? false : group.typeChecked;
  }

  set typeChecked(value: boolean) {
    if (value === false && this.nodeRareLinks === undefined) return;
    this.nodeRareLinksOrNew().typeChecked = value;
  }

  get deferredNodes(): Node[] | undefined {
    const group = this.nodeRareLinks;
    return group === undefined ? undefined : group.deferredNodes;
  }

  set deferredNodes(value: Node[] | undefined) {
    if (value === undefined && this.nodeRareLinks === undefined) return;
    this.nodeRareLinksOrNew().deferredNodes = value;
  }

  /** Case clause types of a switch statement. */
  get switchTypes(): Type[] | undefined {
    const group = this.nodeRareLinks;
    return group === undefined ? undefined : group.switchTypes;
  }

  set switchTypes(value: Type[] | undefined) {
    if (value === undefined && this.nodeRareLinks === undefined) return;
    this.nodeRareLinksOrNew().switchTypes = value;
  }

  /** `typeof` case texts of a switch statement; '' for default and duplicates. */
  get switchWitnesses(): string[] | undefined {
    const group = this.nodeRareLinks;
    return group === undefined ? undefined : group.switchWitnesses;
  }

  set switchWitnesses(value: string[] | undefined) {
    if (value === undefined && this.nodeRareLinks === undefined) return;
    this.nodeRareLinksOrNew().switchWitnesses = value;
  }

  get switchWitnessesValid(): boolean {
    const group = this.nodeRareLinks;
    return group === undefined ? false : group.switchWitnessesValid;
  }

  set switchWitnessesValid(value: boolean) {
    if (value === false && this.nodeRareLinks === undefined) return;
    this.nodeRareLinksOrNew().switchWitnessesValid = value;
  }

  /** 0 unknown, 1 computing, 2 not exhaustive, 3 exhaustive. */
  get exhaustiveState(): number {
    const group = this.nodeRareLinks;
    return group === undefined ? 0 : group.exhaustiveState;
  }

  set exhaustiveState(value: number) {
    if (value === 0 && this.nodeRareLinks === undefined) return;
    this.nodeRareLinksOrNew().exhaustiveState = value;
  }

  /** The signature the runtime calls a decorator of this declaration with. */
  get decoratorSignature(): Signature | undefined {
    const group = this.nodeRareLinks;
    return group === undefined ? undefined : group.decoratorSignature;
  }

  set decoratorSignature(value: Signature | undefined) {
    if (value === undefined && this.nodeRareLinks === undefined) return;
    this.nodeRareLinksOrNew().decoratorSignature = value;
  }

  /** Whether a function body references `arguments`: 0 until computed, 1 for no, 2 for yes. */
  get containsArgumentsReference(): number {
    const group = this.nodeRareLinks;
    return group === undefined ? 0 : group.containsArgumentsReference;
  }

  set containsArgumentsReference(value: number) {
    if (value === 0 && this.nodeRareLinks === undefined) return;
    this.nodeRareLinksOrNew().containsArgumentsReference = value;
  }
}
