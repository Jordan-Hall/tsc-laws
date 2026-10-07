// Mapped construction adapted from resolveMappedTypeMembers/instantiateMappedType.
// Copyright Microsoft Corporation. Licensed under Apache-2.0.
import {
  TypeFlags as F,
  ObjectFlags as O,
  ElementFlags as E,
  IndexFlags as I,
  MappedTypeModifiers as M,
} from './flags.js';
import { TYPE_ID_STRIDE } from './arena.js';
import type { TypeArena, Mapper } from './arena.js';
import type { Type, Property, TypeData, IndexInfo } from './types.js';

export class MappedTypes {
  private readonly instances = new Map<string, number>();
  private readonly genericActive = new Set<number>();
  private readonly optionalActive = new Set<number>();
  private readonly apparentTypes = new Map<number, number>();
  private readonly arrayIterators = new Set<number>();
  private readonly scopes = new Map<number, Mapper>();

  constructor(private readonly arena: TypeArena) {
    for (let i = 0; i < arena.types.length; i++) {
      const d = arena.types[i].data;
      if ((d.objectFlags & O.Mapped) !== 0 && d.target >= 0)
        this.instances.set(d.target + ':' + d.typeArguments.join(','), i);
    }
  }

  root(id: number): number {
    return Number(this.arena.types[id].data.target >= 0 ? this.arena.types[id].data.target : id);
  }

  scope(id: number, key: number): Mapper {
    const cacheKey = id * (TYPE_ID_STRIDE + 1) + key + 1;
    const previous = this.scopes.get(cacheKey);
    if (previous !== undefined) return previous;
    const type = this.arena.types[id];
    const root = this.arena.types[this.root(Number(id))];
    const sources = root.data.typeParameters.slice();
    const targets = type.data.target >= 0 ? type.data.typeArguments.slice() : sources.slice();
    if (key >= 0) {
      sources.push(root.data.mappedParameter);
      targets.push(key);
    }
    const result = this.arena.mapper(sources, targets);
    this.scopes.set(cacheKey, result);
    return result;
  }

  prepare(id: number): void {
    const type = this.arena.types[id];
    if (type.mappedPrepared) return;
    type.mappedPrepared = true;
    if (type.data.target < 0) {
      if (
        type.data.mappedHomomorphic >= 0 &&
        this.arrayLike(Number(this.arena.indexed.baseConstraint(Number(type.data.mappedModifiersType))))
      )
        this.arrayIterators.add(type.data.mappedParameter);
      return;
    }
    const root = this.arena.types[this.root(Number(id))];
    const mapper = this.scope(Number(id), -1);
    const param = this.arena.add({
      ...this.arena.types[root.data.mappedParameter].data,
      constraint: -1,
      defaultType: -1,
    });
    type.data.mappedParameter = param;
    type.data.mappedConstraint = this.arena.instantiate(Number(root.data.mappedConstraint), mapper);
    type.data.mappedModifiersType = this.arena.instantiate(Number(root.data.mappedModifiersType), mapper);
    type.data.mappedHomomorphic = this.arena.instantiate(Number(root.data.mappedHomomorphic), mapper);
    type.data.mappedModifiers = root.data.mappedModifiers;
    type.data.mappedKeyof = root.data.mappedKeyof;
    type.data.mappedTemplate = root.data.mappedTemplate;
    type.data.mappedName = root.data.mappedName;
    this.arena.types[param].constraint = type.data.mappedConstraint;
    this.arena.types[param].data.constraint = type.data.mappedConstraint;
    if (
      type.data.mappedHomomorphic >= 0 &&
      this.arrayLike(Number(this.arena.indexed.baseConstraint(Number(type.data.mappedModifiersType))))
    )
      this.arrayIterators.add(param);
  }

  instantiate(id: number, mapper: Mapper): number {
    const type = this.arena.types[id];
    const rootId = this.root(Number(id));
    const root = this.arena.types[rootId];
    const original = type.data.target >= 0 ? type.data.typeArguments : root.data.typeParameters;
    const args: number[] = [];
    let changed = false;
    for (const arg of original) {
      const value = this.arena.instantiate(Number(arg), mapper);
      args.push(value);
      if (value !== arg) changed = true;
    }
    if (!changed) return Number(id);
    const result = this.construct(Number(rootId), args);
    mapper.memo.set(id, result);
    return Number(result);
  }

