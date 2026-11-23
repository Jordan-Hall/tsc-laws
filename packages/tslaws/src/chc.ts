// Loop invariants by constrained Horn clauses (CHC). The symbolic executor (symbolic.ts) turns each loop into an
// unknown predicate over the loop variables and three kinds of clause:
//
//   entry   the state on entering the loop satisfies Inv
//   step    Inv, the loop condition and one pass of the body give Inv on the next state
//   query   Inv with the condition false, and every other fact, make the law and its obligations hold
//
// Z3's Spacer engine looks for an Inv that satisfies all of them. A solution is not trusted on Spacer's word: the
// invariants it printed are put back into the clauses and plain Z3 must show each implication valid. When Eldarica
// (`eld`) or Golem is installed it solves the same system too; a solver that says there is no solution where Spacer
// found one is a disagreement, and the law is then reported as unknown rather than proved.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { budget, lowerPriority } from './pool.ts';

/** One unknown predicate: the invariant of one loop, over the variables live at the loop. */
export interface Predicate {
  name: string;
  /** The SMT sort of each argument. */
  sorts: string[];
  /** What each argument is called in the source, for showing the invariant. */
  names: string[];
}

/** A clause set with every free constant universally quantified, as Spacer needs. */
export interface HornSystem {
  predicates: Predicate[];
  /** Every constant a clause mentions; each clause is closed over all of them. */
  constants: { name: string; sort: string }[];
  /** `(=> body head)` clauses, with constants free. */
  clauses: string[];
  /** Terms the executor named to keep its formulas short (`_s3`); expanded in place, since a clause is closed. */
  shared: Map<string, string>;
}

export type ExternalAnswer = {
  solver: string;
  answer: 'sat' | 'unsat' | 'unknown' | 'timeout' | 'error';
  detail?: string;
};

export interface Engine {
  /** Z3: runs a script, and `values` after a `sat`. */
  z3: (query: string, values: string, timeoutMs: number) => Promise<{ out: string; vals: string }>;
  /** The other CHC solvers that are installed, on the same system. */
  external: (query: string, timeoutMs: number) => Promise<ExternalAnswer[]>;
}

/**
 * What a proof certificate for a loop proof is made from: the Horn system as `hornText` prints it (no timeout, so it is
 * the same text every run) and the `define-fun` of each invariant as Z3 printed it. The invariants are guesses that need
 * no trust: `certificationProblem` puts them back into the clauses, and the problem it makes is unsatisfiable only when
 * each clause holds with them.
 */
export interface HornCertification {
  horn: string;
  invariants: string;
}

export type ChcVerdict =
  /** A verified invariant for every loop; `notes` says which other solvers confirmed it or could not. */
  | { kind: 'safe'; invariants: string[]; notes: string[]; certification: HornCertification }
  /** Spacer found the clauses contradictory: the law may fail (the unrolled proof looks for the input). */
  | { kind: 'unsafe' }
  /** No answer, or an answer that did not verify. */
  | { kind: 'unknown'; reason: string }
  /** Spacer and another solver gave opposite answers. */
  | { kind: 'disagree'; reason: string };

const unknown = (reason: string): ChcVerdict => ({ kind: 'unknown', reason });

/** Floating point and strings are outside what the CHC engines decide: the unrolled proof handles those. */
const unmodelled = /FloatingPoint|\bfp\.|to_fp|\bstr\.|\bString\b|\bre\./;

function expand(text: string, shared: Map<string, string>): string {
  let out = text;
  // A shared term may name an earlier one, so expand until nothing is left.
  for (let round = 0; round <= shared.size && /\b_s\d+\b/.test(out); round += 1)
    out = out.replace(/\b_s\d+\b/g, (name) => shared.get(name) ?? name);
  return out;
}

const closed = (system: HornSystem, text: string): string => {
  const body = expand(text, system.shared);
  if (system.constants.length === 0) return body;
  return `(forall (${system.constants.map((c) => `(${c.name} ${c.sort})`).join(' ')}) ${body})`;
};

/** The SMT-LIB script Spacer (and any other CHC solver) reads. */
export function hornText(system: HornSystem, timeoutMs?: number): string {
  return [
    ...(timeoutMs === undefined ? [] : [`(set-option :timeout ${timeoutMs})`]),
    '(set-logic HORN)',
    ...system.predicates.map((p) => `(declare-fun ${p.name} (${p.sorts.join(' ')}) Bool)`),
    ...system.clauses.map((clause) => `(assert ${closed(system, clause)})`),
    '(check-sat)',
  ].join('\n');
}

// ---- reading Z3's model --------------------------------------------------------------------------------------

/** The top-level s-expressions of `text`, each as text. */
function topLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') quoted = !quoted;
    if (quoted) continue;
    if (ch === '(') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0 && start >= 0) out.push(text.slice(start, i + 1));
    } else if (depth === 0 && !/\s/.test(ch)) {
      const end = text.slice(i).search(/[\s()]/);
      out.push(text.slice(i, end < 0 ? text.length : i + end));
      i += (end < 0 ? text.length - i : end) - 1;
    }
  }
  return out;
}

