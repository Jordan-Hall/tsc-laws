// Port of the resolved-type assignability paths in internal/checker/relater.go.
// Copyright Microsoft Corporation. Licensed under Apache-2.0.
// Modified: dense type IDs, one assignability relation, explicit unsupported results,
// and definite-only caching for recursive comparisons.
import {
  TypeFlags as F,
  ObjectFlags as O,
  ElementFlags as E,
  AccessFlags as A,
  VarianceFlags as V,
  Ternary as R,
  MappedTypeModifiers as M,
  IndexFlags as I,
} from './flags.js';
import { Type, type Graph, type Signature } from './types.js';
import { RelationCache } from './relation-cache.js';
import { TypeArena, TYPE_ID_STRIDE } from './arena.js';
import { SignatureInference } from './inference.js';
import { VarianceInference } from './variance.js';
import { validEncoding } from './js-string.js';

export class Checker {
  readonly types: Type[] = [];
  readonly strictNullChecks: boolean;
  readonly strictFunctionTypes: boolean;
  readonly exactOptionalPropertyTypes: boolean;
  readonly relation = new RelationCache();
  readonly arena: TypeArena;
  private readonly variance: VarianceInference;
  private readonly mappedDepth = new Map<number, number>();
  private readonly conditionalDepth = new Map<number, number>();
  private readonly inferredSignatures = new Map<string, Signature>();
  private readonly inferencePool: SignatureInference[] = [];
  private flags: Uint32Array;
  private regularTypes: Int32Array;
  private readonly unknownLikeUnions = new Uint8Array(TYPE_ID_STRIDE);
  private depth = 0;
  private comparisons = 0;
  private readonly noExcludedProperties: string[] = [];

  constructor(graph: Graph) {
    this.strictNullChecks = graph.strictNullChecks;
    this.strictFunctionTypes = graph.strictFunctionTypes;
    this.exactOptionalPropertyTypes = graph.exactOptionalPropertyTypes;
    if (graph.types.length >= TYPE_ID_STRIDE) throw new Error('Type arena exceeds the numeric relation-key limit');
    this.flags = new Uint32Array(TYPE_ID_STRIDE);
    this.regularTypes = new Int32Array(TYPE_ID_STRIDE);
    for (let i = 0; i < graph.types.length; i++) {
      const data = graph.types[i];
      if (!Number.isInteger(data.flags) || data.flags < 1 || data.flags > 0xffffffff)
        throw new Error('Invalid type flags');
      this.validateId(data.regularType, graph.types.length, true);
      this.validateId(data.apparentType, graph.types.length, true);
      this.validateId(data.stringIndex, graph.types.length, true);
      this.validateId(data.numberIndex, graph.types.length, true);
      this.validateId(data.symbolIndex, graph.types.length, true);
      if (!Number.isInteger(data.indexReadonly) || data.indexReadonly < 0 || data.indexReadonly > 7)
        throw new Error('Invalid index readonly flags');
      if (!Array.isArray(data.patternIndexes)) throw new Error('Invalid pattern index metadata');
      for (const info of data.patternIndexes) {
        this.validateId(info.keyType, graph.types.length, false);
        this.validateId(info.type, graph.types.length, false);
        if ((graph.types[info.keyType].flags & (F.TemplateLiteral | F.StringMapping)) === 0)
          throw new Error('Invalid pattern index key');
        if (typeof info.readonly !== 'boolean') throw new Error('Invalid pattern index readonly flag');
      }
      this.validateId(data.arrayElement, graph.types.length, true);
      this.validateId(data.constraint, graph.types.length, true);
      this.validateId(data.target, graph.types.length, true);
      this.validateId(data.thisTypeParameter, graph.types.length, true);
      this.validateId(data.defaultType, graph.types.length, true);
      this.validateId(data.indexObject, graph.types.length, true);
      this.validateId(data.indexKey, graph.types.length, true);
      this.validateId(data.enumOrigin, graph.types.length, true);
      for (const member of data.enumMembers)
        if (!Number.isInteger(member.kind) || member.kind < 0 || member.kind > 2)
          throw new Error('Invalid enum member kind');
      for (const id of [
        data.mappedParameter,
        data.mappedConstraint,
        data.mappedTemplate,
        data.mappedName,
        data.mappedModifiersType,
        data.mappedHomomorphic,
      ])
        this.validateId(id, graph.types.length, true);
      for (const id of [data.conditionalCheck, data.conditionalExtends, data.conditionalTrue, data.conditionalFalse])
        this.validateId(id, graph.types.length, true);
      for (const id of data.conditionalInfer) this.validateId(id, graph.types.length, false);
      if (typeof data.conditionalAlias !== 'boolean' || typeof data.conditionalNestedFalse !== 'boolean')
        throw new Error('Invalid conditional tail metadata');
      if (!Number.isInteger(data.varianceAnnotation) || data.varianceAnnotation < -1 || data.varianceAnnotation > 2)
        throw new Error('Invalid variance annotation');
      for (const id of data.typeParameters) this.validateId(id, graph.types.length, false);
      for (const id of data.typeArguments) this.validateId(id, graph.types.length, false);
      for (const id of data.types) this.validateId(id, graph.types.length, false);
      if (
        !Array.isArray(data.templateTexts) ||
        ((data.flags & F.TemplateLiteral) !== 0 &&
          (data.types.length === 0 || data.templateTexts.length !== data.types.length + 1))
      )
        throw new Error('Invalid template literal spans');
      for (const span of data.templateTexts)
        if (typeof span !== 'string' || !validEncoding(String(span))) throw new Error('Invalid template literal text');
      if (
        !Number.isInteger(data.stringMapping) ||
        data.stringMapping < 0 ||
        data.stringMapping > 4 ||
        ((data.flags & F.StringMapping) !== 0) !== data.stringMapping > 0 ||
        ((data.flags & F.StringMapping) !== 0 && data.indexObject < 0)
      )
        throw new Error('Invalid string mapping metadata');
      for (const id of data.tupleElements) this.validateId(id, graph.types.length, false);
      for (const property of data.properties.concat(data.fallbackProperties)) {
        this.validateId(property.type, graph.types.length, false);
        this.validateId(property.keyType, graph.types.length, false);
      }
      for (const signature of data.calls) this.validateSignature(signature, graph.types.length);
      for (const signature of data.constructs) this.validateSignature(signature, graph.types.length);
      if (data.tupleElements.length !== data.tupleFlags.length) throw new Error('Invalid tuple element flags');
      this.types.push(new Type(data));
      this.types[i].id = i;
      this.types[i].signatureOrigin = i;
      this.flags[i] = data.flags;
      this.regularTypes[i] = data.regularType;
    }
    this.arena = new TypeArena(
      this.types,
      this.flags,
      this.regularTypes,
      this.strictNullChecks,
      this.exactOptionalPropertyTypes,
    );
    this.arena.conditional.setRelation(
      (source, target) => this.isRelatedTo(Number(source), Number(target)) !== R.False,
    );
    this.arena.strings.setRelation((source, target) => this.isRelatedTo(Number(source), Number(target)) !== R.False);
    this.arena.stringMappings.setRelation(
      (source, target) => this.isRelatedTo(Number(source), Number(target)) !== R.False,
    );
    this.arena.indexes.setRelation((source, target) => this.isRelatedTo(Number(source), Number(target)) !== R.False);
    this.variance = new VarianceInference(this.arena, (source, target) =>
      this.isRelatedTo(Number(source), Number(target)),
    );
  }

