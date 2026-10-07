// Port of getTemplateLiteralType, inferFromLiteralPartsToTemplateLiteral, and
// placeholder validation from tsgo's checker.go/relater.go/inference.go.
// Copyright Microsoft Corporation. Licensed under Apache-2.0.
import { TypeFlags as F, ObjectFlags as O } from './flags.js';
import { emptyType, type TypeArena, type Mapper } from './arena.js';
import { asciiBytes, decodeBytes, encodeBytes, normalizeBytes, runeSize, numericText, validNumber, validBigint, bigintValue } from './js-string.js';

export class TemplateTypes {
  private readonly instances = new Map<string, number>();
  private readonly decoded = new Map<string, string>();
  private readonly patterns = new Map<number, boolean>();
  private depth = 0;
  private related: (source: number, target: number) => boolean = () => { throw new Error('Template relation is not initialized'); };

  constructor(private readonly arena: TypeArena) {
    for (const t of arena.types) if ((t.flags & F.TemplateLiteral) !== 0) this.instances.set(this.key(t.data.templateTexts, t.types), t.id);
  }

  setRelation(related: (source: number, target: number) => boolean): void { this.related = related; }
  private key(texts: string[], types: number[]): string { return texts.join(':') + '|' + types.join(','); }
  private bytes(value: string): string {
    const previous = this.decoded.get(value);
    if (previous !== undefined) return previous;
    const result = decodeBytes(value);
    this.decoded.set(value, result);
    return result;
  }

  placeholder(id: number): boolean {
    const type = this.arena.types[id];
    if ((type.flags & F.Intersection) !== 0) {
      let seen = false;
      for (const part of type.types) {
        const flags = this.arena.types[part].flags;
        if ((flags & (F.Literal | F.Nullable)) !== 0 || this.placeholder(Number(part))) seen = true;
        else if ((flags & F.Object) === 0) return false;
      }
      return seen;
    }
    return (type.flags & (F.Any | F.String | F.Number | F.BigInt)) !== 0 || this.pattern(Number(id));
  }

  pattern(id: number): boolean {
    const type = this.arena.types[id];
    if ((type.flags & (F.TemplateLiteral | F.StringMapping)) === 0) return false;
    const previous = this.patterns.get(id);
    if (previous !== undefined) return previous;
    this.patterns.set(id, false);
    if ((type.flags & F.StringMapping) !== 0) {
      const result = this.placeholder(Number(type.data.indexObject));
      this.patterns.set(id, result);
      return result;
    }
    for (const part of type.types) if (!this.placeholder(Number(part))) return false;
    this.patterns.set(id, true);
    return true;
  }

  instantiate(id: number, mapper: Mapper): number {
    const type = this.arena.types[id];
    const parts: number[] = [];
    let changed = false;
    for (const part of type.types) {
      const value = this.arena.instantiate(Number(part), mapper);
      parts.push(value);
      if (value !== part) changed = true;
    }
    const result = changed ? this.create(type.data.templateTexts, parts) : id;
    mapper.memo.set(id, result);
    return Number(result);
  }

  create(texts: string[], types: number[]): number {
    if (++this.depth > 100) { this.depth--; throw new Error('Template instantiation complexity limit exceeded'); }
    try { return Number(this.construct(texts, types)); }
    finally { this.depth--; }
  }

  private construct(texts: string[], types: number[]): number {
    let count = 1;
    let union = -1;
    for (let i = 0; i < types.length; i++) {
      const type = this.arena.types[types[i]];
      if ((type.flags & F.Never) !== 0) return Number(this.arena.intrinsic(F.Never));
      if ((type.flags & F.Union) !== 0) { count *= type.types.length; if (union < 0) union = i; }
    }
    if (count >= 100000) throw new Error('Template union cross-product complexity limit exceeded');
    if (union >= 0) {
      const results: number[] = [];
      for (const part of this.arena.types[types[union]].types) {
        const replaced = types.slice(); replaced[union] = part;
        results.push(this.create(texts, replaced));
      }
      return Number(this.arena.combine(results, F.Union));
    }
    for (const part of types) if (this.arena.types[part].wildcard) return Number(part);
    const spans: string[] = [];
    for (const text of texts) spans.push(this.bytes(text));
    const parts = types.slice();
    for (let i = 0; i < parts.length;) {
      const type = this.arena.types[parts[i]];
      if (type.unsupported.length > 0) throw new Error('Unsupported template placeholder: ' + type.unsupported);
      if ((type.flags & (F.Literal | F.Nullable)) !== 0) {
        const value = (type.flags & F.StringLiteral) !== 0 ? this.bytes(type.value)
          : asciiBytes((type.flags & F.Null) !== 0 ? 'null' : (type.flags & F.Undefined) !== 0 ? 'undefined' : type.value);
        spans[i] += value + spans[i + 1];
        spans.splice(i + 1, 1); parts.splice(i, 1);
      } else if ((type.flags & F.TemplateLiteral) !== 0) {
        const nested: string[] = [];
        for (const text of type.data.templateTexts) nested.push(this.bytes(text));
        nested[0] = spans[i] + nested[0];
        nested[nested.length - 1] += spans[i + 1];
        spans.splice(i, 2, ...nested); parts.splice(i, 1, ...type.types);
      } else if (this.arena.indexed.isGenericIndex(Number(parts[i])) || this.placeholder(Number(parts[i]))) i++;
      else return Number(this.arena.intrinsic(F.String));
    }
    const encoded: string[] = [];
    let empty = true;
    for (const text of spans) { encoded.push(encodeBytes(normalizeBytes(text))); if (text !== '') empty = false; }
    if (parts.length === 0) return Number(this.arena.literal(F.StringLiteral, encoded[0]));
    if (empty) {
      let strings = true;
      for (const part of parts) if ((this.arena.types[part].flags & F.String) === 0) strings = false;
      if (strings) return Number(this.arena.intrinsic(F.String));
    }
    const key = this.key(encoded, parts);
    const previous = this.instances.get(key);
    if (previous !== undefined) return Number(previous);
    const data = emptyType(F.TemplateLiteral);
    data.templateTexts = encoded; data.types = parts;
    data.numericString = parts.length === 1 && empty && (this.arena.types[parts[0]].flags & F.Number) !== 0;
    data.apparentType = this.arena.types[this.arena.intrinsic(F.String)].apparentType;
    const result = this.arena.add(data);
    this.instances.set(key, result);
    return Number(result);
  }