/** The elements of one list `( a b (c d) )`. */
function children(list: string): string[] {
  return topLevel(list.trim().slice(1, -1));
}

/** The `define-fun` of each predicate in a model, by name. */
function modelDefinitions(model: string): Map<string, string> {
  let items = topLevel(model);
  // Z3 wraps the definitions in one list.
  if (items.length === 1 && items[0]!.startsWith('(') && !items[0]!.startsWith('(define-fun'))
    items = children(items[0]!);
  const out = new Map<string, string>();
  for (const item of items) {
    const parts = item.startsWith('(define-fun') ? children(item) : [];
    if (parts.length >= 5) out.set(parts[1]!, item);
  }
  return out;
}

/** The invariant as text over the source names: `Inv(s, i, n) := (and ...)`. */
function describe(predicate: Predicate, definition: string, index: number): string {
  const parts = children(definition);
  const body = parts[parts.length - 1]!.replace(/\s+/g, ' ');
  const named = body.replace(/\bx!(\d+)/g, (_, k: string) => predicate.names[Number(k)] ?? `x!${k}`);
  return `loop ${index + 1} invariant over (${predicate.names.join(', ')}): ${named}`;
}

/** `term` with every application of a defined predicate replaced by its body, the arguments put in for the parameters. */
function inlineApplications(term: string, definitions: Map<string, { params: string[]; body: string }>): string {
  if (!term.startsWith('(')) return term;
  const parts = children(term);
  const head = parts[0];
  const definition = head === undefined ? undefined : definitions.get(head);
  const rest = parts.map((part) => inlineApplications(part, definitions));
  if (definition === undefined) return `(${rest.join(' ')})`;
  const args = rest.slice(1);
  if (args.length !== definition.params.length) throw new Error(`${head} is applied to the wrong number of arguments`);
  const bound = new Map(definition.params.map((param, i) => [param, args[i]!]));
  const put = (text: string): string => {
    if (!text.startsWith('(')) return bound.get(text) ?? text;
    return `(${children(text).map(put).join(' ')})`;
  };
  return put(definition.body);
}

/**
 * The SMT-LIB problem that proves a loop proof, from the Horn text and the invariants of a `HornCertification`: every
 * constant of the clauses declared, each invariant put in place of its predicate, and one assertion that some clause
 * fails. It has no quantifiers and no unknown predicate, so cvc5 can refute it with an Alethe proof and Carcara can check
 * that proof. Because some constant can break one clause exactly when some constant breaks a clause, the problem is
 * unsatisfiable exactly when every clause holds for every value, that is, when the invariants are inductive and make the
 * law hold. Undefined when the invariants do not match the predicates the text declares.
 */
export function certificationProblem(horn: string, invariants: string): string | undefined {
  try {
    const definitions = new Map<string, { params: string[]; body: string }>();
    for (const item of topLevel(invariants)) {
      const parts = children(item);
      if (parts[0] !== 'define-fun' || parts.length !== 5 || !parts[2]!.startsWith('(')) return undefined;
      definitions.set(parts[1]!, { params: children(parts[2]!).map((param) => children(param)[0]!), body: parts[4]! });
    }
    const predicates = new Set<string>();
    const constants = new Map<string, string>();
    const clauses: string[] = [];
    for (const item of topLevel(horn)) {
      const parts = children(item);
      if (parts[0] === 'declare-fun') predicates.add(parts[1]!);
      if (parts[0] !== 'assert') continue;
      let body = parts[1]!;
      if (body.startsWith('(forall')) {
        const quantified = children(body);
        for (const binder of children(quantified[1]!)) {
          const [name, sort] = children(binder);
          constants.set(name!, sort!);
        }
        body = quantified[2]!;
      }
      clauses.push(body);
    }
    if (predicates.size !== definitions.size || [...predicates].some((name) => !definitions.has(name)))
      return undefined;
    if (clauses.length === 0) return undefined;
    return [
      ...[...constants].map(([name, sort]) => `(declare-const ${name} ${sort})`),
      `(assert (or ${clauses.map((clause) => `(not ${inlineApplications(clause, definitions)})`).join(' ')}))`,
      '(check-sat)',
    ].join('\n');
  } catch {
    return undefined;
  }
}

/** Plain Z3 checks each clause with the printed invariants in place of the unknowns; true when every one is valid. */
async function verified(
  system: HornSystem,
  definitions: Map<string, string>,
  engine: Engine,
  timeoutMs: number,
): Promise<string | undefined> {
  const query = [
    `(set-option :timeout ${timeoutMs})`,
    ...system.predicates.map((p) => definitions.get(p.name)!),
    ...system.clauses.flatMap((clause) => [
      '(push 1)',
      `(assert (not ${closed(system, clause)}))`,
      '(check-sat)',
      '(pop 1)',
    ]),
  ].join('\n');
  const { out } = await engine.z3(query, '', timeoutMs);
  const answers = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (answers.length === system.clauses.length && answers.every((line) => line === 'unsat')) return undefined;
  return `plain Z3 could not check the invariants Spacer found (${answers.join(', ') || 'no answer'})`;
}

