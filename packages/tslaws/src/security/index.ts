// `tslaws/security`: CWE-tagged law builders for a project's own functions, and the OSV check of covered dependencies.
// A builder returns a SecurityLaw: use `.holds(input)` as a law body, or `.run()` / `.assert()` in a plain test.
import * as fc from 'fast-check';
import { htmlPayloads } from './xss.ts';
import { intPairs } from './integers.ts';
import { pathPayloads } from './pathTraversal.ts';
import { pollutionPaths, pollutionPayloads } from './prototypePollution.ts';
import { redirectTargets } from './redirect.ts';
import { redosAttacks } from './redos.ts';
import { validationCorpus } from './validation.ts';

export { cweCatalog, cweLabel, CweViolation } from './cwe.ts';
export type { CweId } from './cwe.ts';
export { securityLaw } from './law.ts';
export type { SecurityLaw, SecurityLawSpec, SecurityOutcome } from './law.ts';
export { pathCorpus, pathPayloads, pathTraversal } from './pathTraversal.ts';
export type { PathPayload, PathTraversalOptions } from './pathTraversal.ts';
export { htmlCorpus, htmlEscaping, htmlPayloads } from './xss.ts';
export type { HtmlEscapeOptions, HtmlPayload } from './xss.ts';
export {
  marker as pollutionMarker,
  pollutionCorpus,
  pollutionPathCorpus,
  pollutionPaths,
  pollutionPayloads,
  prototypeSafeMerge,
  prototypeSafeParse,
  prototypeSafeSet,
} from './prototypePollution.ts';
export type { PollutionPath, PollutionPayload, PrototypeSafeSetOptions } from './prototypePollution.ts';
export { redos, redosAttacks } from './redos.ts';
export type { RedosAttack, RedosOptions } from './redos.ts';
export { inputValidation, mutations, validationCorpus } from './validation.ts';
export type { UntrustedInput, ValidationOptions } from './validation.ts';
export { intPairs, safeArithmetic } from './integers.ts';
export type { IntPair, SafeArithmeticOptions } from './integers.ts';
export { openRedirect, redirectCorpus, redirectTargets } from './redirect.ts';
export type { OpenRedirectOptions, RedirectTarget } from './redirect.ts';
export { checkDeps, renderDeps } from './deps/run.ts';
export type { DepsOptions, DepsReport, Finding } from './deps/run.ts';
export { defaultSecurityConfig, parseSecurityConfig } from './deps/config.ts';
export type { SecurityConfig } from './deps/config.ts';
export type { Advisory, FetchLike } from './deps/osv.ts';
export { severityRank } from './deps/severity.ts';
export type { Severity } from './deps/severity.ts';

/** The generators a law parameter gets from its type name. Registered when this module loads. */
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
 * `UntrustedInput`, `RedosAttack`, `IntPair`, `RedirectTarget`) in the same registry `arbitrary()` writes to. It runs
 * when `tslaws/security` loads; call it again only to restore these after a test replaced one.
 */
export function registerSecurityGenerators(): void {
  const holder = globalThis as unknown as Record<symbol, Map<string, fc.Arbitrary<unknown>> | undefined>;
  const registry = (holder[registryKey] ??= new Map());
  for (const [name, generator] of Object.entries(generators)) registry.set(name, generator);
}

registerSecurityGenerators();
