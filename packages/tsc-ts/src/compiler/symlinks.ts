// Symlinked directories a program found through module resolution, such as packages linked by
// pnpm or workspaces, so module specifiers can name a file by the path it was imported through.
import {
  ensureTrailingDirectorySeparator,
  getCanonicalFileName,
  getNormalizedAbsolutePath,
  getPathComponents,
  getPathFromPathComponents,
  toPath,
} from './path.js';

/** The real directory of a symlink, with a trailing `/`: as `realpath` spells it, and as a path. */
export class KnownDirectoryLink {
  constructor(
    readonly real: string,
    readonly realPath: string,
  ) {}
}

export class KnownSymlinks {
  /** Real directories by symlink path; keys have a trailing `/`. */
  private readonly directories = new Map<string, KnownDirectoryLink>();
  /** Symlinks, as spelled, by real directory path; keys have a trailing `/`. */
  private readonly directoriesByRealpath = new Map<string, Set<string>>();

  constructor(
    readonly currentDirectory: string,
    readonly useCaseSensitiveFileNames: boolean,
  ) {}

  hasDirectory(symlinkPath: string): boolean {
    return this.directories.has(ensureTrailingDirectorySeparator(symlinkPath));
  }

  /** The symlinks to the real directory `realPath`, which has a trailing `/`. */
  getSymlinksOfDirectory(realPath: string): ReadonlySet<string> | undefined {
    return this.directoriesByRealpath.get(realPath);
  }

  setDirectory(symlink: string, symlinkPath: string, real: KnownDirectoryLink): void {
    if (!this.directories.has(symlinkPath)) {
      let symlinks = this.directoriesByRealpath.get(real.realPath);
      if (symlinks === undefined) {
        symlinks = new Set<string>();
        this.directoriesByRealpath.set(real.realPath, symlinks);
      }
      symlinks.add(symlink);
    }
    this.directories.set(symlinkPath, real);
  }

  /** Records the directory symlink a resolution through `originalPath` to `resolvedFileName` implies. */
  processResolution(originalPath: string, resolvedFileName: string): void {
    if (originalPath === '' || resolvedFileName === '') return;
    const common = this.guessDirectorySymlink(resolvedFileName, originalPath);
    if (common === undefined) return;
    const symlinkPath = toPath(common.original, this.currentDirectory, this.useCaseSensitiveFileNames);
    if (containsIgnoredPath(symlinkPath)) return;
    this.setDirectory(
      common.original,
      ensureTrailingDirectorySeparator(symlinkPath),
      new KnownDirectoryLink(
        ensureTrailingDirectorySeparator(common.resolved),
        ensureTrailingDirectorySeparator(
          toPath(common.resolved, this.currentDirectory, this.useCaseSensitiveFileNames),
        ),
      ),
    );
  }

  /** The longest directories of `resolved` and `original` whose remaining paths are equal. */
  private guessDirectorySymlink(
    resolved: string,
    original: string,
  ): { readonly resolved: string; readonly original: string } | undefined {
    const a = getPathComponents(getNormalizedAbsolutePath(resolved, this.currentDirectory));
    const b = getPathComponents(getNormalizedAbsolutePath(original, this.currentDirectory));
    let aLength = a.length;
    let bLength = b.length;
    while (
      aLength >= 2 &&
      bLength >= 2 &&
      !this.isNodeModulesOrScopedPackageDirectory(a[aLength - 2]!) &&
      !this.isNodeModulesOrScopedPackageDirectory(b[bLength - 2]!) &&
      getCanonicalFileName(a[aLength - 1]!, this.useCaseSensitiveFileNames) ===
        getCanonicalFileName(b[bLength - 1]!, this.useCaseSensitiveFileNames)
    ) {
      aLength--;
      bLength--;
    }
    if (aLength === a.length) return undefined;
    return {
      resolved: getPathFromPathComponents(a.slice(0, aLength)),
      original: getPathFromPathComponents(b.slice(0, bLength)),
    };
  }

  private isNodeModulesOrScopedPackageDirectory(name: string): boolean {
    return (
      name !== '' &&
      (getCanonicalFileName(name, this.useCaseSensitiveFileNames) === 'node_modules' || name.startsWith('@'))
    );
  }
}

/** Paths inside `node_modules/.*` (such as pnpm's store), `.git` or editor lock files. */
export function containsIgnoredPath(path: string): boolean {
  return path.includes('/node_modules/.') || path.includes('/.git') || path.includes('.#');
}
