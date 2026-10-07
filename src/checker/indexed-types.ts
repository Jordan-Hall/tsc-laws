// Native keyof/indexed-access construction and constraint reduction, adapted
// from checker.go getIndexType/getIndexedAccessType/getConstraintFromIndexedAccess.
// Copyright Microsoft Corporation. Licensed under Apache-2.0.
import { TypeFlags as F, ObjectFlags as O, ElementFlags as E, IndexFlags as I, AccessFlags as A } from './flags.js';
import { emptyType, TYPE_ID_STRIDE } from './arena.js';
import type { TypeArena } from './arena.js';
import type { Type } from './types.js';

export class IndexedTypes {
  private readonly keys = new Map<number, number>();
  private readonly accesses = new Map<number, number>();
  private readonly deferredAccesses = new Map<number, number>();
  private readonly emptyKeyObjects = new Map<number, number>();
  private readonly constraints = new Map<number, number>();
  private readonly simplifiedTuples = new Map<number, number>();
  private readonly active = new Set<number>();
  private depth = 0;

  constructor(private readonly arena: TypeArena, private readonly strictNullChecks: boolean) {
    for (let id = 0; id < arena.types.length; id++) {
      const d = arena.types[id].data;
      if ((d.flags & F.Index) !== 0) this.keys.set(d.indexObject * 8 + d.indexFlags, id);
      if ((d.flags & F.IndexedAccess) !== 0) this.deferredAccesses.set(this.accessKey(d.indexObject, d.indexKey, d.accessFlags), id);
    }
  }

  private accessKey(object: number, index: number, flags: number): number { return (object * TYPE_ID_STRIDE + index) * 8 + (flags & 7); }

  propertyKeys(): number {
    return Number(this.arena.combine([this.arena.intrinsic(F.String), this.arena.intrinsic(F.Number), this.arena.intrinsic(F.ESSymbol)], F.Union));
  }

  simplify(id: number, writing: boolean = false): number {
    const d = this.arena.types[id].data;
    if ((d.flags & F.Conditional) !== 0) return Number(this.arena.conditional.simplify(Number(id)));
    if ((d.flags & F.Substitution) !== 0 && d.unsupported.length === 0) return Number(writing || this.arena.isNoInfer(Number(id)) ? d.indexObject : this.arena.combine([d.indexObject, d.constraint], F.Intersection));
    if ((d.flags & F.Index) !== 0) return Number(this.keyof(Number(d.indexObject), d.indexFlags));
    if ((d.flags & F.IndexedAccess) !== 0) {
      const index = this.arena.types[d.indexKey];
      if (this.arena.tuples.generic(Number(d.indexObject)) && (index.flags & F.NumberLike) !== 0) {
        const key = id * 2 + (writing ? 1 : 0);
        const previous = this.simplifiedTuples.get(key);
        if (previous !== undefined) return Number(previous);
        const start = (index.flags & F.Number) !== 0 ? 0 : this.arena.tuples.fixed(Number(d.indexObject));
        const result = this.arena.tuples.elementSlice(Number(d.indexObject), Number(start), 0, writing);
        this.simplifiedTuples.set(key, result);
        return Number(result);
      }
      return Number(this.access(Number(d.indexObject), Number(d.indexKey), d.accessFlags | (writing ? A.Writing : 0)));
    }
    return Number(id);
  }

