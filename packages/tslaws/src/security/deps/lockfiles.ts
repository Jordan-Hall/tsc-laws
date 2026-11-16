// Versions of installed packages, from the project's lockfile (npm, pnpm, yarn or bun) or its node_modules.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface Locked {
  /** Which file the versions came from. */
  source: string;
  /** Every version of each package the lockfile resolves; the first is the one the project's own code sees, where the lockfile says. */
  versions: Map<string, string[]>;
  /** Packages the lockfile links to a folder in the workspace: private, not on npm. */
  links: Set<string>;
}

function add(map: Map<string, string[]>, name: string, version: string, first = false): void {
  const list = map.get(name) ?? [];
  if (!list.includes(version)) {
    if (first) list.unshift(version);
    else list.push(version);
  }
  map.set(name, list);
}

/** package-lock.json and npm-shrinkwrap.json, lockfileVersion 1 to 3. */
export function parseNpmLock(text: string): Pick<Locked, 'versions' | 'links'> {
  const lock = JSON.parse(text) as {
    packages?: Record<string, { version?: string; link?: boolean; resolved?: string }>;
    dependencies?: Record<string, { version?: string; dependencies?: Record<string, unknown> }>;
  };
  const versions = new Map<string, string[]>();
  const links = new Set<string>();
  if (lock.packages !== undefined) {
    for (const [path, entry] of Object.entries(lock.packages)) {
      const at = path.lastIndexOf('node_modules/');
      if (at < 0) continue;
      const name = path.slice(at + 'node_modules/'.length);
      if (entry.link === true) links.add(name);
      else if (entry.version !== undefined) add(versions, name, entry.version, at === 0);
    }
    return { versions, links };
  }
  const walk = (deps: NonNullable<typeof lock.dependencies>, top: boolean): void => {
    for (const [name, entry] of Object.entries(deps)) {
      if (entry.version !== undefined) add(versions, name, entry.version, top);
      if (entry.dependencies !== undefined) walk(entry.dependencies as NonNullable<typeof lock.dependencies>, false);
    }
  };
  walk(lock.dependencies ?? {}, true);
  return { versions, links };
}

/** pnpm-lock.yaml: the keys of `packages:` in the v5 (`/name/1.2.3`), v6 (`/name@1.2.3`) and v9 (`name@1.2.3`) layouts. */
export function parsePnpmLock(text: string): Pick<Locked, 'versions' | 'links'> {
  const versions = new Map<string, string[]>();
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPackages = /^packages:\s*$/.test(line);
      continue;
    }
    if (!inPackages) continue;
    const key = /^ {2}(?!\s)(.+?):\s*$/.exec(line)?.[1];
    if (key === undefined) continue;
    const bare = key
      .replace(/^['"]|['"]$/g, '')
      .replace(/^\//, '')
      .replace(/\(.*$/, '');
    const modern = /^(@?[^@]+)@(\d[^\s_]*)$/.exec(bare);
    const legacy = /^(@[^/]+\/[^/]+|[^/@]+)\/(\d[^_/]*)/.exec(bare);
    const match = legacy ?? modern;
    if (match !== null) add(versions, match[1]!, match[2]!);
  }
  return { versions, links: new Set() };
}

/** yarn.lock, classic (`version "1.2.3"`) and berry (`version: 1.2.3`). */
export function parseYarnLock(text: string): Pick<Locked, 'versions' | 'links'> {
  const versions = new Map<string, string[]>();
  let names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#') || line.trim() === '') continue;
    if (/^\S/.test(line) && line.trimEnd().endsWith(':')) {
      names = line
        .trimEnd()
        .slice(0, -1)
        .split(',')
        .map((spec) => spec.trim().replace(/^['"]|['"]$/g, ''))
        .filter((spec) => !/@(workspace|patch|link|portal|file):/.test(spec))
        .map((spec) => spec.slice(0, spec.indexOf('@', 1)))
        .filter((name) => name !== '');
      continue;
    }
    const version = /^ {2}version:? "?([^"\s]+)"?\s*$/.exec(line)?.[1];
    if (version !== undefined) {
      for (const name of new Set(names)) add(versions, name, version);
      names = [];
    }
  }
  return { versions, links: new Set() };
}

/** bun.lock (text; JSON with comments and trailing commas): each `packages` entry starts with `name@version`. */
export function parseBunLock(text: string): Pick<Locked, 'versions' | 'links'> {
  const json = text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
  const lock = JSON.parse(json) as { packages?: Record<string, unknown[]> };
  const versions = new Map<string, string[]>();
  for (const entry of Object.values(lock.packages ?? {})) {
    const ident = entry[0];
    if (typeof ident !== 'string') continue;
    const at = ident.indexOf('@', 1);
    const version = at > 0 ? ident.slice(at + 1) : '';
    if (/^\d/.test(version)) add(versions, ident.slice(0, at), version);
  }
  return { versions, links: new Set() };
}

const lockfiles: [string, (text: string) => Pick<Locked, 'versions' | 'links'>][] = [
  ['package-lock.json', parseNpmLock],
  ['npm-shrinkwrap.json', parseNpmLock],
  ['pnpm-lock.yaml', parsePnpmLock],
  ['yarn.lock', parseYarnLock],
  ['bun.lock', parseBunLock],
];

/** The nearest lockfile at or above `cwd` (a monorepo keeps one at its root), read; undefined when there is none. */
export function readLockfile(cwd: string): Locked | undefined {
  for (let dir = resolve(cwd), depth = 0; depth < 8; dir = dirname(dir), depth += 1) {
    for (const [name, parse] of lockfiles) {
      const path = join(dir, name);
      if (existsSync(path)) return { source: name, ...parse(readFileSync(path, 'utf8')) };
    }
    if (dirname(dir) === dir) break;
  }
  return undefined;
}

/** The installed version of a package, from the nearest `node_modules/<name>/package.json`, plus whether it is a workspace link. */
export function installedVersion(cwd: string, name: string): { version?: string; link: boolean } {
  for (let dir = resolve(cwd), depth = 0; depth < 8; dir = dirname(dir), depth += 1) {
    const folder = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(folder)) {
      const link = lstatSync(folder).isSymbolicLink();
      try {
        const version = (JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as { version?: unknown })
          .version;
        return { version: typeof version === 'string' ? version : undefined, link };
      } catch {
        return { link };
      }
    }
    if (dirname(dir) === dir) break;
  }
  return { link: false };
}
