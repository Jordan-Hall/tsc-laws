import * as fc from 'fast-check';

/** Where a shrunk array came from, so that the next shrink continues from `fc.array`'s own state. */
interface Origin {
  inner: unknown;
}

/**
 * Every array that is `value` with one run of consecutive elements removed: runs of 1 to all of its elements, at every
 * offset, shortest runs first. `fc.array` removes a run only when its length is one that its integer shrinker proposes (it
 * halves, so it skips lengths such as 2 of 3 elements), so on its own it can stop at an array that is shrinkable only by
 * removing such a run, such as `inc, inc, dec, reset` for `inc, reset`, and whether it does depends on the seed.
 */
export function withoutRuns<T>(value: readonly T[], minLength: number): T[][] {
  const shorter: T[][] = [];
  for (let size = 1; size <= value.length - minLength; size++)
    for (let start = 0; start + size <= value.length; start++)
      shorter.push([...value.slice(0, start), ...value.slice(start + size)]);
  return shorter;
}

class SequenceArbitrary<T> extends fc.Arbitrary<T[]> {
  readonly inner: fc.Arbitrary<T[]>;
  readonly minLength: number;

  constructor(inner: fc.Arbitrary<T[]>, minLength: number) {
    super();
    this.inner = inner;
    this.minLength = minLength;
  }

  generate(mrng: fc.Random, biasFactor: number | undefined): fc.Value<T[]> {
    const made = this.inner.generate(mrng, biasFactor);
    return new fc.Value(made.value, { inner: made.context } satisfies Origin);
  }

  canShrinkWithoutContext(value: unknown): value is T[] {
    return this.inner.canShrinkWithoutContext(value);
  }

  shrink(value: T[], context: unknown): fc.Stream<fc.Value<T[]>> {
    const origin = context as Origin | undefined;
    const own = this.inner
      .shrink(value, origin?.inner)
      .map((shrunk) => new fc.Value(shrunk.value, { inner: shrunk.context } satisfies Origin));
    const runs = new fc.Stream(withoutRuns(value, this.minLength)[Symbol.iterator]()).map(
      (shorter) => new fc.Value(shorter, { inner: undefined } satisfies Origin),
    );
    return own.join(runs);
  }
}

/**
 * `fc.array(item, { minLength, maxLength })` that also shrinks by removing any run of elements. The values generated for a
 * seed are those of `fc.array`; only the search for a smaller failing array differs, and it is deterministic.
 */
export function sequence<T>(
  item: fc.Arbitrary<T>,
  options: { minLength?: number; maxLength: number },
): fc.Arbitrary<T[]> {
  const minLength = options.minLength ?? 0;
  return new SequenceArbitrary(fc.array(item, { minLength, maxLength: options.maxLength }), minLength);
}
