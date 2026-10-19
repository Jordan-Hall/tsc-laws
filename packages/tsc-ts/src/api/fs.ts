// The server's file system: the disk, with operations the client asked to
// handle (`--callbacks`) forwarded to it.
import {
  type DirectoryEntries,
  diskEntries,
  diskReadFile,
  diskRealpath,
  diskStat,
  type FileStat,
} from '../library/disk.js';
import type { Connection } from './connection.js';

export type Callback = 'readFile' | 'fileExists' | 'directoryExists' | 'getAccessibleEntries' | 'realpath';

export function isCallback(name: string): name is Callback {
  return (
    name === 'readFile' ||
    name === 'fileExists' ||
    name === 'directoryExists' ||
    name === 'getAccessibleEntries' ||
    name === 'realpath'
  );
}

interface ReadFileResult {
  content: string | null;
}

interface EntriesResult {
  files: string[] | null;
  directories: string[] | null;
}

export class ClientFileSystem {
  private connection: Connection | undefined;

  constructor(private readonly callbacks: Set<Callback>) {}

  connect(connection: Connection): void {
    this.connection = connection;
  }

  readFile(path: string): string | undefined {
    const reply = this.call('readFile', path);
    if (reply !== undefined) {
      const result = JSON.parse(reply) as ReadFileResult;
      return result.content ?? undefined;
    }
    return diskReadFile(path);
  }

  fileExists(path: string): boolean {
    const reply = this.call('fileExists', path);
    if (reply !== undefined) return reply === 'true';
    return diskStat(path)?.isDirectory === false;
  }

  directoryExists(path: string): boolean {
    const reply = this.call('directoryExists', path);
    if (reply !== undefined) return reply === 'true';
    return diskStat(path)?.isDirectory === true;
  }

  getAccessibleEntries(path: string): DirectoryEntries {
    const reply = this.call('getAccessibleEntries', path);
    if (reply !== undefined) {
      const result = JSON.parse(reply) as EntriesResult;
      return { files: result.files ?? [], directories: result.directories ?? [] };
    }
    return diskEntries(path);
  }

  realpath(path: string): string {
    const reply = this.call('realpath', path);
    if (reply !== undefined) return JSON.parse(reply) as string;
    return diskRealpath(path);
  }

  stat(path: string): FileStat | undefined {
    return diskStat(path);
  }

  // The client's JSON reply, or undefined to use the disk.
  private call(name: Callback, path: string): string | undefined {
    if (!this.callbacks.has(name)) return undefined;
    if (this.connection === undefined) throw new Error(`${name} called before the connection was set`);
    const reply = this.connection.call(name, JSON.stringify(path));
    return reply === '' || reply === 'null' ? undefined : reply;
  }
}
