// The file system a program of tsc-ts's public API reads through its host.

import { diskEntries, diskReadFile, diskRealpath, diskStat } from './disk.js';
import { DirectoryEntries, FileSystem } from '../compiler/file-system.js';
import type { ProgramHost } from './types.js';

/**
 * The host's answers, and the disk's where a callback is missing or answers undefined, as `tsc-ts --api`
 * reads through its client's callbacks. `readFile` answering null means the file doesn't exist.
 */
export class HostFileSystem extends FileSystem {
  constructor(private readonly host: ProgramHost) {
    super(host.useCaseSensitiveFileNames());
  }

  fileExists(path: string): boolean {
    const answer = this.host.fileExists?.(path);
    return answer ?? diskStat(path)?.isDirectory === false;
  }

  directoryExists(path: string): boolean {
    const answer = this.host.directoryExists?.(path);
    return answer ?? diskStat(path)?.isDirectory === true;
  }

  readFile(path: string): string | undefined {
    const answer = this.host.readFile?.(path);
    if (answer === null) return undefined;
    return answer ?? diskReadFile(path);
  }

  getAccessibleEntries(path: string): DirectoryEntries {
    const entries = this.host.getAccessibleEntries?.(path) ?? diskEntries(path);
    return new DirectoryEntries(entries.files.slice(), entries.directories.slice(), undefined);
  }

  realpath(path: string): string {
    return this.host.realpath?.(path) ?? diskRealpath(path);
  }
}
