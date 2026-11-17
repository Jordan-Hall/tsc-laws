// The `security` section of tslaws.json.
import { parseSeverity } from './severity.ts';
import type { Severity } from './severity.ts';

export interface SecurityConfig {
  /** Fail when an advisory is at or above this severity. Default `high`. */
  failOn: Exclude<Severity, 'unknown'>;
  /** Use only the cache and never touch the network. Default false. */
  offline: boolean;
  /** Keep answers in the per-user cache directory (`tslaws/osv-cache.json`). Default true. */
  cache: boolean;
  /** How long a cached answer stays fresh when online, in hours. Default 24. */
  cacheTtlHours: number;
  /** Advisory ids (GHSA, CVE or OSV) that a person has reviewed and accepted. They are listed but never fail. */
  ignore: string[];
}

export const defaultSecurityConfig: SecurityConfig = {
  failOn: 'high',
  offline: false,
  cache: true,
  cacheTtlHours: 24,
  ignore: [],
};

const keys = ['failOn', 'offline', 'cache', 'cacheTtlHours', 'ignore'];

/** Validates `security` from tslaws.json; fills the defaults. */
export function parseSecurityConfig(raw: unknown): SecurityConfig {
  const fail = (message: string): never => {
    throw new Error(`tslaws.json: security: ${message}`);
  };
  if (raw === undefined) return { ...defaultSecurityConfig };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('must be an object');
  const object = raw as Record<string, unknown>;
  for (const key of Object.keys(object))
    if (!keys.includes(key)) fail(`unknown option "${key}"; supported options are ${keys.join(', ')}`);
  const failOn = object.failOn === undefined ? defaultSecurityConfig.failOn : parseSeverity(object.failOn);
  if (failOn === undefined || failOn === 'unknown')
    fail(`"failOn" must be "low", "moderate", "high" or "critical", got ${JSON.stringify(object.failOn)}`);
  for (const key of ['offline', 'cache'] as const)
    if (object[key] !== undefined && typeof object[key] !== 'boolean') fail(`"${key}" must be true or false`);
  const ttl = object.cacheTtlHours;
  if (ttl !== undefined && (typeof ttl !== 'number' || !(ttl >= 0))) fail('"cacheTtlHours" must be a number of hours');
  const ignore = object.ignore;
  if (ignore !== undefined && (!Array.isArray(ignore) || ignore.some((id) => typeof id !== 'string' || id === '')))
    fail('"ignore" must be an array of advisory ids');
  return {
    failOn: failOn as SecurityConfig['failOn'],
    offline: (object.offline as boolean | undefined) ?? defaultSecurityConfig.offline,
    cache: (object.cache as boolean | undefined) ?? defaultSecurityConfig.cache,
    cacheTtlHours: (ttl as number | undefined) ?? defaultSecurityConfig.cacheTtlHours,
    ignore: (ignore as string[] | undefined) ?? [],
  };
}
