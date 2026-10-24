// What a laws file imports: `assume` to discard inputs a law does not cover, and `arbitrary` to register
// a generator for a named type the runner cannot derive.
import * as fc from 'fast-check';

export { fc };

/**
 * An integer the prover treats exactly (within the safe integers) instead of as an IEEE double, so laws over it can be
 * proved. At runtime it is an ordinary number.
 */
export type int = number & { readonly __tslawsInt: true };

/** Thrown by `assume`; the runner skips the input. */
export class LawDiscard extends Error {
  constructor() {
    super('law input discarded');
    this.name = 'LawDiscard';
  }
}

/** Skips the current input unless `condition` holds. */
export function assume(condition: boolean): asserts condition {
  if (!condition) throw new LawDiscard();
}

/**
 * Loop invariant: put it first in a loop body. At runtime it throws when false, so property tests check it on every
 * iteration; the prover assumes it at the top of an arbitrary iteration and proves it again at the end, which makes the
 * loop's result a proof for every number of iterations instead of a bounded one.
 */
export function invariant(condition: boolean): void {
  if (!condition) throw new Error('loop invariant violated');
}

/**
 * True when `predicate(x, i)` holds for every element of `xs`. In a law the prover lowers it over the array's slots, so
 * a claim that relies on it is `bounded` by `--bound` like any array claim. The predicate must be an arrow function
 * the prover can lower; otherwise the law stays `tested`.
 */
export function forall<T>(xs: readonly T[], predicate: (x: T, i: number) => boolean): boolean {
  for (let i = 0; i < xs.length; i += 1) if (!predicate(xs[i]!, i)) return false;
  return true;
}

/** True when `predicate(x, i)` holds for some element of `xs`; the prover lowers it as `forall` does. */
export function exists<T>(xs: readonly T[], predicate: (x: T, i: number) => boolean): boolean {
  for (let i = 0; i < xs.length; i += 1) if (predicate(xs[i]!, i)) return true;
  return false;
}

const registryKey = Symbol.for('tslaws.arbitraries');

type Registry = Map<string, fc.Arbitrary<unknown>>;

export function arbitraryRegistry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  let registry = holder[registryKey];
  if (registry === undefined) {
    registry = new Map();
    holder[registryKey] = registry;
  }
  return registry;
}

/** Registers the generator used for every parameter whose type is named `typeName`. */
export function arbitrary<T>(typeName: string, generator: fc.Arbitrary<T>): void {
  arbitraryRegistry().set(typeName, generator as fc.Arbitrary<unknown>);
}
