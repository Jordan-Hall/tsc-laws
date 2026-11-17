// A client for OSV (https://osv.dev). It sends package names, versions and advisory ids, and nothing else.
import { severityOf } from './severity.ts';
import type { Severity } from './severity.ts';

export const osvBase = 'https://api.osv.dev';

/** The part of `fetch` the client uses, so a test can pass a mock. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface PackageRef {
  name: string;
  version: string;
}

/** The parts of an OSV record the report uses; this is also what the cache keeps. */
export interface Vuln {
  id: string;
  aliases?: string[];
  summary?: string;
  severity?: { type?: string; score?: string }[];
  database_specific?: { severity?: unknown };
  affected?: {
    package?: { name?: string; ecosystem?: string };
    ranges?: { type?: string; events?: Record<string, string>[] }[];
    ecosystem_specific?: { severity?: unknown };
  }[];
}

export interface Advisory {
  /** The OSV id, usually a GHSA id. */
  id: string;
  cve: string[];
  ghsa: string[];
  summary: string;
  severity: Severity;
  /** The versions that fix it, for the installed version. */
  fixed: string[];
  url: string;
}

const maxBatch = 1000;
const maxPages = 20;

async function post(fetch: FetchLike, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${osvBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`OSV answered ${response.status} for ${path}`);
  return response.json();
}

/** The advisory ids that affect each package, in the order of `packages`. */
export async function queryBatch(fetch: FetchLike, packages: readonly PackageRef[]): Promise<string[][]> {
  const ids: Set<string>[] = packages.map(() => new Set());
  for (let start = 0; start < packages.length; start += maxBatch) {
    let pending = packages
      .slice(start, start + maxBatch)
      .map((p, i) => ({ index: start + i, ref: p, token: undefined as string | undefined }));
    for (let page = 0; pending.length > 0 && page < maxPages; page += 1) {
      const queries = pending.map(({ ref, token }) => ({
        package: { name: ref.name, ecosystem: 'npm' },
        version: ref.version,
        ...(token === undefined ? {} : { page_token: token }),
      }));
      const answer = (await post(fetch, '/v1/querybatch', { queries })) as {
        results?: { vulns?: { id: string }[]; next_page_token?: string }[];
      };
      const results = answer.results ?? [];
      if (results.length !== pending.length) throw new Error('OSV answered a different number of results than queries');
      const next: typeof pending = [];
      results.forEach((result, i) => {
        const item = pending[i]!;
        for (const vuln of result.vulns ?? []) ids[item.index]!.add(vuln.id);
        if (result.next_page_token !== undefined) next.push({ ...item, token: result.next_page_token });
      });
      pending = next;
    }
  }
  return ids.map((set) => [...set]);
}

/** One OSV record, by id. */
export async function fetchVuln(fetch: FetchLike, id: string): Promise<Vuln> {
  const response = await fetch(`${osvBase}/v1/vulns/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`OSV answered ${response.status} for ${id}`);
  return trimVuln((await response.json()) as Vuln);
}

/** Keeps only the fields the report reads, for the cache. */
export function trimVuln(vuln: Vuln): Vuln {
  return {
    id: vuln.id,
    aliases: vuln.aliases,
    summary: vuln.summary,
    severity: vuln.severity,
    database_specific:
      vuln.database_specific?.severity === undefined ? undefined : { severity: vuln.database_specific.severity },
    affected: vuln.affected?.map((a) => ({
      package: a.package === undefined ? undefined : { name: a.package.name, ecosystem: a.package.ecosystem },
      ranges: a.ranges?.map((r) => ({ type: r.type, events: r.events })),
      ecosystem_specific:
        a.ecosystem_specific?.severity === undefined ? undefined : { severity: a.ecosystem_specific.severity },
    })),
  };
}

function parts(version: string): { core: number[]; pre: string } {
  const [core = '', pre = ''] = version.replace(/^v/, '').split(/\+/, 1)[0]!.split(/-(.*)/s);
  return { core: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
}

/** Semver order: negative when `a` is lower. Prereleases sort below their release. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i += 1) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === '') return 1;
  if (y.pre === '') return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** The versions of `name` that fix `vuln` for `version`: the `fixed` of the range that holds it, else every `fixed` listed. */
export function fixedVersions(vuln: Vuln, name: string, version: string): string[] {
  const hit = new Set<string>();
  const all = new Set<string>();
  for (const affected of vuln.affected ?? []) {
    if (affected.package?.name !== name || affected.package.ecosystem?.toLowerCase() !== 'npm') continue;
    for (const range of affected.ranges ?? []) {
      if (range.type === 'GIT') continue;
      let start: string | undefined;
      for (const event of range.events ?? []) {
        if (event.introduced !== undefined) {
          start = event.introduced;
          continue;
        }
        const { fixed, last_affected: last } = event;
        if (fixed === undefined && last === undefined) continue;
        if (fixed !== undefined) all.add(fixed);
        const aboveStart = start === undefined || start === '0' || compareVersions(version, start) >= 0;
        const belowEnd =
          fixed !== undefined ? compareVersions(version, fixed) < 0 : compareVersions(version, last!) <= 0;
        if (aboveStart && belowEnd && fixed !== undefined) hit.add(fixed);
        start = undefined;
      }
    }
  }
  return [...(hit.size > 0 ? hit : all)].sort(compareVersions);
}

/** A record shaped for the report, for the package it was found on. */
export function toAdvisory(vuln: Vuln, ref: PackageRef): Advisory {
  const names = [vuln.id, ...(vuln.aliases ?? [])];
  return {
    id: vuln.id,
    cve: names.filter((n) => n.startsWith('CVE-')),
    ghsa: names.filter((n) => n.startsWith('GHSA-')),
    summary: vuln.summary ?? '',
    severity: severityOf(vuln),
    fixed: fixedVersions(vuln, ref.name, ref.version),
    url: `https://osv.dev/vulnerability/${vuln.id}`,
  };
}