  private construct(rootId: number, args: number[]): number {
    const cacheKey = rootId + ':' + args.join(',');
    const previous = this.instances.get(cacheKey);
    if (previous !== undefined) return Number(previous);
    const root = this.arena.types[rootId];
    const data: TypeData = {
      ...root.data,
      target: rootId,
      typeArguments: args,
      typeParameters: [],
      objectFlags: root.objectFlags | O.Instantiated,
      mappedParameter: -1,
      mappedConstraint: -1,
      mappedModifiersType: -1,
      mappedHomomorphic: -1,
      properties: [],
      fallbackProperties: [],
      calls: [],
      constructs: [],
    };
    const result = this.arena.add(data);
    this.instances.set(cacheKey, result);
    this.prepare(Number(result));
    const subject = this.arena.types[result].data.mappedHomomorphic;
    if (subject >= 0 && subject !== root.data.mappedHomomorphic) {
      const type = this.arena.types[subject];
      let mapped = result;
      if ((type.flags & F.Union) !== 0) {
        const parts: number[] = [];
        for (const part of type.types) parts.push(this.withSubject(Number(result), Number(part)));
        mapped = this.arena.combine(parts, F.Union);
      } else if ((type.flags & (F.AnyOrUnknown | F.InstantiableNonPrimitive | F.Object | F.Intersection)) === 0)
        mapped = subject;
      else if (root.data.mappedName < 0) {
        if (
          type.arrayElement >= 0 ||
          ((type.flags & F.Any) !== 0 &&
            this.arrayLike(Number(this.arena.indexed.baseConstraint(Number(root.data.mappedHomomorphic)))))
        )
          mapped = this.arena.array(
            Number(this.element(Number(result), Number(this.arena.intrinsic(F.Number)), true)),
            this.readonly(type.readonly, root.data.mappedModifiers),
          );
        else if ((type.objectFlags & O.Tuple) !== 0) mapped = this.mapTuple(Number(result), Number(subject));
        else if ((type.flags & F.Intersection) !== 0 && this.arrayLike(Number(subject))) {
          const parts: number[] = [];
          for (const part of type.types) parts.push(this.withSubject(Number(result), Number(part)));
          mapped = this.arena.combine(parts, F.Intersection);
        }
      }
      this.instances.set(cacheKey, mapped);
      return Number(mapped);
    }
    return Number(result);
  }

  private withSubject(id: number, subject: number): number {
    const rootId = this.root(Number(id));
    const root = this.arena.types[rootId];
    const mapper = this.scope(Number(id), -1);
    const args: number[] = [];
    for (const param of root.data.typeParameters)
      args.push(param === root.data.mappedHomomorphic ? subject : this.arena.instantiate(Number(param), mapper));
    return Number(this.construct(Number(rootId), args));
  }

  private mapTuple(id: number, subject: number): number {
    const source = this.arena.types[subject];
    const modifiers = this.arena.types[id].data.mappedModifiers;
    const elements: number[] = [];
    const flags: number[] = [];
    let fixed = true;
    for (let i = 0; i < source.tupleElements.length; i++) {
      const flag = source.tupleFlags[i];
      if ((flag & E.Variable) !== 0) fixed = false;
      if ((flag & E.Variadic) !== 0) elements.push(this.withSubject(Number(id), Number(source.tupleElements[i])));
      else if (fixed)
        elements.push(
          this.element(Number(id), Number(this.arena.positionKey(Number(i), false)), (flag & E.Optional) !== 0),
        );
      else {
        const array = this.withSubject(Number(id), Number(this.arena.array(Number(source.tupleElements[i]), false)));
        elements.push(this.arena.types[array].arrayElement);
      }
      flags.push(
        (modifiers & M.IncludeOptional) !== 0 && (flag & E.Required) !== 0
          ? E.Optional
          : (modifiers & M.ExcludeOptional) !== 0 && (flag & E.Optional) !== 0
            ? E.Required
            : flag,
      );
    }
    return Number(this.arena.tuple(elements, flags, this.readonly(source.readonly, modifiers)));
  }

