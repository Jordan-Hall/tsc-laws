// The generators a law parameter gets from the name of its type (`PathPayload`, `HtmlPayload`, ...). Kept apart from
// index.ts so the runner can register them without loading the OSV check and the config reader.
import * as fc from 'fast-check';
import { htmlPayloads } from './xss.ts';
import { intPairs } from './integers.ts';
import { pathPayloads } from './pathTraversal.ts';
import { pollutionPaths, pollutionPayloads } from './prototypePollution.ts';
import { redirectTargets } from './redirect.ts';
import { redosAttacks } from './redos.ts';
import { validationCorpus } from './validation.ts';

/** The generators a law parameter gets from its type name. */
const generators: Record<string, fc.Arbitrary<unknown>> = {
  PathPayload: pathPayloads(),
  HtmlPayload: htmlPayloads(),
  PollutionPayload: pollutionPayloads(),
  PollutionPath: pollutionPaths(),
  UntrustedInput: fc.oneof(fc.constantFrom(...validationCorpus), fc.string({ unit: 'binary' })),
  RedosAttack: redosAttacks(),
  IntPair: intPairs(),
  RedirectTarget: redirectTargets(),
};

const registryKey = Symbol.for('tslaws.arbitraries');

/**
 * Registers the generator for each payload type (`PathPayload`, `HtmlPayload`, `PollutionPayload`, `PollutionPath`,
 * `UntrustedInput`, `RedosAttack`, `IntPair`, `RedirectTarget`) in the same registry `arbitrary()` writes to. `tslaws/security` runs
 * it when it loads, and the runner when a law parameter has one of these types declared by tslaws; call it again only to
 * restore these after a test replaced one.
 */
export function registerSecurityGenerators(): void {
  const holder = globalThis as unknown as Record<symbol, Map<string, fc.Arbitrary<unknown>> | undefined>;
  const registry = (holder[registryKey] ??= new Map());
  for (const [name, generator] of Object.entries(generators)) registry.set(name, generator);
}

/** The type names `registerSecurityGenerators` fills in. */
export const securityTypeNames: ReadonlySet<string> = new Set(Object.keys(generators));