  private validateId(id: number, count: number, optional: boolean): void {
    if (!Number.isInteger(id) || id < (optional ? -1 : 0) || id >= count) throw new Error('Invalid referenced type ID');
  }

  private validateSignature(signature: Signature, count: number): void {
    for (const id of signature.parameters) this.validateId(id, count, false);
    for (const id of signature.typeParameters) this.validateId(id, count, false);
    for (const id of signature.tailTypes) this.validateId(id, count, true);
    if (!Number.isInteger(signature.id) || signature.id < 0) throw new Error('Invalid signature ID');
    this.validateId(signature.returnType, count, false);
    this.validateId(signature.restType, count, true);
    this.validateId(signature.effectiveRest, count, true);
    this.validateId(signature.thisType, count, true);
    this.validateId(signature.predicateType, count, true);
    if (!Number.isInteger(signature.predicateKind) || signature.predicateKind < -1 || signature.predicateKind > 3)
      throw new Error('Invalid predicate kind');
    if (!Number.isInteger(signature.minArgumentCount) || signature.minArgumentCount < 0)
      throw new Error('Invalid signature arity');
  }

  resetRelations(): void {
    this.relation.clear();
    this.arena.conditional.resetRelations();
    // tsgo retains instantiated types/signatures, but recomputes contextual
    // inference when the enclosing relation is cold.
    this.inferredSignatures.clear();
  }

  isTypeAssignableTo(source: number, target: number): boolean {
    if (source === target) return true;
    this.comparisons = 0;
    const result = this.isRelatedTo(Number(source), Number(target));
    // A root Maybe establishes a coinductive relation, but child Maybe results must
    // not enter the cache: a later sibling can invalidate their cycle assumptions.
    if (result === R.Maybe) this.relation.set(source * TYPE_ID_STRIDE + target, R.True);
    return result !== R.False;
  }

  private isRelatedTo(inputSource: number, inputTarget: number): number {
    if (inputSource === inputTarget) return R.True;
    // v0.2.5 requires an explicit native numeric conversion for these parameter indices.
    const regularSource = this.regularTypes[Number(inputSource)];
    const regularTarget = this.regularTypes[Number(inputTarget)];
    const sourceId = regularSource >= 0 ? regularSource : inputSource;
    const targetId = regularTarget >= 0 ? regularTarget : inputTarget;
    if (sourceId === targetId) return R.True;
    const sourceFlags = this.flags[sourceId];
    const targetFlags = this.flags[targetId];
    if (this.isSimpleTypeRelatedTo(sourceId, targetId, sourceFlags, targetFlags)) return R.True;
    if ((targetFlags & F.Never) !== 0) return R.False;
    if (((sourceFlags | targetFlags) & (F.StructuredOrInstantiable | F.EnumLike | F.UniqueESSymbol)) === 0)
      return R.False;
    const key = sourceId * TYPE_ID_STRIDE + targetId;
    const cached = this.relation.get(key);
    if (cached !== 2) return cached;
    const source = this.types[sourceId];
    const target = this.types[targetId];
    if (source.unsupported.length !== 0) throw new Error('Unsupported source type: ' + source.unsupported);
    if (target.unsupported.length !== 0) throw new Error('Unsupported target type: ' + target.unsupported);
    if (this.depth >= 100 || ++this.comparisons > 1000000)
      throw new Error(
        'Type relation complexity limit exceeded: ' +
          sourceId +
          ' ' +
          source.name +
          ' -> ' +
          targetId +
          ' ' +
          target.name,
      );
    this.relation.set(key, R.Maybe);
    this.depth++;
    let result = 2;
    try {
      result = this.structuredTypeRelatedTo(sourceId, targetId);
    } finally {
      this.depth--;
      this.relation.set(key, result === R.True || result === R.False ? result : 2);
    }
    return result;
  }

  // Fast paths from tsgo's isSimpleTypeRelatedTo, relater.go:205. Group
  // enum cases behind one flag check to keep ordinary comparisons cheap.
  private isSimpleTypeRelatedTo(sourceId: number, targetId: number, s: number, t: number): boolean {
    if ((t & F.Any) !== 0 || (s & F.Never) !== 0 || ((s & F.Any) !== 0 && this.types[sourceId].wildcard)) return true;
    if ((t & F.Unknown) !== 0) return true;
    if ((t & F.Never) !== 0) return false;
    if ((s & F.StringLike) !== 0 && (t & F.String) !== 0) return true;
    if (
      (t & F.TemplateLiteral) !== 0 &&
      this.types[targetId].data.numericString &&
      this.types[sourceId].data.numericString
    )
      return true;
    if ((s & F.NumberLike) !== 0 && (t & F.Number) !== 0) return true;
    if ((s & F.BigIntLike) !== 0 && (t & F.BigInt) !== 0) return true;
    if ((s & F.BooleanLike) !== 0 && (t & F.Boolean) !== 0) return true;
    if ((s & F.ESSymbolLike) !== 0 && (t & F.ESSymbol) !== 0) return true;
    if (
      (s & F.Undefined) !== 0 &&
      ((!this.strictNullChecks && (t & F.UnionOrIntersection) === 0) || (t & (F.Undefined | F.Void)) !== 0)
    )
      return true;
    if ((s & F.Null) !== 0 && ((!this.strictNullChecks && (t & F.UnionOrIntersection) === 0) || (t & F.Null) !== 0))
      return true;
    if ((s & F.Object) !== 0 && (t & F.NonPrimitive) !== 0) return true;
    if ((s & F.Any) !== 0) return true;
    if (
      (s & F.Literal) !== 0 &&
      (s & F.Literal) === (t & F.Literal) &&
      (s & F.EnumLiteral) === 0 &&
      (t & F.EnumLiteral) === 0 &&
      this.types[sourceId].value === this.types[targetId].value
    )
      return true;
    if (((s | t) & F.EnumLike) !== 0) {
      if (
        (s & (F.StringLiteral | F.EnumLiteral)) === (F.StringLiteral | F.EnumLiteral) &&
        (t & F.StringLiteral) !== 0 &&
        (t & F.EnumLiteral) === 0 &&
        this.types[sourceId].value === this.types[targetId].value
      )
        return true;
      if (
        (s & (F.NumberLiteral | F.EnumLiteral)) === (F.NumberLiteral | F.EnumLiteral) &&
        (t & F.NumberLiteral) !== 0 &&
        (t & F.EnumLiteral) === 0 &&
        this.types[sourceId].value === this.types[targetId].value
      )
        return true;
      if (
        (s & t & F.Enum) !== 0 &&
        this.types[sourceId].data.enumMemberName === this.types[targetId].data.enumMemberName &&
        this.arena.enumRelated(Number(sourceId), Number(targetId))
      )
        return true;
      if ((s & t & F.EnumLiteral) !== 0) {
        if ((s & t & F.Union) !== 0 && this.arena.enumRelated(Number(sourceId), Number(targetId))) return true;
        if (
          (s & F.Literal) !== 0 &&
          (s & F.Literal) === (t & F.Literal) &&
          this.types[sourceId].value === this.types[targetId].value &&
          this.arena.enumRelated(Number(sourceId), Number(targetId))
        )
          return true;
      }
      if (
        (s & F.Number) !== 0 &&
        ((t & F.Enum) !== 0 || (t & (F.NumberLiteral | F.EnumLiteral)) === (F.NumberLiteral | F.EnumLiteral))
      )
        return true;
      if (
        (s & F.NumberLiteral) !== 0 &&
        (s & F.EnumLiteral) === 0 &&
        ((t & F.Enum) !== 0 ||
          ((t & (F.NumberLiteral | F.EnumLiteral)) === (F.NumberLiteral | F.EnumLiteral) &&
            this.types[sourceId].value === this.types[targetId].value))
      )
        return true;
    }
    if (this.strictNullChecks && (t & F.Union) !== 0) return this.isUnknownLikeUnion(Number(targetId));
    return false;
  }