  private readonly(original: boolean, modifiers: number): boolean {
    return (modifiers & M.IncludeReadonly) !== 0 || ((modifiers & M.ExcludeReadonly) === 0 && original);
  }

  value(id: number, key: number): number {
    const root = this.arena.types[this.root(Number(id))];
    return Number(this.arena.instantiate(Number(root.data.mappedTemplate), this.scope(Number(id), Number(key))));
  }

  name(id: number, key: number): number {
    const root = this.arena.types[this.root(Number(id))];
    return Number(
      root.data.mappedName < 0
        ? -1
        : this.arena.instantiate(Number(root.data.mappedName), this.scope(Number(id), Number(key))),
    );
  }

  private element(id: number, key: number, optional: boolean): number {
    const value = this.value(Number(id), Number(key));
    const modifiers = this.arena.types[id].data.mappedModifiers;
    if (!this.arena.strictNullChecks) return Number(value);
    if ((modifiers & M.IncludeOptional) !== 0)
      return Number(this.arena.combine([value, this.arena.optionalType()], F.Union));
    if ((modifiers & M.ExcludeOptional) !== 0 && optional)
      return Number(this.arena.removeOptional(Number(value), this.arena.exactOptionalPropertyTypes));
    return Number(value);
  }

  generic(id: number): boolean {
    const type = this.arena.types[id];
    if (type.mappedGeneric >= 0) return type.mappedGeneric === 1;
    if (this.genericActive.has(id)) return true;
    this.genericActive.add(id);
    try {
      this.prepare(Number(id));
      const d = this.arena.types[id].data;
      if (this.arena.indexed.isGenericIndex(Number(d.mappedConstraint))) {
        type.mappedGeneric = 1;
        return true;
      }
      const name = this.name(Number(id), Number(d.mappedConstraint));
      const generic = name >= 0 && this.arena.indexed.isGenericIndex(Number(name));
      type.mappedGeneric = generic ? 1 : 0;
      return generic;
    } finally {
      this.genericActive.delete(id);
    }
  }

  filtering(id: number): boolean {
    this.prepare(Number(id));
    const d = this.arena.types[id].data;
    if (d.mappedName < 0) return true;
    const name = this.name(Number(id), Number(d.mappedParameter));
    if (name === d.mappedParameter || (this.arena.types[name].flags & F.Never) !== 0) return true;
    const type = this.arena.types[name];
    return (type.flags & F.Intersection) !== 0 && type.types.includes(d.mappedParameter);
  }

  access(id: number, key: number): number {
    let value = this.value(Number(id), Number(key));
    if (this.arena.strictNullChecks && this.optionality(Number(id)) > 0)
      value = this.arena.combine([value, this.arena.optionalType()], F.Union);
    return Number(value);
  }

  private arrayLike(id: number): boolean {
    const type = this.arena.types[id];
    if (type.arrayElement >= 0 || (type.objectFlags & O.Tuple) !== 0) return true;
    if ((type.flags & F.UnionOrIntersection) === 0 || type.types.length === 0) return false;
    for (const part of type.types) if (!this.arrayLike(Number(part))) return false;
    return true;
  }

  apparent(id: number): number {
    const previous = this.apparentTypes.get(id);
    if (previous !== undefined) return Number(previous);
    this.apparentTypes.set(id, id);
    this.prepare(Number(id));
    const d = this.arena.types[id].data;
    const root = this.arena.types[this.root(Number(id))].data;
    if (root.mappedHomomorphic < 0 || root.mappedName >= 0) return Number(id);
    const modifiers = this.arena.types[d.mappedModifiersType];
    const base =
      (modifiers.objectFlags & O.Mapped) !== 0 && this.generic(Number(modifiers.id))
        ? this.apparent(Number(modifiers.id))
        : this.arena.indexed.baseConstraint(Number(modifiers.id));
    if (!this.arrayLike(Number(base))) return Number(id);
    const result = this.withSubject(Number(id), Number(base));
    this.apparentTypes.set(id, result);
    return Number(result);
  }

  isArrayIterator(id: number): boolean {
    return this.arrayIterators.has(id);
  }

