// `tslaws migrate <from> [files...] [--write] [--out DIR]`: reads test files of another framework and writes the same
// tests as laws. A dry run says what would happen; `--write` creates files that do not exist and never replaces one.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { convertTestFile } from './convert.ts';
import { frameworkModules, isSourceName, sources, type SourceName } from './framework.ts';
import { renderReport, type FileResult, type MigrateReport } from './report.ts';

export interface MigrateOptions {
  cwd: string;
  from: SourceName;
  /** Test files or directories; empty means every test file under `cwd`. */
  files: string[];
  write: boolean;
  /** A directory to write the laws under instead of next to the sources. */
  out?: string;
}

const ignoredDirs = new Set(['node_modules', '.tslaws', '.git', 'dist', 'build', 'coverage']);
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const sourceFile = /\.[cm]?[jt]sx?$/;

const slash = (path: string): string => path.replace(/\\/g, '/');

function walk(dir: string, into: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    if (ignoredDirs.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, into);
    else if (testFile.test(entry) && !entry.endsWith('.d.ts')) into.push(full);
  }
}

/** The framework modules a file imports or requires. */
function modulesOf(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)(['"])([^'"]+)\1/g))
    if (frameworkModules[match[2]!] !== undefined) found.add(match[2]!);
  return found;
}

/** Whether a file found by searching (not named by the person) belongs to the framework being migrated. */
function belongs(text: string, from: SourceName): boolean {
  const modules = [...modulesOf(text)];
  if (from === 'fast-check')
    return modules.some((m) => frameworkModules[m] === 'fast-check' || m.startsWith('@fast-check/'));
  if (from === 'playwright') return modules.includes('@playwright/test');
  const own = modules.filter((m) => frameworkModules[m] === from);
  if (own.length > 0) return true;
  // No framework import at all: the file relies on globals, which vitest, jest and rstest provide.
  return (
    !modules.some((m) => frameworkModules[m] !== 'fast-check') &&
    (from === 'vitest' || from === 'jest' || from === 'rstest')
  );
}

/** `src/a.test.ts` to `a`, the name the laws file is built on. */
function baseOf(file: string): string {
  const name = basename(file);
  const stripped = name.replace(/\.(?:test|spec)(?=\.[cm]?[jt]sx?$)/, '').replace(/\.[cm]?[jt]sx?$/, '');
  return stripped === '' ? name : stripped;
}

export function targetFor(file: string, options: Pick<MigrateOptions, 'cwd' | 'from' | 'out'>): string {
  const suffix = options.from === 'playwright' ? '.browser.laws.ts' : '.laws.ts';
  const name = `${baseOf(file)}${suffix}`;
  const dir = dirname(resolve(options.cwd, file));
  if (options.out === undefined) return join(dir, name);
  const mirrored = relative(options.cwd, dir);
  return join(resolve(options.cwd, options.out), mirrored.startsWith('..') ? '' : mirrored, name);
}

/** How a module specifier written in the source reads from the file the laws are written to. */
function rewriter(sourceDir: string, targetDir: string): (specifier: string) => string {
  return (specifier) => {
    if (sourceDir === targetDir) return specifier;
    let rel = slash(relative(targetDir, resolve(sourceDir, specifier)));
    if (rel === '') rel = '.';
    return rel.startsWith('.') ? rel : `./${rel}`;
  };
}

export function migrate(options: MigrateOptions): MigrateReport {
  const { cwd, from } = options;
  const found: string[] = [];
  const explicit = new Set<string>();
  for (const file of options.files.length > 0 ? options.files : ['.']) {
    const full = resolve(cwd, file);
    if (!existsSync(full)) throw new Error(`no such file: ${file}`);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (sourceFile.test(full)) {
      found.push(full);
      explicit.add(full);
    } else throw new Error(`not a TypeScript or JavaScript file: ${file}`);
  }
  const files: FileResult[] = [];
  const claimed = new Set<string>();
  for (const full of found) {
    if (/\.laws\.[cm]?[jt]s$/.test(full)) continue;
    const text = readFileSync(full, 'utf8');
    if (!explicit.has(full) && !belongs(text, from)) continue;
    const source = slash(relative(cwd, full));
    const target = targetFor(full, options);
    const converted = convertTestFile({
      path: full,
      text,
      from,
      rewrite: rewriter(dirname(full), dirname(target)),
    });
    for (const entry of converted.entries) entry.file = source;
    const result: FileResult = { source, laws: converted.laws, entries: converted.entries, written: 'none' };
    if (converted.output !== undefined && converted.laws.length > 0) {
      result.target = slash(relative(cwd, target));
      result.output = converted.output;
      if (claimed.has(target)) {
        result.written = 'exists';
        result.entries.push({
          file: source,
          line: 1,
          kind: 'note',
          message: `${result.target} is already the target of another test file in this run; this file is not written`,
        });
      } else if (existsSync(target)) result.written = 'exists';
      else if (options.write) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, converted.output);
        result.written = 'written';
      } else result.written = 'dry-run';
      claimed.add(target);
    }
    files.push(result);
  }
  return { from, write: options.write, files };
}

export const migrateUsage = `tslaws migrate ${sources.join('|')} [files...] [--write] [--out DIR]   convert existing tests into laws (*.laws.ts; Playwright becomes *.browser.laws.ts); a dry run unless --write; never overwrites; the new laws are not in the lock`;

/** The `migrate` command: prints the report. Status 0 when it ran, 2 when the arguments are wrong. */
export function migrateCommand(
  cwd: string,
  from: string | undefined,
  files: string[],
  flags: Map<string, string | true>,
  write: (text: string) => void,
): number {
  if (!isSourceName(from)) {
    write(`tslaws migrate needs the framework to read: one of ${sources.join(', ')}\n`);
    return 2;
  }
  const out = flags.get('out');
  if (out === true || out === '') {
    write('--out needs a directory\n');
    return 2;
  }
  try {
    const report = migrate({ cwd, from, files, write: flags.has('write'), out });
    write(renderReport(report));
    return 0;
  } catch (error) {
    write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
