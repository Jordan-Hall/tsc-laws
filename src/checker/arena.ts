// Native type substitution and lazy reference members, adapted from tsgo's
// instantiateType/instantiateSignature/resolveTypeReferenceMembers.
// Copyright Microsoft Corporation. Licensed under Apache-2.0.
import { TypeFlags as F, ObjectFlags as O, ElementFlags as E } from './flags.js';
import { Type, type TypeData, type Property, type Signature, type IndexInfo } from './types.js';
import { IndexedTypes } from './indexed-types.js';
import { MappedTypes } from './mapped-types.js';
import { ConditionalTypes } from './conditional-types.js';
import { TupleTypes } from './tuple-types.js';
import { TemplateTypes } from './template-types.js';
import { IndexSignatures } from './index-signatures.js';
import { StringMappings } from './string-mappings.js';
import { decodeBytes, numericText, validNumber } from './js-string.js';

export const TYPE_ID_STRIDE = 1048576;

export class Mapper {
  readonly substitutions = new Map<number, number>();
  readonly memo = new Map<number, number>();
  readonly signatures = new Map<number, Signature>();
  constructor(readonly sources: number[], readonly targets: number[], readonly mode: number = 0) {
    for (let i = 0; i < sources.length; i++) this.substitutions.set(sources[i], targets[i]);
  }
}

export function emptyType(flags: number): TypeData {
  return { flags, symbolFlags: 0, objectFlags: 0, name: '', value: '', regularType: -1, apparentType: -1,
    target: -1, typeParameters: [], typeArguments: [], thisTypeParameter: -1, defaultType: -1, varianceAnnotation: -1,
    indexObject: -1, indexKey: -1, indexFlags: 0, accessFlags: 0, numericKey: false, numericString: false, templateTexts: [], stringMapping: 0, tupleIndex: -1,
    keyName: '', numericName: '', missing: false, mappedParameter: -1, mappedConstraint: -1,
    mappedTemplate: -1, mappedName: -1, mappedModifiers: 0, mappedModifiersType: -1, mappedHomomorphic: -1, mappedKeyof: false,
    conditionalCheck: -1, conditionalExtends: -1, conditionalTrue: -1, conditionalFalse: -1,
    conditionalInfer: [], conditionalDistributive: false, conditionalTuples: false, conditionalDependent: false,
    conditionalAlias: false, conditionalNestedFalse: false,
    enumOrigin: -1, enumName: '', enumMemberName: '', enumRegular: false, enumMembers: [], enumNumberIndex: false,
    types: [], properties: [], fallbackProperties: [], calls: [], constructs: [], stringIndex: -1,
    numberIndex: -1, symbolIndex: -1, indexReadonly: 0, patternIndexes: [], arrayElement: -1, tupleElements: [], tupleFlags: [], readonly: false,
    constraint: -1, unsupported: '' };
}

export class TypeArena {
  readonly indexed: IndexedTypes;
  readonly mapped: MappedTypes;
  readonly conditional: ConditionalTypes;
  readonly tuples: TupleTypes;
  readonly strings: TemplateTypes;
  readonly indexes: IndexSignatures;
  readonly stringMappings: StringMappings;
  private readonly references = new Map<string, number>();
  private readonly combinations = new Map<string, number>();
  private readonly mappers = new Map<string, Mapper>();
  private readonly templates = new Map<number, number>();
  private readonly templateMappers = new Map<number, Mapper>();
  private readonly enumRelations = new Map<number, boolean>();
  private readonly enumMemberIndexes = new Map<number, Map<string, number>>();
  private readonly intrinsics = new Map<number, number>();
  private readonly literals = new Map<string, number>();
  private mutableArrayTarget = -1;
  private readonlyArrayTarget = -1;
  private missingType = -1;
  private nextSignatureId = 0;

