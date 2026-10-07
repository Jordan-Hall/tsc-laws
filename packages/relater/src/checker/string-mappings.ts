// Port of getStringMappingType, applyTemplateStringMapping, and string mapping
// membership from checker.go/relater.go; JS casing from internal/stringutil.
// Copyright Microsoft Corporation. Licensed under Apache-2.0.
import { TypeFlags as F } from './flags.js';
import { emptyType, TYPE_ID_STRIDE, type TypeArena, type Mapper } from './arena.js';
import { decodeBytes, encodeBytes, runeAt, runeSize } from './js-string.js';
import { caseCodePoints, caseLower, caseUpper, caseCasedRanges, caseIgnorableRanges } from './case-mappings.js';

function inRanges(cp: number, ranges: number[]): boolean {
  let lo = 0;
  let hi = ranges.length / 3 - 1;
  while (lo <= hi) {
    const middle = Math.floor((lo + hi) / 2);
    const start = Number(ranges[middle * 3]);
    const end = Number(ranges[middle * 3 + 1]);
    if (cp < start) hi = middle - 1;
    else if (cp > end) lo = middle + 1;
    else return (cp - start) % Number(ranges[middle * 3 + 2]) === 0;
  }
  return false;
}

function caseIndex(cp: number): number {
  let lo = 0;
  let hi = caseCodePoints.length - 1;
  while (lo <= hi) {
    const middle = Math.floor((lo + hi) / 2);
    const value = Number(caseCodePoints[middle]);
    if (cp === value) return Number(middle);
    if (cp < value) hi = middle - 1;
    else lo = middle + 1;
  }
  return -1;
}

function casedAfter(value: string, start: number): boolean {
  for (let i = start; i < value.length; i += runeSize(value, Number(i))) {
    const cp = runeAt(value, Number(i));
    if (!inRanges(Number(cp), caseIgnorableRanges)) return inRanges(Number(cp), caseCasedRanges);
  }
  return false;
}

// Input/output is the ASCII hex representation of the original WTF-8 bytes.
// Never delegate to host Unicode casing, which can use a different version.
export function caseBytes(value: string, kind: number): string {
  if (value === '') return value;
  const upper = kind === 1 || kind === 3;
  const firstOnly = kind === 3 || kind === 4;
  let result = '';
  let casedBefore = false;
  for (let i = 0; i < value.length;) {
    const cp = runeAt(value, Number(i));
    const end = i + runeSize(value, Number(i));
    const index = caseIndex(Number(cp));
    if (!upper && cp === 0x3a3 && casedBefore && !casedAfter(value, Number(end))) result += 'cf82';
    else result += index >= 0 ? String(upper ? caseUpper[index] : caseLower[index]) : value.slice(i, end);
    if (firstOnly) return result + value.slice(end);
    if (!upper && !inRanges(Number(cp), caseIgnorableRanges)) casedBefore = inRanges(Number(cp), caseCasedRanges);
    i = end;
  }
  return result;
}

export class StringMappings {
  private readonly instances = new Map<number, number>();
  private readonly texts = new Map<string, string>();
  private depth = 0;
  private related: (source: number, target: number) => boolean = () => {
    throw new Error('String mapping relation is not initialized');
  };

  constructor(private readonly arena: TypeArena) {
    for (const type of arena.types)
      if ((type.flags & F.StringMapping) !== 0)
        this.instances.set(type.data.stringMapping * TYPE_ID_STRIDE + type.data.indexObject, type.id);
  }
  setRelation(related: (source: number, target: number) => boolean): void {
    this.related = related;
  }

  apply(kind: number, value: string): string {
    const key = kind + ':' + value;
    const previous = this.texts.get(key);
    if (previous !== undefined) return previous;
    const result = encodeBytes(caseBytes(decodeBytes(value), Number(kind)));
    this.texts.set(key, result);
    return result;
  }

  instantiate(id: number, mapper: Mapper): number {
    const type = this.arena.types[id];
    const result = this.create(
      type.data.stringMapping,
      Number(this.arena.instantiate(Number(type.data.indexObject), mapper)),
    );
    mapper.memo.set(id, result);
    return Number(result);
  }

  create(kind: number, id: number): number {
    if (++this.depth > 100) {
      this.depth--;
      throw new Error('String mapping instantiation complexity limit exceeded');
    }
    try {
      return Number(this.construct(kind, id));
    } finally {
      this.depth--;
    }
  }

  private construct(kind: number, id: number): number {
    const type = this.arena.types[id];
    if ((type.flags & F.Union) !== 0) {
      const parts: number[] = [];
      for (const part of type.types) parts.push(this.create(kind, Number(part)));
      return Number(this.arena.combine(parts, F.Union));
    }
    if ((type.flags & F.Never) !== 0) return Number(id);
    if ((type.flags & F.StringLiteral) !== 0)
      return Number(this.arena.literal(F.StringLiteral, this.apply(kind, type.value)));
    if ((type.flags & F.TemplateLiteral) !== 0) {
      const texts = type.data.templateTexts.slice();
      const parts = type.types.slice();
      if (kind === 1 || kind === 2) {
        for (let i = 0; i < texts.length; i++) texts[i] = this.apply(kind, String(texts[i]));
        for (let i = 0; i < parts.length; i++) parts[i] = this.create(kind, Number(parts[i]));
      } else if (texts[0] !== '') texts[0] = this.apply(kind, String(texts[0]));
      else parts[0] = this.create(kind, Number(parts[0]));
      return Number(this.arena.strings.create(texts, parts));
    }
    if ((type.flags & F.StringMapping) !== 0 && type.data.stringMapping === kind) return Number(id);
    if ((type.flags & (F.Any | F.String | F.StringMapping)) === 0 && !this.arena.indexed.isGenericIndex(Number(id))) {
      if (this.arena.strings.placeholder(Number(id)))
        return Number(this.generic(kind, Number(this.arena.strings.create(['', ''], [id]))));
      return Number(id);
    }
    return Number(this.generic(kind, id));
  }

  private generic(kind: number, id: number): number {
    const key = kind * TYPE_ID_STRIDE + id;
    const previous = this.instances.get(key);
    if (previous !== undefined) return Number(previous);
    const data = emptyType(F.StringMapping);
    data.stringMapping = kind;
    data.indexObject = id;
    data.apparentType = this.arena.types[this.arena.intrinsic(F.String)].apparentType;
    const result = this.arena.add(data);
    this.instances.set(key, result);
    return Number(result);
  }

  constraint(id: number): number {
    const type = this.arena.types[id];
    const inner = type.data.indexObject;
    const bound = this.arena.indexed.baseConstraint(Number(inner));
    return Number(
      bound !== inner ? this.create(type.data.stringMapping, Number(bound)) : this.arena.intrinsic(F.String),
    );
  }

  member(source: number, target: number): boolean {
    const type = this.arena.types[target];
    if ((type.flags & F.Any) !== 0) return true;
    if ((type.flags & (F.String | F.TemplateLiteral)) !== 0) return this.related(Number(source), Number(target));
    if ((type.flags & F.StringMapping) === 0) return false;
    const chain: number[] = [];
    let inner = target;
    while ((this.arena.types[inner].flags & F.StringMapping) !== 0) {
      if (chain.length >= 100) throw new Error('String mapping membership complexity limit exceeded');
      chain.push(this.arena.types[inner].data.stringMapping);
      inner = this.arena.types[inner].data.indexObject;
    }
    let mapped = source;
    for (let i = chain.length - 1; i >= 0; i--) mapped = this.create(Number(chain[i]), Number(mapped));
    return mapped === source && this.member(Number(source), Number(inner));
  }
}