  apparentKeys(id: number): number {
    this.prepare(Number(id));
    const parts: number[] = [];
    for (const key of this.keyParts(Number(id))) {
      const name = this.name(Number(id), Number(key));
      parts.push(name < 0 ? key : name);
    }
    return Number(this.arena.combine(parts, F.Union));
  }

  keys(id: number, flags: number): number {
    this.prepare(Number(id));
    const d = this.arena.types[id].data;
    if (d.mappedName < 0 && (flags & I.NoIndexSignatures) === 0) return Number(d.mappedConstraint);
    if (d.mappedKeyof && this.generic(Number(id))) return Number(this.arena.indexed.deferKeys(Number(id), flags));
    const parts: number[] = [];
    for (const key of this.keyParts(Number(id))) {
      const name = this.name(Number(id), Number(key));
      const value = name >= 0 ? name : key;
      parts.push(
        (this.arena.types[value].flags & F.String) !== 0
          ? this.arena.combine([value, this.arena.intrinsic(F.Number)], F.Union)
          : value,
      );
    }
    let result = this.arena.combine(parts, F.Union);
    if ((flags & I.NoIndexSignatures) !== 0) {
      const t = this.arena.types[result];
      const list = (t.flags & F.Union) !== 0 ? t.types : [result];
      result = this.arena.combine(
        list.filter((part) => (this.arena.types[part].flags & (F.Any | F.String)) === 0),
        F.Union,
      );
    }
    return Number(result);
  }

  private lowerBound(id: number): number {
    const type = this.arena.types[id];
    if ((type.flags & F.Index) !== 0) {
      const target = this.arena.indexed.baseConstraint(Number(type.data.indexObject));
      return Number(this.arena.indexed.keyof(Number(target), 0));
    }
    if ((type.flags & F.Union) !== 0) {
      const parts: number[] = [];
      for (const part of type.types) parts.push(this.lowerBound(Number(part)));
      return Number(this.arena.combine(parts, F.Union));
    }
    return Number(id);
  }

  private keyParts(id: number): number[] {
    const d = this.arena.types[id].data;
    if (d.mappedKeyof) {
      const original = this.arena.indexed.baseConstraint(Number(d.mappedModifiersType));
      let source = this.arena.types[original];
      if ((source.flags & F.Any) !== 0) return [this.arena.intrinsic(F.String)];
      if (source.apparentType >= 0) source = this.arena.types[source.apparentType];
      if ((source.flags & F.UnionOrIntersection) === 0) {
        this.arena.resolve(source);
        const keys: number[] = [];
        for (const p of source.properties) keys.push(p.keyType);
        if (source.stringIndex >= 0) keys.push(this.arena.intrinsic(F.String));
        if (source.numberIndex >= 0) keys.push(this.arena.intrinsic(F.Number));
        if (source.symbolIndex >= 0) keys.push(this.arena.intrinsic(F.ESSymbol));
        for (const info of source.patternIndexes) keys.push(info.keyType);
        return keys;
      }
    }
    const constraint = this.lowerBound(Number(d.mappedConstraint));
    const type = this.arena.types[constraint];
    return (type.flags & F.Union) !== 0 ? type.types : [constraint];
  }

