// The OSV answers kept in the user's cache directory (`tslaws/osv-cache.json`), so a rerun or an offline run does not
// need the network. The file is never read from the project: a cache a repository commits could hide known
// vulnerabilities from a run that trusts it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import type { Vuln } from './osv.ts';

interface Stored {
  version: 1;
  /** `name@version` to the advisory ids that affected it, and when OSV was asked (ms since the epoch). */
  packages: Record<string, { ids: string[]; at: number }>;
  advisories: Record<string, { vuln: Vuln; at: number }>;
}

export interface OsvCache {
  /** The ids for a package, when known and (online) fresh enough; `stale: true` answers from old entries too (offline). */
  ids(key: string, options: { now: number; ttlMs: number; stale: boolean }): string[] | undefined;
  advisory(id: string, options: { now: number; ttlMs: number; stale: boolean }): Vuln | undefined;
  setIds(key: string, ids: string[], now: number): void;
  setAdvisory(id: string, vuln: Vuln, now: number): void;
  save(): void;
}

/**
 * The per-user cache directory: `%LOCALAPPDATA%	slaws` on Windows, else `$XDG_CACHE_HOME/tslaws` or `~/.cache/tslaws`.
 * A variable that is empty or not an absolute path is ignored, as the XDG spec says: a relative one would put the cache
 * inside whichever directory the run starts in, which can be the repository.
 */
export function cacheDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const isAbsolute = platform === 'win32' ? win32.isAbsolute : posix.isAbsolute;
  const absolute = (value: string | undefined): string | undefined =>
    value !== undefined && isAbsolute(value) ? value : undefined;
  if (platform === 'win32') return join(absolute(env.LOCALAPPDATA) ?? join(home, 'AppData', 'Local'), 'tslaws');
  return join(absolute(env.XDG_CACHE_HOME) ?? join(home, '.cache'), 'tslaws');
}

export const cachePath = (env: NodeJS.ProcessEnv = process.env): string => join(cacheDir(env), 'osv-cache.json');

/** An entry dated further ahead than this is not believed: clocks drift a little, a planted file is not that close. */
const skewMs = 5 * 60_000;

const fresh = (at: number, o: { now: number; ttlMs: number; stale: boolean }): boolean => {
  // Offline there is no newer answer to prefer, so any age is accepted; online a date in the future never is.
  if (o.stale) return true;
  return at <= o.now + skewMs && o.now - at <= o.ttlMs;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optional = (value: unknown, ok: (v: unknown) => boolean): boolean => value === undefined || ok(value);

const isString = (value: unknown): value is string => typeof value === 'string';
const isArrayOf = (value: unknown, ok: (item: unknown) => boolean): boolean => Array.isArray(value) && value.every(ok);

/** An OSV range event: `introduced`, `fixed`, `last_affected` or `limit`, each a version string. */
const isEvent = (value: unknown): boolean => isObject(value) && Object.values(value).every(isString);
const isRange = (value: unknown): boolean =>
  isObject(value) && optional(value.type, isString) && optional(value.events, (v) => isArrayOf(v, isEvent));
const isAffected = (value: unknown): boolean =>
  isObject(value) &&
  optional(value.package, (v) => isObject(v) && optional(v.name, isString) && optional(v.ecosystem, isString)) &&
  optional(value.ranges, (v) => isArrayOf(v, isRange)) &&
  optional(value.ecosystem_specific, isObject);
const isScore = (value: unknown): boolean =>
  isObject(value) && optional(value.type, isString) && optional(value.score, isString);

/** Whether `value` has the shape `trimVuln` writes, all the way down, and is the advisory `id`. */
function isVuln(value: unknown, id: string): value is Vuln {
  if (!isObject(value) || value.id !== id) return false;
  return (
    optional(value.aliases, isStrings) &&
    optional(value.summary, isString) &&
    optional(value.severity, (v) => isArrayOf(v, isScore)) &&
    optional(value.database_specific, isObject) &&
    optional(value.affected, (v) => isArrayOf(v, isAffected))
  );
}

/** Objects without a prototype, so a key such as `__proto__` in a planted file is only a key. */
const empty = (): Stored => ({ version: 1, packages: Object.create(null), advisories: Object.create(null) });

/** The entries of a cache file that are well formed; the rest are dropped, so they are asked of OSV again. */
function validated(read: unknown): Stored {
  const out: Stored = empty();
  if (!isObject(read) || read.version !== 1) return out;
  if (isObject(read.packages))
    for (const [key, entry] of Object.entries(read.packages))
      if (isObject(entry) && isStrings(entry.ids) && isTime(entry.at))
        out.packages[key] = { ids: entry.ids, at: entry.at };
  if (isObject(read.advisories))
    for (const [id, entry] of Object.entries(read.advisories))
      if (isObject(entry) && isTime(entry.at) && isVuln(entry.vuln, id))
        out.advisories[id] = { vuln: entry.vuln, at: entry.at };
  return out;
}

/** Reads the cache file (an empty cache when it is missing or unreadable). */
export function openCache(env: NodeJS.ProcessEnv = process.env): OsvCache {
  const path = cachePath(env);
  let stored: Stored = empty();
  try {
    stored = validated(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    // Nothing cached yet.
  }
  return {
    ids: (key, o) => {
      const entry = Object.hasOwn(stored.packages, key) ? stored.packages[key] : undefined;
      return entry !== undefined && fresh(entry.at, o) ? entry.ids : undefined;
    },
    advisory: (id, o) => {
      const entry = Object.hasOwn(stored.advisories, id) ? stored.advisories[id] : undefined;
      return entry !== undefined && fresh(entry.at, o) ? entry.vuln : undefined;
    },
    setIds: (key, ids, now) => {
      stored.packages[key] = { ids, at: now };
    },
    setAdvisory: (id, vuln, now) => {
      stored.advisories[id] = { vuln, at: now };
    },
    save: () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(stored)}\n`);
    },
  };
}

/** A cache that keeps nothing. */
export const noCache: OsvCache = {
  ids: () => undefined,
  advisory: () => undefined,
  setIds: () => undefined,
  setAdvisory: () => undefined,
  save: () => undefined,
};
