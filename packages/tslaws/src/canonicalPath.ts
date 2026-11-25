import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Resolves `dir` to its canonical Windows filesystem casing without following symlinks that point elsewhere.
 * On Windows, VS Code (`Uri.fsPath`) and some shells pass lowercase drive letters (`d:\...`) while Node's
 * permission model, symlink targets and `tsc-laws` use canonical casing (`D:\...`).
 */
export function canonicalCwd(dir: string): string {
  if (process.platform !== 'win32') return dir;
  const resolved = resolve(dir);
  try {
    const real = realpathSync.native(resolved);
    if (real.toLowerCase() === resolved.toLowerCase()) return real;
  } catch {
    // Fall back to uppercasing the drive letter when the path does not exist yet.
  }
  return resolved.replace(/^[a-z](?=:)/, (drive) => drive.toUpperCase());
}