  resolve(type: Type): void {
    this.prepare(Number(type.id));
    const d = type.data;
    const modifierId = this.arena.indexed.baseConstraint(Number(d.mappedModifiersType));
    let modifiersType = this.arena.types[modifierId];
    if (modifiersType.apparentType >= 0) modifiersType = this.arena.types[modifiersType.apparentType];
    this.arena.resolve(modifiersType);
    const properties: Property[] = [];
    const propertyKeys: number[][] = [];
    const stripOptional: boolean[] = [];
    const indexes: number[][] = [[], [], []];
    const patterns: IndexInfo[] = [];
    let indexReadonly = 0;
    for (const key of this.keyParts(Number(type.id))) {
      const remapped = this.name(Number(type.id), Number(key));
      const nameId = remapped >= 0 ? remapped : key;
      const name = this.arena.types[nameId];
      const names = (name.flags & F.Union) !== 0 ? name.types : [nameId];
      for (const part of names) {
        const keyType = this.arena.types[part];
        if (keyType.unsupported.length > 0) throw new Error('Unsupported mapped key: ' + keyType.unsupported);
        if ((keyType.flags & F.StringOrNumberLiteralOrUnique) !== 0) {
          const inputKey = this.arena.types[key];
          const index = modifiersType.propertyIndex.get(inputKey.data.keyName);
          const original = index === undefined ? undefined : modifiersType.lookupProperties[index];
          const optional =
            (d.mappedModifiers & M.IncludeOptional) !== 0 ||
            ((d.mappedModifiers & M.ExcludeOptional) === 0 && original !== undefined && original.optional);
          const p: Property = {
            name: keyType.data.keyName,
            keyType: part,
            numeric: keyType.data.numericName.length > 0,
            numericName: keyType.data.numericName,
            type: -1,
            optional,
            readonly: this.readonly(original !== undefined && original.readonly, d.mappedModifiers),
            privateOrigin: -1,
          };
          let existing = -1;
          for (let i = 0; i < properties.length; i++)
            if (properties[i].name === p.name) {
              existing = i;
              break;
            }
          if (existing < 0) {
            properties.push(p);
            propertyKeys.push([key]);
            stripOptional.push(!optional && original !== undefined && original.optional);
          } else {
            propertyKeys[existing].push(key);
            properties[existing].keyType = this.arena.combine([properties[existing].keyType, part], F.Union);
          }
        } else {
          const original = this.arena.indexes.find(modifiersType, Number(part));
          const readonly = this.readonly(original !== undefined && original.readonly, d.mappedModifiers);
          if ((keyType.flags & (F.TemplateLiteral | F.StringMapping)) !== 0) {
            this.arena.indexes.append(
              patterns,
              { keyType: part, type: this.value(Number(type.id), Number(key)), readonly },
              true,
            );
          } else {
            const slot =
              (keyType.flags & (F.String | F.Any)) !== 0
                ? 0
                : (keyType.flags & (F.Number | F.Enum)) !== 0
                  ? 1
                  : (keyType.flags & F.ESSymbol) !== 0
                    ? 2
                    : -1;
            if (slot >= 0) {
              indexes[slot].push(this.value(Number(type.id), Number(key)));
              if (readonly) indexReadonly |= 1 << slot;
            }
          }
        }
      }
    }
    for (let i = 0; i < properties.length; i++) {
      let value = this.value(Number(type.id), Number(this.arena.combine(propertyKeys[i], F.Union)));
      if (
        properties[i].optional &&
        this.arena.strictNullChecks &&
        !this.arena.exactOptionalPropertyTypes &&
        (this.arena.types[value].flags & F.Void) === 0
      )
        value = this.arena.combine([value, this.arena.intrinsic(F.Undefined)], F.Union);
      else if (stripOptional[i] && this.arena.strictNullChecks)
        value = this.arena.removeOptional(Number(value), this.arena.exactOptionalPropertyTypes);
      if (this.arena.exactOptionalPropertyTypes) value = this.arena.removeOptional(Number(value), true);
      properties[i].type = value;
    }
    type.setMembers(
      properties,
      [],
      [],
      [],
      indexes[0].length === 0 ? -1 : this.arena.combine(indexes[0], F.Union),
      indexes[1].length === 0 ? -1 : this.arena.combine(indexes[1], F.Union),
      indexes[2].length === 0 ? -1 : this.arena.combine(indexes[2], F.Union),
      patterns,
      indexReadonly,
    );
    type.inferableIndex = true;
  }

  optionality(id: number): number {
    if (id < 0 || this.optionalActive.has(id)) return 0;
    this.optionalActive.add(id);
    try {
      const type = this.arena.types[id];
      if ((type.objectFlags & O.Mapped) !== 0) {
        this.prepare(Number(id));
        const d = type.data;
        if ((d.mappedModifiers & M.ExcludeOptional) !== 0) return -1;
        if ((d.mappedModifiers & M.IncludeOptional) !== 0) return 1;
        return Number(this.optionality(Number(d.mappedModifiersType)));
      }
      if ((type.flags & F.Intersection) !== 0 && type.types.length > 0) {
        const first = this.optionality(Number(type.types[0]));
        for (const part of type.types) if (this.optionality(Number(part)) !== first) return 0;
        return Number(first);
      }
      return 0;
    } finally {
      this.optionalActive.delete(id);
    }
  }
}