  constructor(readonly types: Type[], readonly flags: Uint32Array, readonly regular: Int32Array, readonly strictNullChecks: boolean, readonly exactOptionalPropertyTypes: boolean) {
    for (let i = 0; i < types.length; i++) {
      const d = types[i].data;
      if ((d.flags & F.Intrinsic) !== 0 && !d.missing) this.intrinsics.set(d.flags, i);
      if (d.missing) this.missingType = i;
      if ((d.flags & F.Literal) !== 0 && d.regularType < 0) this.literals.set(d.flags + ':' + d.value, i);
      if (d.target < 0 && d.arrayElement >= 0) {
        if (d.readonly) this.readonlyArrayTarget = i; else this.mutableArrayTarget = i;
      }
      if ((d.flags & F.Union) !== 0 && d.types.length === 2 && (types[d.types[0]].flags & F.BooleanLiteral) !== 0 && (types[d.types[1]].flags & F.BooleanLiteral) !== 0) this.intrinsics.set(F.Boolean, i);
      if (d.target >= 0) this.references.set(this.referenceKey(d.target, d.typeArguments), i);
      if ((d.flags & F.UnionOrIntersection) !== 0) this.combinations.set(this.combinationKey(d.flags & F.UnionOrIntersection, d.types), i);
      if ((d.flags & F.Substitution) !== 0 && d.constraint >= 0 && (types[d.constraint].flags & F.Unknown) !== 0) this.combinations.set('noinfer:' + d.indexObject, i);
      for (const sig of d.calls.concat(d.constructs)) this.nextSignatureId = Math.max(this.nextSignatureId, sig.id + 1);
    }
    this.tuples = new TupleTypes(this);
    this.indexed = new IndexedTypes(this, strictNullChecks);
    this.mapped = new MappedTypes(this);
    this.conditional = new ConditionalTypes(this);
    this.strings = new TemplateTypes(this);
    this.stringMappings = new StringMappings(this);
    this.indexes = new IndexSignatures(this);
  }

  add(data: TypeData): number {
    const id = this.types.length;
    if (id >= TYPE_ID_STRIDE) throw new Error('Type arena exceeds the numeric relation-key limit');
    this.types.push(new Type(data));
    this.types[id].id = id;
    this.types[id].signatureOrigin = id;
    this.flags[id] = data.flags;
    this.regular[id] = data.regularType;
    return id;
  }

  // Declaration compatibility from relater.go isEnumTypeRelatedTo. Its cache
  // survives ordinary relation resets, as it does in tsgo.
  enumRelated(source: number, target: number): boolean {
    const s = this.types[source].data.enumOrigin;
    const t = this.types[target].data.enumOrigin;
    if (s < 0 || t < 0) throw new Error('Missing enum declaration metadata');
    if (s === t) return true;
    const sourceEnum = this.types[s].data;
    const targetEnum = this.types[t].data;
    if (sourceEnum.enumName !== targetEnum.enumName || !sourceEnum.enumRegular || !targetEnum.enumRegular) return false;
    const key = s * TYPE_ID_STRIDE + t;
    const previous = this.enumRelations.get(key);
    if (previous !== undefined) return previous;
    let indexes = this.enumMemberIndexes.get(t);
    if (indexes === undefined) {
      indexes = new Map<string, number>();
      for (let i = 0; i < targetEnum.enumMembers.length; i++) indexes.set(targetEnum.enumMembers[i].name, i);
      this.enumMemberIndexes.set(t, indexes);
    }
    for (const member of sourceEnum.enumMembers) {
      const index = indexes.get(member.name);
      if (index === undefined) { this.enumRelations.set(key, false); return false; }
      const other = targetEnum.enumMembers[index];
      if (member.kind !== other.kind || member.value !== other.value) {
        if (member.kind !== 0 && other.kind !== 0 || member.kind === 2 || other.kind === 2) { this.enumRelations.set(key, false); return false; }
      }
    }
    this.enumRelations.set(key, true);
    return true;
  }

  intrinsic(flags: number): number {
    const existing = this.intrinsics.get(flags);
    if (existing !== undefined) return existing;
    const id = this.add(emptyType(flags));
    this.intrinsics.set(flags, id);
    return id;
  }

  literal(flags: number, value: string): number {
    const key = flags + ':' + value;
    const previous = this.literals.get(key);
    if (previous !== undefined) return Number(previous);
    const data = emptyType(flags);
    data.value = value;
    if ((flags & F.StringLiteral) !== 0) {
      data.keyName = value;
      const bytes = decodeBytes(value);
      const text = numericText(bytes);
      data.numericString = validNumber(bytes, false);
      data.numericKey = text !== '' && String(Number(text)) === text;
      if (data.numericKey) data.numericName = text;
      const index = Number(text);
      if (data.numericKey && Number.isInteger(index) && index >= 0) data.tupleIndex = index;
    }
    const broad = (flags & F.StringLiteral) !== 0 ? F.String : (flags & F.NumberLiteral) !== 0 ? F.Number : (flags & F.BigIntLiteral) !== 0 ? F.BigInt : F.Boolean;
    data.apparentType = this.types[this.intrinsic(Number(broad))].apparentType;
    const result = this.add(data);
    this.literals.set(key, result);
    return Number(result);
  }

  optionalType(): number {
    if (!this.exactOptionalPropertyTypes) return Number(this.intrinsic(F.Undefined));
    if (this.missingType < 0) { const data = emptyType(F.Undefined); data.missing = true; this.missingType = this.add(data); }
    return Number(this.missingType);
  }

