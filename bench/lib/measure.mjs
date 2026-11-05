// Runs one command as a child process and measures it: wall time with process.hrtime, plus (on Windows) CPU time and the
// peak resident set size of the whole process tree, taken by tools/rsswrap.exe, which puts the command in a job object.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { benchRoot } from './gen.mjs';

const wrapperSource = join(benchRoot, 'tools', 'rsswrap.cs');
export const wrapperExe = join(benchRoot, 'bin', 'rsswrap.exe');

/** Builds the Windows measuring wrapper with the C# compiler that ships with Windows. Returns whether it is available. */
export function ensureWrapper() {
  if (process.platform !== 'win32') return false;
  if (existsSync(wrapperExe) && statSync(wrapperExe).mtimeMs >= statSync(wrapperSource).mtimeMs) return true;
  const windir = process.env.SystemRoot ?? 'C:\\Windows';
  const csc = join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!existsSync(csc)) return false;
  mkdirSync(join(benchRoot, 'bin'), { recursive: true });
  const built = spawnSync(csc, ['/nologo', '/optimize', '/platform:x64', `/out:${wrapperExe}`, wrapperSource], {
    encoding: 'utf8',
  });
  if (built.status !== 0) {
    process.stderr.write(
      `could not build rsswrap.exe, peak RSS will not be measured:\n${built.stdout}${built.stderr}\n`,
    );
    return false;
  }
  return true;
}

const quote = (arg) =>
  /[\s"]/.test(arg) || arg === '' ? `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"` : arg;

export const commandLine = (argv) => argv.map(quote).join(' ');

/**
 * Runs `argv` in `cwd`, writing its stdout and stderr to `logFile`.
 * Resolves to { wallMs, exitCode, timedOut, innerWallMs?, cpuMs?, peakRssBytes?, ... }.
 */
export function measure({ argv, cwd, env, logFile, timeoutMs, useWrapper }) {
  const log = openSync(logFile, 'w');
  const start = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const finish = (result) => {
      const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
      closeSync(log);
      resolve({ wallMs, ...result });
    };
    if (useWrapper) {
      const outFile = `${logFile}.rss.json`;
      rmSync(outFile, { force: true });
      const child = spawn(wrapperExe, [], {
        cwd,
        stdio: ['ignore', log, log],
        windowsHide: true,
        env: {
          ...env,
          RSSWRAP_CMDLINE: commandLine(argv),
          RSSWRAP_CWD: cwd,
          RSSWRAP_OUT: outFile,
          RSSWRAP_TIMEOUT_MS: String(timeoutMs),
        },
      });
      child.on('error', (error) => {
        closeSync(log);
        reject(error);
      });
      child.on('close', () => {
        let report;
        try {
          report = JSON.parse(readFileSync(outFile, 'utf8'));
        } catch (error) {
          report = { started: false, error: `no wrapper report: ${error.message}` };
        }
        finish({ ...report, exitCode: report.started ? report.exitCode : -1 });
      });
    } else {
      const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', log, log], windowsHide: true, env });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        closeSync(log);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish({ started: true, exitCode: code ?? -1, timedOut });
      });
    }
  });
}

/** Nearest-rank percentile of `values` (0..1); NaN for none. */
export function percentile(values, p) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export const median = (values) => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
