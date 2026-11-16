// Project discovery for a monorepo: a project is a directory holding a tslaws.json. Which directories to look in comes
// from the first source that names any: `projects` in the root tslaws.json, `workspaces` in package.json (npm, yarn
// and bun alike), or `packages:` in pnpm-workspace.yaml.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { projectsProblem, readConfig } from './coverage.ts';
import { globMatcher } from './globs.ts';
import { customLawFile } from './lawFiles.ts';
import { readResolution } from './tsconfigResolve.ts';

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

/** Directories (relative POSIX paths) under `root` that hold a `marker` file and match `globs`. */
function matchingProjects(root: string, globs: string[], marker = 'tslaws.json'): string[] {
  const patterns = globs.map((glob) => {
    const negated = glob.startsWith('!');
    return `${negated ? '!' : ''}${normalise(negated ? glob.slice(1) : glob)}`;
  });
  const matches = globMatcher(patterns);
  const includes = patterns.filter((glob) => !glob.startsWith('!'));
  const found: string[] = [];
  const walk = (path: string): void => {
    const dir = path === '' ? root : join(root, path);
    if (path !== '' && matches(path) && existsSync(join(dir, marker))) found.push(path);
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
 * The cheap test for "the root has laws of its own": a tsc-laws.lock beside it, any `*.laws.ts` file outside the
 * projects, or a file the root's `laws` globs pick that declares a law. It reads directory names, and the contents of
 * only those files the `laws` globs match; it skips node_modules, .git, dist and each project, and stops at the first
 * hit.
 */
function rootHasLaws(root: string, projects: string[]): boolean {
  if (existsSync(join(root, 'tsc-laws.lock'))) return true;
  const inProject = new Set(projects);
  const custom = customLawFile(root, readConfig(root).laws);
  const walk = (path: string): boolean => {
    for (const entry of readdirSync(path === '' ? root : join(root, path), { withFileTypes: true })) {
      if (
        entry.isFile() &&
        (entry.name.endsWith('.laws.ts') || custom(path === '' ? entry.name : `${path}/${entry.name}`))
      )
        return true;
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

/** What changed against a base ref. */
export interface ChangeSet {
  /** The merge-base of the ref and HEAD that the working tree was compared with. */
  base: string;
  /** Changed files relative to the directory asked about, with `/` separators; deleted files are included. */
  files: string[];
}

function git(cwd: string, args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.error !== undefined) throw new Error(`git: ${run.error.message}`);
  if (run.status !== 0) throw new Error(run.stderr.trim() || `git ${args[0]} failed`);
  return run.stdout;
}

/**
 * What changed since `git merge-base <ref> HEAD`: committed, staged, unstaged and untracked files under `cwd` (ignored
 * files do not count, nor do `.tslaws` and `node_modules`).
 */
export function changedSince(cwd: string, ref: string): ChangeSet {
  if (ref === '' || ref.startsWith('-'))
    throw new Error('--changed needs a base ref, for example --changed origin/main');
  let base: string;
  try {
    base = git(cwd, ['merge-base', ref, 'HEAD']).trim();
  } catch (error) {
    throw new Error(`--changed ${ref}: ${(error as Error).message} (in CI, fetch the full history: fetch-depth: 0)`);
  }
  const split = (out: string): string[] => out.split('\0').filter((file) => file !== '');
  const tracked = split(git(cwd, ['diff', '--name-only', '-z', '--no-renames', '--relative', base]));
  const untracked = split(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']));
  const files = [...new Set([...tracked, ...untracked].map((file) => file.replaceAll('\\', '/')))]
    .filter((file) => !file.split('/').some((segment) => segment === '.tslaws' || segment === 'node_modules'))
    .sort();
  return { base, files };
}

/** Files at the root that every project depends on: workspace, package and lock files, and the base tsconfigs. */
const rootConfig =
  /^(tslaws\.json|package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|tsconfig(\..+)?\.json)$/;

/** The files `extends` reaches from the tslaws.json in `dir`, as paths relative to `root`. */
function extendsChain(root: string, dir: string): string[] {
  const found: string[] = [];
  let file = join(dir, 'tslaws.json');
  for (let depth = 0; depth < 32; depth += 1) {
    let parent: unknown;
    try {
      parent = (readJson(file) as { extends?: unknown } | null)?.extends;
    } catch {
      return found;
    }
    if (typeof parent !== 'string' || parent === '') return found;
    file = resolve(dirname(file), parent);
    found.push(normalise(relative(root, file)));
  }
  return found;
}

interface Manifest {
  name?: string;
  deps: string[];
}

function manifestIn(dir: string): Manifest | undefined {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return undefined;
  try {
    const json = readJson(file) as Record<string, unknown> | null;
    const deps = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((key) => {
      const table = json?.[key];
      return typeof table === 'object' && table !== null ? Object.keys(table) : [];
    });
    return { name: typeof json?.name === 'string' ? json.name : undefined, deps };
  } catch {
    return undefined;
  }
}

/** The directory one level up, as a relative POSIX path; '' above the first segment. */
const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/**
 * The dependency edges between the projects and workspace packages of `root`, as `path -> paths it depends on`. Sources:
 * package.json `dependencies`, `devDependencies` and `peerDependencies` that name another workspace package (a project
 * without a package.json uses the nearest one above it); tsconfig `paths` targets that land in another package (a
 * wildcard inside a target, as in `packages/*` + `/src`, counts as every package under it); and a nested package or
 * project, which depends on the one around it.
 */
function dependencyGraph(root: string, projects: Project[]): Map<string, Set<string>> {
  const globs = [workspacesOf(root), pnpmWorkspacesOf(root)].find((list) => list.length > 0) ?? [];
  const packages = globs.length === 0 ? [] : matchingProjects(root, globs, 'package.json');
  const nodes = new Set([...packages, ...projects.map((project) => project.path)]);
  const dirOf = (path: string): string => (path === '' ? root : join(root, path));
  const names = new Map<string, string>();
  for (const node of nodes) {
    const name = manifestIn(dirOf(node))?.name;
    if (name !== undefined) names.set(name, node);
  }
  const nearest = (path: string): string | undefined => {
    for (let at = path; ; at = parentOf(at)) {
      if (nodes.has(at)) return at;
      if (at === '') return undefined;
    }
  };
  const graph = new Map<string, Set<string>>();
  for (const node of nodes) {
    const edges = new Set<string>();
    graph.set(node, edges);
    let manifest = manifestIn(dirOf(node));
    for (let at = parentOf(node); manifest === undefined && node !== '' && at !== ''; at = parentOf(at))
      manifest = manifestIn(dirOf(at));
    for (const dep of manifest?.deps ?? []) {
      const target = names.get(dep);
      if (target !== undefined && target !== node) edges.add(target);
    }
    const outer = node === '' ? undefined : nearest(parentOf(node));
    if (outer !== undefined && outer !== '') edges.add(outer);
  }
  for (const project of projects) {
    let paths: Record<string, string[]> | undefined;
    try {
      paths = readResolution(project.dir)?.options.paths as Record<string, string[]> | undefined;
    } catch {
      continue;
    }
    const edges = graph.get(project.path)!;
    for (const target of Object.values(paths ?? {}).flat()) {
      const [fixed = ''] = target.split('*', 1);
      const at = normalise(relative(root, fixed).replaceAll('\\', '/'));
      if (at === '..' || at.startsWith('../') || /^[a-z]:/i.test(at)) continue;
      if (!target.includes('*')) {
        const hit = nearest(at);
        if (hit !== undefined && hit !== '') edges.add(hit);
        continue;
      }
      const dir = fixed.endsWith('/') ? at : parentOf(at);
      const inside = nearest(dir);
      if (inside !== undefined && inside !== '') edges.add(inside);
      for (const node of nodes) if (node !== '' && (dir === '' || node.startsWith(`${dir}/`))) edges.add(node);
    }
    edges.delete(project.path);
  }
  return graph;
}

export interface Affected {
  project: Project;
  /** Why it runs, in a few words. */
  reason: string;
}

/**
 * The projects of `root` that changed files (paths relative to `root`) can affect: the project that holds each file (the
 * nearest enclosing one) and every project that depends on one, however indirectly. A change to a root config file or
 * to a file a tslaws.json extends selects every project.
 */
export function affectedProjects(root: string, files: string[]): Affected[] {
  const dir = resolve(root);
  const projects = discoverProjects(dir);
  const every = (reason: string): Affected[] => projects.map((project) => ({ project, reason }));
  const bases = new Map<string, string>();
  for (const project of projects)
    for (const base of extendsChain(dir, project.dir)) bases.set(base, project.path === '' ? '.' : project.path);
  for (const file of files) {
    if (!file.includes('/') && rootConfig.test(file)) return every(`${file} changed (root config)`);
    const user = bases.get(file);
    if (user !== undefined) return every(`${file} changed (extended by ${user})`);
  }
  const graph = dependencyGraph(dir, projects);
  const why = new Map<string, string>();
  const direct = new Set<string>();
  const queue: string[] = [];
  for (const file of files) {
    for (let at = parentOf(file); ; at = parentOf(at)) {
      if (graph.has(at)) {
        if (!why.has(at)) {
          why.set(at, `contains changed file ${file}`);
          direct.add(at);
          queue.push(at);
        }
        break;
      }
      if (at === '') break;
    }
  }
  const dependents = new Map<string, string[]>();
  for (const [node, edges] of graph)
    for (const edge of edges) dependents.set(edge, [...(dependents.get(edge) ?? []), node]);
  for (const node of queue) {
    for (const next of dependents.get(node) ?? []) {
      if (why.has(next)) continue;
      why.set(
        next,
        `depends on ${node === '' ? '.' : node}, which ${direct.has(node) ? 'has changes' : 'is affected'}`,
      );
      queue.push(next);
    }
  }
  return projects.flatMap((project) => {
    const reason = why.get(project.path);
    return reason === undefined ? [] : [{ project, reason }];
  });
}
