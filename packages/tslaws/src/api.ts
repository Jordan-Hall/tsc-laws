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