/**
 * Looks for an invariant for every loop in `system`, verifies it, and has the installed CHC solvers confirm it.
 * Never throws: anything that goes wrong is an `unknown` verdict, and the caller falls back to unrolling.
 */
export async function solveHorn(system: HornSystem, engine: Engine, timeoutMs: number): Promise<ChcVerdict> {
  const query = hornText(system, timeoutMs);
  if (unmodelled.test(query))
    return unknown('a loop uses floating-point numbers or strings, which CHC solving does not model');
  try {
    const { out, vals } = await engine.z3(query, '(get-model)', timeoutMs);
    const first = out.split('\n')[0]?.trim() ?? '';
    if (first === 'unsat') return { kind: 'unsafe' };
    if (first !== 'sat') return unknown(`Spacer gave up (${first === '' ? 'no answer' : first.slice(0, 80)})`);
    const definitions = modelDefinitions(vals);
    const missing = system.predicates.find((p) => !definitions.has(p.name));
    if (missing !== undefined) return unknown(`Spacer printed no invariant for ${missing.name}`);
    const problem = await verified(system, definitions, engine, timeoutMs);
    if (problem !== undefined) return unknown(problem);
    const notes: string[] = [];
    for (const other of await engine.external(hornText(system), timeoutMs)) {
      if (other.answer === 'sat') notes.push(`${other.solver} agrees`);
      else if (other.answer === 'unsat')
        return {
          kind: 'disagree',
          reason: `Spacer found invariants but ${other.solver} says the loops can break the law: the solvers disagree`,
        };
      else notes.push(`${other.solver} did not confirm (${other.detail ?? other.answer})`);
    }
    const invariants = system.predicates.map((p, i) => describe(p, definitions.get(p.name)!, i));
    const certification = {
      horn: hornText(system),
      invariants: system.predicates.map((p) => definitions.get(p.name)!).join('\n'),
    };
    return { kind: 'safe', invariants, notes, certification };
  } catch (error) {
    return unknown((error as Error).message);
  }
}

// ---- other CHC solvers -----------------------------------------------------------------------------------------

interface External {
  name: string;
  /** The environment variable naming the binary, and the name looked up on the PATH without it. */
  env: string;
  command: string;
  args: (timeoutMs: number) => string[];
}

const externals: External[] = [
  { name: 'Eldarica', env: 'TSLAWS_ELDARICA', command: 'eld', args: (ms) => [`-t:${Math.ceil(ms / 1000)}`] },
  { name: 'Golem', env: 'TSLAWS_GOLEM', command: 'golem', args: () => [] },
];

/** Binaries that could not be started, so a missing solver costs one failed start per run, not one per law. */
const missing = new Set<string>();

/** A path ending in .js, .mjs or .cjs is a Node script and runs under the current Node (the tests use one as a mock). */
function start(path: string, args: string[]): { file: string; args: string[] } {
  return ['.js', '.mjs', '.cjs'].includes(extname(path))
    ? { file: process.execPath, args: [path, ...args] }
    : { file: path, args };
}

function runExternal(
  solver: External,
  path: string,
  query: string,
  timeoutMs: number,
): Promise<ExternalAnswer | undefined> {
  const dir = mkdtempSync(join(tmpdir(), 'tslaws-chc-'));
  const file = join(dir, 'system.smt2');
  writeFileSync(file, `${query}\n`);
  const { file: bin, args } = start(path, [...solver.args(timeoutMs), file]);
  return new Promise((resolve) => {
    let stdout = '';
    let finished = false;
    const done = (answer: ExternalAnswer | undefined): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolve(answer);
    };
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    lowerPriority(child.pid);
    const timer = setTimeout(() => {
      child.kill();
      done({ solver: solver.name, answer: 'timeout', detail: `no answer within ${timeoutMs} ms` });
    }, timeoutMs + 3000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.resume();
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'EACCES') {
        missing.add(path);
        done(undefined);
      } else done({ solver: solver.name, answer: 'error', detail: error.message });
    });
    child.on('close', () => {
      const first = stdout.trim().split('\n')[0]?.trim() ?? '';
      if (first === 'sat' || first === 'unsat' || first === 'unknown') done({ solver: solver.name, answer: first });
      else done({ solver: solver.name, answer: 'error', detail: first === '' ? 'no answer' : first.slice(0, 80) });
    });
  });
}

/** Runs each installed solver (`TSLAWS_ELDARICA` and `TSLAWS_GOLEM`, else `eld` and `golem` on the PATH) on the system. */
export async function runExternalSolvers(query: string, timeoutMs: number): Promise<ExternalAnswer[]> {
  // One extra slot for each solver past the first; with none free they run one after another.
  const answers = await budget.portfolio(
    externals.map((solver) => async () => {
      const path = process.env[solver.env] ?? solver.command;
      return missing.has(path) ? undefined : runExternal(solver, path, query, timeoutMs);
    }),
  );
  return answers.filter((answer): answer is ExternalAnswer => answer !== undefined);
}