  private isUnknownLikeUnion(id: number): boolean {
    const cached = this.unknownLikeUnions[id];
    if (cached !== 0) return cached === 2;
    this.unknownLikeUnions[id] = 1;
    const target = this.types[id];
    if (target.types.length < 3) return false;
    // Go's intrinsic IDs put undefined/null first. Dense exported and
    // natively interned IDs do not preserve that ordering.
    let nullable = 0;
    for (const part of target.types) nullable |= this.flags[Number(part)] & F.Nullable;
    if (nullable !== F.Nullable) return false;
    for (const partId of target.types) {
      const part = this.types[partId];
      if ((part.flags & F.Object) !== 0 && part.arrayElement < 0 && (part.objectFlags & O.Tuple) === 0)
        this.arena.resolve(part);
      if (
        (part.flags & F.Object) !== 0 &&
        part.properties.length === 0 &&
        part.calls.length === 0 &&
        part.constructs.length === 0 &&
        part.stringIndex < 0 &&
        part.numberIndex < 0 &&
        part.symbolIndex < 0 &&
        part.patternIndexes.length === 0 &&
        part.arrayElement < 0 &&
        (part.objectFlags & O.Tuple) === 0 &&
        ((part.objectFlags & O.Mapped) === 0 || !this.arena.mapped.generic(Number(partId)))
      ) {
        this.unknownLikeUnions[id] = 2;
        return true;
      }
    }
    return false;
  }

