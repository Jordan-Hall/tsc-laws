// `tslaws security deps`: the npm packages the covered code imports, checked against OSV.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coverFiles } from '../../coverage.ts';
import { noCache, openCache } from './cache.ts';
import type { OsvCache } from './cache.ts';
import { defaultSecurityConfig } from './config.ts';
import type { SecurityConfig } from './config.ts';
import { collectImports } from './imports.ts';
import { installedVersion, readLockfile } from './lockfiles.ts';
import { fetchVuln, queryBatch, toAdvisory } from './osv.ts';
import type { Advisory, FetchLike, PackageRef } from './osv.ts';
import { severityRank } from './severity.ts';
import type { Severity } from './severity.ts';

export interface DepsOptions {
  cwd: string;
  /** `cover` globs of tslaws.json; without them, every non-laws source file. */
  cover?: string[];
  config?: SecurityConfig;
  /** Flags that beat the config. */
  failOn?: SecurityConfig['failOn'];
  offline?: boolean;
  noCache?: boolean;
  fetch?: FetchLike;
  now?: () => number;
}

export interface Finding extends Advisory {
  name: string;
  version: string;
  /** Listed in `security.ignore`: shown, never fails. */
  ignored: boolean;
}

export interface DepsReport {
  failOn: SecurityConfig['failOn'];
  offline: boolean;
  /** `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock` or `node_modules`. */
  source: string;
  /** The packages checked and how many covered files import each. */
  packages: (PackageRef & { files: number })[];
  findings: Finding[];
  /** Imported packages with no version in the lockfile or node_modules (a path alias, or not installed). */
  unresolved: string[];
  /** Offline runs: packages the cache has no answer for. */
  unchecked: string[];
  /** True when a finding that is not ignored is at or above `failOn`. */
  failed: boolean;
}

const semverLike = /^\d+\.\d+\.\d+/;

/** Resolves the imported packages to name and version through the lockfile, falling back to node_modules. */
export function resolvePackages(
  cwd: string,
  imported: Map<string, number>,
): { source: string; packages: (PackageRef & { files: number })[]; unresolved: string[] } {
  const lock = readLockfile(cwd);
  let own: string | undefined;
  try {
    own = (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { name?: string }).name;
  } catch {
    // No package.json.
  }
  const packages: (PackageRef & { files: number })[] = [];
  const unresolved: string[] = [];
  for (const [name, files] of imported) {
    if (name === own) continue;
    const installed = installedVersion(cwd, name);
    // A workspace package is private, so it is neither checked nor sent anywhere.
    if (installed.link || lock?.links.has(name) === true) continue;
    let versions = lock?.versions.get(name) ?? [];
    if (versions.length === 0 && installed.version !== undefined) {
      versions = [installed.version];
    }
    versions = versions.filter((v) => semverLike.test(v));
    if (versions.length === 0) unresolved.push(name);
    for (const version of versions) packages.push({ name, version, files });
  }
  return { source: lock?.source ?? 'node_modules', packages, unresolved };
}

/**
 * Collects the packages the covered code imports and asks OSV about each name and version. Only `name` and `version`
 * go over the network (and the advisory ids it answers with); no source code, path or project name does.
 */
export async function checkDeps(options: DepsOptions): Promise<DepsReport> {
  const config = options.config ?? defaultSecurityConfig;
  const failOn = options.failOn ?? config.failOn;
  const offline = options.offline ?? config.offline;
  const now = (options.now ?? Date.now)();
  const cache: OsvCache = options.noCache === true || !config.cache ? noCache : openCache(options.cwd);
  const fetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const freshness = { now, ttlMs: config.cacheTtlHours * 3600_000, stale: offline };

  const files = coverFiles(options.cwd, options.cover ?? ['**']);
  const { source, packages, unresolved } = resolvePackages(options.cwd, collectImports(options.cwd, files));

  const ids = new Map<string, string[]>();
  const missing: (PackageRef & { files: number })[] = [];
  for (const p of packages) {
    const known = cache.ids(`${p.name}@${p.version}`, freshness);
    if (known === undefined) missing.push(p);
    else ids.set(`${p.name}@${p.version}`, known);
  }
  const unchecked: string[] = [];
  if (missing.length > 0 && offline) unchecked.push(...missing.map((p) => `${p.name}@${p.version}`));
  else if (missing.length > 0) {
    const answers = await queryBatch(fetch, missing);
    missing.forEach((p, i) => {
      ids.set(`${p.name}@${p.version}`, answers[i]!);
      cache.setIds(`${p.name}@${p.version}`, answers[i]!, now);
    });
  }

  const findings: Finding[] = [];
  const vulns = new Map<string, Awaited<ReturnType<typeof fetchVuln>> | undefined>();
  for (const p of packages) {
    for (const id of ids.get(`${p.name}@${p.version}`) ?? []) {
      if (!vulns.has(id)) {
        let vuln = cache.advisory(id, freshness);
        if (vuln === undefined && !offline) {
          vuln = await fetchVuln(fetch, id);
          cache.setAdvisory(id, vuln, now);
        }
        vulns.set(id, vuln);
      }
      const vuln = vulns.get(id);
      if (vuln === undefined) {
        unchecked.push(`${p.name}@${p.version} (${id})`);
        continue;
      }
      const advisory = toAdvisory(vuln, p);
      const ignored = config.ignore.some(
        (entry) => entry === advisory.id || advisory.cve.includes(entry) || advisory.ghsa.includes(entry),
      );
      findings.push({ ...advisory, name: p.name, version: p.version, ignored });
    }
  }
  if (!offline) cache.save();
  findings.sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  return {
    failOn,
    offline,
    source,
    packages,
    findings,
    unresolved,
    unchecked,
    failed: findings.some((f) => !f.ignored && severityRank(f.severity) >= severityRank(failOn)),
  };
}

/** The report as text for a terminal. */
export function renderDeps(report: DepsReport): string {
  const lines: string[] = [];
  const names = new Set(report.packages.map((p) => p.name));
  lines.push(
    `security deps: ${names.size} package${names.size === 1 ? '' : 's'} (${report.packages.length} version${report.packages.length === 1 ? '' : 's'}) imported by covered code, from ${report.source}${report.offline ? ', offline (cache only)' : ''}`,
  );
  for (const f of report.findings) {
    const ids = [...new Set([f.id, ...f.cve, ...f.ghsa])];
    const fixed = f.fixed.length > 0 ? `fixed in ${f.fixed.join(', ')}` : 'no fixed version listed';
    const ranked: Severity = f.severity;
    lines.push(
      `${f.ignored ? 'ignored ' : severityRank(ranked) >= severityRank(report.failOn) ? 'FAIL    ' : 'warn    '}${ranked.padEnd(8)} ${f.name}@${f.version}  ${ids.join(' ')}  ${fixed}`,
    );
    if (f.summary !== '') lines.push(`         ${f.summary}`);
  }
  if (report.unresolved.length > 0)
    lines.push(`not checked, no version found: ${report.unresolved.join(', ')} (a path alias, or not installed)`);
  if (report.unchecked.length > 0)
    lines.push(`not checked, not in the cache (offline): ${report.unchecked.join(', ')}`);
  const failing = report.findings.filter((f) => !f.ignored && severityRank(f.severity) >= severityRank(report.failOn));
  lines.push(
    report.failed
      ? `${failing.length} advisor${failing.length === 1 ? 'y' : 'ies'} at or above ${report.failOn}: failed`
      : `${report.findings.length} advisor${report.findings.length === 1 ? 'y' : 'ies'}, none at or above ${report.failOn}: passed`,
  );
  return `${lines.join('\n')}\n`;
}
