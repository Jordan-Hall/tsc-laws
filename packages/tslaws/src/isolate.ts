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
import { lawKey } from './lock.ts';
import { budget, jobs } from './pool.ts';
import type { CheckOptions, LawResult, LawStatus, ProposalOutcome } from './types.ts';

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
const proposalReasons: readonly ProposalOutcome['reason'][] = ['added', 'changed', 'removed', 'level', 'exempt'];

/**
 * What the parent knows of a project without running any of it: the keys (`file::name`) of the laws its own compile found,
 * of the laws the lock records, and of the functions marked exempt. A report may name only these.
 */
export interface Expected {
  laws: ReadonlySet<string>;
  lock: ReadonlySet<string>;
  exempt: ReadonlySet<string>;
  /**
   * The laws the report must name, when it covers only some of them (a partial run, see `onlyKeys`). Default: every law.
   * It may still name any other law of the project.
   */
  required?: ReadonlySet<string>;
}

const longest = { path: 1024, method: 200, text: 20000, assumptions: 100 };

/**
 * A report as plain data, or an error. A child (or a results file) is untrusted, so each result is rebuilt from the fields
 * checked here and everything else, certificates included, is dropped. The keys must be exactly the project's laws, plus
 * the removals, exemptions and uncovered functions the parent's own view allows; nothing else is taken on trust. What a
 * law says of itself (its status, a counterexample) is the law's own claim and stays one.
 */