  private structuredTypeRelatedTo(sourceId: number, targetId: number): number {
    const simplifiedSource =
      (this.flags[sourceId] & (F.Index | F.IndexedAccess | F.Substitution | F.Conditional)) !== 0
        ? this.arena.indexed.simplify(Number(sourceId))
        : sourceId;
    const simplifiedTarget =
      (this.flags[targetId] & (F.Index | F.IndexedAccess | F.Substitution | F.Conditional)) !== 0
        ? this.arena.indexed.simplify(Number(targetId), true)
        : targetId;
    if (simplifiedSource !== sourceId || simplifiedTarget !== targetId)
      return this.isRelatedTo(
        Number(simplifiedSource >= 0 ? simplifiedSource : this.arena.intrinsic(F.Unknown)),
        Number(simplifiedTarget >= 0 ? simplifiedTarget : this.arena.intrinsic(F.Unknown)),
      );
    let source = this.types[sourceId];
    const target = this.types[targetId];
    if ((target.flags & F.Object) !== 0 && target.arrayElement < 0 && (target.objectFlags & O.Tuple) === 0)
      this.arena.resolve(target);
    // tsgo deliberately handles source unions before target unions/intersections.
    if ((source.flags & F.Union) !== 0) {
      let result = R.True as number;
      for (let i = 0; i < source.types.length; i++) {
        let related = R.False as number;
        if (
          (target.flags & F.Union) !== 0 &&
          target.types.length > 0 &&
          source.types.length % target.types.length === 0
        ) {
          related = this.isRelatedTo(Number(source.types[i]), Number(target.types[i % target.types.length]));
        }
        if (related === R.False) related = this.isRelatedTo(Number(source.types[i]), Number(targetId));
        if (related === R.False) return R.False;
        result &= related;
      }
      return result;
    }
    if ((source.flags & F.Conditional) !== 0 && (target.flags & F.Union) !== 0) {
      const conditional = this.conditionalRelatedTo(Number(sourceId), Number(targetId));
      if (conditional !== R.False) return Number(conditional);
    }
    if ((source.flags & F.TypeVariable) !== 0 && (target.flags & F.Union) !== 0) {
      const constraint = this.arena.indexed.constraint(Number(sourceId));
      if (constraint >= 0 && constraint !== sourceId) {
        const related = this.isRelatedTo(Number(constraint), Number(targetId));
        if (related !== R.False) return Number(related);
      }
    }
    if ((target.flags & F.Union) !== 0) {
      let result = R.False as number;
      for (const part of target.types) {
        const related = this.isRelatedTo(Number(sourceId), Number(part));
        if (related === R.True) return R.True;
        result |= related;
      }
      if (result === R.False && (source.flags & (F.Object | F.Intersection)) !== 0)
        return this.typeRelatedToDiscriminatedType(source, target);
      return result;
    }
    if ((target.flags & F.Intersection) !== 0) {
      let result = R.True as number;
      for (const part of target.types) {
        const related = this.isRelatedTo(Number(sourceId), Number(part));
        if (related === R.False) return R.False;
        result &= related;
      }
      return result;
    }
    if (
      (source.flags & F.Intersection) !== 0 &&
      target.stringIndex < 0 &&
      target.numberIndex < 0 &&
      target.symbolIndex < 0 &&
      target.patternIndexes.length === 0
    ) {
      let result = R.False as number;
      for (const part of source.types) {
        const related = this.isRelatedTo(Number(part), Number(targetId));
        if (related === R.True) return R.True;
        result |= related;
      }
      if (result !== R.False) return result;
      // Resolved intersections expose their merged properties in the arena.
    }
    if (((source.flags | target.flags) & F.Conditional) !== 0) {
      const conditional = this.conditionalRelatedTo(Number(sourceId), Number(targetId));
      if (conditional !== R.False || (source.flags & F.Conditional) !== 0) return Number(conditional);
    }
    if ((target.flags & F.TemplateLiteral) !== 0) {
      if ((source.flags & F.TemplateLiteral) !== 0)
        for (const part of source.types)
          if (this.arena.indexed.isGenericIndex(Number(part))) this.variance.report(V.Unreliable);
      if (this.arena.strings.matches(Number(sourceId), Number(targetId))) return R.True;
    }
    if (
      (target.flags & F.StringMapping) !== 0 &&
      (source.flags & F.StringMapping) === 0 &&
      this.arena.stringMappings.member(Number(sourceId), Number(targetId))
    )
      return R.True;
    if ((source.flags & F.StringMapping) !== 0) {
      if ((target.flags & F.StringMapping) !== 0)
        return source.data.stringMapping === target.data.stringMapping
          ? this.isRelatedTo(Number(source.data.indexObject), Number(target.data.indexObject))
          : R.False;
      const constraint = this.arena.indexed.constraint(Number(sourceId));
      if (constraint >= 0 && constraint !== sourceId) {
        const related = this.isRelatedTo(Number(constraint), Number(targetId));
        if (related !== R.False) return Number(related);
      }
    }
    if ((source.flags & F.TemplateLiteral) !== 0 && (target.flags & (F.TemplateLiteral | F.Object)) === 0) {
      const constraint = this.arena.indexed.constraint(Number(sourceId));
      if (constraint >= 0 && constraint !== sourceId) {
        const related = this.isRelatedTo(Number(constraint), Number(targetId));
        if (related !== R.False) return Number(related);
      }
    }
    if (this.arena.tuples.single(source) && !source.readonly) {
      const related = this.isRelatedTo(Number(source.tupleElements[0]), Number(targetId));
      if (related !== R.False) return Number(related);
    }
    if (this.arena.tuples.single(target)) {
      const bound = this.types[this.arena.indexed.baseConstraint(Number(sourceId))];
      if (target.readonly || (!bound.readonly && (bound.arrayElement >= 0 || (bound.objectFlags & O.Tuple) !== 0))) {
        const related = this.isRelatedTo(Number(sourceId), Number(target.tupleElements[0]));
        if (related !== R.False) return Number(related);
      }
    }
    if ((target.flags & F.Index) !== 0) {
      if ((source.flags & F.Index) !== 0) {
        const related = this.isRelatedTo(Number(target.data.indexObject), Number(source.data.indexObject));
        if (related !== R.False) return related;
      }
      const indexed = this.types[target.data.indexObject];
      if ((indexed.objectFlags & O.Tuple) !== 0) {
        const related = this.isRelatedTo(Number(sourceId), Number(this.arena.tuples.knownKeys(Number(indexed.id))));
        if (related !== R.False) return Number(related);
      }
      const constraint =
        (indexed.objectFlags & O.Tuple) !== 0 ? -1 : this.arena.indexed.constraint(Number(target.data.indexObject));
      if (
        constraint >= 0 &&
        this.isRelatedTo(
          Number(sourceId),
          Number(this.arena.indexed.keyof(Number(constraint), target.data.indexFlags)),
        ) === R.True
      )
        return R.True;
      if (constraint < 0 && (indexed.objectFlags & O.Mapped) !== 0 && this.arena.mapped.generic(Number(indexed.id))) {
        this.arena.mapped.prepare(Number(indexed.id));
        const name = this.arena.mapped.name(Number(indexed.id), Number(indexed.data.mappedParameter));
        const keys =
          name < 0
            ? indexed.data.mappedConstraint
            : indexed.data.mappedKeyof
              ? this.arena.combine([this.arena.mapped.apparentKeys(Number(indexed.id)), name], F.Union)
              : name;
        if (this.isRelatedTo(Number(sourceId), Number(keys)) === R.True) return R.True;
      }
    }
    if ((target.flags & F.IndexedAccess) !== 0) {
      if ((source.flags & F.IndexedAccess) !== 0) {
        let related = this.isRelatedTo(Number(source.data.indexObject), Number(target.data.indexObject));
        if (related !== R.False)
          related &= this.isRelatedTo(Number(source.data.indexKey), Number(target.data.indexKey));
        if (related !== R.False) return related;
      }
      const object = this.arena.indexed.baseConstraint(Number(target.data.indexObject));
      const index = this.arena.indexed.baseConstraint(Number(target.data.indexKey));
      const constraint = this.arena.indexed.access(
        Number(object),
        Number(index),
        A.Writing | (object !== target.data.indexObject ? A.NoIndexSignatures : 0),
      );
      if (constraint >= 0 && (this.types[constraint].flags & F.IndexedAccess) === 0) {
        const related = this.isRelatedTo(Number(sourceId), Number(constraint));
        if (related !== R.False) return related;
      }
    }
    if ((target.flags & F.TypeParameter) !== 0 && (source.objectFlags & O.Mapped) !== 0) {
      this.arena.mapped.prepare(Number(sourceId));
      if (
        source.data.mappedName < 0 &&
        (source.data.mappedModifiers & M.IncludeOptional) === 0 &&
        this.isRelatedTo(
          Number(this.arena.indexed.keyof(Number(targetId), 0)),
          Number(source.data.mappedConstraint),
        ) !== R.False
      ) {
        const related = this.isRelatedTo(
          Number(this.arena.mapped.value(Number(sourceId), Number(source.data.mappedParameter))),
          Number(this.arena.indexed.access(Number(targetId), Number(source.data.mappedParameter), 0)),
        );
        if (related !== R.False) return related;
      }
    }
    if (
      (target.objectFlags & O.Mapped) !== 0 &&
      this.arena.mapped.generic(Number(targetId)) &&
      (source.objectFlags & O.Mapped) === 0
    ) {
      const related = this.sourceToMapped(Number(sourceId), Number(targetId));
      if (related !== R.False) return related;
    }
    if ((source.flags & F.TypeVariable) !== 0 && (source.flags & target.flags & F.IndexedAccess) === 0) {
      const constraint = this.arena.indexed.constraint(Number(sourceId));
      return this.isRelatedTo(Number(constraint >= 0 ? constraint : this.arena.intrinsic(F.Unknown)), Number(targetId));
    }
    if ((source.flags & F.Index) !== 0) {
      const related = this.isRelatedTo(Number(this.arena.indexed.propertyKeys()), Number(targetId));
      if (related !== R.False) return Number(related);
      const mapped = this.types[source.data.indexObject];
      if ((mapped.objectFlags & O.Mapped) !== 0 && this.arena.mapped.generic(Number(mapped.id))) {
        this.arena.mapped.prepare(Number(mapped.id));
        const name = this.arena.mapped.name(Number(mapped.id), Number(mapped.data.mappedParameter));
        const keys =
          name < 0
            ? mapped.data.mappedConstraint
            : mapped.data.mappedKeyof
              ? this.arena.mapped.apparentKeys(Number(mapped.id))
              : name;
        return this.isRelatedTo(Number(keys), Number(targetId));
      }
      return R.False;
    }
    if ((target.flags & F.Object) === 0) return R.False;
    if ((target.objectFlags & O.Mapped) !== 0) {
      this.arena.mapped.prepare(Number(targetId));
      if (
        (target.data.mappedModifiers & M.IncludeOptional) !== 0 &&
        (source.flags & F.Object) !== 0 &&
        ((source.objectFlags & O.Mapped) === 0 || !this.arena.mapped.generic(Number(sourceId)))
      ) {
        this.arena.resolve(source);
        if (
          source.properties.length === 0 &&
          source.calls.length === 0 &&
          source.constructs.length === 0 &&
          source.stringIndex < 0 &&
          source.numberIndex < 0 &&
          source.symbolIndex < 0 &&
          source.patternIndexes.length === 0
        )
          return R.True;
      }
      if (this.arena.mapped.generic(Number(targetId))) {
        return (source.objectFlags & O.Mapped) !== 0 && this.arena.mapped.generic(Number(sourceId))
          ? this.mappedRelatedTo(Number(sourceId), Number(targetId))
          : R.False;
      }
    }
    // The empty anonymous object type accepts all definitely non-nullish values.
    if (
      target.properties.length === 0 &&
      target.calls.length === 0 &&
      target.constructs.length === 0 &&
      target.stringIndex < 0 &&
      target.numberIndex < 0 &&
      target.symbolIndex < 0 &&
      target.patternIndexes.length === 0 &&
      target.arrayElement < 0 &&
      (target.objectFlags & O.Tuple) === 0
    ) {
      return (source.flags & (F.Void | F.Nullable)) === 0 &&
        (!this.strictNullChecks || (source.flags & F.Unknown) === 0)
        ? R.True
        : R.False;
    }
    // Primitive members come from the resolved String/Number/etc. apparent type.
    if (source.apparentType >= 0) source = this.types[source.apparentType];
    if ((source.objectFlags & O.Mapped) !== 0) {
      const apparent = this.arena.mapped.apparent(Number(source.id));
      if (apparent !== source.id) return this.isRelatedTo(Number(apparent), Number(targetId));
    }
    if ((source.flags & (F.Object | F.Intersection)) === 0) return R.False;
    if (target.arrayElement >= 0) {
      if (source.readonly && !target.readonly) return R.False;
      if (source.arrayElement >= 0) return this.isRelatedTo(Number(source.arrayElement), Number(target.arrayElement));
      if ((source.objectFlags & O.Tuple) !== 0) {
        let result = R.True as number;
        for (let i = 0; i < source.tupleElements.length; i++) {
          const part =
            (source.tupleFlags[i] & E.Variadic) !== 0
              ? this.arena.indexed.access(Number(source.tupleElements[i]), Number(this.arena.intrinsic(F.Number)), 0)
              : source.tupleElements[i];
          const related = this.isRelatedTo(Number(part), Number(target.arrayElement));
          if (related === R.False) return R.False;
          result &= related;
        }
        return result;
      }
      return R.False;
    }
    if ((target.objectFlags & O.Tuple) !== 0) return this.tupleRelatedTo(source, target);
    if (
      (source.objectFlags & target.objectFlags & O.Reference) !== 0 &&
      (source.objectFlags & O.Mapped) === 0 &&
      source.data.target >= 0 &&
      source.data.target === target.data.target &&
      !source.marker &&
      !target.marker
    ) {
      const variances = this.variance.get(Number(source.data.target));
      if (variances.length === 0) return R.Unknown;
      const related = this.typeArgumentsRelatedTo(source.data.typeArguments, target.data.typeArguments, variances);
      if (related !== R.False) return related;
      let fallback = false;
      for (let i = 0; i < variances.length; i++)
        if (
          (variances[i] & V.AllowsStructuralFallback) !== 0 ||
          ((variances[i] & V.VarianceMask) === V.Covariant &&
            (this.flags[Number(target.data.typeArguments[i])] & F.Void) !== 0)
        )
          fallback = true;
      if (!fallback) return R.False;
    }
    return this.objectRelatedTo(source, target, this.noExcludedProperties, (this.flags[sourceId] & F.Primitive) !== 0);
  }

