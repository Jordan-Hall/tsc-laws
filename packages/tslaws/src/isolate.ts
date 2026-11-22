// Runs a check in a child process that holds no credentials. In GitHub mode the process that talks to GitHub holds a
// token, and a law (or any module a law imports) runs arbitrary code: in a worker thread it shares that process's
// memory, environment and `/proc/self/environ`. So the laws run here instead, in a child started with an allowlisted
// environment, and the parent receives the report over IPC as plain data and validates it before it acts on it.
//
// What this guarantees: no token is in the child's environment, its `/proc/self/environ` or its `process.env`, and a
// token that only the parent holds is never sent to it. What it does not: a child can still read the parent's
// `/proc/<pid>/environ` or memory (same user), which is why the action also runs the laws in a job that never holds
// the token (see docs/github.md and `--results-out`).
import { fork } from 'node:child_process';
import type { CheckReport } from './check.ts';
import type { CheckOptions, LawResult, LawStatus } from './types.ts';

/** Names a child may inherit. Everything else, tokens included, is dropped. */
const allowed = new Set(
  [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMDATA',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'TZ',
    'CI',
    'NODE_ENV',
    'PLAYWRIGHT_BROWSERS_PATH',
  ].map((name) => name.toUpperCase()),
);
const prefixes = ['TSC_LAWS_', 'TSLAWS_', 'TSC_TS_', 'LC_'];
/** A name that suggests a credential is dropped even under an allowed prefix. */
const secretName = /token|secret|password|passwd|credential|private|api[_-]?key|_key$/i;
/** Prefixes of the variables a GitHub runner sets, some of which carry credentials (ACTIONS_RUNTIME_TOKEN, ...). */
const runnerPrefixes = ['ACTIONS_', 'GITHUB_', 'GH_', 'RUNNER_', 'INPUT_'];

/** The environment a law may see: the allowlisted names of `env`, minus any that name a credential. */
export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (runnerPrefixes.some((prefix) => upper.startsWith(prefix))) continue;
    if (secretName.test(name)) continue;
    if (!allowed.has(upper) && !prefixes.some((prefix) => upper.startsWith(prefix))) continue;
    out[name] = value;
  }
  // Keep resource limits, and drop everything that loads code (--require, --import, --loader, ...).
  const node = (env.NODE_OPTIONS ?? '')
    .split(/\s+/)
    .filter((flag) => /^--(max-old-space-size|max-semi-space-size|stack-size)=\d+$/.test(flag));
  if (node.length > 0) out.NODE_OPTIONS = node.join(' ');
  return out;
}

const statuses: readonly LawStatus[] = [
  'proved',
  'bounded',
  'tested',
  'open',
  'failed',
  'tampered',
  'uncovered',
  'error',
];

/**
 * A report as plain data, or an error. A child (or a results file) is untrusted: this checks the shape, not the
 * truth, so everything later code reads from it has the type it expects.
 */
export function readReport(value: unknown): CheckReport {
  const fail = (why: string): never => {
    throw new Error(`the check's report is not valid: ${why}`);
  };
  if (typeof value !== 'object' || value === null) return fail('not an object');
  const report = value as Record<string, unknown>;
  if (!Array.isArray(report.results)) return fail('results is not a list');
  if (typeof report.compileDiagnostics !== 'string') return fail('compileDiagnostics is not text');
  for (const key of ['compileOk', 'lockMissing', 'ok'] as const)
    if (typeof report[key] !== 'boolean') return fail(`${key} is not a boolean`);
  if (!Array.isArray(report.notices) || report.notices.some((n) => typeof n !== 'string'))
    return fail('notices is not a list of text');
  const results: LawResult[] = [];
  for (const entry of report.results as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return fail('a result is not an object');
    const r = entry as Record<string, unknown>;
    if (typeof r.file !== 'string' || typeof r.name !== 'string' || typeof r.method !== 'string')
      return fail('a result lacks its file, name or method');
    if (typeof r.line !== 'number') return fail('a result lacks its line');
    if (typeof r.status !== 'string' || !statuses.includes(r.status as LawStatus))
      return fail('a result has no status');
    results.push(r as unknown as LawResult);
  }
  return {
    results,
    compileDiagnostics: report.compileDiagnostics,
    compileOk: report.compileOk as boolean,
    lockMissing: report.lockMissing as boolean,
    notices: report.notices as string[],
    ok: report.ok as boolean,
  };
}

/** What the child is told: the options as data (no callbacks cross the boundary). */
export type ChildRequest = { options: Omit<CheckOptions, 'onEvent'>; enforceLock: boolean };

/** Runs `check(options, enforceLock)` in a credential-free child and returns its validated report. */
export function checkIsolated(
  options: CheckOptions,
  enforceLock: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckReport> {
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const { onEvent: _onEvent, ...data } = options;
  return new Promise((resolve, reject) => {
    const child = fork(new URL(`./isolatedCheck${extension}`, import.meta.url), [], {
      env: scrubbedEnv(env),
      execArgv: process.execArgv,
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    let settled = false;
    const done = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      child.kill();
      finish();
    };
    child.on('message', (message: { report?: unknown; error?: string }) => {
      done(() => {
        if (message.error !== undefined) reject(new Error(message.error));
        else {
          try {
            resolve(readReport(message.report));
          } catch (error) {
            reject(error);
          }
        }
      });
    });
    child.on('error', (error) => done(() => reject(error)));
    child.on('exit', (code, signal) =>
      done(() => reject(new Error(`the check process ended without a report (${signal ?? `exit ${code}`})`))),
    );
    child.send({ options: data, enforceLock } satisfies ChildRequest);
  });
}