  keyof(id: number, flags: number): number {
    const key = id * 8 + flags;
    const cached = this.keys.get(key);
    if (cached !== undefined) return Number(cached);
    const type = this.arena.types[id];
    if (type.unsupported.length > 0 && type.unsupported !== 'protected member') throw new Error('Unsupported keyof type: ' + type.unsupported);
    if (this.arena.isNoInfer(Number(id))) {
      const result = this.arena.noInfer(Number(this.keyof(Number(type.data.indexObject), flags)));
      this.keys.set(key, result);
      return Number(result);
    }
    if ((type.objectFlags & O.Mapped) !== 0) return Number(this.arena.mapped.keys(Number(id), flags));
    let defer = (type.flags & F.InstantiableNonPrimitive) !== 0 || this.arena.tuples.generic(Number(id));
    if ((type.flags & F.Union) !== 0 && (type.objectFlags & O.ContainsIntersections) !== 0 && this.containsVariable(id)) defer = true;
    if ((type.flags & F.Intersection) !== 0 && this.containsVariable(id)) {
      for (const part of type.types) {
        const t = this.arena.types[part];
        if ((t.flags & F.Object) !== 0 && (t.objectFlags & O.Anonymous) !== 0) {
          this.arena.resolve(t);
          if (t.properties.length === 0 && t.calls.length === 0 && t.constructs.length === 0 && t.stringIndex < 0 && t.numberIndex < 0 && t.symbolIndex < 0 && t.patternIndexes.length === 0) defer = true;
        }
      }
    }
    if (defer) {
      const data = emptyType(F.Index);
      data.indexObject = id;
      data.indexFlags = flags;
      const result = this.arena.add(data);
      this.keys.set(key, result);
      return Number(result);
    }
    let result: number;
    if ((type.flags & F.Unknown) !== 0) result = this.arena.intrinsic(F.Never);
    else if ((type.flags & (F.Any | F.Never)) !== 0) result = this.propertyKeys();
    else if ((type.flags & F.Index) !== 0) result = this.keyof(Number(this.propertyKeys()), flags);
    else if ((type.flags & F.UnionOrIntersection) !== 0) {
      const parts: number[] = [];
      for (const part of type.types) parts.push(this.keyof(Number(part), flags));
      result = (type.flags & F.Union) !== 0 ? this.intersectKeys(parts) : this.arena.combine(parts, F.Union);
    } else {
      const object = type.apparentType >= 0 ? this.arena.types[type.apparentType] : type;
      this.arena.resolve(object);
      const parts: number[] = [];
      for (const p of object.properties) {
        const keyFlags = this.arena.types[p.keyType].flags;
        if ((flags & I.StringsOnly) === 0 || (keyFlags & F.StringLike) !== 0) parts.push(p.keyType);
      }
      if ((flags & I.NoIndexSignatures) === 0) {
        for (const info of object.patternIndexes) parts.push(info.keyType);
        if (object.stringIndex >= 0) { parts.push(this.arena.intrinsic(F.String)); if ((flags & I.StringsOnly) === 0) parts.push(this.arena.intrinsic(F.Number)); }
        if ((flags & I.StringsOnly) === 0) {
          if (object.numberIndex >= 0 && !object.data.enumNumberIndex) parts.push(this.arena.intrinsic(F.Number));
          if (object.symbolIndex >= 0) parts.push(this.arena.intrinsic(F.ESSymbol));
        }
      }
      result = this.arena.combine(parts, F.Union);
    }
    this.keys.set(key, result);
    return Number(result);
  }

  private containsVariable(id: number): boolean {
    const type = this.arena.types[id];
    if ((type.flags & (F.TemplateLiteral | F.StringMapping)) !== 0) return !this.arena.strings.pattern(Number(id));
    if ((type.flags & F.Instantiable) !== 0) return true;
    if ((type.objectFlags & O.Mapped) !== 0 && this.arena.mapped.generic(Number(id))) return true;
    if ((type.flags & F.UnionOrIntersection) !== 0) for (const part of type.types) if (this.containsVariable(Number(part))) return true;
    if (this.arena.tuples.generic(Number(id))) return true;
    return false;
  }

  isGenericIndex(id: number): boolean {
    const type = this.arena.types[id];
    if ((type.flags & (F.InstantiableNonPrimitive | F.Index)) !== 0) return true;
    if ((type.flags & (F.TemplateLiteral | F.StringMapping)) !== 0) return !this.arena.strings.pattern(Number(id));
    if ((type.flags & F.UnionOrIntersection) !== 0) for (const part of type.types) if (this.isGenericIndex(Number(part))) return true;
    return false;
  }

  deferKeys(id: number, flags: number): number {
    const key = id * 8 + flags;
    const previous = this.keys.get(key);
    if (previous !== undefined) return Number(previous);
    const data = emptyType(F.Index);
    data.indexObject = id; data.indexFlags = flags;
    const result = this.arena.add(data);
    this.keys.set(key, result);
    return Number(result);
  }

