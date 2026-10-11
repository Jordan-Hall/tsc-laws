// Marker-based generic-reference variance adapted from relater.go getVariancesWorker.
// Copyright Microsoft Corporation. Licensed under Apache-2.0.
import { TypeFlags as F, VarianceFlags as V, Ternary as R } from './flags.js';
import { emptyType } from './arena.js';
import type { TypeArena } from './arena.js';

export class VarianceInference {
  private readonly results = new Map<number, number[]>();
  private superType = -1;
  private subType = -1;
  private otherType = -1;
  // Not private: scriptc 0.2.8 aborts with "Cannot access 'dynamicViews' before initialization"
  // when it analyzes a private array field that is read through `this` (fixed in later scriptc).
  readonly reliability: number[] = [];

  constructor(
    private readonly arena: TypeArena,
    private readonly related: (source: number, target: number) => number,
  ) {}

  report(flags: number): void {
    if (this.reliability.length > 0) this.reliability[this.reliability.length - 1] |= flags;
  }

  get(target: number): number[] {
    const previous = this.results.get(target);
    if (previous !== undefined) return previous;
    const type = this.arena.types[target];
    if (type.arrayElement >= 0) {
      const result = [V.Covariant];
      this.results.set(target, result);
      return result;
    }
    // An empty result denotes an active computation. Nested references do not
    // contribute witnesses to their own variance while that computation is open.
    this.results.set(target, []);
    if (this.superType < 0) {
      this.superType = this.arena.add(emptyType(F.TypeParameter));
      const sub = emptyType(F.TypeParameter);
      sub.constraint = this.superType;
      this.subType = this.arena.add(sub);
      this.otherType = this.arena.add(emptyType(F.TypeParameter));
    }
    const result: number[] = [];
    for (const param of type.data.typeParameters) {
      const annotation = this.arena.types[param].data.varianceAnnotation;
      if (annotation >= 0) {
        result.push(annotation);
        continue;
      }
      const superRef = this.marker(Number(target), Number(param), Number(this.superType));
      const subRef = this.marker(Number(target), Number(param), Number(this.subType));
      this.reliability.push(0);
      let variance =
        (this.related(Number(subRef), Number(superRef)) !== R.False ? V.Covariant : 0) |
        (this.related(Number(superRef), Number(subRef)) !== R.False ? V.Contravariant : 0);
      if (
        variance === V.Bivariant &&
        this.related(Number(this.marker(Number(target), Number(param), Number(this.otherType))), Number(superRef)) !==
          R.False
      )
        variance = V.Independent;
      variance |= this.reliability.pop() ?? 0;
      result.push(variance);
    }
    this.results.set(target, result);
    return result;
  }

  private marker(target: number, param: number, replacement: number): number {
    const result = this.arena.instantiate(Number(target), this.arena.mapper([param], [replacement]));
    this.arena.types[result].marker = true;
    return Number(result);
  }
}