  private conditionalRelatedTo(sourceId: number, targetId: number): number {
    const conditional = this.arena.conditional;
    const source = this.types[sourceId];
    const target = this.types[targetId];
    const sourceConditional = (source.flags & F.Conditional) !== 0;
    const targetConditional = (target.flags & F.Conditional) !== 0;
    if (sourceConditional) conditional.prepare(Number(sourceId));
    if (targetConditional) conditional.prepare(Number(targetId));
    const key =
      (sourceConditional ? conditional.root(Number(sourceId)) : sourceId) * TYPE_ID_STRIDE +
      (targetConditional ? conditional.root(Number(targetId)) : targetId);
    const depth = this.conditionalDepth.get(key) ?? 0;
    if (depth >= 10) return R.Maybe;
    this.conditionalDepth.set(key, depth + 1);
    try {
      if (
        targetConditional &&
        target.data.conditionalInfer.length === 0 &&
        !target.data.conditionalDependent &&
        (!sourceConditional || conditional.root(Number(sourceId)) !== conditional.root(Number(targetId)))
      ) {
        const skipTrue =
          this.isRelatedTo(
            Number(conditional.permissive(Number(target.data.conditionalCheck))),
            Number(conditional.permissive(Number(target.data.conditionalExtends))),
          ) === R.False;
        const skipFalse =
          !skipTrue &&
          this.isRelatedTo(
            Number(conditional.restrictive(Number(target.data.conditionalCheck))),
            Number(conditional.restrictive(Number(target.data.conditionalExtends))),
          ) !== R.False;
        let result = skipTrue
          ? R.True
          : this.isRelatedTo(Number(sourceId), Number(conditional.branch(Number(targetId), true, false)));
        if (result !== R.False && !skipFalse)
          result &= this.isRelatedTo(Number(sourceId), Number(conditional.branch(Number(targetId), false, false)));
        if (result !== R.False) return Number(result);
      }
      if (sourceConditional) {
        if (targetConditional) {
          let sourceExtends = source.data.conditionalExtends;
          let sourceTrue = conditional.branch(Number(sourceId), true, false);
          if (source.data.conditionalInfer.length > 0) {
            const mapper = conditional.infer(
              Number(target.data.conditionalExtends),
              Number(sourceExtends),
              source.data.conditionalInfer,
              conditional.scope(Number(sourceId)),
            );
            sourceExtends = this.arena.instantiate(Number(sourceExtends), mapper);
            sourceTrue = this.arena.instantiate(Number(sourceTrue), mapper);
          }
          if (
            conditional.identical(Number(sourceExtends), Number(target.data.conditionalExtends)) &&
            (this.isRelatedTo(Number(source.data.conditionalCheck), Number(target.data.conditionalCheck)) !== R.False ||
              this.isRelatedTo(Number(target.data.conditionalCheck), Number(source.data.conditionalCheck)) !== R.False)
          ) {
            let result = this.isRelatedTo(
              Number(sourceTrue),
              Number(conditional.branch(Number(targetId), true, false)),
            );
            if (result !== R.False)
              result &= this.isRelatedTo(
                Number(conditional.branch(Number(sourceId), false, false)),
                Number(conditional.branch(Number(targetId), false, false)),
              );
            if (result !== R.False) return Number(result);
          }
        }
        const defaultConstraint = conditional.defaultConstraint(Number(sourceId));
        if (defaultConstraint !== sourceId) {
          const related = this.isRelatedTo(Number(defaultConstraint), Number(targetId));
          if (related !== R.False) return Number(related);
        }
        if (!targetConditional) {
          const distributed = conditional.distributiveConstraint(Number(sourceId));
          if (distributed >= 0) return Number(this.isRelatedTo(Number(distributed), Number(targetId)));
        }
      }
      return R.False;
    } finally {
      if (depth === 0) this.conditionalDepth.delete(key);
      else this.conditionalDepth.set(key, depth);
    }
  }

  private mappedRelatedTo(sourceId: number, targetId: number): number {
    // Symbolic recursive templates can grow T[P][Q] indefinitely even though
    // their declarations repeat. As upstream's deeply-nested-type check does,
    // stop adding witnesses once both mapped declarations repeat three times.
    const pair = this.arena.mapped.root(Number(sourceId)) * TYPE_ID_STRIDE + this.arena.mapped.root(Number(targetId));
    const depth = this.mappedDepth.get(pair) ?? 0;
    if (depth >= 3) return R.Maybe;
    this.mappedDepth.set(pair, depth + 1);
    try {
      this.arena.mapped.prepare(Number(sourceId));
      this.arena.mapped.prepare(Number(targetId));
      const source = this.types[sourceId].data;
      const target = this.types[targetId].data;
      if (this.arena.mapped.optionality(Number(sourceId)) > this.arena.mapped.optionality(Number(targetId)))
        return R.False;
      this.variance.report(this.arena.mapped.optionality(Number(sourceId)) < 0 ? V.Unmeasurable : V.Unreliable);
      const constraint = this.isRelatedTo(Number(target.mappedConstraint), Number(source.mappedConstraint));
      if (constraint === R.False) return R.False;
      if (
        this.arena.mapped.name(Number(sourceId), Number(target.mappedParameter)) !==
        this.arena.mapped.name(Number(targetId), Number(target.mappedParameter))
      )
        return R.False;
      return (
        constraint &
        this.isRelatedTo(
          Number(this.arena.mapped.value(Number(sourceId), Number(target.mappedParameter))),
          Number(this.arena.mapped.value(Number(targetId), Number(target.mappedParameter))),
        )
      );
    } finally {
      this.mappedDepth.set(pair, depth);
    }
  }

