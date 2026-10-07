// Index signature selection and merging from checker.go:
// findApplicableIndexInfo, isApplicableIndexType, and appendIndexInfo.
// Copyright Microsoft Corporation. Licensed under Apache-2.0.
import { TypeFlags as F } from './flags.js';
import type { TypeArena } from './arena.js';
import type { Type, IndexInfo } from './types.js';

export class IndexSignatures {
  private readonly lists = new Map<number, IndexInfo[]>();
  private readonly versions = new Map<number, number>();
  private related: (source: number, target: number) => boolean = () => { throw new Error('Index relation is not initialized'); };
  constructor(private readonly arena: TypeArena) {}
  setRelation(related: (source: number, target: number) => boolean): void { this.related = related; }

  all(type: Type): IndexInfo[] {
    this.arena.resolve(type);
    const previous = this.lists.get(type.id);
    if (previous !== undefined && this.versions.get(type.id) === type.membersVersion) return previous;
    const list: IndexInfo[] = [];
    if (type.stringIndex >= 0) list.push({ keyType: this.arena.intrinsic(F.String), type: type.stringIndex, readonly: (type.indexReadonly & 1) !== 0 });
    if (type.numberIndex >= 0) list.push({ keyType: this.arena.intrinsic(F.Number), type: type.numberIndex, readonly: (type.indexReadonly & 2) !== 0 });
    if (type.symbolIndex >= 0) list.push({ keyType: this.arena.intrinsic(F.ESSymbol), type: type.symbolIndex, readonly: (type.indexReadonly & 4) !== 0 });
    for (const info of type.patternIndexes) list.push(info);
    this.lists.set(type.id, list);
    this.versions.set(type.id, type.membersVersion);
    return list;
  }

  applicable(source: number, target: number): boolean {
    if (source === target || this.related(Number(source), Number(target))) return true;
    const s = this.arena.types[source];
    const t = this.arena.types[target];
    return (t.flags & F.String) !== 0 && this.related(Number(source), Number(this.arena.intrinsic(F.Number)))
      || (t.flags & F.Number) !== 0 && ((s.flags & F.StringLiteral) !== 0 && s.data.numericKey || (s.flags & F.TemplateLiteral) !== 0 && s.data.numericString);
  }

  find(type: Type, key: number): IndexInfo | undefined {
    let stringInfo: IndexInfo | undefined;
    let single: IndexInfo | undefined;
    const values: number[] = [];
    let readonly = true;
    for (const info of this.all(type)) {
      if ((this.arena.types[info.keyType].flags & F.String) !== 0) { stringInfo = info; continue; }
      if (this.applicable(Number(key), Number(info.keyType))) {
        single = info; values.push(info.type);
        if (!info.readonly) readonly = false;
      }
    }
    if (values.length > 1) return { keyType: this.arena.intrinsic(F.Unknown), type: this.arena.combine(values, F.Intersection), readonly };
    if (single !== undefined) return single;
    return stringInfo !== undefined && this.applicable(Number(key), Number(stringInfo.keyType)) ? stringInfo : undefined;
  }

  append(list: IndexInfo[], info: IndexInfo, union: boolean): void {
    for (let i = 0; i < list.length; i++) if (list[i].keyType === info.keyType) {
      const previous = list[i];
      list[i] = { keyType: info.keyType, type: this.arena.combine([previous.type, info.type], union ? F.Union : F.Intersection),
        readonly: union ? previous.readonly || info.readonly : previous.readonly && info.readonly };
      return;
    }
    list.push(info);
  }

  inferable(type: Type): boolean {
    if ((type.flags & F.Intersection) !== 0) {
      for (const part of type.types) if (!this.inferable(this.arena.types[part])) return false;
      return true;
    }
    return type.inferableIndex;
  }
}
