// Dense IDs replace Go pointers at the boundary; the checking logic is native TypeScript.
import { ObjectFlags, SymbolFlags } from './flags.js';
export interface Property {
  name: string;
  numeric: boolean;
  numericName: string;
  keyType: number;
  type: number;
  optional: boolean;
  readonly: boolean;
  privateOrigin: number;
}

export interface Signature {
  id: number;
  typeParameters: number[];
  tailTypes: number[];
  nonArrayRest: boolean;
  parameters: number[];
  minArgumentCount: number;
  restType: number;
  effectiveRest: number;
  returnType: number;
  thisType: number;
  bivariant: boolean;
  generic: boolean;
  abstract: boolean;
  predicateKind: number;
  predicateIndex: number;
  predicateType: number;
  unsupported: string;
}

export interface EnumMember {
  name: string;
  kind: number; // 0: unknown numeric value; 1: number; 2: string
  value: string;
}

export interface IndexInfo {
  keyType: number;
  type: number;
  readonly: boolean;
}

export interface TypeData {
  flags: number;
  symbolFlags: number;
  objectFlags: number;
  name: string;
  value: string;
  regularType: number;
  apparentType: number;
  target: number;
  typeParameters: number[];
  typeArguments: number[];
  thisTypeParameter: number;
  defaultType: number;
  varianceAnnotation: number;
  indexObject: number;
  indexKey: number;
  indexFlags: number;
  accessFlags: number;
  numericKey: boolean;
  numericString: boolean;
  templateTexts: string[];
  stringMapping: number; // 0: none; 1/2/3/4: Uppercase/Lowercase/Capitalize/Uncapitalize
  tupleIndex: number;
  keyName: string;
  numericName: string;
  missing: boolean;
  mappedParameter: number;
  mappedConstraint: number;
  mappedTemplate: number;
  mappedName: number;
  mappedModifiers: number;
  mappedModifiersType: number;
  mappedHomomorphic: number;
  mappedKeyof: boolean;
  conditionalCheck: number;
  conditionalExtends: number;
  conditionalTrue: number;
  conditionalFalse: number;
  conditionalInfer: number[];
  conditionalDistributive: boolean;
  conditionalTuples: boolean;
  conditionalDependent: boolean;
  conditionalAlias: boolean;
  conditionalNestedFalse: boolean;
  enumOrigin: number;
  enumName: string;
  enumMemberName: string;
  enumRegular: boolean;
  enumMembers: EnumMember[];
  enumNumberIndex: boolean;
  types: number[];
  properties: Property[];
  fallbackProperties: Property[];
  calls: Signature[];
  constructs: Signature[];
  stringIndex: number;
  numberIndex: number;
  symbolIndex: number;
  indexReadonly: number; // string/number/symbol bits: 1/2/4
  patternIndexes: IndexInfo[];
  arrayElement: number;
  tupleElements: number[];
  tupleFlags: number[];
  readonly: boolean;
  constraint: number;
  unsupported: string;
}

export interface Query {
  source: number;
  target: number;
  expected: boolean;
  label: string;
}

export interface Graph {
  schema: string;
  revision: string;
  strictNullChecks: boolean;
  strictFunctionTypes: boolean;
  exactOptionalPropertyTypes: boolean;
  types: TypeData[];
  queries: Query[];
}

export class Type {
  id = -1;
  signatureOrigin = -1;
  marker = false;
  mappedPrepared = false;
  mappedGeneric = -1;
  conditionalPrepared = false;
  restrictive = false;
  wildcard = false;
  readonly data: TypeData;
  readonly flags: number;
  readonly objectFlags: number;
  inferableIndex: boolean;
  readonly name: string;
  readonly value: string;
  readonly regularType: number;
  readonly apparentType: number;
  types: number[];
  properties: Property[];
  lookupProperties: Property[];
  readonly propertyIndex = new Map<string, number>();
  calls: Signature[];
  constructs: Signature[];
  stringIndex: number;
  numberIndex: number;
  symbolIndex: number;
  indexReadonly: number;
  patternIndexes: IndexInfo[];
  membersResolved: boolean;
  membersVersion = 0;
  readonly arrayElement: number;
  readonly tupleElements: number[];
  readonly tupleFlags: number[];
  readonly readonly: boolean;
  constraint: number;
  defaultType: number;
  readonly unsupported: string;

