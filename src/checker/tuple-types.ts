// Tuple normalization and slicing adapted from checker.go and relater.go.
// Copyright Microsoft Corporation. Licensed under Apache-2.0.
import { TypeFlags as F, ObjectFlags as O, ElementFlags as E } from './flags.js';
import { emptyType } from './arena.js';
import type { TypeArena, Mapper } from './arena.js';
import type { Type } from './types.js';

export class TupleTypes {
  private readonly tuples = new Map<string, number>();
  private depth = 0;
  constructor(private readonly arena: TypeArena) {
    for (const type of arena.types)
      if ((type.objectFlags & O.Tuple) !== 0)
        this.tuples.set(this.key(type.tupleElements, type.tupleFlags, type.readonly), type.id);
  }
  private key(elements: number[], flags: number[], readonly: boolean): string {
    return elements.join(',') + ':' + flags.join(',') + ':' + readonly;
  }
  generic(id: number): boolean {
    const type = this.arena.types[id];
    if ((type.objectFlags & O.Tuple) !== 0)
      for (const flag of type.tupleFlags) if ((flag & E.Variadic) !== 0) return true;
    return false;
  }
  fixed(id: number): number {
    const flags = this.arena.types[id].tupleFlags;
    let count = 0;
    while (count < flags.length && (flags[count] & E.Fixed) !== 0) count++;
    return Number(count);
  }
  end(id: number): number {
    const flags = this.arena.types[id].tupleFlags;
    let count = 0;
    while (count < flags.length && (flags[flags.length - count - 1] & E.Fixed) !== 0) count++;
    return Number(count);
  }
  totalFixed(id: number): number {
    return Number(this.fixed(Number(id)) + (this.variable(Number(id)) ? this.end(Number(id)) : 0));
  }
  knownKeys(id: number): number {
    const type = this.arena.types[id];
    const keys: number[] = [];
    for (let i = 0; i < this.fixed(Number(id)); i++) keys.push(this.arena.positionKey(Number(i), false));
    keys.push(
      this.arena.indexed.keyof(Number(this.arena.array(Number(this.arena.intrinsic(F.Any)), type.readonly)), 0),
    );
    return Number(this.arena.combine(keys, F.Union));
  }
  variable(id: number): boolean {
    for (const flag of this.arena.types[id].tupleFlags) if ((flag & E.Variable) !== 0) return true;
    return false;
  }
  instantiate(id: number, mapper: Mapper): number {
    const type = this.arena.types[id];
    const elements: number[] = [];
    let changed = false;
    for (const element of type.tupleElements) {
      const value = this.arena.instantiate(Number(element), mapper);
      elements.push(value);
      if (value !== element) changed = true;
    }
    const result = changed ? this.create(elements, type.tupleFlags, type.readonly) : id;
    mapper.memo.set(id, result);
    return Number(result);
  }
  create(elements: number[], flags: number[], readonly: boolean): number {
    if (elements.length !== flags.length) throw new Error('Invalid tuple element flags');
    if (++this.depth > 100) {
      this.depth--;
      throw new Error('Tuple normalization complexity limit exceeded');
    }
    try {
      return Number(this.normalize(elements, flags, readonly));
    } finally {
      this.depth--;
    }
  }
  private normalize(elements: number[], flags: number[], readonly: boolean): number {
    for (let i = 0; i < elements.length; i++)
      if ((flags[i] & E.Variadic) !== 0) {
        const type = this.arena.types[elements[i]];
        if ((type.flags & F.Never) !== 0) return Number(elements[i]);
        if ((type.flags & F.Union) !== 0) {
          let combinations = type.types.length;
          for (let j = i + 1; j < elements.length; j++)
            if ((flags[j] & E.Variadic) !== 0 && (this.arena.types[elements[j]].flags & F.Union) !== 0)
              combinations *= this.arena.types[elements[j]].types.length;
          if (combinations >= 100000) throw new Error('Tuple union exceeds the 100000-combination limit');
          const parts: number[] = [];
          for (const part of type.types) {
            const replaced = elements.slice();
            replaced[i] = part;
            parts.push(this.create(replaced, flags, readonly));
          }
          return Number(this.arena.combine(parts, F.Union));
        }
      }
    const resultElements: number[] = [];
    const resultFlags: number[] = [];
    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      const type = this.arena.types[element];
      if ((flags[i] & E.Variadic) === 0) {
        resultElements.push(element);
        resultFlags.push(flags[i]);
      } else if ((type.flags & F.Any) !== 0) {
        resultElements.push(element);
        resultFlags.push(E.Rest);
      } else if (
        (type.flags & F.InstantiableNonPrimitive) !== 0 ||
        ((type.objectFlags & O.Mapped) !== 0 && this.arena.mapped.generic(Number(element)))
      ) {
        resultElements.push(element);
        resultFlags.push(E.Variadic);
      } else if ((type.objectFlags & O.Tuple) !== 0) {
        if (resultElements.length + type.tupleElements.length >= 10000)
          throw new Error('Tuple type exceeds the 10000-element limit');
        for (let j = 0; j < type.tupleElements.length; j++) {
          resultElements.push(type.tupleElements[j]);
          resultFlags.push(type.tupleFlags[j]);
        }
      } else {
        const value = this.arena.indexed.access(Number(element), Number(this.arena.intrinsic(F.Number)), 0);
        resultElements.push(value >= 0 ? value : this.arena.intrinsic(F.Any));
        resultFlags.push(E.Rest);
      }
    }
    let firstRest = -1;
    let lastRequired = -1;
    let lastOptionalOrRest = -1;
    for (let i = 0; i < resultFlags.length; i++) {
      const flag = resultFlags[i];
      if ((flag & E.Rest) !== 0 && firstRest < 0) firstRest = i;
      if ((flag & E.Required) !== 0) lastRequired = i;
      if ((flag & (E.Optional | E.Rest)) !== 0) lastOptionalOrRest = i;
      if (this.arena.strictNullChecks && (flag & E.Optional) !== 0)
        resultElements[i] = this.arena.combine([resultElements[i], this.arena.optionalType()], F.Union);
    }
    for (let i = 0; i < lastRequired; i++) if ((resultFlags[i] & E.Optional) !== 0) resultFlags[i] = E.Required;
    if (firstRest >= 0 && firstRest < lastOptionalOrRest) {
      const collapsed: number[] = [];
      for (let i = firstRest; i <= lastOptionalOrRest; i++)
        collapsed.push(
          (resultFlags[i] & E.Variadic) !== 0
            ? this.arena.indexed.access(Number(resultElements[i]), Number(this.arena.intrinsic(F.Number)), 0)
            : resultElements[i],
        );
      resultElements.splice(firstRest, lastOptionalOrRest - firstRest + 1, this.arena.combine(collapsed, F.Union));
      resultFlags.splice(firstRest, lastOptionalOrRest - firstRest + 1, E.Rest);
    }
    if (resultFlags.length === 1 && resultFlags[0] === E.Rest)
      return Number(this.arena.array(Number(resultElements[0]), readonly));
    return Number(this.shape(resultElements, resultFlags, readonly));
  }
  // Base constraints replace spread arguments without changing the tuple's
  // flags. Normalizing them would incorrectly make a generic indexed target
  // writable through its broad array constraint.
  private shape(elements: number[], flags: number[], readonly: boolean): number {
    const key = this.key(elements, flags, readonly);
    const previous = this.tuples.get(key);
    if (previous !== undefined) return Number(previous);
    const data = emptyType(F.Object);
    data.objectFlags = O.Tuple | O.Reference;
    data.tupleElements = elements;
    data.tupleFlags = flags;
    data.readonly = readonly;
    const result = this.arena.add(data);
    this.tuples.set(key, result);
    this.arena.types[result].numberIndex = this.elementSlice(Number(result), 0, 0);
    this.arena.types[result].data.numberIndex = this.arena.types[result].numberIndex;
    return Number(result);
  }
  elementSlice(id: number, start: number, endSkip: number, writing: boolean = false): number {
    const type = this.arena.types[id];
    const parts: number[] = [];
    for (let i = start; i < type.tupleElements.length - endSkip; i++) {
      const element = type.tupleElements[i];
      const value =
        (type.tupleFlags[i] & E.Variadic) !== 0
          ? this.arena.indexed.access(Number(element), Number(this.arena.intrinsic(F.Number)), 0)
          : element;
      if (value < 0) throw new Error('Unsupported indexed tuple spread');
      parts.push(value);
    }
    return Number(this.arena.combine(parts, writing ? F.Intersection : F.Union));
  }
  slice(id: number, start: number, endSkip: number): number {
    const type = this.arena.types[id];
    if (type.arrayElement >= 0) return Number(this.arena.array(Number(type.arrayElement), false));
    const fixed = this.fixed(Number(id));
    if (start > fixed) {
      if (this.variable(Number(id)))
        return Number(this.arena.array(Number(this.elementSlice(Number(id), Number(fixed), 0)), false));
      return Number(this.create([], [], false));
    }
    const end = type.tupleElements.length - Math.max(endSkip, 0);
    if (start >= end) return Number(this.create([], [], false));
    return Number(this.create(type.tupleElements.slice(start, end), type.tupleFlags.slice(start, end), false));
  }
  constraint(id: number): number {
    const type = this.arena.types[id];
    const elements = type.tupleElements.slice();
    let changed = false;
    for (let i = 0; i < elements.length; i++)
      if ((type.tupleFlags[i] & E.Variadic) !== 0 && (this.arena.types[elements[i]].flags & F.TypeParameter) !== 0) {
        const bound = this.arena.indexed.baseConstraint(Number(elements[i]));
        if (bound !== elements[i] && this.bounded(Number(bound))) {
          elements[i] = bound;
          changed = true;
        }
      }
    return Number(changed ? this.shape(elements, type.tupleFlags, type.readonly) : -1);
  }
  private bounded(id: number): boolean {
    const type = this.arena.types[id];
    if ((type.flags & F.Union) !== 0) {
      for (const part of type.types) if (!this.bounded(Number(part))) return false;
      return true;
    }
    return type.arrayElement >= 0 || ((type.objectFlags & O.Tuple) !== 0 && !this.generic(Number(id)));
  }
  single(type: Type): boolean {
    return type.tupleFlags.length === 1 && (type.tupleFlags[0] & E.Variadic) !== 0;
  }
}