  private sourceToMapped(sourceId: number, targetId: number): number {
    this.arena.mapped.prepare(Number(targetId));
    const target = this.types[targetId].data;
    if ((target.mappedModifiers & M.ExcludeOptional) !== 0) return R.False;
    const templateId = this.arena.mapped.value(Number(targetId), Number(target.mappedParameter));
    const template = this.types[templateId];
    if (
      target.mappedName < 0 &&
      (template.flags & F.IndexedAccess) !== 0 &&
      template.data.indexObject === sourceId &&
      template.data.indexKey === target.mappedParameter
    )
      return R.True;
    const keys =
      target.mappedName < 0
        ? target.mappedConstraint
        : this.arena.mapped.name(Number(targetId), Number(target.mappedParameter));
    const sourceKeys = this.arena.indexed.keyof(Number(sourceId), I.NoIndexSignatures);
    const optional = (target.mappedModifiers & M.IncludeOptional) !== 0;
    const applicable = optional ? this.arena.indexed.intersectKeys([keys, sourceKeys]) : keys;
    if (
      optional
        ? (this.flags[applicable] & F.Never) !== 0
        : this.isRelatedTo(Number(keys), Number(sourceKeys)) === R.False
    )
      return R.False;
    const parts = (template.flags & F.Union) !== 0 ? template.types : [templateId];
    const nonNull = this.arena.combine(
      parts.filter((part) => (this.flags[Number(part)] & F.Nullable) === 0),
      F.Union,
    );
    const component = this.types[nonNull];
    if (
      target.mappedName < 0 &&
      (component.flags & F.IndexedAccess) !== 0 &&
      component.data.indexKey === target.mappedParameter
    )
      return this.isRelatedTo(Number(sourceId), Number(component.data.indexObject));
    const index =
      target.mappedName >= 0
        ? applicable
        : optional
          ? this.arena.combine([applicable, target.mappedParameter], F.Intersection)
          : target.mappedParameter;
    const value = this.arena.indexed.access(Number(sourceId), Number(index), 0);
    return value >= 0 ? this.isRelatedTo(Number(value), Number(templateId)) : R.False;
  }

  private typeArgumentsRelatedTo(sources: number[], targets: number[], variances: number[]): number {
    let result = R.True as number;
    for (let i = 0; i < Math.min(sources.length, targets.length); i++) {
      const varianceFlags = i < variances.length ? variances[i] : V.Covariant;
      const variance = varianceFlags & V.VarianceMask;
      if (variance === V.Independent) continue;
      this.variance.report(varianceFlags & V.AllowsStructuralFallback);
      if ((varianceFlags & V.Unmeasurable) !== 0) {
        if (sources[i] !== targets[i]) return R.False;
        continue;
      }
      let related =
        variance === V.Contravariant || variance === V.Bivariant
          ? this.isRelatedTo(Number(targets[i]), Number(sources[i]))
          : this.isRelatedTo(Number(sources[i]), Number(targets[i]));
      if (variance === V.Bivariant && related === R.False)
        related = this.isRelatedTo(Number(sources[i]), Number(targets[i]));
      if (variance === V.Invariant && related !== R.False)
        related &= this.isRelatedTo(Number(targets[i]), Number(sources[i]));
      if (related === R.False) return R.False;
      result &= related;
    }
    return result;
  }

  private objectRelatedTo(
    source: Type,
    target: Type,
    excludedProperties: string[],
    sourceIsPrimitive: boolean,
  ): number {
    this.arena.resolve(source);
    this.arena.resolve(target);
    let result = R.True as number;
    let commonProperties = 0;
    let allOptional = target.properties.length !== 0;
    for (const targetProperty of target.properties) {
      if (!targetProperty.optional) allOptional = false;
      const index = source.propertyIndex.get(targetProperty.name);
      if (index === undefined) {
        if (!targetProperty.optional) return R.False;
        continue;
      }
      commonProperties++;
      const sourceProperty = source.lookupProperties[index];
      if (excludedProperties.length > 0 && excludedProperties.includes(targetProperty.name)) continue;
      if (
        sourceProperty.privateOrigin !== targetProperty.privateOrigin &&
        (sourceProperty.privateOrigin >= 0 || targetProperty.privateOrigin >= 0)
      )
        return R.False;
      if (sourceProperty.optional && !targetProperty.optional) return R.False;
      const related = this.isRelatedTo(Number(sourceProperty.type), Number(targetProperty.type));
      if (related === R.False) return R.False;
      result &= related;
    }
    // Weak target types require a common property (tsgo isWeakType/hasCommonProperties).
    if (
      allOptional &&
      commonProperties === 0 &&
      (source.properties.length > 0 ||
        source.calls.length > 0 ||
        source.constructs.length > 0 ||
        source.arrayElement >= 0 ||
        (source.objectFlags & O.Tuple) !== 0) &&
      target.calls.length === 0 &&
      target.constructs.length === 0 &&
      target.stringIndex < 0 &&
      target.numberIndex < 0 &&
      target.symbolIndex < 0 &&
      target.patternIndexes.length === 0
    )
      return R.False;
    const sameTemplate =
      source.signatureOrigin === target.signatureOrigin &&
      (source.objectFlags & O.Instantiated) !== 0 &&
      (target.objectFlags & O.Instantiated) !== 0;
    const calls = this.signaturesRelatedTo(source.calls, target.calls, sameTemplate);
    if (calls === R.False) return R.False;
    result &= calls;
    const constructs = this.signaturesRelatedTo(source.constructs, target.constructs, sameTemplate);
    if (constructs === R.False) return R.False;
    result &= constructs;
    if (source.patternIndexes.length > 0 || target.patternIndexes.length > 0)
      return Number(result & this.indexSignaturesRelatedTo(source, target, sourceIsPrimitive));
    if (target.stringIndex >= 0 && (sourceIsPrimitive || (this.types[target.stringIndex].flags & F.Any) === 0)) {
      if (source.stringIndex >= 0) {
        const related = this.isRelatedTo(Number(source.stringIndex), Number(target.stringIndex));
        if (related === R.False) return R.False;
        result &= related;
      } else {
        // Implicit index signatures apply to anonymous types, not interfaces.
        if (!this.isObjectTypeWithInferableIndex(source)) return R.False;
        if (source.numberIndex >= 0) {
          const related = this.isRelatedTo(Number(source.numberIndex), Number(target.stringIndex));
          if (related === R.False) return R.False;
          result &= related;
        }
        for (const property of source.properties) {
          if ((this.flags[Number(property.keyType)] & F.ESSymbolLike) !== 0) continue;
          const related =
            property.optional && !this.exactOptionalPropertyTypes
              ? this.isRelatedWithoutUndefined(property.type, target.stringIndex)
              : this.isRelatedTo(Number(property.type), Number(target.stringIndex));
          if (related === R.False) return R.False;
          result &= related;
        }
      }
    }
    if (
      target.numberIndex >= 0 &&
      (sourceIsPrimitive || target.stringIndex < 0 || (this.types[target.numberIndex].flags & F.Any) === 0)
    ) {
      const sourceIndex = source.numberIndex >= 0 ? source.numberIndex : source.stringIndex;
      if (sourceIndex >= 0) {
        const related = this.isRelatedTo(Number(sourceIndex), Number(target.numberIndex));
        if (related === R.False) return R.False;
        result &= related;
      } else {
        if (!this.isObjectTypeWithInferableIndex(source)) return R.False;
        for (const property of source.properties) {
          if (property.numeric) {
            const related = this.isRelatedTo(Number(property.type), Number(target.numberIndex));
            if (related === R.False) return R.False;
            result &= related;
          }
        }
      }
    }
    if (target.symbolIndex >= 0) {
      if (source.symbolIndex >= 0) {
        const related = this.isRelatedTo(Number(source.symbolIndex), Number(target.symbolIndex));
        if (related === R.False) return R.False;
        result &= related;
      } else {
        if (!this.isObjectTypeWithInferableIndex(source)) return R.False;
        for (const p of source.properties)
          if ((this.types[p.keyType].flags & F.ESSymbolLike) !== 0) {
            const related =
              p.optional && !this.exactOptionalPropertyTypes
                ? this.isRelatedWithoutUndefined(p.type, target.symbolIndex)
                : this.isRelatedTo(Number(p.type), Number(target.symbolIndex));
            if (related === R.False) return R.False;
            result &= related;
          }
      }
    }
    return result;
  }

