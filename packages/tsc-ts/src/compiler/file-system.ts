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
}

/** Caches every query of another file system; for a single compilation, where files don't change. */
export class CachedFileSystem extends FileSystem {
  private readonly files = new Map<string, boolean>();
  private readonly directories = new Map<string, boolean>();
  private readonly entries = new Map<string, DirectoryEntries>();
  private readonly realpaths = new Map<string, string>();

  constructor(private readonly inner: FileSystem) {
    super(inner.useCaseSensitiveFileNames);
  }

  fileExists(path: string): boolean {
    const key = this.key(path);
    let exists = this.files.get(key);
    if (exists === undefined) {
      exists = this.inner.fileExists(path);
      this.files.set(key, exists);
    }
    return exists;
  }

  directoryExists(path: string): boolean {
    const key = this.key(path);
    let exists = this.directories.get(key);
    if (exists === undefined) {
      exists = this.inner.directoryExists(path);
      this.directories.set(key, exists);
    }
    return exists;
  }

  readFile(path: string): string | undefined {
    return this.inner.readFile(path);
  }

  getAccessibleEntries(path: string): DirectoryEntries {
    const key = this.key(path);
    let entries = this.entries.get(key);
    if (entries === undefined) {
      entries = this.inner.getAccessibleEntries(path);
      this.entries.set(key, entries);
    }
    return entries;
  }

  realpath(path: string): string {
    const key = this.key(path);
    let real = this.realpaths.get(key);
    if (real === undefined) {
      real = this.inner.realpath(path);
      this.realpaths.set(key, real);
    }
    return real;
  }

  private key(path: string): string {
    return getCanonicalFileName(path, this.useCaseSensitiveFileNames);
  }
}
