// Shrinking of generated arrays: a failing operation sequence always shrinks to the shortest one, whatever the seed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as fc from 'fast-check';
import { runProperty } from '../dist/property.js';
import { CANDIDATE_CAP, sequence, withoutElements } from '../dist/sequence.js';

type Op = 'inc' | 'dec' | 'reset';

// The counter of model.test.ts: `reset` fails to reset when the count is 1, so `inc, reset` is the shortest failing sequence.
function agrees(ops: Op[]): boolean {
  let real = 0;
  let model = 0;
  for (const op of ops) {
    if (op === 'inc') {
      real += 1;
      model += 1;
    } else if (op === 'dec') {
      real -= 1;
      model -= 1;
    } else {
      if (real !== 1) real = 0;
      model = 0;
    }
    if (real !== model) return false;
  }
  return true;
}

const ops = fc.oneof(fc.constant<Op>('inc'), fc.constant<Op>('dec'), fc.constant<Op>('reset'));
const counterexampleFor = async (seed: number): Promise<string | undefined> => {
  const details = await runProperty(agrees as (...args: unknown[]) => unknown, [sequence(ops, { maxLength: 8 })], {
    runs: 200,
    seed,
  } as never);
  return details.failed ? fc.stringify(details.counterexample) : undefined;
};

describe('sequence shrinking', () => {
  // `inc, inc, dec, reset` fails and is not shrunk by dropping one element, a prefix or a suffix. With fast-check's own array
  // arbitrary these seeds stop there, or at another longer sequence; they were found by sweeping seeds 1 to 2000.
  for (const seed of [15, 46, 93, 104, 145]) {
    it(`reaches inc, reset for seed ${seed}`, async () => {
      assert.equal(await counterexampleFor(seed), '[["inc","reset"]]');
    });
  }

  it('reaches inc, reset for every seed in a sweep', async () => {
    const wrong: string[] = [];
    for (let seed = 1; seed <= 400; seed++) {
      const found = await counterexampleFor(seed);
      if (found !== undefined && found !== '[["inc","reset"]]') wrong.push(`${seed}: ${found}`);
    }
    assert.deepEqual(wrong, []);
  });

  it('is deterministic for a seed', async () => {
    assert.equal(await counterexampleFor(93), await counterexampleFor(93));
  });

  it('keeps shrinking elements after removing a run', async () => {
    // Fails on any array holding a number above 9; the minimum is the one-element array [10].
    const arb = sequence(fc.integer({ min: 0, max: 1000 }), { maxLength: 8 });
    for (let seed = 1; seed <= 50; seed++) {
      const details = await runProperty(
        ((xs: number[]) => xs.every((x) => x <= 9)) as (...args: unknown[]) => unknown,
        [arb],
        {
          runs: 100,
          seed,
        } as never,
      );
      if (details.failed) assert.deepEqual(details.counterexample, [[10]]);
    }
  });

  it('never shrinks below minLength', async () => {
    const arb = sequence(fc.constant(0), { minLength: 2, maxLength: 6 });
    const details = await runProperty((() => false) as (...args: unknown[]) => unknown, [arb], {
      runs: 20,
      seed: 1,
    } as never);
    assert.deepEqual(details.counterexample, [[0, 0]]);
  });
});

/** What fast-check ends at: the first failing candidate, again and again, until none fails. */
function minimise<T>(arb: fc.Arbitrary<T[]>, start: T[], fails: (value: T[]) => boolean): T[] {
  let current = new fc.Value(start, undefined);
  for (;;) {
    const next = arb
      .shrink(current.value, current.context)
      .filter((candidate) => fails(candidate.value))
      .getNthOrLast(0);
    if (next === null) return current.value;
    current = next;
  }
}

const exactly = (...arrays: string[][]) => {
  const bad = new Set(arrays.map((a) => a.join('')));
  return (value: string[]) => bad.has(value.join(''));
};