  private indexSignaturesRelatedTo(source: Type, target: Type, sourceIsPrimitive: boolean): number {
    let result = R.True as number;
    for (const targetInfo of this.arena.indexes.all(target)) {
      if (!sourceIsPrimitive && target.stringIndex >= 0 && (this.types[targetInfo.type].flags & F.Any) !== 0) continue;
      const found = this.arena.indexes.find(source, Number(targetInfo.keyType));
      if (found !== undefined) {
        const related = this.isRelatedTo(Number(found.type), Number(targetInfo.type));
        if (related === R.False) return R.False;
        result &= related;
        continue;
      }
      if (!this.isObjectTypeWithInferableIndex(source)) return R.False;
      for (const p of source.properties)
        if (this.arena.indexes.applicable(Number(p.keyType), Number(targetInfo.keyType))) {
          const related =
            p.optional && !this.exactOptionalPropertyTypes && (this.types[targetInfo.keyType].flags & F.Number) === 0
              ? this.isRelatedWithoutUndefined(Number(p.type), Number(targetInfo.type))
              : this.isRelatedTo(Number(p.type), Number(targetInfo.type));
          if (related === R.False) return R.False;
          result &= related;
        }
      for (const info of this.arena.indexes.all(source))
        if (this.arena.indexes.applicable(Number(info.keyType), Number(targetInfo.keyType))) {
          const related = this.isRelatedTo(Number(info.type), Number(targetInfo.type));
          if (related === R.False) return R.False;
          result &= related;
        }
    }
    return Number(result);
  }

  private isObjectTypeWithInferableIndex(type: Type): boolean {
    if ((type.flags & F.Intersection) !== 0) {
      for (const id of type.types) if (!this.isObjectTypeWithInferableIndex(this.types[id])) return false;
      return true;
    }
    return type.inferableIndex;
  }

  private isLiteralType(id: number): boolean {
    const type = this.types[id];
    if ((type.flags & F.Union) !== 0) {
      for (const part of type.types) if ((this.types[part].flags & F.Unit) === 0) return false;
      return true;
    }
    return (type.flags & F.Unit) !== 0;
  }

  // Port of typeRelatedToDiscriminatedType: cover every cartesian combination,
  // then compare the remaining properties against every matching union member.
  private typeRelatedToDiscriminatedType(source: Type, target: Type): number {
    if (source.arrayElement >= 0 || (source.objectFlags & O.Tuple) !== 0) return R.False;
    this.arena.resolve(source);
    const members: number[] = [];
    for (const id of target.types)
      if ((this.types[id].flags & (F.Object | F.Intersection)) !== 0) {
        this.arena.resolve(this.types[id]);
        members.push(id);
      }
    if (members.length < 2) return R.False;
    const names: string[] = [];
    const choices: number[][] = [];
    let combinations = 1;
    for (const property of this.types[members[0]].properties) {
      const sourceIndex = source.propertyIndex.get(property.name);
      if (sourceIndex === undefined) continue;
      let nonUniform = false;
      let literal = false;
      let common = true;
      for (const id of members) {
        const member = this.types[id];
        const index = member.propertyIndex.get(property.name);
        if (index === undefined) {
          common = false;
          break;
        }
        const typeId = member.lookupProperties[index].type;
        if ((this.types[typeId].flags & F.Instantiable) !== 0) {
          common = false;
          break;
        }
        if (typeId !== property.type) nonUniform = true;
        if (this.isLiteralType(typeId)) literal = true;
      }
      if (!common || !nonUniform || !literal) continue;
      const sourceTypeId = source.lookupProperties[sourceIndex].type;
      const sourceType = this.types[sourceTypeId];
      const parts = (sourceType.flags & F.Union) !== 0 ? sourceType.types : [sourceTypeId];
      combinations *= parts.length;
      if (combinations === 0 || combinations > 25) return R.False;
      names.push(property.name);
      choices.push(parts);
    }
    if (names.length === 0) return R.False;
    const matching = new Uint8Array(members.length);
    for (let combination = 0; combination < combinations; combination++) {
      let hasMatch = false;
      for (let memberIndex = 0; memberIndex < members.length; memberIndex++) {
        const member = this.types[members[memberIndex]];
        let match = true;
        let remaining = combination;
        for (let i = names.length - 1; i >= 0; i--) {
          const name = names[i];
          const sourceIndex = source.propertyIndex.get(name);
          const targetIndex = member.propertyIndex.get(name);
          if (sourceIndex === undefined || targetIndex === undefined) {
            match = false;
            break;
          }
          const sourceProperty = source.lookupProperties[sourceIndex];
          const targetProperty = member.lookupProperties[targetIndex];
          if (
            (sourceProperty.privateOrigin !== targetProperty.privateOrigin &&
              (sourceProperty.privateOrigin >= 0 || targetProperty.privateOrigin >= 0)) ||
            (!this.strictNullChecks && sourceProperty.optional && !targetProperty.optional)
          ) {
            match = false;
            break;
          }
          const parts = choices[i];
          const related = this.isRelatedTo(Number(parts[remaining % parts.length]), Number(targetProperty.type));
          remaining = Math.floor(remaining / parts.length);
          if (related === R.False) {
            match = false;
            break;
          }
        }
        if (match) {
          matching[memberIndex] = 1;
          hasMatch = true;
        }
      }
      if (!hasMatch) return R.False;
    }
    let result = R.True as number;
    for (let i = 0; i < members.length; i++) {
      if (matching[i] === 0) continue;
      const related = this.objectRelatedTo(source, this.types[members[i]], names, false);
      if (related === R.False) return R.False;
      result &= related;
    }
    return result;
  }

  private isRelatedWithoutUndefined(source: number, target: number): number {
    const type = this.types[source];
    if ((type.flags & F.Union) === 0) return this.isRelatedTo(Number(source), Number(target));
    let result = R.True as number;
    for (const part of type.types) {
      if ((this.types[part].flags & F.Undefined) !== 0) continue;
      const related = this.isRelatedTo(Number(part), Number(target));
      if (related === R.False) return R.False;
      result &= related;
    }
    return result;
  }

