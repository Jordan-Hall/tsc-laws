// The server's file system: the disk, with operations the client asked to
// handle (`--callbacks`) forwarded to it.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';

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

export interface DirectoryEntries {
  files: string[];
  directories: string[];
}

export interface FileStat {
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
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

// Reads a text file, decoding UTF-16 byte order marks and dropping a UTF-8 one.
function diskReadFile(path: string): string | undefined {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    return undefined;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be(bytes.subarray(2));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  return new TextDecoder().decode(bytes);
}

function utf16be(bytes: Uint8Array): string {
  const swapped = new Uint8Array(bytes.length & ~1);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1];
    swapped[i + 1] = bytes[i];
  }
  return new TextDecoder('utf-16le').decode(swapped);
}

function diskStat(path: string): FileStat | undefined {
  try {
    const s = statSync(path);
    return { isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}

// Lists a directory, following symbolic links and skipping broken ones.
function diskEntries(path: string): DirectoryEntries {
  const files: string[] = [];
  const directories: string[] = [];
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return { files, directories };
  }
  for (const name of names.sort()) {
    const stat = diskStat(path + '/' + name);
    if (stat === undefined) continue;
    if (stat.isDirectory) directories.push(name);
    else files.push(name);
  }
  return { files, directories };
}

function diskRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
