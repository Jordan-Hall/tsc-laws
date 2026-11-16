// Project discovery for a monorepo: a project is a directory holding a tslaws.json. Which directories to look in comes
// from the first source that names any: `projects` in the root tslaws.json, `workspaces` in package.json (npm, yarn
// and bun alike), or `packages:` in pnpm-workspace.yaml.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectsProblem } from './coverage.ts';
import { globMatcher } from './globs.ts';

export interface Project {
  /** Absolute directory of the project. */
  dir: string;
  /** Directory relative to the repository root, with `/` separators; '' for the root itself. */
  path: string;
}

export interface DiscoverOptions {
  /** Keep projects whose `path` matches one of these globs (a leading `!` excludes). */
  filter?: string[];
  /** Keep only projects whose `path` is exactly one of these. */
  only?: string[];
}

/** Directories never searched, for projects or for laws files. */
const skipped = new Set(['node_modules', '.git', 'dist', '.tslaws']);

/** `./packages/a/` as `packages/a`; `.` and `./` as ''. */
function normalise(path: string): string {
  return path
    .replaceAll('\\', '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')
    .replace(/^\.$/, '');
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

/** The raw `projects` list of tslaws.json in `dir`, or undefined when there is no file or no such key. */
function projectsOf(dir: string): string[] | undefined {
  const file = join(dir, 'tslaws.json');
  if (!existsSync(file)) return undefined;
  const raw = readJson(file) as Record<string, unknown> | null;
  if (typeof raw !== 'object' || raw === null || raw.projects === undefined) return undefined;
  const problem = projectsProblem(raw.projects);
  if (problem !== undefined) throw new Error(`tslaws.json: ${problem}`);
  return raw.projects as string[];
}

function workspacesOf(dir: string): string[] {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return [];
  let workspaces: unknown;
  try {
    workspaces = (readJson(file) as { workspaces?: unknown } | null)?.workspaces;
  } catch {
    return [];
  }
  const list = Array.isArray(workspaces) ? workspaces : (workspaces as { packages?: unknown } | undefined)?.packages;
  return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * The `packages:` list of pnpm-workspace.yaml. Only the plain shapes pnpm documents are read: a block list of
 * (optionally quoted) globs, or a one-line `[a, b]`. That keeps this free of a YAML dependency.
 */
export function pnpmPackages(text: string): string[] {
  const found: string[] = [];
  let inList = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) {
      const key = /^packages\s*:\s*(.*?)\s*(?:#.*)?$/.exec(line);
      inList = key !== null;
      if (key?.[1]?.startsWith('[') === true) {
        for (const item of key[1].replace(/^\[|\]$/g, '').split(',')) {
          const value = item.trim().replace(/^(['"])(.*)\1$/, '$2');
          if (value !== '') found.push(value);
        }
        inList = false;
      }
      continue;
    }
    if (!inList) continue;
    const item = /^\s*-\s*(?:'([^']*)'|"([^"]*)"|([^#\s][^#]*?))\s*(?:#.*)?$/.exec(line);
    const value = item?.[1] ?? item?.[2] ?? item?.[3];
    if (value !== undefined && value !== '') found.push(value);
  }
  return found;
}

function pnpmWorkspacesOf(dir: string): string[] {
  const file = join(dir, 'pnpm-workspace.yaml');
  return existsSync(file) ? pnpmPackages(readFileSync(file, 'utf8')) : [];
}

/**
 * Whether the glob `pattern` could match `path` or something below it, from its fixed leading segments alone. It lets
 * the search skip a whole `apps/` tree when the globs are `packages/*`.
 */
function reaches(pattern: string, path: string): boolean {
  const want = pattern.split('/');
  const have = path.split('/');
  for (const [index, segment] of have.entries()) {
    const expected = want[index];
    if (expected === undefined) return want[want.length - 1] === '**';
    if (/[*?]/.test(expected)) return true;
    if (expected !== segment) return false;
  }
  return true;
}

/** Directories (relative POSIX paths) under `root` that hold a tslaws.json and match `globs`. */
function matchingProjects(root: string, globs: string[]): string[] {
  const patterns = globs.map((glob) => {
    const negated = glob.startsWith('!');
    return `${negated ? '!' : ''}${normalise(negated ? glob.slice(1) : glob)}`;
  });
  const matches = globMatcher(patterns);
  const includes = patterns.filter((glob) => !glob.startsWith('!'));
  const found: string[] = [];
  const walk = (path: string): void => {
    const dir = path === '' ? root : join(root, path);
    if (path !== '' && matches(path) && existsSync(join(dir, 'tslaws.json'))) found.push(path);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || skipped.has(entry.name)) continue;
      const next = path === '' ? entry.name : `${path}/${entry.name}`;
      if (includes.some((glob) => reaches(glob, next))) walk(next);
    }
  };
  walk('');
  return found;
}

/**
 * The cheap test for "the root has laws of its own": a tsc-laws.lock beside it, or any `*.laws.ts` file outside the
 * projects. It reads directory names only (no file contents), skips node_modules, .git, dist and each project, and
 * stops at the first hit.
 */
function rootHasLaws(root: string, projects: string[]): boolean {
  if (existsSync(join(root, 'tsc-laws.lock'))) return true;
  const inProject = new Set(projects);
  const walk = (path: string): boolean => {
    for (const entry of readdirSync(path === '' ? root : join(root, path), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.laws.ts')) return true;
      if (!entry.isDirectory() || skipped.has(entry.name)) continue;
      const next = path === '' ? entry.name : `${path}/${entry.name}`;
      if (!inProject.has(next) && walk(next)) return true;
    }
    return false;
  };
  return walk('');
}

/**
 * Every project under `root`, sorted by path. The root itself is one only when it has a tslaws.json and either that
 * file has no `projects` key (a plain single project that happens to hold others) or the root carries laws of its
 * own (see `rootHasLaws`); a root whose tslaws.json only lists projects is just the list.
 */
export function discoverProjects(root: string, opts: DiscoverOptions = {}): Project[] {
  const dir = resolve(root);
  const listed = projectsOf(dir);
  const globs = listed ?? [workspacesOf(dir), pnpmWorkspacesOf(dir)].find((list) => list.length > 0) ?? [];
  const paths = globs.length === 0 ? [] : matchingProjects(dir, globs);
  if (existsSync(join(dir, 'tslaws.json')) && (listed === undefined || rootHasLaws(dir, paths))) paths.push('');
  let projects = paths.sort().map((path): Project => ({ dir: path === '' ? dir : join(dir, path), path }));
  if (opts.only !== undefined && opts.only.length > 0) {
    const only = new Set(opts.only.map(normalise));
    projects = projects.filter((project) => only.has(project.path));
  }
  if (opts.filter !== undefined && opts.filter.length > 0) {
    const matches = globMatcher(
      opts.filter.map((glob) => (glob.startsWith('!') ? `!${normalise(glob.slice(1))}` : normalise(glob))),
    );
    projects = projects.filter((project) => matches(project.path));
  }
  return projects;
}

/**
 * Whether `cwd` is the root of a monorepo run: it has no tslaws.json but discovery finds projects below it, or its
 * tslaws.json has a `projects` list.
 */
export function isMonorepoRoot(cwd: string): boolean {
  const dir = resolve(cwd);
  if (!existsSync(join(dir, 'tslaws.json'))) return discoverProjects(dir).length > 0;
  return projectsOf(dir) !== undefined;
}