  private tupleRelatedTo(source: Type, target: Type): number {
    if (source.readonly && !target.readonly) return R.False;
    const sourceArray = source.arrayElement >= 0;
    if (!sourceArray && (source.objectFlags & O.Tuple) === 0) return R.False;
    const sourceArity = sourceArray ? 1 : source.tupleElements.length;
    const targetArity = target.tupleElements.length;
    let sourceMinLength = 0;
    let targetMinLength = 0;
    let sourceRest = sourceArray;
    let targetRest = false;
    let targetVariable = false;
    let targetStart = 0;
    let targetEnd = 0;
    for (const flag of source.tupleFlags) {
      if ((flag & (E.Required | E.Variadic)) !== 0) sourceMinLength++;
      if ((flag & E.Rest) !== 0) sourceRest = true;
    }
    for (const flag of target.tupleFlags) {
      if ((flag & (E.Required | E.Variadic)) !== 0) targetMinLength++;
      if ((flag & E.Rest) !== 0) targetRest = true;
      if ((flag & E.Variable) !== 0) targetVariable = true;
    }
    if (!sourceRest && sourceArity < targetMinLength) return R.False;
    if (!targetVariable && (targetArity < sourceMinLength || sourceRest || targetArity < sourceArity)) return R.False;
    for (const flag of target.tupleFlags) {
      if ((flag & E.Rest) !== 0) break;
      targetStart++;
    }
    for (let i = targetArity - 1; i >= 0; i--) {
      if ((target.tupleFlags[i] & E.Rest) !== 0) break;
      targetEnd++;
    }
    let result = R.True as number;
    for (let i = 0; i < sourceArity; i++) {
      const sourceFlag = sourceArray ? E.Rest : source.tupleFlags[i];
      const targetPosition =
        targetRest && i >= targetStart ? targetArity - 1 - Math.min(sourceArity - 1 - i, targetEnd) : i;
      if (targetPosition < 0 || targetPosition >= targetArity) return R.False;
      const targetFlag = target.tupleFlags[targetPosition];
      if ((targetFlag & E.Variadic) !== 0 && (sourceFlag & E.Variadic) === 0) return R.False;
      if ((sourceFlag & E.Variadic) !== 0 && (targetFlag & E.Variable) === 0) return R.False;
      if ((targetFlag & E.Required) !== 0 && (sourceFlag & E.Required) === 0) return R.False;
      let sourceElement = sourceArray ? source.arrayElement : source.tupleElements[i];
      let targetElement = target.tupleElements[targetPosition];
      if ((sourceFlag & targetFlag & E.Optional) !== 0)
        sourceElement = this.arena.removeOptional(Number(sourceElement), true);
      if ((sourceFlag & E.Variadic) !== 0 && (targetFlag & E.Rest) !== 0)
        targetElement = this.arena.array(Number(targetElement), false);
      else if ((targetFlag & E.Optional) !== 0) targetElement = this.arena.removeOptional(Number(targetElement), true);
      const related = this.isRelatedTo(Number(sourceElement), Number(targetElement));
      if (related === R.False) return R.False;
      result &= related;
    }
    return result;
  }

  private signaturesRelatedTo(sources: Signature[], targets: Signature[], sameTemplate: boolean): number {
    let result = R.True as number;
    if (sameTemplate) {
      if (sources.length !== targets.length) throw new Error('Inconsistent instantiated signature template');
      for (let i = 0; i < targets.length; i++) {
        const related = this.compareSignaturesRelated(this.arena.erase(sources[i]), this.arena.erase(targets[i]), 0);
        if (related === R.False) return R.False;
        result &= related;
      }
      return result;
    }
    const erase = sources.length !== 1 || targets.length !== 1;
    for (const target of targets) {
      let some = R.False as number;
      for (const source of sources) {
        const related = this.compareSignaturesRelated(
          erase ? this.arena.erase(source) : source,
          erase ? this.arena.erase(target) : target,
          0,
        );
        if (related === R.True) {
          some = R.True;
          break;
        }
        some |= related;
      }
      if (some === R.False) return R.False;
      result &= some;
    }
    return result;
  }

  // Port of compareSignaturesRelated, using native contextual instantiation.
  private compareSignaturesRelated(source: Signature, target: Signature, callback: number): number {
    // The top signature accepts every function without generic instantiation.
    if (
      !target.generic &&
      target.parameters.length === 0 &&
      target.restType >= 0 &&
      (this.types[target.restType].flags & (F.Any | F.Never)) !== 0 &&
      (this.types[target.returnType].flags & (F.Any | F.Unknown)) !== 0 &&
      (target.thisType < 0 || (this.types[target.thisType].flags & F.Any) !== 0)
    )
      return R.True;
    if (source.unsupported.length !== 0 || target.unsupported.length !== 0)
      throw new Error('Unsupported signature: ' + source.unsupported + target.unsupported);
    if (source.abstract && !target.abstract) return R.False;
    if (target.restType < 0 && source.minArgumentCount > target.parameters.length) return R.False;
    if (source.generic) {
      const key = source.id + ':' + target.id;
      const cached = this.inferredSignatures.get(key);
      if (cached !== undefined) source = cached;
      else {
        const available = this.inferencePool.pop();
        const inference =
          available !== undefined
            ? available
            : new SignatureInference(
                this.arena,
                this.strictFunctionTypes,
                (s: number, t: number): boolean => this.isRelatedTo(Number(s), Number(t)) !== R.False,
              );
        try {
          const instantiated = inference.instantiate(source, target);
          this.inferredSignatures.set(key, instantiated);
          source = instantiated;
        } finally {
          this.inferencePool.push(inference);
        }
      }
    }
    const strictVariance = callback === 0 && this.strictFunctionTypes && !target.bivariant;
    let result = R.True as number;
    if (source.thisType >= 0 && (this.types[source.thisType].flags & F.Void) === 0 && target.thisType >= 0) {
      let related = strictVariance ? R.False : this.isRelatedTo(Number(source.thisType), Number(target.thisType));
      if (related === R.False) related = this.isRelatedTo(Number(target.thisType), Number(source.thisType));
      if (related === R.False) return R.False;
      result &= related;
    }
    const sourceCount = source.parameters.length + (source.restType >= 0 ? 1 : 0);
    const targetCount = target.parameters.length + (target.restType >= 0 ? 1 : 0);
    const tails = source.nonArrayRest || target.nonArrayRest;
    const count = tails ? Math.min(sourceCount, targetCount) : Math.max(sourceCount, targetCount);
    for (let i = 0; i < count; i++) {
      const s =
        tails && i === count - 1
          ? this.arena.tail(source, i)
          : i < source.parameters.length
            ? source.parameters[i]
            : source.restType;
      const t =
        tails && i === count - 1
          ? this.arena.tail(target, i)
          : i < target.parameters.length
            ? target.parameters[i]
            : target.restType;
      if (s < 0 || t < 0 || s === t) continue;
      const sourceType = this.types[s];
      const targetType = this.types[t];
      this.arena.resolve(sourceType);
      this.arena.resolve(targetType);
      let related = R.False as number;
      if (
        callback === 0 &&
        sourceType.calls.length === 1 &&
        targetType.calls.length === 1 &&
        sourceType.calls[0].predicateKind < 0 &&
        targetType.calls[0].predicateKind < 0
      ) {
        related = this.compareSignaturesRelated(targetType.calls[0], sourceType.calls[0], strictVariance ? 2 : 1);
      } else {
        if (!strictVariance && callback === 0) related = this.isRelatedTo(Number(s), Number(t));
        if (related === R.False) related = this.isRelatedTo(Number(t), Number(s));
      }
      if (related === R.False) return R.False;
      result &= related;
    }
    if ((this.types[target.returnType].flags & (F.Void | F.Any)) === 0) {
      if (target.predicateKind >= 0) {
        if (source.predicateKind < 0) return target.predicateKind < 2 ? R.False : result;
        if (
          source.predicateKind !== target.predicateKind ||
          ((target.predicateKind === 1 || target.predicateKind === 3) &&
            source.predicateIndex !== target.predicateIndex)
        )
          return R.False;
        if (source.predicateType === target.predicateType) return result;
        if (source.predicateType < 0 || target.predicateType < 0) return R.False;
        return result & this.isRelatedTo(Number(source.predicateType), Number(target.predicateType));
      }
      let related = callback === 1 ? this.isRelatedTo(Number(target.returnType), Number(source.returnType)) : R.False;
      if (related === R.False) related = this.isRelatedTo(Number(source.returnType), Number(target.returnType));
      if (related === R.False) return R.False;
      result &= related;
    }
    return result;
  }
}
