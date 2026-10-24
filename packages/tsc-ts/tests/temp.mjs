// Temporary directories, deleted when the process exits, and sources compiled into them.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
 * The path to run for a native binary built without an extension (go build -o dist/name). Windows only runs
 * files that end in .exe, so there it returns a copy named *.exe, kept in a cache directory keyed by size and
 * modification time. Elsewhere, or when the binary is missing, returns `path` unchanged.
 */
export function nativeExe(path) {
  if (process.platform !== 'win32' || path.endsWith('.exe') || !existsSync(path)) return path;
  if (existsSync(path + '.exe')) return path + '.exe';
  const { size, mtimeMs } = statSync(path);
  const cache = join(tmpdir(), 'tsc-ts-exe-cache');
  const copy = join(cache, `${basename(path)}-${size}-${Math.trunc(mtimeMs)}.exe`);
  if (!existsSync(copy)) {
    mkdirSync(cache, { recursive: true });
    const partial = copy + '.' + process.pid + '.tmp';
    copyFileSync(path, partial);
    renameSync(partial, copy);
  }
  return copy;
}

/**
 * A temporary directory for sources compiled from src/, which finds packages (such as
 * `@scriptc/threads`) in the repository's node_modules as dist/ does.
 */
export function compiledDir(prefix) {
  const dir = tempDir(prefix);
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
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
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      ...compileOptions,
      '--outDir',
      dir,
      '--rootDir',
      src,
      ...entries.map((entry) => join(src, entry)),
    ],
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
