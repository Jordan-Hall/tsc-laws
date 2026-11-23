// Run settings: the command line flag beats tslaws.json, which beats the built-in default.
import type { CoverageConfig } from './coverage.ts';
import type { CheckOptions } from './types.ts';

export type Flags = Map<string, string | true>;

export interface RunDefaults {
  runs: number;
  bound: number;
  proofTimeoutMs: number;
  propertyTimeoutMs: number;
}

/** What `tslaws check` uses when neither a flag nor tslaws.json says otherwise. */
export const checkDefaults: RunDefaults = { runs: 200, bound: 4, proofTimeoutMs: 5000, propertyTimeoutMs: 30000 };

/**
 * The keys of tslaws.json the lock does not seal, each for a reason. Every other key is sealed, so a key added later is
 * sealed until someone decides it is harmless.
 *   - `$schema`: an editor hint.
 *   - `github`: who may accept and how a pull request is reviewed (github.ts); it changes no law's run.
 *   - `security`: the severity, cache and offline mode of `tslaws security deps`; it reads packages, it runs no law.
 *   - `jobs`: how many things run at once on this machine; it changes no law's result.
 *   - `levels`: the lock records each laws file's level in its own section and compares it, and a lock that records
 *     levels while the project no longer resolves any is tampered (see `compareLock`).
 */
export const unsealedKeys: readonly string[] = ['$schema', 'github', 'security', 'levels', 'jobs'];

/**
 * The whole effective tslaws.json (every `extends` followed) except `unsealedKeys`, with defaults filled in so that
 * writing a default down changes nothing. The lock seals it with each law, so weakening any of it (fewer runs, a lower
 * bound, shorter timeouts, fewer solvers, no certificates, looser compiler options, a smaller `cover`, another
 * `e2e` server or `env`) reads as tampered, and so does strengthening it. Command line flags are not part of it: they
 * are one run's choice, not the project's. What the config points at, `bundlerPlugins` and `tsconfig`, is digested
 * by seal.ts.
 */
export function sealedSettings(config: CoverageConfig): Record<string, unknown> {
  const { runs, bound, proofTimeoutMs, propertyTimeoutMs } = resolveSettings(new Map(), config);
  return {
    ...Object.fromEntries(Object.entries(config).filter(([key]) => !unsealedKeys.includes(key))),
    runs,
    bound,
    proofTimeoutMs,
    propertyTimeoutMs,
    solvers: config.solvers ?? ['z3'],
    certify: config.certify ?? false,
    compilerOptions: config.compilerOptions ?? {},
  };
}

/** `tslaws mutate` runs every law many times over, so it takes fewer runs per mutant. */
export const mutateDefaults: RunDefaults = { ...checkDefaults, runs: 30 };

export type ResolvedSettings = RunDefaults & Pick<CheckOptions, 'explicit'>;

/** Resolves runs, bound and the two timeouts: flag, then tslaws.json, then `defaults`. */
export function resolveSettings(
  flags: Flags,
  config: CoverageConfig,
  defaults: RunDefaults = checkDefaults,
): ResolvedSettings {
  const flag = (name: string): number | undefined => (flags.has(name) ? Number(flags.get(name)) : undefined);
  return {
    runs: flag('runs') ?? config.runs ?? defaults.runs,
    bound: flag('bound') ?? config.bound ?? defaults.bound,
    proofTimeoutMs: flag('proof-timeout') ?? config.proofTimeoutMs ?? defaults.proofTimeoutMs,
    propertyTimeoutMs: flag('property-timeout') ?? config.propertyTimeoutMs ?? defaults.propertyTimeoutMs,
    explicit: (['runs', 'property-timeout'] as const).filter((name) => flags.has(name)),
  };
}