  constructor(data: TypeData) {
    this.data = data;
    this.membersResolved = data.target < 0 && (data.objectFlags & (ObjectFlags.Mapped | ObjectFlags.Tuple)) === 0;
    this.flags = data.flags;
    this.objectFlags = data.objectFlags;
    this.inferableIndex =
      ((data.symbolFlags &
        (SymbolFlags.ObjectLiteral | SymbolFlags.TypeLiteral | SymbolFlags.Enum | SymbolFlags.ValueModule)) !==
        0 &&
        (data.symbolFlags & SymbolFlags.Class) === 0 &&
        data.calls.length === 0 &&
        data.constructs.length === 0) ||
      (data.objectFlags & (ObjectFlags.JSLiteral | ObjectFlags.ObjectRestType)) !== 0;
    this.name = data.name;
    this.value = data.value;
    this.regularType = data.regularType;
    this.apparentType = data.apparentType;
    this.types = data.types;
    this.properties = data.properties;
    this.lookupProperties = data.properties.concat(data.fallbackProperties);
    for (let i = 0; i < this.lookupProperties.length; i++) this.propertyIndex.set(this.lookupProperties[i].name, i);
    this.calls = data.calls;
    this.constructs = data.constructs;
    this.stringIndex = data.stringIndex;
    this.numberIndex = data.numberIndex;
    this.symbolIndex = data.symbolIndex;
    this.indexReadonly = data.indexReadonly;
    this.patternIndexes = data.patternIndexes;
    this.arrayElement = data.arrayElement;
    this.tupleElements = data.tupleElements;
    this.tupleFlags = data.tupleFlags;
    this.readonly = data.readonly;
    this.constraint = data.constraint;
    this.defaultType = data.defaultType;
    this.unsupported = data.unsupported;
  }

  setMembers(
    properties: Property[],
    fallbacks: Property[],
    calls: Signature[],
    constructs: Signature[],
    stringIndex: number,
    numberIndex: number,
    symbolIndex: number,
    patterns: IndexInfo[] = [],
    indexReadonly: number = 0,
  ): void {
    this.membersVersion++;
    this.data.properties = properties;
    this.data.fallbackProperties = fallbacks;
    this.data.calls = calls;
    this.data.constructs = constructs;
    this.data.stringIndex = stringIndex;
    this.data.numberIndex = numberIndex;
    this.data.symbolIndex = symbolIndex;
    this.data.patternIndexes = patterns;
    this.data.indexReadonly = indexReadonly;
    this.properties = properties;
    this.lookupProperties = properties.concat(fallbacks);
    this.propertyIndex.clear();
    for (let i = 0; i < this.lookupProperties.length; i++) this.propertyIndex.set(this.lookupProperties[i].name, i);
    this.calls = calls;
    this.constructs = constructs;
    this.stringIndex = stringIndex;
    this.numberIndex = numberIndex;
    this.symbolIndex = symbolIndex;
    this.patternIndexes = patterns;
    this.indexReadonly = indexReadonly;
    this.inferableIndex =
      ((this.data.symbolFlags &
        (SymbolFlags.ObjectLiteral | SymbolFlags.TypeLiteral | SymbolFlags.Enum | SymbolFlags.ValueModule)) !==
        0 &&
        (this.data.symbolFlags & SymbolFlags.Class) === 0 &&
        calls.length === 0 &&
        constructs.length === 0) ||
      (this.objectFlags & (ObjectFlags.JSLiteral | ObjectFlags.ObjectRestType)) !== 0;
  }
}
