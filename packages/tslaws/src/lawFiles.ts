// Which files are laws files. Every `*.laws.ts` is one; with a `laws` setting in tslaws.json, so is any file the globs
// match that declares a top-level `export law`. Proposals are separate: they live in `.tslaws/proposals/`, outside the
// tree the lock covers (in-tree `*.proposed.laws.ts` files are the usual proposals and keep working).
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readConfig } from './coverage.ts';
import { globMatcher } from './globs.ts';
import { isProposedLawFile } from './lawNames.ts';
import { parseLawFile } from './promote.ts';

/** Directories no walk enters. */
export const ignoredDirs = new Set(['node_modules', '.tslaws', '.git']);

/** The tool-owned directory proposals live in, relative to the project root. */
export const proposalsDir = '.tslaws/proposals';

const slash = (path: string): string => path.replaceAll('\\', '/');

/** Whether the text declares a law at the top level (cheap test first, then the real scan). */
export function declaresLaw(text: string): boolean {
  return /\bexport\s+(?:async\s+)?law\b/.test(text) && parseLawFile(text).laws.length > 0;
}

function walk(cwd: string, visit: (file: string) => void): void {
  const step = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (ignoredDirs.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) step(full);
      else visit(slash(relative(cwd, full)));
    }
  };
  step(cwd);
}

/** A predicate for files the `laws` globs of tslaws.json pick, which still have to declare a law to count. */
export function customLawFile(
  cwd: string,
  globs: string[] | undefined = readConfig(cwd).laws,
): (file: string) => boolean {
  if (globs === undefined || globs.length === 0) return () => false;
  const matches = globMatcher(globs);
  return (file) => {
    if (!/\.(ts|tsx|mts|cts)$/.test(file) || /\.d\.(ts|mts|cts)$/.test(file) || !matches(file)) return false;
    try {
      return declaresLaw(readFileSync(join(cwd, file), 'utf8'));
    } catch {
      return false;
    }
  };
}

/**
 * The laws files of the tree, project-relative and sorted: `*.laws.ts` plus the files the `laws` globs find. With
 * `proposed`, the in-tree `*.proposed.laws.ts` files instead (the usual proposals; `discoverProposals` finds the optional ones in `.tslaws/proposals`).
 */
export function discoverLaws(cwd: string, proposed = false): string[] {
  const custom = customLawFile(cwd);
  const found: string[] = [];
  walk(cwd, (file) => {
    const name = file.slice(file.lastIndexOf('/') + 1);
    if (name.endsWith('.laws.ts')) {
      if (isProposedLawFile(name) === proposed) found.push(file);
    } else if (!proposed && custom(file)) found.push(file);
  });
  return found.sort();
}

/** The files in `.tslaws/proposals/` (any name ending `.ts`), project-relative and sorted. */
export function discoverProposals(cwd: string): string[] {
  const dir = join(cwd, proposalsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(
      (entry) =>
        /\.(ts|mts|cts)$/.test(entry) && !/\.d\.(ts|mts|cts)$/.test(entry) && lstatSync(join(dir, entry)).isFile(),
    )
    .map((entry) => `${proposalsDir}/${entry}`)
    .sort();
}

/** Whether a project-relative path is a laws file of the tree (not a proposal). */
export function isLawsFile(cwd: string, file: string): boolean {
  const name = slash(file);
  return name.endsWith('.laws.ts') || customLawFile(cwd)(name);
}

/** Whether a project-relative path is inside the proposals directory. */
export function inProposals(file: string): boolean {
  return slash(file).startsWith(`${proposalsDir}/`);
}

/** Whether a (possibly new) path is a name a laws file may have: `*.laws.ts`, or a path a `laws` glob picks. */
export function namesLawsFile(cwd: string, file: string): boolean {
  const name = slash(file);
  if (isProposedLawFile(name)) return false;
  if (name.endsWith('.laws.ts')) return true;
  const globs = readConfig(cwd).laws;
  return globs !== undefined && /\.(ts|mts|cts)$/.test(name) && globMatcher(globs)(name);
}