  private keySubtype(source: number, target: number): boolean {
    if (source === target) return true;
    const s = this.arena.types[source];
    const t = this.arena.types[target];
    if ((s.flags & F.Never) !== 0 || (t.flags & F.AnyOrUnknown) !== 0) return true;
    if ((t.flags & F.TemplateLiteral) !== 0 && t.data.numericString && s.data.numericString) return true;
    if ((t.flags & F.TemplateLiteral) !== 0) return this.arena.strings.matches(Number(source), Number(target));
    if ((s.flags & F.StringLike) !== 0 && (t.flags & F.String) !== 0 || (s.flags & F.NumberLike) !== 0 && (t.flags & F.Number) !== 0 || (s.flags & F.ESSymbolLike) !== 0 && (t.flags & F.ESSymbol) !== 0) return true;
    if ((s.flags & F.EnumLiteral) !== 0 && (s.flags & F.Literal) !== 0 && (s.flags & F.Literal) === (t.flags & F.Literal) && s.value === t.value) return (t.flags & F.EnumLiteral) === 0 || this.arena.enumRelated(Number(source), Number(target));
    if ((s.flags & t.flags & F.EnumLiteral) !== 0) return false;
    return (s.flags & F.Literal) !== 0 && s.flags === t.flags && s.value === t.value;
  }

  intersectKeys(ids: number[]): number {
    if (ids.length === 0) return Number(this.propertyKeys());
    let result = Number(ids[0]);
    for (let i = 1; i < ids.length; i++) {
      const left = this.arena.types[result];
      const right = this.arena.types[ids[i]];
      if ((left.flags & F.Instantiable) !== 0 || (right.flags & F.Instantiable) !== 0) return Number(this.arena.combine(ids, F.Intersection));
      const leftParts = (left.flags & F.Union) !== 0 ? left.types : [result];
      const rightParts = (right.flags & F.Union) !== 0 ? right.types : [ids[i]];
      const parts: number[] = [];
      for (const s of leftParts) for (const t of rightParts) {
        if (this.keySubtype(Number(s), Number(t))) parts.push(s);
        else if (this.keySubtype(Number(t), Number(s))) parts.push(t);
      }
      result = this.arena.combine(parts, F.Union);
    }
    return Number(result);
  }

  access(objectId: number, indexId: number, flags: number): number {
    const key = this.accessKey(objectId, indexId, flags);
    const cached = this.accesses.get(key);
    if (cached !== undefined) return Number(cached);
    if (this.depth >= 100 || this.active.has(key)) throw new Error('Unsupported circular indexed access');
    this.active.add(key); this.depth++;
    let result = -1;
    try { result = this.accessWorker(objectId, indexId, flags); }
    finally { this.depth--; this.active.delete(key); }
    this.accesses.set(key, result);
    return Number(result);
  }

