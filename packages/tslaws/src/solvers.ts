// A second opinion on proofs. Z3 always decides; when `"solvers": ["z3", "cvc5"]` is set in tslaws.json, a law Z3 proves
// (an `unsat` answer) counts as `proved` only if the cvc5 binary also says `unsat` to the same SMT-LIB query. Any other
// answer from cvc5 leaves the law `bounded`, with a limit that names what cvc5 said. Refutations are never sent to cvc5:
// they already replay in JavaScript.
import { spawn } from 'node:child_process';
import { extname } from 'node:path';

export type SolverName = 'z3' | 'cvc5';

export const solverNames: readonly SolverName[] = ['z3', 'cvc5'];

/** The solvers of a project without a `solvers` key: Z3 alone, with no second opinion. */
export const defaultSolvers: readonly SolverName[] = ['z3'];

/** What is wrong with a `solvers` value from tslaws.json, or undefined when it is valid. */
export function solversProblem(value: unknown): string | undefined {
  const allowed = solverNames.map((name) => `"${name}"`).join(' and ');
  if (!Array.isArray(value) || value.length === 0)
    return `"solvers" must be an array of solver names (${allowed}), got ${JSON.stringify(value)}`;
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || !solverNames.includes(entry as SolverName))
      return `"solvers" has an unknown solver ${JSON.stringify(entry)}; the supported solvers are ${allowed}`;
  }
  if (!value.includes('z3')) return '"solvers" must include "z3": Z3 decides every proof and cvc5 only confirms it';
  const repeated = (value as string[]).find((entry, index) => value.indexOf(entry) !== index);
  if (repeated !== undefined) return `"solvers" lists "${repeated}" more than once`;
  return undefined;
}

/** The cvc5 binary is not there to run. */
export class SolverUnavailable extends Error {}

export type Cvc5Answer =
  | { kind: 'unsat' | 'sat' | 'unknown' }
  | { kind: 'timeout' }
  | { kind: 'error'; detail: string };

/**
 * The text cvc5 reads: Z3's query without the Z3-only timeout option (cvc5 takes `--tlimit`) and without `(get-model)`,
 * with `(set-logic ALL)` first when the query names no logic.
 */
export function cvc5Text(query: string): string {
  const lines = query.split('\n').filter((line) => !/^\s*\(set-option\s+:timeout\s+\d+\)\s*$/.test(line));
  const text = lines
    .filter((line) => line.trim() !== '(get-model)')
    .join('\n')
    .trimEnd();
  const logic = /\(set-logic\s/.test(text) ? '' : '(set-logic ALL)\n';
  return `${logic}${text}\n`;
}

/**
 * Where the binary is and how to start it: `TSLAWS_CVC5`, else `cvc5` on the PATH. A path ending in .js, .mjs or .cjs is
 * a Node script and runs under the current Node (the tests use one as a fake solver, which a .cmd file could not do on
 * every platform); anything else is run as it is. No shell is involved.
 */
function command(): { file: string; args: string[] } {
  const path = process.env.TSLAWS_CVC5 ?? 'cvc5';
  return ['.js', '.mjs', '.cjs'].includes(extname(path))
    ? { file: process.execPath, args: [path] }
    : { file: path, args: [] };
}

const missing = (): SolverUnavailable =>
  new SolverUnavailable(
    `"solvers" includes "cvc5", but the cvc5 binary was not found: install cvc5 (https://cvc5.github.io) so that cvc5 is on the PATH, or set TSLAWS_CVC5 to its path`,
  );

/** Asks cvc5 for the verdict on the query; a binary that cannot be started throws `SolverUnavailable`. */
export function runCvc5(query: string, timeoutMs: number): Promise<Cvc5Answer> {
  const { file, args } = command();
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args, '--lang', 'smt2', '--tlimit', String(timeoutMs)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const done = (answer: Cvc5Answer): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(answer);
    };
    // cvc5 stops itself at --tlimit; the grace period only catches a process that does not.
    const timer = setTimeout(() => {
      child.kill();
      done({ kind: 'timeout' });
    }, timeoutMs + 3000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (finished) return;
      if (error.code === 'ENOENT' || error.code === 'EACCES') {
        finished = true;
        clearTimeout(timer);
        reject(missing());
      } else done({ kind: 'error', detail: error.message });
    });
    child.on('close', (code) => {
      const first = stdout.trim().split('\n')[0]?.trim() ?? '';
      if (code === 0 && (first === 'unsat' || first === 'sat' || first === 'unknown')) done({ kind: first });
      else {
        const detail = first !== '' ? first : stderr.trim().split('\n')[0]?.trim() || `exited with code ${code}`;
        done({ kind: 'error', detail });
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(cvc5Text(query));
  });
}

/** The reason cvc5 did not agree, or undefined when it also said `unsat`. */
export function disagreementOf(answer: Cvc5Answer, timeoutMs: number): string | undefined {
  if (answer.kind === 'unsat') return undefined;
  if (answer.kind === 'timeout') return `cvc5 did not confirm the proof (no answer within ${timeoutMs} ms)`;
  if (answer.kind === 'error') return `cvc5 did not confirm the proof (error: ${answer.detail})`;
  return `cvc5 did not confirm the proof (${answer.kind})`;
}

/**
 * Runs the second solver on a query Z3 answered `unsat`. Returns what stops the proof from standing, or undefined when
 * the solvers agree or no second solver is configured.
 */
export async function secondOpinion(
  solvers: readonly SolverName[],
  query: string,
  timeoutMs: number,
): Promise<string | undefined> {
  if (!solvers.includes('cvc5')) return undefined;
  return disagreementOf(await runCvc5(query, timeoutMs), timeoutMs);
}