  constraint(id: number): number {
    const type = this.arena.types[id];
    if (this.pattern(Number(id))) return Number(id);
    const bounds: number[] = [];
    for (const part of type.types) {
      const bound = this.arena.indexed.baseConstraint(Number(part));
      if (bound === part && this.arena.indexed.isGenericIndex(Number(part))) return Number(this.arena.intrinsic(F.String));
      bounds.push(bound);
    }
    return Number(this.create(type.data.templateTexts, bounds));
  }

  matches(source: number, target: number): boolean {
    const captures = this.infer(Number(source), Number(target));
    if (captures.length === 0) return false;
    const placeholders = this.arena.types[target].types;
    for (let i = 0; i < captures.length; i++) if (!this.valid(Number(captures[i]), Number(placeholders[i]))) return false;
    return true;
  }

  private valid(source: number, target: number): boolean {
    const s = this.arena.types[source];
    const t = this.arena.types[target];
    if ((t.flags & F.Intersection) !== 0) {
      for (const part of t.types) {
        const tag = this.arena.types[part];
        if ((tag.flags & F.Object) !== 0 && (tag.objectFlags & O.Anonymous) !== 0) {
          this.arena.resolve(tag);
          if (tag.properties.length === 0 && tag.calls.length === 0 && tag.constructs.length === 0 && tag.stringIndex < 0 && tag.numberIndex < 0 && tag.symbolIndex < 0 && tag.patternIndexes.length === 0) continue;
        }
        if (!this.valid(Number(source), Number(part))) return false;
      }
      return true;
    }
    if ((t.flags & F.String) !== 0 || this.related(Number(source), Number(target))) return true;
    if ((s.flags & F.StringLiteral) !== 0) {
      const value = this.bytes(s.value);
      return (t.flags & F.Number) !== 0 && validNumber(value, false)
        || (t.flags & F.BigInt) !== 0 && validBigint(value, false)
        || (t.flags & (F.BooleanLiteral | F.Nullable)) !== 0 && value === asciiBytes((t.flags & F.Null) !== 0 ? 'null' : (t.flags & F.Undefined) !== 0 ? 'undefined' : t.value)
        || (t.flags & F.StringMapping) !== 0 && this.arena.stringMappings.member(Number(source), Number(target))
        || (t.flags & F.TemplateLiteral) !== 0 && this.matches(Number(source), Number(target));
    }
    return (s.flags & F.TemplateLiteral) !== 0 && s.types.length === 1 && s.data.templateTexts[0] === '' && s.data.templateTexts[1] === '' && this.related(Number(s.types[0]), Number(target));
  }

