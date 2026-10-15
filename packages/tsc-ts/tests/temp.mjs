// Temporary directories, deleted when the process exits, and sources compiled into them.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const dirs = [];
process.on('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * A temporary directory for sources compiled from src/, which finds packages (such as
 * `@scriptc/threads`) in the repository's node_modules as dist/ does.
 */
export function compiledDir(prefix) {
  const dir = tempDir(prefix);
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

/**
 * Compiles `entries` (paths below src/) with tsc into a new compiledDir laid out like src/, and returns the directory.
 * When TSC_TS_TEST_BUILD names a directory holding all of src/ compiled with the same options
 * (scripts/ci/compile-tests.mjs), copies that directory instead.
 */
export function compileSources(prefix, entries) {
  const dir = compiledDir(prefix);
  if (process.env.TSC_TS_TEST_BUILD) {
    cpSync(process.env.TSC_TS_TEST_BUILD, dir, { recursive: true });
    return dir;
  }
  const src = join(root, 'packages/tsc-ts/src');
  execFileSync(
    join(root, 'node_modules/.bin/tsc'),
    [...compileOptions, '--outDir', dir, '--rootDir', src, ...entries.map((entry) => join(src, entry))],
    { stdio: 'inherit', cwd: root },
  );
  return dir;
}

/** The tsc options test builds use. */
export const compileOptions = [
  '--target',
  'es2024',
  '--module',
  'nodenext',
  '--moduleResolution',
  'nodenext',
  '--strict',
  '--skipLibCheck',
  '--types',
  'node',
];
