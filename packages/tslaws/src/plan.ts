// A generator plan: what to generate for one parameter type, as plain data. The type checker reads a parameter's type
// once, in the main process, and writes the plan; a worker turns the plan into fast-check arbitraries without loading
// TypeScript (about 0.8 s of start-up per worker).
import { sequence } from './sequence.ts';
import * as fc from 'fast-check';
import { arbitraryRegistry } from './api.ts';

export class UnsupportedType extends Error {}

export type Plan =
  | { k: 'anything' }
  | { k: 'const'; v: undefined | null | boolean | number | string }
  | { k: 'bigconst'; v: string }
  | { k: 'boolean' | 'number' | 'string' | 'bigint' | 'symbol' | 'object' | 'date' | 'regexp' }
  | { k: 'union'; of: Plan[] }
  | { k: 'template'; texts: string[]; parts: Plan[] }
  /** A type with a registered generator; `fallback` is what to generate when none is registered by the time of use. */
  | { k: 'named'; name: string; fallback?: Plan }
  | { k: 'array'; of: Plan }
  | { k: 'tuple'; required: Plan[]; optional: Plan[] }
  | { k: 'fn'; returns: Plan }
  | { k: 'record'; fields: Record<string, Plan>; required: string[] }
  | { k: 'dict'; of: Plan };

const numbers = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -8, max: 8 }) },
  { weight: 3, arbitrary: fc.integer({ min: -1000, max: 1000 }) },
  { weight: 1, arbitrary: fc.integer() },
  { weight: 2, arbitrary: fc.double({ noNaN: true, noDefaultInfinity: true }) },
);

// `int` from 'tslaws': whole numbers, biased to small ones.
arbitraryRegistry().set(
  'int',
  fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: -8, max: 8 }) },
    { weight: 3, arbitrary: fc.integer({ min: -1000, max: 1000 }) },
    { weight: 1, arbitrary: fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }) },
  ),
);

/** Marks a generated function on the wire: browser laws receive their arguments as structured data. */
export const wireKey = '$tslawsFn';

function pick(samples: unknown[], args: unknown[]): unknown {
  let key = '';
  try {
    key = JSON.stringify(args) ?? '';
  } catch {
    // Arguments that are not JSON (a node, a cycle) all share the first sample.
  }
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 33) + key.charCodeAt(i)) | 0;
  return samples[(h >>> 0) % samples.length];
}

/**
 * A function of a type with one call signature: it returns one of a few values generated from the return type,
 * chosen by its arguments (like `fc.func`: the same arguments give the same result, `void` gives `undefined`).
 * `samples` rides along so a browser law can rebuild the function in the page.
 */
function generatedFunction(samples: unknown[]): unknown {
  const fn = (...args: unknown[]): unknown => pick(samples, args);
  Object.defineProperty(fn, wireKey, { value: samples, enumerable: false });
  Object.defineProperty(fn, 'toString', { value: () => `[generated function]`, enumerable: false });
  return fn;
}

/** Replaces generated functions inside arguments with a structured-clone-safe marker `{ $tslawsFn: samples }`. */
export function toWire(value: unknown): unknown {
  if (typeof value === 'function') {
    const samples = (value as unknown as Record<string, unknown>)[wireKey];
    return { [wireKey]: Array.isArray(samples) ? samples : [undefined] };
  }
  if (Array.isArray(value)) return value.map(toWire);
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null)
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toWire(v)]));
  }
  return value;
}

/** The fast-check arbitrary a plan describes. */
export function arbitraryOf(plan: Plan): fc.Arbitrary<unknown> {
  switch (plan.k) {
    case 'anything':
      return fc.anything();
    case 'const':
      return fc.constant(plan.v);
    case 'bigconst':
      return fc.constant(BigInt(plan.v));
    case 'boolean':
      return fc.boolean();
    case 'number':
      return numbers;
    case 'string':
      return fc.string({ maxLength: 24 });
    case 'bigint':
      return fc.bigInt();
    case 'symbol':
      return fc.string().map((s) => Symbol(s));
    case 'object':
      return fc.object();
    case 'date':
      return fc.date({ noInvalidDate: true });
    case 'regexp':
      return fc.constant(/x/);
    case 'union':
      return fc.oneof(...plan.of.map(arbitraryOf));
    case 'template': {
      const parts: fc.Arbitrary<string>[] = [fc.constant(plan.texts[0] ?? '')];
      plan.parts.forEach((part, i) => {
        parts.push(arbitraryOf(part).map(String));
        parts.push(fc.constant(plan.texts[i + 1] ?? ''));
      });
      return fc.tuple(...parts).map((p) => p.join(''));
    }
    case 'named': {
      const registered = arbitraryRegistry().get(plan.name);
      if (registered !== undefined) return registered;
      if (plan.fallback === undefined) throw new UnsupportedType(`no generator registered for ${plan.name}`);
      return arbitraryOf(plan.fallback);
    }
    case 'array':
      return sequence(arbitraryOf(plan.of), { maxLength: 8 });
    case 'tuple': {
      const required = plan.required.map(arbitraryOf);
      const optional = plan.optional.map(arbitraryOf);
      return fc.tuple(...required).chain((head) => {
        if (optional.length === 0) return fc.constant(head);
        return fc.tuple(...optional).map((tail) => [...head, ...tail]);
      });
    }
    case 'fn':
      return fc.array(arbitraryOf(plan.returns), { minLength: 1, maxLength: 4 }).map(generatedFunction);
    case 'record': {
      const model: Record<string, fc.Arbitrary<unknown>> = {};
      for (const [key, field] of Object.entries(plan.fields)) model[key] = arbitraryOf(field);
      return fc.record(model, { requiredKeys: plan.required });
    }
    case 'dict':
      return fc.dictionary(fc.string({ maxLength: 6 }), arbitraryOf(plan.of), { maxKeys: 6 });
  }
}
