/**
 * The file system the compiler reads, and a caching layer over it.
 */
import { getCanonicalFileName } from './path.js';

/** The files and directories directly inside a directory, sorted by name. */
export class DirectoryEntries {
  constructor(
    readonly files: readonly string[],
    readonly directories: readonly string[],
    /** Entries reached through a symlink; `undefined` if the file system doesn't track symlinks. */
    readonly symlinks: ReadonlySet<string> | undefined,
  ) {}
}

export const emptyDirectoryEntries = new DirectoryEntries([], [], undefined);

/** File system access. Paths are absolute and use `/`. */
export abstract class FileSystem {
  constructor(readonly useCaseSensitiveFileNames: boolean) {}

  abstract fileExists(path: string): boolean;
  abstract directoryExists(path: string): boolean;
  /** Returns `undefined` if the file can't be read. */
  abstract readFile(path: string): string | undefined;
  /** Entries of a readable directory; empty if it can't be read. */
  abstract getAccessibleEntries(path: string): DirectoryEntries;
  /** The path with symlinks resolved, or `path` itself if it does not exist. */
  abstract realpath(path: string): string;

  /**
   * Called before the file system is shared with other threads, which makes it immutable
   * (parallel-check.ts): a file system that caches keeps caching on each thread from then on.
   */
  prepareForSharing(): void {}
}

/** The answers a CachedFileSystem keeps. */
class FileSystemCaches {
  readonly files = new Map<string, boolean>();
  readonly directories = new Map<string, boolean>();
  readonly entries = new Map<string, DirectoryEntries>();
  readonly realpaths = new Map<string, string>();
}

// What each file system shared with other threads (and so immutable) did not know yet when it was
// shared, as this thread learned it.
const threadCaches = new Map<CachedFileSystem, FileSystemCaches>();

/**
 * Caches every query of another file system; for a single compilation, where files don't change.
 * Once shared with other threads (`prepareForSharing`), what was cached until then is read by every
 * thread, and each thread caches new answers in tables of its own.
 */
export class CachedFileSystem extends FileSystem {
  private readonly caches = new FileSystemCaches();
  private shared = false;

  constructor(private readonly inner: FileSystem) {
    super(inner.useCaseSensitiveFileNames);
  }

  prepareForSharing(): void {
    this.shared = true;
  }

  /** Where new answers go: this file system's caches, or once it is shared, this thread's. */
  private ownCaches(): FileSystemCaches {
    if (!this.shared) return this.caches;
    let caches = threadCaches.get(this);
    if (caches === undefined) {
      caches = new FileSystemCaches();
      threadCaches.set(this, caches);
    }
    return caches;
  }

  fileExists(path: string): boolean {
    const key = this.key(path);
    let exists = this.caches.files.get(key);
    if (exists !== undefined) return exists;
    const own = this.ownCaches();
    exists = own.files.get(key);
    if (exists === undefined) {
      exists = this.inner.fileExists(path);
      own.files.set(key, exists);
    }
    return exists;
  }

  directoryExists(path: string): boolean {
    const key = this.key(path);
    let exists = this.caches.directories.get(key);
    if (exists !== undefined) return exists;
    const own = this.ownCaches();
    exists = own.directories.get(key);
    if (exists === undefined) {
      exists = this.inner.directoryExists(path);
      own.directories.set(key, exists);
    }
    return exists;
  }

  readFile(path: string): string | undefined {
    return this.inner.readFile(path);
  }

  getAccessibleEntries(path: string): DirectoryEntries {
    const key = this.key(path);
    let entries = this.caches.entries.get(key);
    if (entries !== undefined) return entries;
    const own = this.ownCaches();
    entries = own.entries.get(key);
    if (entries === undefined) {
      entries = this.inner.getAccessibleEntries(path);
      own.entries.set(key, entries);
    }
    return entries;
  }

  realpath(path: string): string {
    const key = this.key(path);
    let real = this.caches.realpaths.get(key);
    if (real !== undefined) return real;
    const own = this.ownCaches();
    real = own.realpaths.get(key);
    if (real === undefined) {
      real = this.inner.realpath(path);
      own.realpaths.set(key, real);
    }
    return real;
  }

  private key(path: string): string {
    return getCanonicalFileName(path, this.useCaseSensitiveFileNames);
  }
}
