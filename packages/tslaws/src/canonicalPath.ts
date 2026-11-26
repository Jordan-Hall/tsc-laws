import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/** `path` split on either slash. Empty pieces stay, so a UNC prefix round-trips. */
const pieces = (path: string): string[] => path.split(/[\\/]/);

/** The slash `path` is written with. A path that uses both keeps the backslash. */
const divider = (path: string): string => (path.includes('\\') ? '\\' : '/');

/**
 * Drops the `\\?\` prefix Node's native realpath can return on Windows. The permission model does not treat
 * `\\?\D:\repo` as `D:\repo`, so a grant written with the prefix does not cover the path a process opens.
 */
export function plainPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`;
  if (path.startsWith('\\\\?\\')) return path.slice(4);
  return path;
}

/**
 * Resolves `dir` to its canonical Windows filesystem casing without following symlinks that point elsewhere.
 * On Windows, VS Code (`Uri.fsPath`) and some shells pass lowercase drive letters (`d:\...`) while Node's
 * permission model, symlink targets and `tsc-laws` use canonical casing (`D:\...`).
 */
export function canonicalCwd(dir: string): string {
  if (process.platform !== 'win32') return dir;
  const resolved = plainPath(resolve(dir));
  try {
    const real = plainPath(realpathSync.native(resolved));
    if (real.toLowerCase() === resolved.toLowerCase()) return real;
  } catch {
    // Fall back to uppercasing the drive letter when the path does not exist yet.
  }
  return resolved.replace(/^[a-z](?=:)/, (drive) => drive.toUpperCase());
}

/**
 * The first prefixes of `opened` and `actual` that are not the same directory name. Windows reports
 * one directory as an 8.3 name and a long name (`C:\Users\RUNNER~1` and `C:\Users\runneradmin`), and a
 * junction has a different name from its target. A path under either prefix is the other path with
 * that prefix swapped. Undefined when the two names differ only by case, or not at all: case is
 * already one path to the permission model.
 */
export function spellingRoots(opened: string, actual: string): { opened: string; actual: string } | undefined {
  const left = pieces(opened);
  const right = pieces(actual);
  let index = 0;
  while (index < left.length && index < right.length && left[index]!.toLowerCase() === right[index]!.toLowerCase())
    index += 1;
  if (index >= left.length || index >= right.length) return undefined;
  const mark = divider(opened);
  return { opened: left.slice(0, index + 1).join(mark), actual: right.slice(0, index + 1).join(mark) };
}

/**
 * `path` with a prefix of `from` replaced by `to`. Comparison is by directory name, so `RUNNER~1`
 * does not match `RUNNER~10`, and the result keeps the slashes `path` was written with. `path`
 * itself when it does not start at `from`.
 */
export function retargetPath(path: string, from: string, to: string): string {
  if (from === '') return path;
  const file = pieces(path);
  const root = pieces(from);
  if (file.length < root.length) return path;
  for (let index = 0; index < root.length; index += 1)
    if (file[index]!.toLowerCase() !== root[index]!.toLowerCase()) return path;
  return [...pieces(to), ...file.slice(root.length)].join(divider(path));
}

/**
 * `path` written the way `like` is written, when `like` and `unlike` are one directory under two
 * names. `path` itself when they are the same name, or when `path` is not under `unlike`.
 */
export function ontoSpelling(path: string, like: string, unlike: string): string {
  const roots = spellingRoots(like, unlike);
  if (roots === undefined) return path;
  return retargetPath(path, roots.actual, roots.opened);
}