  infer(source: number, target: number): number[] {
    const s = this.arena.types[source];
    const t = this.arena.types[target];
    if ((s.flags & (F.StringLiteral | F.TemplateLiteral)) === 0) return [];
    if ((s.flags & F.TemplateLiteral) !== 0 && s.data.templateTexts.join(':') === t.data.templateTexts.join(':')) {
      const matches: number[] = [];
      for (let i = 0; i < s.types.length; i++) {
        const part = s.types[i];
        const preserve = this.related(Number(this.arena.indexed.baseConstraint(Number(part))), Number(this.arena.indexed.baseConstraint(Number(t.types[i]))));
        matches.push(preserve || (this.arena.types[part].flags & (F.Any | F.StringLike)) !== 0 ? part : this.create(['', ''], [part]));
      }
      return matches;
    }
    const sourceTexts: string[] = [];
    if ((s.flags & F.StringLiteral) !== 0) sourceTexts.push(this.bytes(s.value));
    else for (const text of s.data.templateTexts) sourceTexts.push(this.bytes(text));
    const sourceTypes = (s.flags & F.TemplateLiteral) !== 0 ? s.types : [];
    const targetTexts: string[] = [];
    for (const text of t.data.templateTexts) targetTexts.push(this.bytes(text));
    const last = sourceTexts.length - 1;
    const start = targetTexts[0];
    const end = targetTexts[targetTexts.length - 1];
    if (last === 0 && sourceTexts[0].length < start.length + end.length || !sourceTexts[0].startsWith(start) || !sourceTexts[last].endsWith(end)) return [];
    sourceTexts[last] = sourceTexts[last].slice(0, sourceTexts[last].length - end.length);
    let seg = 0;
    let pos = start.length;
    const matches: number[] = [];
    for (let i = 1; i < targetTexts.length; i++) {
      const delim = targetTexts[i];
      let nextSeg = seg;
      let nextPos = pos;
      if (i === targetTexts.length - 1) { nextSeg = last; nextPos = sourceTexts[last].length; }
      else if (delim !== '') {
        while (nextSeg <= last) {
          let found = sourceTexts[nextSeg].indexOf(delim, nextPos);
          while (found >= 0 && found % 2 !== 0) found = sourceTexts[nextSeg].indexOf(delim, found + 1);
          if (found >= 0) { nextPos = found; break; }
          nextSeg++; nextPos = 0;
        }
        if (nextSeg > last) return [];
      } else if (pos < sourceTexts[seg].length) nextPos += runeSize(sourceTexts[seg], Number(pos));
      else if (seg < last) { nextSeg++; nextPos = 0; }
      else return [];
      if (nextSeg === seg) matches.push(this.arena.literal(F.StringLiteral, encodeBytes(normalizeBytes(sourceTexts[seg].slice(pos, nextPos)))));
      else {
        const captured = sourceTexts.slice(seg, nextSeg + 1);
        captured[0] = captured[0].slice(pos);
        captured[captured.length - 1] = captured[captured.length - 1].slice(0, nextPos);
        const encoded: string[] = [];
        for (const text of captured) encoded.push(encodeBytes(text));
        matches.push(this.create(encoded, sourceTypes.slice(seg, nextSeg)));
      }
      seg = nextSeg; pos = nextPos + (i === targetTexts.length - 1 ? 0 : delim.length);
    }
    return matches;
  }

  // Prefer captures compatible with a constrained infer parameter. Number and
  // bigint conversion requires the exact canonical spelling, as in tsgo.
  constrained(source: number, constraint: number): number {
    const s = this.arena.types[source];
    if ((s.flags & F.StringLiteral) === 0 || constraint < 0) return Number(source);
    const bound = this.arena.types[this.arena.indexed.baseConstraint(Number(constraint))];
    if ((bound.flags & F.Any) !== 0) return Number(source);
    const parts = (bound.flags & F.Union) !== 0 ? bound.types : [bound.id];
    for (const part of parts) if ((this.arena.types[part].flags & F.String) !== 0) return Number(source);
    const value = this.bytes(s.value);
    let result = -1;
    let rank = 100;
    for (const part of parts) {
      const t = this.arena.types[part];
      let candidate = -1;
      let priority = 100;
      if ((t.flags & F.TemplateLiteral) !== 0 && this.matches(Number(source), Number(part))) { candidate = source; priority = 0; }
      else if ((t.flags & F.StringMapping) !== 0 && s.value === this.arena.stringMappings.apply(t.data.stringMapping, s.value)) { candidate = source; priority = 1; }
      else if ((t.flags & F.StringLiteral) !== 0 && t.value === s.value) { candidate = part; priority = 2; }
      else if ((t.flags & F.NumberLike) !== 0 && validNumber(value, true)) {
        if ((t.flags & (F.Number | F.Enum)) !== 0) { candidate = this.arena.literal(F.NumberLiteral, String(Number(numericText(value)))); priority = (t.flags & F.Number) !== 0 ? 3 : 4; }
        else if (Number(t.value) === Number(numericText(value))) { candidate = part; priority = 5; }
      } else if ((t.flags & F.BigIntLike) !== 0 && validBigint(value, true)) {
        if ((t.flags & F.BigInt) !== 0) { candidate = this.arena.literal(F.BigIntLiteral, bigintValue(value)); priority = 6; }
        else if (asciiBytes(t.value) === value) { candidate = part; priority = 7; }
      } else if ((t.flags & F.BooleanLike) !== 0 && (value === asciiBytes('true') || value === asciiBytes('false'))) {
        if ((t.flags & F.Boolean) !== 0 || asciiBytes(t.value) === value) { candidate = this.arena.literal(F.BooleanLiteral, value === asciiBytes('true') ? 'true' : 'false'); priority = (t.flags & F.Boolean) !== 0 ? 8 : 9; }
      } else if ((t.flags & F.Undefined) !== 0 && value === asciiBytes('undefined')) { candidate = part; priority = 10; }
      else if ((t.flags & F.Null) !== 0 && value === asciiBytes('null')) { candidate = part; priority = 11; }
      if (candidate >= 0 && priority < rank) { result = candidate; rank = priority; }
    }
    return Number(result >= 0 ? result : source);
  }
}