  private accessWorker(objectId: number, indexId: number, flags: number): number {
    const object = this.arena.types[objectId];
    const index = this.arena.types[indexId];
    if ((object.unsupported.length > 0 && object.unsupported !== 'protected member') || index.unsupported.length > 0) throw new Error('Unsupported indexed-access type: ' + object.unsupported + index.unsupported);
    if ((object.flags & F.AnyOrUnknown) !== 0 && ((object.flags & F.Any) !== 0 || this.containsVariable(indexId))) return Number(objectId);
    if ((index.flags & F.Union) !== 0) {
      const parts: number[] = [];
      for (const part of index.types) {
        const value = this.access(Number(objectId), Number(part), flags);
        if (value < 0) return -1;
        parts.push(value);
      }
      return Number(this.arena.combine(parts, (flags & A.Writing) !== 0 ? F.Intersection : F.Union));
    }
    if ((object.flags & F.UnionOrIntersection) !== 0 && !this.containsVariable(indexId)) {
      const parts: number[] = [];
      for (const part of object.types) {
        const value = this.access(Number(part), Number(indexId), flags);
        if (value >= 0) parts.push(value);
        else if ((object.flags & F.Union) !== 0) return -1;
      }
      if (parts.length === 0) return -1;
      return Number(this.arena.combine(parts, (object.flags & F.Intersection) !== 0 || (flags & A.Writing) !== 0 ? F.Intersection : F.Union));
    }
    if ((object.objectFlags & O.Mapped) !== 0 && this.arena.mapped.generic(Number(objectId)) && this.arena.mapped.filtering(Number(objectId))) return Number(this.arena.mapped.access(Number(objectId), Number(indexId)));
    const fixedTupleIndex = (object.objectFlags & O.Tuple) !== 0 && index.data.tupleIndex >= 0 && index.data.tupleIndex < this.arena.tuples.totalFixed(Number(objectId));
    if (this.containsVariable(objectId) && !fixedTupleIndex || this.containsVariable(indexId)) {
      const key = this.accessKey(objectId, indexId, flags & A.Persistent);
      const previous = this.deferredAccesses.get(key);
      if (previous !== undefined) return Number(previous);
      const data = emptyType(F.IndexedAccess);
      data.indexObject = objectId; data.indexKey = indexId; data.accessFlags = flags & A.Persistent;
      const result = this.arena.add(data);
      this.deferredAccesses.set(key, result);
      return Number(result);
    }
    const apparent = object.apparentType >= 0 ? this.arena.types[object.apparentType] : object;
    this.arena.resolve(apparent);
    if ((index.flags & (F.StringLiteral | F.NumberLiteral | F.UniqueESSymbol)) !== 0) {
      for (const p of apparent.lookupProperties) {
        const match = (index.flags & F.StringLiteral) !== 0 ? index.value === p.name : (index.flags & F.NumberLiteral) !== 0 ? p.numeric && index.value === p.numericName : indexId === p.keyType;
        if (match) {
          if (p.optional && this.strictNullChecks && ((flags & A.Writing) === 0 || !this.arena.exactOptionalPropertyTypes)) return Number(this.arena.combine([p.type, this.arena.optionalType()], F.Union));
          return Number(p.type);
        }
      }
    }
    if ((apparent.objectFlags & O.Tuple) !== 0 && index.data.tupleIndex >= 0) {
      let fixed = 0;
      while (fixed < apparent.tupleFlags.length && (apparent.tupleFlags[fixed] & E.Variable) === 0) fixed++;
      const pos = index.data.tupleIndex;
      let value: number;
      if (pos < fixed) {
        value = apparent.tupleElements[pos];
        if ((apparent.tupleFlags[pos] & E.Optional) !== 0 && this.strictNullChecks && ((flags & A.Writing) === 0 || !this.arena.exactOptionalPropertyTypes)) value = this.arena.combine([value, this.arena.intrinsic(F.Undefined)], F.Union);
      } else value = fixed === apparent.tupleElements.length ? this.arena.intrinsic(F.Undefined) : this.arena.tuples.elementSlice(Number(apparent.id), Number(fixed), 0);
      if ((flags & A.IncludeUndefined) !== 0) value = this.arena.combine([value, this.arena.intrinsic(F.Undefined)], F.Union);
      return Number(value);
    }
    let value = -1;
    let numberOnly = false;
    if (apparent.patternIndexes.length > 0) {
      const info = this.arena.indexes.find(apparent, Number(indexId));
      if (info !== undefined) { value = info.type; numberOnly = (this.arena.types[info.keyType].flags & F.Number) !== 0; }
      else if ((index.flags & (F.StringLike | F.NumberLike | F.ESSymbolLike | F.Any | F.Never)) !== 0) value = apparent.stringIndex;
    } else {
    if ((index.flags & (F.NumberLike | F.Any | F.Never)) !== 0 || index.data.numericKey || (index.flags & F.TemplateLiteral) !== 0 && index.data.numericString) { value = apparent.numberIndex; numberOnly = value >= 0; }
    if ((index.flags & (F.ESSymbolLike | F.Any | F.Never)) !== 0 && apparent.symbolIndex >= 0) {
      value = value >= 0 ? this.arena.combine([value, apparent.symbolIndex], F.Intersection) : apparent.symbolIndex;
      numberOnly = false;
    }
    if (value < 0 && (index.flags & (F.StringLike | F.NumberLike | F.ESSymbolLike | F.Any | F.Never)) !== 0) value = apparent.stringIndex;
    }
    if ((flags & A.NoIndexSignatures) !== 0 && value >= 0 && !numberOnly) return -1;
    if (value >= 0) return Number((flags & A.IncludeUndefined) !== 0 ? this.arena.combine([value, this.arena.intrinsic(F.Undefined)], F.Union) : value);
    if ((index.flags & F.Never) !== 0 || (object.flags & F.Never) !== 0) return Number(this.arena.intrinsic(F.Never));
    if ((index.flags & F.Any) !== 0) return Number(indexId);
    return -1;
  }

