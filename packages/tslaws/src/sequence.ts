import * as fc from 'fast-check';

/** Where a shrunk array came from, so that the next shrink continues from `fc.array`'s own state. */
interface Origin {
  inner: unknown;
}

/** Arrays of up to this many elements are shrunk by trying every subset of them: 2^12 - 1 = 4095 candidates at most. */
export const EXHAUSTIVE_LENGTH = 12;

/** The most candidates enumerated for one longer array, whatever its length. */
export const CANDIDATE_CAP = 50_000;

/** The longest array whose one- and two-span removals all fit in `CANDIDATE_CAP`: C(34, 4) + 33 * 34 / 2 = 46937. */
export const TWO_SPAN_LENGTH = 33;

/** Combinations of `size` of the indexes `0..length - 1`, in lexicographic order, one at a time. */
function* combinations(length: number, size: number): Generator<number[]> {
  const at: number[] = Array.from({ length: size }, (_, i) => i);
  for (;;) {
    yield at.slice();
    let i = size - 1;
    while (i >= 0 && at[i] === length - size + i) i--;
    if (i < 0) return;
    at[i]!++;
    for (let j = i + 1; j < size; j++) at[j] = at[j - 1]! + 1;
  }
}

/** A key that is equal for two arrays exactly when they hold the same elements (`Object.is`, objects by identity). */
function keyOf(elements: readonly unknown[], ids: Map<unknown, number>): string {
  return elements
    .map((element) => {
      if (Object.is(element, -0)) return 'z';
      let id = ids.get(element);
      if (id === undefined) {
        id = ids.size;
        ids.set(element, id);
      }
      return id;
    })
    .join(',');
}

function* spans<T>(value: readonly T[], minLength: number): Generator<T[]> {
  const n = value.length;
  let enumerated = 0;
  // Every run of consecutive elements, shortest runs first.
  for (let size = 1; size <= n - minLength; size++)
    for (let start = 0; start + size <= n; start++) {
      if (enumerated++ >= CANDIDATE_CAP) return;
      yield [...value.slice(0, start), ...value.slice(start + size)];
    }
  // Every two runs that are apart from each other: [a, b) and [c, d) with b < c.
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d <= n; d++) {
          if (n - (b - a) - (d - c) < minLength) continue;
          if (enumerated++ >= CANDIDATE_CAP) return;
          yield [...value.slice(0, a), ...value.slice(b, c), ...value.slice(d)];
        }
}

/**
 * The smaller arrays to try in place of `value`, one at a time (nothing is built before it is asked for), without
 * repeating one and never shorter than `minLength`. `fc.array` removes a run only when its length is one its integer
 * shrinker proposes (it halves, so it skips lengths such as 2 of 3 elements), and never two separate runs, so on its own it
 * can stop at a failing array that is longer than the shortest, such as `inc, inc, dec, reset` for `inc, reset`, and
 * whether it does depends on the seed.
 *
 * - Up to `EXHAUSTIVE_LENGTH` elements: every subset of them, fewest remaining first. fast-check shrinks to a fixpoint, so
 *   the result is a shortest failing subsequence of the array it started from.
 * - Longer: every run removed, then every pair of runs that are apart, at most `CANDIDATE_CAP` candidates. The result is
 *   locally minimal under removing up to two runs when all of them fit, which is the case up to `TWO_SPAN_LENGTH` elements.
 *   Beyond that the cap cuts the search short, and repeats are no longer filtered (a repeat costs one more property run).
 */
export function* withoutElements<T>(value: readonly T[], minLength: number): Generator<T[]> {
  const n = value.length;
  const ids = new Map<unknown, number>();
  const seen = new Set<string>();
  const fresh = (candidate: T[]): boolean => {
    if (n > TWO_SPAN_LENGTH) return true;
    const key = keyOf(candidate, ids);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  if (n <= EXHAUSTIVE_LENGTH) {
    for (let size = minLength; size < n; size++)
      for (const kept of combinations(n, size)) {
        const candidate = kept.map((i) => value[i]!);
        if (fresh(candidate)) yield candidate;
      }
    return;
  }
  for (const candidate of spans(value, minLength)) if (fresh(candidate)) yield candidate;
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
    const fewer = new fc.Stream(withoutElements(value, this.minLength)).map(
      (shorter) => new fc.Value(shorter, { inner: undefined } satisfies Origin),
    );
    return own.join(fewer);
  }
}

/**
 * `fc.array(item, { minLength, maxLength })` that also shrinks by removing elements (see `withoutElements` for what that
 * guarantees). The values generated for a seed are those of `fc.array`; only the search for a smaller failing array differs,
 * and it is deterministic.
 */
export function sequence<T>(
  item: fc.Arbitrary<T>,
  options: { minLength?: number; maxLength: number },
): fc.Arbitrary<T[]> {
  const minLength = options.minLength ?? 0;
  return new SequenceArbitrary(fc.array(item, { minLength, maxLength: options.maxLength }), minLength);
}