  removeOptional(id: number, missingOnly: boolean): number {
    const type = this.types[id];
    const parts = (type.flags & F.Union) !== 0 ? type.types : [id];
    const kept: number[] = [];
    for (const part of parts) if (missingOnly ? !this.types[part].data.missing : (this.types[part].flags & F.Undefined) === 0) kept.push(part);
    return Number(this.combine(kept, F.Union));
  }

  // Only decimal tuple positions are synthesized here. Other names remain
  // opaque oracle bytes, including lone surrogates and unique symbols.
  positionKey(pos: number, numeric: boolean): number {
    const value = String(pos);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let encoded = '';
    for (let i = 0; i < value.length; i += 3) {
      const a = value.charCodeAt(i);
      const b = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      const c = i + 2 < value.length ? value.charCodeAt(i + 2) : 0;
      encoded += alphabet[(a >> 2) & 63] + alphabet[((a & 3) << 4) | (b >> 4)]
        + (i + 1 < value.length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=')
        + (i + 2 < value.length ? alphabet[c & 63] : '=');
    }
    const flags = numeric ? F.NumberLiteral : F.StringLiteral;
    const literalValue = numeric ? value : encoded;
    const cacheKey = flags + ':' + literalValue;
    const previous = this.literals.get(cacheKey);
    if (previous !== undefined) return Number(previous);
    const data = emptyType(flags);
    data.value = literalValue; data.keyName = encoded; data.numericName = value;
    data.numericString = !numeric;
    data.numericKey = !numeric; data.tupleIndex = pos;
    data.apparentType = this.types[this.intrinsic(numeric ? F.Number : F.String)].apparentType;
    const result = this.add(data);
    this.literals.set(cacheKey, result);
    return Number(result);
  }

  array(element: number, readonly: boolean): number {
    const target = readonly ? this.readonlyArrayTarget : this.mutableArrayTarget;
    if (target < 0) throw new Error('Missing native array declaration template');
    return Number(this.instantiate(Number(target), this.mapper(this.types[target].data.typeParameters, [element])));
  }

  tuple(elements: number[], flags: number[], readonly: boolean): number {
    return Number(this.tuples.create(elements, flags, readonly));
  }

  mapper(sources: number[], targets: number[], mode: number = 0): Mapper {
    if (sources.length !== targets.length) throw new Error('Invalid type mapper arity');
    const key = sources.join(',') + ':' + targets.join(',') + ':' + mode;
    const previous = this.mappers.get(key);
    if (previous !== undefined) return previous;
    const result = new Mapper(sources.slice(), targets.slice(), mode);
    this.mappers.set(key, result);
    return result;
  }

  private referenceKey(target: number, arguments_: number[]): string { return target + ':' + arguments_.join(','); }
  private combinationKey(flags: number, parts: number[]): string { return flags + ':' + parts.join(','); }

  instantiate(id: number, mapper: Mapper): number {
    if (id < 0) return Number(id);
    const mapped = mapper.substitutions.get(id);
    if (mapped !== undefined) return Number(mapped);
    const memo = mapper.memo.get(id);
    if (memo !== undefined) return Number(memo);
    const type = this.types[id];
    if ((type.flags & F.TypeParameter) !== 0 && mapper.mode !== 0) return Number(this.conditional.parameter(Number(id), mapper.mode));
    if ((type.flags & F.Conditional) !== 0) return Number(this.conditional.instantiate(Number(id), mapper));
    if ((type.flags & F.TemplateLiteral) !== 0) return Number(this.strings.instantiate(Number(id), mapper));
    if ((type.flags & F.StringMapping) !== 0) return Number(this.stringMappings.instantiate(Number(id), mapper));
    if ((type.objectFlags & O.Tuple) !== 0) return Number(this.tuples.instantiate(Number(id), mapper));
    // Compose lazy anonymous-object mappers instead of eagerly expanding
    // library prototype methods during a second substitution.
    const template = this.templates.get(id);
    if (template !== undefined) {
      const inner = this.templateMappers.get(id);
      if (inner === undefined) throw new Error('Missing template mapper');
      const sources = mapper.sources.concat(inner.sources);
      const targets = mapper.targets.slice();
      for (const target of inner.targets) targets.push(this.instantiate(Number(target), mapper));
      const result = this.instantiate(Number(template), this.mapper(sources, targets, inner.mode !== 0 ? inner.mode : mapper.mode));
      mapper.memo.set(id, result);
      return Number(result);
    }
    const d = type.data;
    if ((type.flags & F.Substitution) !== 0 && type.unsupported.length === 0) {
      const base = this.instantiate(Number(d.indexObject), mapper);
      const result = this.isNoInfer(Number(id)) ? this.noInfer(Number(base)) : this.substitution(Number(base), Number(this.instantiate(Number(d.constraint), mapper)));
      mapper.memo.set(id, result);
      return Number(result);
    }
    if ((type.objectFlags & O.Mapped) !== 0) return Number(this.mapped.instantiate(Number(id), mapper));
    if ((type.flags & (F.Index | F.IndexedAccess)) !== 0) {
      const object = this.instantiate(Number(d.indexObject), mapper);
      const result = (type.flags & F.Index) !== 0 ? this.indexed.keyof(Number(object), d.indexFlags)
        : this.indexed.access(Number(object), Number(this.instantiate(Number(d.indexKey), mapper)), d.accessFlags);
      const resolved = result >= 0 ? result : this.intrinsic(F.Unknown);
      mapper.memo.set(id, resolved);
      return Number(resolved);
    }
    if ((type.flags & (F.Object | F.UnionOrIntersection)) === 0) return Number(id);
    if ((type.flags & F.UnionOrIntersection) !== 0) {
      const parts = this.instantiateList(d.types, mapper);
      const result = this.combine(parts, type.flags & F.UnionOrIntersection);
      mapper.memo.set(id, result);
      return Number(result);
    }
    if (d.target >= 0 || (d.objectFlags & O.Reference) !== 0 && d.typeParameters.length > 0) {
      const target = d.target >= 0 ? d.target : id;
      const original = d.target >= 0 ? d.typeArguments : d.typeParameters;
      const args = this.instantiateList(original, mapper);
      let changed = false;
      for (let i = 0; i < args.length; i++) if (args[i] !== original[i]) changed = true;
      if (!changed) return Number(id);
      const key = this.referenceKey(target, args);
      const previous = this.references.get(key);
      if (previous !== undefined) { mapper.memo.set(id, previous); return Number(previous); }
      const data: TypeData = { ...d, target, typeArguments: args, typeParameters: [], thisTypeParameter: -1,
        arrayElement: this.instantiate(Number(d.arrayElement), mapper),
        tupleElements: this.instantiateList(d.tupleElements, mapper),
        numberIndex: this.instantiate(Number(d.numberIndex), mapper),
        stringIndex: this.instantiate(Number(d.stringIndex), mapper),
        symbolIndex: this.instantiate(Number(d.symbolIndex), mapper),
        patternIndexes: [],
        properties: [], fallbackProperties: [], calls: [], constructs: [] };
      const result = this.add(data);
      this.references.set(key, result);
      mapper.memo.set(id, result);
      return Number(result);
    }
    // Reserve before visiting members so recursive object templates close cycles.
    const data: TypeData = { ...d, objectFlags: d.objectFlags | O.Instantiated, properties: [], fallbackProperties: [], calls: [], constructs: [], patternIndexes: [] };
    const result = this.add(data);
    mapper.memo.set(id, result);
    this.types[result].membersResolved = false;
    this.types[result].signatureOrigin = type.signatureOrigin;
    this.templates.set(result, id);
    this.templateMappers.set(result, mapper);
    return Number(result);
  }

  private instantiateList(ids: number[], mapper: Mapper): number[] {
    const result: number[] = [];
    for (const id of ids) result.push(this.instantiate(Number(id), mapper));
    return result;
  }

  substitution(base: number, constraint: number): number {
    const type = this.types[base];
    if ((this.types[constraint].flags & F.AnyOrUnknown) !== 0 || (type.flags & F.Any) !== 0 || base === constraint || type.constraint === constraint) return Number(base);
    if ((type.flags & F.TypeVariable) === 0) return Number(this.substitutionIntersection(Number(base), Number(constraint)));
    const key = 'substitution:' + base + ':' + constraint;
    const previous = this.combinations.get(key);
    if (previous !== undefined) return Number(previous);
    const data = emptyType(F.Substitution);
    data.indexObject = base; data.constraint = constraint;
    const result = this.add(data);
    this.combinations.set(key, result);
    return Number(result);
  }

  isNoInfer(id: number): boolean {
    const type = this.types[id];
    return (type.flags & F.Substitution) !== 0 && type.constraint >= 0 && (this.types[type.constraint].flags & F.Unknown) !== 0;
  }

  noInfer(base: number): number {
    if (!this.noInferTarget(Number(base))) return Number(base);
    const key = 'noinfer:' + base;
    const previous = this.combinations.get(key);
    if (previous !== undefined) return Number(previous);
    const data = emptyType(F.Substitution);
    data.indexObject = base; data.constraint = this.intrinsic(F.Unknown);
    const result = this.add(data);
    this.combinations.set(key, result);
    return Number(result);
  }

  private noInferTarget(id: number): boolean {
    let type = this.types[id];
    if ((type.flags & F.UnionOrIntersection) !== 0) { for (const part of type.types) if (this.noInferTarget(Number(part))) return true; return false; }
    if ((type.flags & F.Substitution) !== 0) return !this.isNoInfer(Number(id)) && this.noInferTarget(Number(type.data.indexObject));
    if ((type.flags & F.Object) !== 0) {
      if ((type.objectFlags & O.Anonymous) === 0) return true;
      const template = this.templates.get(id);
      if (template !== undefined) type = this.types[template];
      return type.properties.length > 0 || type.calls.length > 0 || type.constructs.length > 0 || type.stringIndex >= 0 || type.numberIndex >= 0 || type.symbolIndex >= 0 || type.patternIndexes.length > 0;
    }
    return (type.flags & F.Instantiable) !== 0 && !((type.flags & (F.TemplateLiteral | F.StringMapping)) !== 0 && this.strings.pattern(Number(id)));
  }

  substitutionIntersection(base: number, constraint: number): number {
    return Number(this.keyType(Number(base)) && this.keyType(Number(constraint)) ? this.indexed.intersectKeys([base, constraint]) : this.combine([base, constraint], F.Intersection));
  }

  private keyType(id: number): boolean {
    const type = this.types[id];
    if ((type.flags & F.Union) !== 0) {
      for (const part of type.types) if (!this.keyType(Number(part))) return false;
      return true;
    }
    return (type.flags & (F.StringLike | F.NumberLike | F.ESSymbolLike | F.Never)) !== 0;
  }

  resolve(type: Type): void {
    if (type.membersResolved) return;
    type.membersResolved = true;
    if ((type.objectFlags & O.Tuple) !== 0) { this.resolveConstructedTuple(type); return; }
    if ((type.objectFlags & O.Mapped) !== 0) { this.mapped.resolve(type); return; }
    const templateId = this.templates.get(type.id);
    if (templateId === undefined && (type.flags & F.Intersection) !== 0) { this.resolveIntersection(type); return; }
    let d = type.data;
    let mapper: Mapper;
    if (templateId !== undefined) {
      d = this.types[templateId].data;
      const saved = this.templateMappers.get(type.id);
      if (saved === undefined) throw new Error('Missing template mapper');
      mapper = saved;
    } else {
      if (d.target < 0) throw new Error('Missing reference target');
      const referenceId = type.id;
      const args = d.typeArguments.slice();
      d = this.types[d.target].data;
      const params = d.typeParameters.slice();
      if (d.thisTypeParameter >= 0) {
        params.push(d.thisTypeParameter);
        if (args.length < params.length) args.push(referenceId);
      }
      mapper = this.mapper(params, args);
    }
    const properties = this.instantiateProperties(d.properties, mapper);
    const fallbacks = this.instantiateProperties(d.fallbackProperties, mapper);
    const calls: Signature[] = [];
    const constructs: Signature[] = [];
    for (const sig of d.calls) calls.push(this.signature(sig, mapper, false));
    for (const sig of d.constructs) constructs.push(this.signature(sig, mapper, false));
    const patterns: IndexInfo[] = [];
    for (const info of d.patternIndexes) patterns.push({ keyType: this.instantiate(Number(info.keyType), mapper), type: this.instantiate(Number(info.type), mapper), readonly: info.readonly });
    type.setMembers(properties, fallbacks, calls, constructs,
      this.instantiate(Number(d.stringIndex), mapper), this.instantiate(Number(d.numberIndex), mapper), this.instantiate(Number(d.symbolIndex), mapper), patterns, d.indexReadonly);
  }

  private resolveConstructedTuple(type: Type): void {
    const arrayTarget = type.readonly ? this.readonlyArrayTarget : this.mutableArrayTarget;
    if (arrayTarget < 0) throw new Error('Missing native array declaration template');
    const array = this.types[arrayTarget];
    const params = array.data.typeParameters.slice();
    const args = [type.numberIndex];
    if (array.data.thisTypeParameter >= 0) { params.push(array.data.thisTypeParameter); args.push(type.id); }
    const mapper = this.mapper(params, args);
    const properties: Property[] = [];
    let min = 0;
    let variable = false;
    let fixed = true;
    for (let i = 0; i < type.tupleElements.length; i++) {
      const flag = type.tupleFlags[i];
      if ((flag & E.Required) !== 0) min++;
      if ((flag & E.Variable) !== 0) { variable = true; fixed = false; }
      if (fixed) {
        const key = this.positionKey(Number(i), false);
        const optional = (flag & E.Optional) !== 0;
        const value = optional && this.exactOptionalPropertyTypes ? this.removeOptional(Number(type.tupleElements[i]), true) : optional && this.strictNullChecks ? this.combine([type.tupleElements[i], this.intrinsic(F.Undefined)], F.Union) : type.tupleElements[i];
        properties.push({ name: this.types[key].data.keyName, numeric: true, numericName: String(i), keyType: key, type: value, optional, readonly: type.readonly, privateOrigin: -1 });
      }
    }
    const lengths: number[] = [];
    if (!variable) for (let i = min; i <= type.tupleElements.length; i++) lengths.push(this.positionKey(Number(i), true));
    for (const p of this.instantiateProperties(array.properties, mapper)) properties.push(p.name === 'bGVuZ3Ro' ? { ...p, type: variable ? this.intrinsic(F.Number) : this.combine(lengths, F.Union) } : p);
    type.setMembers(properties, this.instantiateProperties(array.data.fallbackProperties, mapper), [], [], -1, type.numberIndex, -1, [], type.readonly ? 2 : 0);
  }

  private resolveIntersection(type: Type): void {
    const properties: Property[] = [];
    const fallbacks: Property[] = [];
    const calls: Signature[] = [];
    const constructs: Signature[] = [];
    const stringIndexes: number[] = [];
    const numberIndexes: number[] = [];
    const symbolIndexes: number[] = [];
    const patterns: IndexInfo[] = [];
    let indexReadonly = 7;
    for (const part of type.types) {
      const original = this.types[part];
      const member = original.apparentType >= 0 ? this.types[original.apparentType] : original;
      this.resolve(member);
      this.mergeProperties(properties, member.properties);
      this.mergeProperties(fallbacks, member.data.fallbackProperties);
      for (const sig of member.calls) calls.push(sig);
      for (const sig of member.constructs) constructs.push(sig);
      if (member.stringIndex >= 0) stringIndexes.push(member.stringIndex);
      if (member.numberIndex >= 0) numberIndexes.push(member.numberIndex);
      if (member.symbolIndex >= 0) symbolIndexes.push(member.symbolIndex);
      if (member.stringIndex >= 0 && (member.indexReadonly & 1) === 0) indexReadonly &= ~1;
      if (member.numberIndex >= 0 && (member.indexReadonly & 2) === 0) indexReadonly &= ~2;
      if (member.symbolIndex >= 0 && (member.indexReadonly & 4) === 0) indexReadonly &= ~4;
      for (const info of member.patternIndexes) this.indexes.append(patterns, info, false);
    }
    type.setMembers(properties, fallbacks, calls, constructs,
      stringIndexes.length === 0 ? -1 : this.combine(stringIndexes, F.Intersection),
      numberIndexes.length === 0 ? -1 : this.combine(numberIndexes, F.Intersection),
      symbolIndexes.length === 0 ? -1 : this.combine(symbolIndexes, F.Intersection), patterns,
      indexReadonly & ((stringIndexes.length > 0 ? 1 : 0) | (numberIndexes.length > 0 ? 2 : 0) | (symbolIndexes.length > 0 ? 4 : 0)));
  }

  private mergeProperties(result: Property[], input: Property[]): void {
    for (const p of input) {
      let index = -1;
      for (let i = 0; i < result.length; i++) if (result[i].name === p.name) { index = i; break; }
      if (index < 0) result.push(p);
      else {
        const previous = result[index];
        if (previous === undefined) throw new Error('Missing intersection property');
        result[index] = { ...previous, type: this.combine([previous.type, p.type], F.Intersection), optional: previous.optional && p.optional };
      }
    }
  }

  private instantiateProperties(properties: Property[], mapper: Mapper): Property[] {
    const result: Property[] = [];
    for (const p of properties) {
      let value = this.instantiate(Number(p.type), mapper);
      if (p.optional && this.exactOptionalPropertyTypes) value = this.removeOptional(Number(value), true);
      result.push({ name: p.name, numeric: p.numeric, numericName: p.numericName, keyType: p.keyType, optional: p.optional,
        readonly: p.readonly, privateOrigin: p.privateOrigin, type: value });
    }
    return result;
  }

  signature(sig: Signature, outer: Mapper, erase: boolean): Signature {
    // The same signature can have both scoped and erased instantiations.
    const cacheId = erase ? -sig.id - 1 : sig.id;
    const previous = outer.signatures.get(cacheId);
    if (previous !== undefined) return previous;
    let mapper = outer;
    let parameters: number[] = [];
    if (!erase && sig.typeParameters.length > 0) {
      const sources = outer.sources.slice();
      const targets = outer.targets.slice();
      for (const param of sig.typeParameters) {
        const clone = this.add({ ...this.types[param].data, constraint: -1, defaultType: -1 });
        sources.push(param); targets.push(clone); parameters.push(clone);
      }
      mapper = this.mapper(sources, targets, outer.mode);
      for (let i = 0; i < parameters.length; i++) {
        const clone = this.types[parameters[i]];
        clone.constraint = this.instantiate(Number(this.types[sig.typeParameters[i]].constraint), mapper);
        clone.defaultType = this.instantiate(Number(this.types[sig.typeParameters[i]].defaultType), mapper);
        clone.data.constraint = clone.constraint;
        clone.data.defaultType = clone.defaultType;
      }
    }
    const result: Signature = { id: this.nextSignatureId++, typeParameters: parameters, generic: parameters.length > 0,
      minArgumentCount: sig.minArgumentCount, nonArrayRest: sig.nonArrayRest, bivariant: sig.bivariant, abstract: sig.abstract,
      predicateKind: sig.predicateKind, predicateIndex: sig.predicateIndex, unsupported: sig.unsupported,
      parameters: this.instantiateList(sig.parameters, mapper), tailTypes: this.instantiateList(sig.tailTypes, mapper),
      restType: this.instantiate(Number(sig.restType), mapper), effectiveRest: this.instantiate(Number(sig.effectiveRest), mapper), returnType: this.instantiate(Number(sig.returnType), mapper),
      thisType: this.instantiate(Number(sig.thisType), mapper), predicateType: this.instantiate(Number(sig.predicateType), mapper) };
    if (sig.effectiveRest >= 0 && result.effectiveRest !== sig.effectiveRest) this.normalizeSignatureRest(result);
    outer.signatures.set(cacheId, result);
    return result;
  }

  private normalizeSignatureRest(sig: Signature): void {
    let effective = sig.effectiveRest;
    const prefix = sig.parameters.length;
    const type = this.types[effective];
    if ((type.flags & F.Any) !== 0) effective = this.array(Number(effective), false);
    else if ((type.objectFlags & O.Tuple) !== 0) {
      const fixed = this.tuples.fixed(Number(effective));
      let required = 0;
      while (required < type.tupleFlags.length && (type.tupleFlags[required] & E.Required) !== 0) required++;
      if (required > 0) sig.minArgumentCount = prefix + required;
      for (let i = 0; i < fixed; i++) sig.parameters.push(this.strictNullChecks && (type.tupleFlags[i] & E.Optional) !== 0 ? this.combine([type.tupleElements[i], this.intrinsic(F.Undefined)], F.Union) : type.tupleElements[i]);
      effective = fixed === type.tupleElements.length ? -1 : this.tuples.slice(Number(effective), Number(fixed), 0);
    }
    sig.effectiveRest = effective;
    sig.restType = effective < 0 ? -1 : this.indexed.access(Number(effective), Number(this.intrinsic(F.Number)), 0);
    sig.nonArrayRest = effective >= 0 && this.types[effective].arrayElement < 0 && (this.types[effective].flags & F.Any) === 0;
    sig.tailTypes = [];
    for (let i = 0; i < sig.parameters.length; i++) sig.tailTypes.push(-1);
    if (effective >= 0) sig.tailTypes.push(effective);
    for (let i = sig.minArgumentCount - 1; i >= 0; i--) {
      const type = this.types[i < sig.parameters.length ? sig.parameters[i] : sig.restType];
      let voidType = (type.flags & F.Void) !== 0;
      if ((type.flags & F.Union) !== 0) for (const part of type.types) if ((this.types[part].flags & F.Void) !== 0) voidType = true;
      if (!voidType) break;
      sig.minArgumentCount = i;
    }
  }

  erase(sig: Signature): Signature {
    if (!sig.generic) return sig;
    const args: number[] = [];
    for (const id of sig.typeParameters) args.push(this.intrinsic(F.Any));
    return this.signature(sig, this.mapper(sig.typeParameters, args), true);
  }

  combine(input: number[], flags: number): number {
    const parts: number[] = [];
    for (const id of input) {
      const t = this.types[id];
      if ((t.flags & F.Any) !== 0) return Number(id);
      if (flags === F.Union && (t.flags & F.Unknown) !== 0) return Number(id);
      if (flags === F.Intersection && (t.flags & F.Never) !== 0) return Number(id);
      if (flags === F.Union && (t.flags & F.Never) !== 0 || flags === F.Intersection && (t.flags & F.Unknown) !== 0) continue;
      const ids = (t.flags & flags) !== 0 ? t.types : [id];
      for (const part of ids) if (!parts.includes(part)) parts.push(part);
    }
    if (flags === F.Union) {
      let broad = 0;
      for (const part of parts) broad |= this.types[part].flags & (F.String | F.Number | F.BigInt | F.ESSymbol);
      for (let i = parts.length - 1; i >= 0; i--) {
        const f = this.types[parts[i]].flags;
        if ((broad & F.String) !== 0 && (f & F.StringLike) !== 0 && (f & F.String) === 0 || (broad & F.Number) !== 0 && (f & F.NumberLiteral) !== 0 || (broad & F.BigInt) !== 0 && (f & F.BigIntLiteral) !== 0 || (broad & F.ESSymbol) !== 0 && (f & F.UniqueESSymbol) !== 0) parts.splice(i, 1);
      }
    } else {
      let primitive = 0;
      let unit = -1;
      for (const part of parts) {
        const f = this.types[part].flags;
        const group = (f & F.StringLike) !== 0 ? 1 : (f & F.NumberLike) !== 0 ? 2 : (f & F.BigIntLike) !== 0 ? 3 : (f & F.BooleanLike) !== 0 ? 4 : (f & F.ESSymbolLike) !== 0 ? 5 : (f & (F.Void | F.Undefined)) !== 0 ? 6 : (f & F.Null) !== 0 ? 7 : 0;
        if (group !== 0) {
          if (primitive !== 0 && primitive !== group) return Number(this.intrinsic(F.Never));
          primitive = group;
        }
        if ((f & (F.Literal | F.UniqueESSymbol)) !== 0) {
          if (unit >= 0) {
            const previous = this.types[unit];
            if ((f & F.UniqueESSymbol) !== 0 ? part !== unit : previous.value !== this.types[part].value) return Number(this.intrinsic(F.Never));
          }
          unit = part;
        }
      }
      // K & string becomes the concrete string literal after key substitution.
      // Retaining the broad primitive would leave `${K & string}` unresolved.
      let narrow = 0;
      for (const part of parts) {
        const f = this.types[part].flags;
        if ((f & (F.StringLiteral | F.TemplateLiteral | F.StringMapping)) !== 0) narrow |= F.String;
        if ((f & F.NumberLiteral) !== 0) narrow |= F.Number;
        if ((f & F.BigIntLiteral) !== 0) narrow |= F.BigInt;
        if ((f & F.BooleanLiteral) !== 0) narrow |= F.Boolean;
        if ((f & F.UniqueESSymbol) !== 0) narrow |= F.ESSymbol;
      }
      for (let i = parts.length - 1; i >= 0; i--) if ((this.types[parts[i]].flags & narrow) !== 0) parts.splice(i, 1);
    }
    parts.sort((a, b) => a - b);
    if (parts.length === 0) return Number(this.intrinsic(flags === F.Union ? F.Never : F.Unknown));
    if (parts.length === 1) return Number(parts[0]);
    const key = this.combinationKey(flags, parts);
    const previous = this.combinations.get(key);
    if (previous !== undefined) return Number(previous);
    const data = emptyType(flags);
    data.types = parts;
    const id = this.add(data);
    if (flags === F.Intersection) this.types[id].membersResolved = false;
    this.combinations.set(key, id);
    return Number(id);
  }

  // Comparison collapses an any[] tail to any; inference keeps its array shape.
  tail(sig: Signature, pos: number): number {
    const result = this.restTail(sig, Number(pos));
    const type = this.types[result];
    return Number(type.arrayElement >= 0 && (this.types[type.arrayElement].flags & F.Any) !== 0 ? type.arrayElement : result);
  }

  restTail(sig: Signature, pos: number): number {
    const cached = pos < sig.tailTypes.length ? sig.tailTypes[pos] : -1;
    if (cached >= 0) return Number(cached);
    let result = -1;
    if (pos >= sig.parameters.length && sig.effectiveRest >= 0) {
      result = pos === sig.parameters.length ? sig.effectiveRest : this.array(Number(this.indexed.access(Number(sig.effectiveRest), Number(this.intrinsic(F.Number)), 0)), false);
    } else {
      const elements = sig.parameters.slice(pos);
      const flags: number[] = [];
      for (let i = pos; i < sig.parameters.length; i++) flags.push(i < sig.minArgumentCount ? E.Required : E.Optional);
      if (sig.effectiveRest >= 0) { elements.push(sig.effectiveRest); flags.push(E.Variadic); }
      result = this.tuple(elements, flags, false);
    }
    while (sig.tailTypes.length <= pos) sig.tailTypes.push(-1);
    sig.tailTypes[pos] = result;
    return Number(result);
  }
}
