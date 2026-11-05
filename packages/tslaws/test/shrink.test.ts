// Shrinking of generated arrays: a failing operation sequence always shrinks to the shortest one, whatever the seed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as fc from 'fast-check';
import { runProperty } from '../dist/property.js';
import { sequence, withoutRuns } from '../dist/sequence.js';

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

describe('withoutRuns', () => {
  it('lists every run removal, shortest runs first', () => {
    assert.deepEqual(withoutRuns(['a', 'b', 'c'], 0), [['b', 'c'], ['a', 'c'], ['a', 'b'], ['c'], ['a'], []]);
  });

  it('keeps at least minLength elements', () => {
    assert.deepEqual(withoutRuns(['a', 'b', 'c'], 2), [
      ['b', 'c'],
      ['a', 'c'],
      ['a', 'b'],
    ]);
    assert.deepEqual(withoutRuns(['a'], 1), []);
  });
});
