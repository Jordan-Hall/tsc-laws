// CWE-400 / CWE-1333: a function finishes under a time budget on adversarial long inputs.
import * as fc from 'fast-check';
import { performance } from 'node:perf_hooks';
import { show } from './cwe.ts';
import { securityLaw } from './law.ts';
import type { SecurityLaw } from './law.ts';

/** An attack: `pump` repeated to a length, then `suffix`. For a law parameter: `law fast(a: RedosAttack) => redos.holds(a)`. */
export interface RedosAttack {
  pump: string;
  suffix: string;
}

const pumps = [
  'a',
  'aa',
  'ab',
  'a ',
  ' ',
  '0',
  '1',
  '-',
  '.',
  'a.',
  'a@',
  '<',
  '>',
  '"',
  "'",
  '\\',
  '(',
  'a,',
  'a=',
  '\t',
  '\n',
  'x-',
  '_',
  '1.',
  'é',
];
const suffixes = ['!', '', '\0', 'x', '@', '/', '\n', '#', '?', '$', ' ', '1', '"'];

/** Character counts tried in turn: small steps first, where an exponential pattern shows itself before it hangs, then large. */
const ladder = [8, 12, 16, 20, 24, 28, 32, 48, 64, 128, 512, 2048, 8192, 32768, 131072];

export function redosAttacks(): fc.Arbitrary<RedosAttack> {
  return fc.record({ pump: fc.constantFrom(...pumps), suffix: fc.constantFrom(...suffixes) });
}

export interface RedosOptions {
  /** The most one call may take, in milliseconds. Default 100. */
  budgetMs?: number;
  /** The longest input to try, in characters. Default 20000. */
  maxLength?: number;
}

function build(attack: RedosAttack, length: number): string {
  if (attack.pump === '') return attack.suffix;
  return attack.pump.repeat(Math.ceil(length / attack.pump.length)).slice(0, length) + attack.suffix;
}

/**
 * CWE-400 and CWE-1333. `fn(text)` must return within `budgetMs` for every attack at every length up to `maxLength`.
 * The attack grows in steps and stops at the first one over budget, so a pattern that backtracks exponentially is
 * caught at a length of a few dozen characters. The function must be synchronous: the check times it, and cannot
 * interrupt a call that never returns. An exception does not fail the law.
 */
export function redos(fn: (text: string) => unknown, options: RedosOptions = {}): SecurityLaw<RedosAttack> {
  const budget = options.budgetMs ?? 100;
  const maxLength = options.maxLength ?? 20000;
  const lengths = [...ladder.filter((n) => n < maxLength), maxLength];
  const slow = (attack: RedosAttack): { detail: string } | undefined => {
    for (const length of lengths) {
      const text = build(attack, length);
      const start = performance.now();
      try {
        fn(text);
      } catch {
        // A refusal is fast enough.
      }
      const took = performance.now() - start;
      if (took > budget)
        return {
          detail: `fn took ${took.toFixed(0)} ms (budget ${budget} ms) on ${text.length} characters: ${show(attack.pump)} repeated, then ${show(attack.suffix)}`,
        };
    }
    return undefined;
  };
  // The fixed attacks are checked once per law, not on every generated input.
  let corpusVerdict: { detail: string } | undefined | 'unchecked' = 'unchecked';
  const corpus = (): { detail: string } | undefined => {
    if (corpusVerdict === 'unchecked') {
      corpusVerdict = undefined;
      for (const pump of pumps)
        for (const suffix of ['!', '', 'x']) {
          corpusVerdict = slow({ pump, suffix });
          if (corpusVerdict !== undefined) return corpusVerdict;
        }
    }
    return corpusVerdict;
  };
  return securityLaw<RedosAttack>({
    id: 'redos',
    cwe: ['CWE-400', 'CWE-1333'],
    title: `a function finishes within ${budget} ms on adversarial long inputs`,
    input: redosAttacks(),
    verdict: (attack) => corpus() ?? slow(attack),
  });
}
