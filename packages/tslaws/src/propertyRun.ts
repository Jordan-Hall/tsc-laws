// Running a property test, without the TypeScript compiler: this is all a property worker loads.
import { join } from 'node:path';
import * as fc from 'fast-check';
import { decodeExample, encodeExample } from './regressions.ts';
import type { CheckOptions } from './types.ts';

export function jsPath(outDir: string, file: string): string {
  return join(outDir, file.replace(/\.(ts|tsx|mts|cts)$/, '.js'));
}

export function isDiscard(error: unknown): boolean {
  return error instanceof Error && error.name === 'LawDiscard';
}

/** Runs `call` on generated inputs. `call` may be async (a law that waits, or one that runs in a browser). */
export async function runProperty(
  call: (...args: unknown[]) => unknown,
  generators: fc.Arbitrary<unknown>[],
  options: CheckOptions,
): Promise<fc.RunDetails<unknown[]>> {
  // fast-check needs at least one arbitrary: a law without parameters gets a stand-in and runs once.
  const none = generators.length === 0;
  const property = fc.asyncProperty(
    ...((none ? [fc.constant(undefined)] : generators) as [fc.Arbitrary<unknown>]),
    async (...args: unknown[]) => {
      try {
        return (await call(...(none ? [] : args))) !== false;
      } catch (error) {
        if (isDiscard(error)) {
          fc.pre(false);
          return true;
        }
        throw error;
      }
    },
  );
  return (await fc.check(property as unknown as fc.IAsyncProperty<unknown[]>, {
    numRuns: none ? 1 : options.runs,
    seed: options.seed,
    maxSkipsPerRun: 100,
    ...(!none && options.regressionExamples?.length ? { examples: options.regressionExamples.map(decodeExample) } : {}),
  })) as fc.RunDetails<unknown[]>;
}

export const runLaw = runProperty;

/** The outcome of a law's property test, without the generated values' prototypes so it can cross a thread. */
export interface PropertyOutcome {
  failed: boolean;
  numRuns: number;
  seed: number;
  /** Absent when the law failed because `assume` discarded nearly every input. */
  counterexample?: string;
  message?: string;
  /** The stack of the error the law threw, to say which function threw. */
  stack?: string;
  screenshot?: string;
  /** The counterexample in the regression corpus's encoding; absent when it cannot be stored. */
  encoded?: string;
  /** Whether the counterexample is one that was replayed from the corpus. */
  regression?: boolean;
}

export function summarise(details: fc.RunDetails<unknown[]>, options?: CheckOptions): PropertyOutcome {
  const message = details.errorInstance instanceof Error ? details.errorInstance.message : undefined;
  let encoded: string | undefined;
  if (details.failed && details.counterexample !== null) {
    try {
      encoded = encodeExample(details.counterexample);
    } catch {
      // Not storable (a class instance, a function): it is reported but not kept.
    }
  }
  return {
    encoded,
    regression: encoded !== undefined && options?.regressionExamples?.includes(encoded) === true,
    failed: details.failed,
    numRuns: details.numRuns,
    seed: details.seed,
    counterexample: details.counterexample === null ? undefined : fc.stringify(details.counterexample),
    message,
    stack: details.errorInstance instanceof Error ? details.errorInstance.stack : undefined,
  };
}

/** Inputs a law has run on, at least, before a proof of it stands. */
export const crossCheckRuns = 50;

/**
 * A `proved` verdict is checked against plain JavaScript: the law's property run (generators that stay inside what the
 * proof assumes) already passed in this check, and counts when it ran `crossCheckRuns` inputs. A shorter one (a low
 * `--runs`) is topped up with a run of `crossCheckRuns` from the same seed. Returns the outcome of the top-up when the
 * law fails on it, `'timeout'` when it does not finish, and `undefined` when nothing disagrees with the proof.
 */
export async function crossCheck(
  passed: Pick<PropertyOutcome, 'numRuns'>,
  parameters: number,
  rerun: (runs: number) => Promise<PropertyOutcome | 'timeout'>,
): Promise<PropertyOutcome | 'timeout' | undefined> {
  if (parameters === 0 || passed.numRuns >= crossCheckRuns) return undefined;
  const again = await rerun(crossCheckRuns);
  if (again === 'timeout') return again;
  return again.failed && again.counterexample !== undefined ? again : undefined;
}

/** Why a law counts as failed when the prover said `proved` and a JavaScript run disagrees. */
export function disagreement(outcome: Pick<PropertyOutcome, 'message'>): string {
  const reason =
    outcome.message === undefined || outcome.message.startsWith('Property failed by returning false')
      ? 'returned false'
      : `threw: ${outcome.message}`;
  return `the prover said proved but a JavaScript run disagrees (${reason}); this is likely a translation bug in the prover, please report it`;
}
