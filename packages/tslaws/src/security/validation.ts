// CWE-20: a validator accepts only inputs that satisfy a stated predicate.
import * as fc from 'fast-check';
import { show } from './cwe.ts';
import { securityLaw } from './law.ts';
import type { SecurityLaw } from './law.ts';
import { htmlCorpus } from './xss.ts';
import { pathCorpus } from './pathTraversal.ts';

/** An untrusted string for a law parameter: `law strict(s: UntrustedInput) => validation.holds(s)`. */
export type UntrustedInput = string & { readonly __tslawsUntrusted: true };

/** Edge cases that slip past a loose pattern: line breaks, a null byte, padding, other scripts' digits, and overlong text. */
export const validationCorpus: readonly string[] = [
  '',
  ' ',
  '\n',
  '\r\n',
  '\0',
  '0',
  '-1',
  '1e3',
  '0x10',
  '٣٢',
  '１２',
  '12\n',
  '\n12',
  '12\0',
  ' 12',
  '12 ',
  '12;DROP TABLE users',
  "' OR '1'='1",
  'a'.repeat(5000),
  ...htmlCorpus,
  ...pathCorpus,
];

/** Variants of a valid example that a strict validator must still judge correctly. */
export function mutations(seed: string): string[] {
  return [
    seed + '\n',
    '\n' + seed,
    seed + '\0',
    seed + ' ',
    ' ' + seed,
    seed + seed,
    seed.slice(1),
    seed.slice(0, -1),
    seed.toUpperCase(),
    seed.toLowerCase(),
    seed + ';',
    "'" + seed,
    seed + '%00',
    seed.replace(/[0-9]/g, (d) => String.fromCodePoint(0x660 + Number(d))),
    seed.replace(/[0-9]/g, (d) => String.fromCodePoint(0xff10 + Number(d))),
  ];
}

export interface ValidationOptions<T> {
  /** Valid examples; their mutations (a trailing newline, a null byte, other scripts' digits) are tried too. Strings only. */
  seeds?: readonly string[];
  /** Inputs to try instead of the built-in strings. Required when the validator takes something other than a string. */
  input?: fc.Arbitrary<T>;
}

/**
 * CWE-20. Every input `validator` accepts must satisfy `predicate`: the accepted set is a subset of the stated one.
 * The validator may accept less than the predicate; that is not a failure. Both may throw, and a throw from the
 * validator counts as a refusal.
 */
export function inputValidation(
  validator: (input: string) => boolean,
  predicate: (input: string) => boolean,
  options?: ValidationOptions<UntrustedInput>,
): SecurityLaw<UntrustedInput>;
export function inputValidation<T>(
  validator: (input: T) => boolean,
  predicate: (input: T) => boolean,
  options: ValidationOptions<T> & { input: fc.Arbitrary<T> },
): SecurityLaw<T>;
export function inputValidation(
  validator: (input: any) => boolean,
  predicate: (input: any) => boolean,
  options: ValidationOptions<any> = {},
): SecurityLaw<any> {
  const seeds = options.seeds ?? [];
  const strings = fc.oneof(
    { weight: 4, arbitrary: fc.string({ unit: 'binary' }) },
    { weight: 2, arbitrary: fc.constantFrom(...validationCorpus) },
    ...(seeds.length > 0
      ? [
          {
            weight: 4,
            arbitrary: fc.constantFrom(...seeds).chain((seed) => fc.constantFrom(seed, ...mutations(seed))),
          },
        ]
      : []),
  );
  const input = options.input ?? strings;
  const corpus =
    options.input === undefined ? [...validationCorpus, ...seeds.flatMap((s) => [s, ...mutations(s)])] : [];
  return securityLaw<any>({
    id: 'input-validation',
    cwe: ['CWE-20'],
    title: 'a validator accepts only inputs that satisfy the stated predicate',
    input,
    corpus,
    verdict: (value: unknown) => {
      let accepted: boolean;
      try {
        accepted = validator(value);
      } catch {
        return undefined;
      }
      if (accepted !== true) return undefined;
      let stated: boolean;
      try {
        stated = predicate(value);
      } catch {
        stated = false;
      }
      return stated ? undefined : { detail: `validator accepted ${show(value)}, which the predicate rejects` };
    },
  });
}
