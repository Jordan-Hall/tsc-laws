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
