// What a laws file imports: `assume` to discard inputs a law does not cover, and `arbitrary` to register
// a generator for a named type the runner cannot derive.
import * as fc from 'fast-check';

export { fc };

/**
 * An integer the prover treats exactly (within the safe integers) instead of as an IEEE double, so laws over it can be
 * proved. At runtime it is an ordinary number.
 */
export type int = number & { readonly __tslawsInt: true };

/** A non-negative exact integer (`n >= 0`). Generated and proved in `[0, MAX_SAFE_INTEGER]`. */
export type nat = int & { readonly __tslawsNat: true };

/** A strictly positive exact integer (`n >= 1`). Generated and proved in `[1, MAX_SAFE_INTEGER]`. */
export type posInt = int & { readonly __tslawsPosInt: true };

/** A non-zero exact integer (`n !== 0`). Generated and proved with `n !== 0`. */
export type nonZeroInt = int & { readonly __tslawsNonZeroInt: true };

/**
 * An exact integer bounded between `Lo` and `Hi` inclusive (like a LiquidHaskell refinement type): fast-check generates
 * directly inside `[Lo, Hi]` without wasted `assume()` skips, and Z3 assumes `Lo <= x <= Hi` automatically.
 */
export type intRange<Lo extends number, Hi extends number> = int & {
  readonly __tslawsMin: Lo;
  readonly __tslawsMax: Hi;
};

/** A non-empty array (`xs.length >= 1`). Generated non-empty and proved with `xs.length >= 1`. */
export type nonEmpty<T> = T[] & { readonly __tslawsNonEmpty: true };

/** An ASCII string (characters U+0000..U+007F). Generated and proved over ASCII. */
export type asciiString = string & { readonly __tslawsAscii: true };

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
 * Intermediate proof step (like Dafny `assert`): throws at runtime if false; in the prover, checked first as its own
 * SMT subgoal and then assumed for the rest of the law, helping Z3 discharge multi-step proofs.
 */
export function lemma(condition: boolean): asserts condition {
  if (!condition) throw new Error('lemma failed');
}

/**
 * Function precondition (like Dafny/Verus `requires`): throws at runtime if false. Inside a called function, the prover
 * verifies that every caller satisfies it; at the top level of a law it acts as an assumption.
 */
export function requires(condition: boolean): asserts condition {
  if (!condition) throw new Error('precondition violated');
}

/**
 * Function postcondition (like Dafny/Verus `ensures`): throws at runtime if false; in the prover, verified as an
 * obligation before the function returns.
 */
export function ensures(condition: boolean): asserts condition {
  if (!condition) throw new Error('postcondition violated');
}

/**
 * Termination measure for a loop (with `invariant`) or recursive function (like Dafny/Verus `decreases`): must be a
 * non-negative integer that strictly decreases on every iteration or recursive call.
 */
export function decreases(measure: number): void {
  if (typeof measure !== 'number' || measure < 0 || !Number.isFinite(measure))
    throw new Error('termination measure must be a non-negative finite number');
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

/** What a law may return: `false` fails it, anything else holds. A law may be async (browser laws wait for the page). */
export type LawBody = (...args: any[]) => boolean | void | Promise<boolean | void>;

export interface LawDeclare {
  /** Declares a law: `law('name', (x: int) => holds(x))`. Parameters need type annotations, inputs are generated from them. */
  (name: string, body: LawBody): void;
  /** A law the prover must prove for every input; `open` when it cannot. */
  proved(name: string, body: LawBody): void;
}

function notRun(): never {
  throw new Error('law() declares a specification and is run by `tslaws check`, not called at runtime');
}

/** Declares a law. `tslaws` lowers these calls to checked functions before it runs them; they never run as written. */
export const law: LawDeclare = Object.assign((_name: string, _body: LawBody): void => notRun(), {
  proved: (_name: string, _body: LawBody): void => notRun(),
});