export function readReport(value: unknown, expected: Expected): CheckReport {
  const fail = (why: string): never => {
    throw new Error(`the check's report is not valid: ${why}`);
  };
  const object = (input: unknown, what: string): Record<string, unknown> => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(`${what} is not an object`);
    return input as Record<string, unknown>;
  };
  const text = (input: unknown, what: string, max: number): string => {
    if (typeof input !== 'string') return fail(`${what} is not text`);
    if (input.length > max) return fail(`${what} is longer than ${max} characters`);
    return input;
  };
  const optionalText = (input: unknown, what: string, max: number): string | undefined =>
    input === undefined ? undefined : text(input, what, max);
  const whole = (input: unknown, what: string, max: number): number => {
    if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input > max)
      return fail(`${what} is not a whole number from 0 to ${max}`);
    return input;
  };
  const known = (set: ReadonlySet<string>, key: string): boolean =>
    set.has(key) || [...set].some((member) => member.startsWith(`${key}::`));

  const report = object(value, 'the report');
  if (!Array.isArray(report.results)) return fail('results is not a list');
  if (report.results.length > 100000) return fail('results is too long');
  const compileDiagnostics = text(report.compileDiagnostics, 'compileDiagnostics', longest.text * 10);
  for (const key of ['compileOk', 'lockMissing'] as const)
    if (typeof report[key] !== 'boolean') return fail(`${key} is not a boolean`);
  if (!Array.isArray(report.notices) || report.notices.length > 10000) return fail('notices is not a list');
  const notices = (report.notices as unknown[]).map((n) => text(n, 'a notice', longest.text));

  const results: LawResult[] = [];
  const seenLaws = new Set<string>();
  const seenUncovered = new Set<string>();
  for (const entry of report.results as unknown[]) {
    const r = object(entry, 'a result');
    const file = text(r.file, 'a result file', longest.path);
    const name = text(r.name, 'a result name', longest.path);
    const key = lawKey(file, name);
    if (typeof r.status !== 'string' || !statuses.includes(r.status as LawStatus))
      return fail('a result has no status');
    const status = r.status as LawStatus;
    const result: LawResult = {
      file,
      name,
      line: whole(r.line, 'a result line', 10_000_000),
      status,
      method: text(r.method, 'a result method', longest.method),
    };
    const message = optionalText(r.message, 'a message', longest.text);
    const counterexample = optionalText(r.counterexample, 'a counterexample', longest.text);
    if (message !== undefined) result.message = message;
    if (counterexample !== undefined) result.counterexample = counterexample;
    if (r.runs !== undefined) result.runs = whole(r.runs, 'runs', 1_000_000_000);
    if (r.seed !== undefined) {
      // A seed may be negative (a 32-bit signed integer).
      if (typeof r.seed !== 'number' || !Number.isSafeInteger(r.seed)) return fail('a seed is not a whole number');
      result.seed = r.seed;
    }
    if (r.assumptions !== undefined) {
      if (!Array.isArray(r.assumptions) || r.assumptions.length > longest.assumptions)
        return fail('assumptions is not a short list');
      result.assumptions = (r.assumptions as unknown[]).map((a) => text(a, 'an assumption', longest.path));
    }
    if (r.screenshot !== undefined) {
      const shot = text(r.screenshot, 'a screenshot path', longest.path);
      // A path the parent could be led to read or upload: only one inside the project.
      if (/^([/\\]|[A-Za-z]:)/.test(shot) || shot.split(/[/\\]/).includes('..'))
        return fail('a screenshot path leaves the project');
      result.screenshot = shot;
    }
    if (r.proposal !== undefined) {
      const p = object(r.proposal, 'a proposal');
      if (typeof p.reason !== 'string' || !proposalReasons.includes(p.reason as ProposalOutcome['reason']))
        return fail('a proposal has no reason');
      if (
        typeof p.status !== 'string' ||
        !statuses.includes(p.status as LawStatus) ||
        p.status === 'tampered' ||
        p.status === 'uncovered'
      )
        return fail('a proposal has no status');
      const proposal: ProposalOutcome = {
        reason: p.reason as ProposalOutcome['reason'],
        status: p.status as ProposalOutcome['status'],
        method: text(p.method, 'a proposal method', longest.method),
      };
      const proposalCounterexample = optionalText(p.counterexample, 'a proposal counterexample', longest.text);
      const proposalMessage = optionalText(p.message, 'a proposal message', longest.text);
      if (proposalCounterexample !== undefined) proposal.counterexample = proposalCounterexample;
      if (proposalMessage !== undefined) proposal.message = proposalMessage;
      result.proposal = proposal;
    }

    if (status === 'uncovered') {
      if (seenUncovered.has(key)) return fail(`${key} is reported twice`);
      seenUncovered.add(key);
    } else {
      const kind = result.proposal?.reason;
      const allowed =
        expected.laws.has(key) ||
        (status === 'tampered' && kind === 'removed' && known(expected.lock, key)) ||
        (status === 'tampered' && kind === 'exempt' && known(expected.exempt, key));
      if (!allowed) return fail(`${key} is not a law of this project`);
      const identity = `${key}\0${kind === 'removed' || kind === 'exempt' ? kind : ''}`;
      if (seenLaws.has(identity)) return fail(`${key} is reported twice`);
      seenLaws.add(identity);
    }
    results.push(result);
  }
  const got = new Set(results.filter((r) => r.status !== 'uncovered').map((r) => lawKey(r.file, r.name)));
  for (const key of expected.required ?? expected.laws) if (!got.has(key)) return fail(`${key} has no result`);

  const compileOk = report.compileOk as boolean;
  const lockMissing = report.lockMissing as boolean;
  return {
    results,
    compileDiagnostics,
    compileOk,
    lockMissing,
    notices,
    // The parent decides this itself from the results it has kept.
    ok:
      compileOk &&
      !lockMissing &&
      results.every((r) => r.status === 'proved' || r.status === 'bounded' || r.status === 'tested'),
  };
}

/** What the child is told: the options as data (no callbacks cross the boundary). */
export type ChildRequest = { options: Omit<CheckOptions, 'onEvent'>; enforceLock: boolean; jobs?: number };

/** Runs `check(options, enforceLock)` in a credential-free child and returns its validated report. */
export function checkIsolated(
  options: CheckOptions,
  enforceLock: boolean,
  expected: Expected,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckReport> {
  // The child is a slot of the budget while it runs, and it is handed the budget's size, not a fresh one of its own.
  return budget.run(() => forkCheck(options, enforceLock, expected, env));
}

function forkCheck(
  options: CheckOptions,
  enforceLock: boolean,
  expected: Expected,
  env: NodeJS.ProcessEnv,
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
            resolve(readReport(message.report, expected));
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
    child.send({ options: data, enforceLock, jobs: jobs() } satisfies ChildRequest);
  });
}