  constraint(id: number): number {
    const previous = this.constraints.get(id);
    if (previous !== undefined) return Number(previous);
    this.constraints.set(id, -1);
    const type = this.arena.types[id];
    let result = -1;
    if ((type.flags & F.TypeParameter) !== 0) result = type.constraint;
    else if ((type.flags & F.TemplateLiteral) !== 0) result = this.arena.strings.constraint(Number(id));
    else if ((type.flags & F.StringMapping) !== 0) result = this.arena.stringMappings.constraint(Number(id));
    else if ((type.flags & F.Conditional) !== 0) result = this.arena.conditional.constraint(Number(id));
    else if (this.arena.tuples.generic(Number(id))) result = this.arena.tuples.constraint(Number(id));
    else if ((type.flags & F.Substitution) !== 0 && type.unsupported.length === 0) result = this.arena.substitutionIntersection(Number(this.baseConstraint(Number(type.data.indexObject))), Number(this.baseConstraint(Number(type.constraint))));
    else if ((type.flags & F.Index) !== 0) result = this.propertyKeys();
    else if ((type.flags & F.IndexedAccess) !== 0) {
      if (this.arena.mapped.isArrayIterator(Number(type.data.indexKey))) {
        const objectBound = this.baseConstraint(Number(type.data.indexObject));
        if (this.arena.types[objectBound].arrayElement >= 0) {
          const element = this.arena.types[objectBound].arrayElement;
          this.constraints.set(id, element);
          return Number(element);
        }
      }
      const simplified = this.simplify(id);
      if (simplified >= 0 && simplified !== id) result = simplified;
      else {
        const index = this.constraint(Number(type.data.indexKey));
        if (index >= 0) result = this.access(Number(type.data.indexObject), Number(index), type.data.accessFlags);
        if (result < 0 || result === id) {
          const object = this.constraint(Number(type.data.indexObject));
          if (object >= 0) result = this.access(Number(object), Number(type.data.indexKey), type.data.accessFlags);
        }
        if (result === id) result = -1;
      }
    }
    this.constraints.set(id, result);
    return Number(result);
  }

  baseConstraint(id: number): number {
    const seen = new Set<number>();
    let result = id;
    while (!seen.has(result)) {
      seen.add(result);
      const next = this.constraint(Number(result));
      if (next < 0 || next === result) return Number(result);
      result = next;
    }
    return Number(id);
  }

  emptyObjectForKeys(id: number): number {
    const previous = this.emptyKeyObjects.get(id);
    if (previous !== undefined) return Number(previous);
    const data = emptyType(F.Object);
    data.objectFlags = O.Anonymous;
    const type = this.arena.types[id];
    const parts = (type.flags & F.Union) !== 0 ? type.types : [id];
    for (const part of parts) {
      const key = this.arena.types[part];
      if ((key.flags & F.StringLiteral) !== 0) data.properties.push({ name: key.value, numeric: key.data.numericKey,
        numericName: '', keyType: part, type: this.arena.intrinsic(F.Any), optional: false, readonly: false, privateOrigin: -1 });
    }
    if ((type.flags & F.String) !== 0) data.stringIndex = this.arena.add(emptyType(F.Object));
    const result = this.arena.add(data);
    this.emptyKeyObjects.set(id, result);
    return Number(result);
  }
}
