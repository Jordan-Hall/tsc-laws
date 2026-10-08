// Usage: cli [tsc arguments]
// Runs the tsc command line up to compilation, which is not implemented yet.
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { normalizePath } from '../compiler/command-line-paths.js';
import { ExitStatus, System, executeCommandLine } from '../compiler/tsc-cli.js';

class NodeSystem extends System {
  getEnvironmentVariable(name: string): string {
    return process.env[name] ?? '';
  }

  write(text: string): void {
    writeSync(1, text);
  }

  readFile(path: string): string | undefined {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  }

  writeFile(path: string, text: string): boolean {
    try {
      writeFileSync(path, text);
      return true;
    } catch {
      return false;
    }
  }

  fileExists(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }

  directoryExists(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }
}

/** Columns of the terminal, from `stty` since there's no portable API for it. */
function terminalWidth(): number {
  const result = spawnSync('stty', ['size'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  if (result.status !== 0) return 0;
  const columns = Number(result.stdout.trim().split(' ')[1]);
  return Number.isInteger(columns) ? columns : 0;
}

const isTTY = process.stdout.isTTY === true;
const sys = new NodeSystem(normalizePath(process.cwd()), isTTY, isTTY ? terminalWidth() : 0, true);
const result = executeCommandLine(sys, process.argv.slice(2));
if (result.kind === 'exit') {
  process.exitCode = result.status;
} else {
  process.stderr.write(
    `tsc-ts: ${result.kind === 'config' ? 'tsconfig.json loading' : result.kind} is not implemented yet\n`,
  );
  process.exitCode = ExitStatus.NotImplemented;
}
