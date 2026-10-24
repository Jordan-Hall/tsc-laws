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

let lastModelFailure: { step: number; op: unknown } | undefined;

/** Where the latest `runModel` / `runModelAsync` call diverged (`step` is the op index, -1 before the first op), or undefined if it agreed. */
export function modelFailure(): { step: number; op: unknown } | undefined {
  return lastModelFailure;
}

/**
 * Stateful law helper: applies `ops` to `real` and to a simple reference `model` and returns false at the first step
 * after which `agree` fails (`agree` is also checked before the first op). `apply` performs the op on `real` and returns
 * the next model state. Use it in a law over `ops: Op[]` so failing sequences shrink to the shortest one. On a
 * disagreement `modelFailure()` names the step and op.
 */
export function runModel<Op, Real, Model>(spec: {
  ops: readonly Op[];
  real: Real;
  model: Model;
  apply: (real: Real, model: Model, op: Op, step: number) => Model;
  agree: (real: Real, model: Model) => boolean;
}): boolean {
  lastModelFailure = undefined;
  let model = spec.model;
  if (!spec.agree(spec.real, model)) {
    lastModelFailure = { step: -1, op: undefined };
    return false;
  }
  for (let step = 0; step < spec.ops.length; step += 1) {
    const op = spec.ops[step]!;
    model = spec.apply(spec.real, model, op, step);
    if (!spec.agree(spec.real, model)) {
      lastModelFailure = { step, op };
      return false;
    }
  }
  return true;
}

/** `runModel` for `apply` and `agree` that return promises (a browser law can click and `await settle()`). */
export async function runModelAsync<Op, Real, Model>(spec: {
  ops: readonly Op[];
  real: Real;
  model: Model;
  apply: (real: Real, model: Model, op: Op, step: number) => Model | Promise<Model>;
  agree: (real: Real, model: Model) => boolean | Promise<boolean>;
}): Promise<boolean> {
  lastModelFailure = undefined;
  let model = spec.model;
  if (!(await spec.agree(spec.real, model))) {
    lastModelFailure = { step: -1, op: undefined };
    return false;
  }
  for (let step = 0; step < spec.ops.length; step += 1) {
    const op = spec.ops[step]!;
    model = await spec.apply(spec.real, model, op, step);
    if (!(await spec.agree(spec.real, model))) {
      lastModelFailure = { step, op };
      return false;
    }
  }
  return true;
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
