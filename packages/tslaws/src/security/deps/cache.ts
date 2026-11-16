// The OSV answers kept in `.tslaws/osv-cache.json`, so a rerun or an offline run does not need the network.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

export const cachePath = (cwd: string): string => join(cwd, '.tslaws', 'osv-cache.json');

const fresh = (at: number, o: { now: number; ttlMs: number; stale: boolean }): boolean =>
  o.stale || o.now - at <= o.ttlMs;

/** Reads the cache file (an empty cache when it is missing or unreadable). */
export function openCache(cwd: string): OsvCache {
  const path = cachePath(cwd);
  let stored: Stored = { version: 1, packages: {}, advisories: {} };
  try {
    const read = JSON.parse(readFileSync(path, 'utf8')) as Stored;
    if (read.version === 1) stored = read;
  } catch {
    // Nothing cached yet.
  }
  return {
    ids: (key, o) => {
      const entry = stored.packages[key];
      return entry !== undefined && fresh(entry.at, o) ? entry.ids : undefined;
    },
    advisory: (id, o) => {
      const entry = stored.advisories[id];
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