describe('shrinking by removing separate spans', () => {
  const letters = sequence(fc.constantFrom('a', 'b', 'c', 'x', 'y', 'p', 'q', 'r', 's'), { maxLength: 40 });

  it('removes two separate spans when no one span helps', () => {
    // Fails on a,b,c and on a,x,b,y,c, but passes on every one-span deletion of a,x,b,y,c: x and y are apart.
    const fails = exactly(['a', 'b', 'c'], ['a', 'x', 'b', 'y', 'c']);
    assert.deepEqual(minimise(letters, ['a', 'x', 'b', 'y', 'c'], fails), ['a', 'b', 'c']);
  });

  it('shortens an array of 12 whose shortest failing subsequence needs five spans removed', () => {
    const shortest = ['p', 'q', 'r', 's'];
    const long = ['x', 'p', 'x', 'q', 'x', 'r', 'x', 's', 'x', 'x', 'x', 'x'];
    assert.deepEqual(minimise(letters, long, exactly(shortest, long)), shortest);
  });

  it('shortens an array of 13 that needs two spans removed', () => {
    const shortest = ['p', 'q', 'r', 's'];
    const long = ['p', 'q', 'x', 'x', 'x', 'r', 's', 'x', 'x', 'x', 'x', 'x', 'x'];
    assert.deepEqual(minimise(letters, long, exactly(shortest, long)), shortest);
  });

  it('shortens an array of 33, the longest whose pairs of spans all fit in the cap', () => {
    const shortest = ['p', 'q', 'r', 's'];
    const long = ['p', 'q', ...Array<string>(20).fill('y'), 'r', 's', ...Array<string>(9).fill('x')];
    assert.equal(long.length, 33);
    assert.deepEqual(minimise(letters, long, exactly(shortest, long)), shortest);
  });

  it('reaches the shortest subsequence for every seed', async () => {
    // Fails on any array holding 2, 0, 1 in that order, so the shortest failing array is [2, 0, 1].
    const holds = (xs: number[]) => {
      const want = [2, 0, 1];
      let at = 0;
      for (const x of xs) if (x === want[at]) at++;
      return at < want.length;
    };
    const arb = sequence(fc.integer({ min: 0, max: 2 }), { maxLength: 12 });
    const wrong: string[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const details = await runProperty(holds as (...args: unknown[]) => unknown, [arb], { runs: 100, seed } as never);
      if (details.failed && fc.stringify(details.counterexample) !== '[[2,0,1]]')
        wrong.push(`${seed}: ${fc.stringify(details.counterexample)}`);
    }
    assert.deepEqual(wrong, []);
  });
});

describe('withoutElements', () => {
  const unique = (n: number) => Array.from({ length: n }, (_, i) => i);

  it('lists every subset up to 12 elements, fewest remaining first', () => {
    assert.deepEqual(
      [...withoutElements(['a', 'b', 'c'], 0)],
      [[], ['a'], ['b'], ['c'], ['a', 'b'], ['a', 'c'], ['b', 'c']],
    );
    const all = [...withoutElements(unique(12), 0)];
    assert.equal(all.length, 2 ** 12 - 1);
    assert.deepEqual(
      all.map((a) => a.length),
      all.map((a) => a.length).sort((x, y) => x - y),
    );
  });

  it('keeps at least minLength elements and skips repeats', () => {
    assert.deepEqual(
      [...withoutElements(['a', 'b', 'c'], 2)],
      [
        ['a', 'b'],
        ['a', 'c'],
        ['b', 'c'],
      ],
    );
    assert.deepEqual([...withoutElements(['a'], 1)], []);
    assert.deepEqual([...withoutElements([], 0)], []);
    assert.deepEqual([...withoutElements(['a', 'a'], 0)], [[], ['a']]);
    assert.deepEqual([...withoutElements([0, -0], 0)], [[], [0], [-0]]);
  });

  it('is complete up to 33 elements: every run and every pair of runs, once', () => {
    const n = 33;
    const runs = (n * (n + 1)) / 2;
    const pairs = ((n + 1) * n * (n - 1) * (n - 2)) / 24;
    const all = [...withoutElements(unique(n), 0)];
    assert.equal(all.length, runs + pairs);
    assert.equal(new Set(all.map((a) => a.join(','))).size, all.length);
    assert.ok(all.length <= CANDIDATE_CAP);
  });

  it('stops at the cap for longer arrays, and builds candidates only when asked', () => {
    const started = performance.now();
    const huge = withoutElements(unique(100_000), 0);
    const first = [huge.next().value, huge.next().value, huge.next().value];
    assert.equal(first[0]!.length, 99_999);
    assert.ok(performance.now() - started < 1000);

    let count = 0;
    for (const candidate of withoutElements(unique(200), 0)) {
      count++;
      assert.ok(candidate.length < 200);
    }
    assert.equal(count, CANDIDATE_CAP);
  });
});
