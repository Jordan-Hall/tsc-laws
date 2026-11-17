// The shape every builder of the pack returns: a generator of adversarial inputs plus a check, tagged with its CWE.
import * as fc from 'fast-check';
import { CweViolation, cweLabel, show } from './cwe.ts';
import type { CweId } from './cwe.ts';

/** The result of `SecurityLaw.run`, for a plain test or a script outside `tslaws check`. */
export interface SecurityOutcome {
  ok: boolean;
  id: string;
  cwe: readonly CweId[];
  runs: number;
  seed: number;
  /** The first failing input, shown as JSON. */
  counterexample?: string;
  /** `[CWE-22] ...`: the CWE tag and why the input breaks the property. */
  message?: string;
}

export interface SecurityLaw<I> {
  /** Stable name of the builder, as in `path-traversal`. */
  readonly id: string;
  readonly cwe: readonly CweId[];
  readonly title: string;
  /** Adversarial inputs for the law's parameter. */
  readonly input: fc.Arbitrary<I>;
  /** Why `input` breaks the property, or undefined when it holds. Does not throw for a violation. */
  verdict(input: I): string | undefined;
  /**
   * Use it as the body of a law: `law x(p: PathPayload) => traversal.holds(p)`. Checks the builder's fixed corpus of
   * attacks and then `input`; returns true, or throws a CweViolation so the report carries the CWE and the reason.
   */
  holds(input: I): true;
  /** Runs the property on its own with fast-check (corpus first), without the `tslaws check` runner. */
  run(options?: { runs?: number; seed?: number }): SecurityOutcome;
  /** `run`, then throws a CweViolation if it failed. */
  assert(options?: { runs?: number; seed?: number }): void;
}

export interface SecurityLawSpec<I> {
  id: string;
  cwe: readonly CweId[];
  title: string;
  input: fc.Arbitrary<I>;
  /** Fixed attacks checked on every call before the generated input. */
  corpus?: readonly I[];
  /** Returns the reason an input breaks the property, or undefined. The reason already carries its CWE tag choice. */
  verdict(input: I): { cwe?: readonly CweId[]; detail: string } | undefined;
}

/** Builds a SecurityLaw from a verdict. */
export function securityLaw<I>(spec: SecurityLawSpec<I>): SecurityLaw<I> {
  const failure = (input: I): CweViolation | undefined => {
    const found = spec.verdict(input);
    return found === undefined ? undefined : new CweViolation(found.cwe ?? spec.cwe, found.detail);
  };
  const holds = (input: I): true => {
    for (const attack of spec.corpus ?? []) {
      const bad = failure(attack);
      if (bad !== undefined) throw bad;
    }
    const bad = failure(input);
    if (bad !== undefined) throw bad;
    return true;
  };
  const runDetailed = (options: { runs?: number; seed?: number } = {}): [SecurityOutcome, CweViolation | undefined] => {
    const runs = options.runs ?? 200;
    const seed = options.seed ?? Date.now() % 2 ** 31;
    const base = { id: spec.id, cwe: spec.cwe, runs, seed };
    for (const attack of spec.corpus ?? []) {
      const bad = failure(attack);
      if (bad !== undefined) return [{ ok: false, ...base, counterexample: show(attack), message: bad.message }, bad];
    }
    const details = fc.check(
      fc.property(spec.input, (input) => failure(input) === undefined),
      { numRuns: runs, seed },
    );
    if (!details.failed) return [{ ok: true, ...base }, undefined];
    const counter = details.counterexample?.[0] as I;
    const bad = failure(counter);
    return [{ ok: false, ...base, counterexample: show(counter), message: bad?.message }, bad];
  };
  return {
    id: spec.id,
    cwe: spec.cwe,
    title: spec.title,
    input: spec.input,
    verdict: (input) => {
      const found = spec.verdict(input);
      return found === undefined ? undefined : `[${cweLabel(found.cwe ?? spec.cwe)}] ${found.detail}`;
    },
    holds,
    run: (options) => runDetailed(options)[0],
    assert: (options) => {
      const [outcome, bad] = runDetailed(options);
      if (!outcome.ok)
        throw new CweViolation(
          bad?.cwe ?? spec.cwe,
          `${bad?.detail ?? 'failed'} (input ${outcome.counterexample ?? '?'})`,
        );
    },
  };
}
