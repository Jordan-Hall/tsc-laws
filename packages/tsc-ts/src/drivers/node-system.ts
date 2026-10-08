// The tsc command line on the disk, for `tsc-ts` and the cli driver.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { DirectoryEntries } from '../compiler/file-system.js';
import { normalizePath } from '../compiler/path.js';
import { ExitStatus, System, executeCommandLine } from '../compiler/tsc-cli.js';
import { compile } from '../compiler/tsc-compile.js';

const bundledPrefix = 'bundled:///libs/';

class NodeSystem extends System {
  constructor(
    currentDirectory: string,
    writeOutputIsTTY: boolean,
    terminalWidth: number,
    defaultLibraryPath: string,
    /** The directory `bundled:///libs/` maps to, or `''`. */
    private readonly bundledLibs: string,
  ) {
    super(currentDirectory, writeOutputIsTTY, terminalWidth, true, defaultLibraryPath);
  }

  getEnvironmentVariable(name: string): string {
    return process.env[name] ?? '';
  }

  write(text: string): void {
    // A pipe may be non-blocking (EAGAIN): retry a while until everything is written.
    const bytes = Buffer.from(text);
    let offset = 0;
    let failures = 0;
    while (offset < bytes.length) {
      try {
        offset += writeSync(1, bytes, offset);
        failures = 0;
      } catch {
        if (++failures > 100000) throw new Error('cannot write to stdout');
      }
    }
  }

  private toOsPath(path: string): string {
    if (this.bundledLibs !== '' && path.startsWith(bundledPrefix)) {
      return this.bundledLibs + '/' + path.slice(bundledPrefix.length);
    }
    return path;
  }

  readFile(path: string): string | undefined {
    try {
      return readFileSync(this.toOsPath(path), 'utf8');
    } catch {
      return undefined;
    }
  }

  writeFile(path: string, text: string): boolean {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      return true;
    } catch {
      return false;
    }
  }

  fileExists(path: string): boolean {
    try {
      return statSync(this.toOsPath(path)).isFile();
    } catch {
      return false;
    }
  }

  directoryExists(path: string): boolean {
    try {
      return statSync(this.toOsPath(path)).isDirectory();
    } catch {
      return false;
    }
  }

  getAccessibleEntries(path: string): DirectoryEntries {
    const files: string[] = [];
    const directories: string[] = [];
    const symlinks = new Set<string>();
    let entries;
    try {
      entries = readdirSync(this.toOsPath(path), { withFileTypes: true });
    } catch {
      return new DirectoryEntries(files, directories, symlinks);
    }
    const names = entries.map((entry) => entry.name).sort(compareUtf8);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    for (const name of names) {
      const entry = byName.get(name);
      if (entry === undefined) continue;
      if (entry.isDirectory()) directories.push(name);
      else if (entry.isFile()) files.push(name);
      else if (entry.isSymbolicLink()) {
        try {
          const stat = statSync(this.toOsPath(path) + '/' + name);
          if (stat.isDirectory()) directories.push(name);
          else if (stat.isFile()) files.push(name);
          else continue;
          symlinks.add(name);
        } catch {
          // A broken link.
        }
      }
    }
    return new DirectoryEntries(files, directories, symlinks);
  }

  realpath(path: string): string {
    try {
      return normalizePath(realpathSync(path));
    } catch {
      return path;
    }
  }
}

/** Orders names by UTF-8 bytes, as Go's directory listing does. */
function compareUtf8(a: string, b: string): number {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return Buffer.compare(x, y);
}

/** Columns of the terminal, from `stty` since there's no portable API for it. */
function terminalWidth(): number {
  const result = spawnSync('stty', ['size'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  if (result.status !== 0) return 0;
  const columns = Number(result.stdout.trim().split(' ')[1]);
  return Number.isInteger(columns) ? columns : 0;
}

/**
 * The system of a `tsc` run in the current directory. Lib files are read from `libraryPath`;
 * `bundled:///libs/` maps to `bundledLibs` when it isn't `''`.
 */
export function createNodeSystem(libraryPath: string, bundledLibs: string): System {
  const isTTY = process.stdout.isTTY === true;
  return new NodeSystem(
    normalizePath(process.cwd()),
    isTTY,
    isTTY ? terminalWidth() : 0,
    normalizePath(libraryPath),
    bundledLibs,
  );
}

/** Runs the tsc command line `args` and returns the exit status. */
export function runTsc(args: readonly string[], libraryPath: string): number {
  const sys = createNodeSystem(libraryPath, '');
  const result = executeCommandLine(sys, args);
  if (result.kind === 'exit') return result.status;
  if (result.kind === 'compile') return compile(sys, result);
  process.stderr.write(`tsc-ts: ${result.kind} is not implemented yet\n`);
  return ExitStatus.NotImplemented;
}
