// The prover: symbolically executes the compiled JavaScript of a law (see symbolic.ts) and asks Z3 whether any input
// makes it return `false`, or break an obligation (an integer leaving the safe range, an index leaving its array).
//
//   proved    no such input exists, with no bound involved: the law holds for every input
//   bounded   no such input exists within the bounds the proof had to cut at (array length, loop count, recursion)
//   refuted   Z3 found an input and the compiled law really fails on it in JavaScript
//   unsupported  the code uses something that does not lower, Z3 gave up, or its model did not reproduce
//
// Arrays that are parameters, with integer, bigint or boolean elements, are SMT arrays of any length, and a loop
// becomes constrained Horn clauses for Z3's Spacer to find an invariant (see chc.ts): both are proved without a bound.
// Anything outside that runs again the old way, with arrays cut at `bound` and loops unrolled that far.
//
// Numbers are IEEE doubles; a parameter typed `number` is a finite double (the generators exclude NaN and the
// infinities too). A parameter typed `int` (from 'tslaws') or `bigint` is an exact integer.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { budget, jobs, WorkerPool } from './pool.ts';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { certificateName, certify, problemText, type Certificate, type CertifyMode } from './certificates.ts';
import { runExternalSolvers, solveHorn, type HornSystem } from './chc.ts';
import { lawKey } from './lock.ts';
import { SolverUnavailable, secondOpinion, type SolverName } from './solvers.ts';
import { Executor, SpuriousModel, Unsupported, and, not, type SeqElement, type Value } from './symbolic.ts';
import type { ManifestLaw } from './types.ts';
import { plural } from './plural.ts';

export type Shape =
  | 'number'
  | 'int'
  | 'bigint'
  | 'boolean'
  | 'string'
  | { array: Shape }
  | { fields: Record<string, Shape> }
  | undefined;

export type ProofResult =
  | { kind: 'proved'; assumptions: string[]; certificate?: Certificate }
  | { kind: 'bounded'; limits: string[]; assumptions: string[]; certificate?: Certificate }
  | { kind: 'refuted'; model: string; inputs: unknown[] }
  | { kind: 'unsupported'; reason: string }
  /** A configured second solver could not run (the cvc5 binary is missing). */
  | { kind: 'error'; message: string };

export interface ProveInput {
  law: ManifestLaw;
  /** The shape of each parameter's type; `undefined` when the type is not modelled. */
  shapes: Shape[];
  /** The compiled JavaScript file of the law. */
  jsFile: string;
  timeoutMs: number;
  /** Longest array, most loop iterations and deepest recursion a proof considers. */
  bound: number;
  /** Runs the compiled law on concrete inputs; true when it holds. */
  holds: (inputs: unknown[]) => boolean | Promise<boolean>;
  /** The solvers that must agree on a proof (see solvers.ts); default Z3 alone. */
  solvers?: readonly SolverName[];
  /**
   * Check the `unsat` of an unbounded or bounded proof with cvc5 and Carcara (see certificates.ts). `dir` keeps the
   * proofs of certified laws; `root` is the project they are named relative to.
   */
  certify?: { mode: CertifyMode; dir: string; root: string };
}

type Sort = 'fp' | 'int' | 'bool' | 'str';

interface Declared {
  name: string;
  sort: Sort;
  /** The term to ask the model for when it is not the constant itself (an element of an array of any length). */
  term?: string;
}

/** How many elements of an array of any length a counterexample can show; a longer one is left to the bounded proof. */
const shownElements = 16;

const safeRange = (t: string): string => `(and (<= (- 9007199254740991) ${t}) (<= ${t} 9007199254740991))`;

class Declarations {
  readonly lines: string[] = [];
  readonly constants: Declared[] = [];
  /** Every `declare-const`, with its SMT sort, for the Horn clauses that quantify over them. */
  readonly declared: { name: string; sort: string }[] = [];
  /** The length constant of each array of any length. */
  readonly lengths: string[] = [];
  readonly assumptions: string[] = [];

  constant(name: string, sort: Sort): void {
    const smt = { fp: '(_ FloatingPoint 11 53)', int: 'Int', bool: 'Bool', str: 'String' }[sort];
    this.lines.push(`(declare-const ${name} ${smt})`);
    this.declared.push({ name, sort: smt });
    this.constants.push({ name, sort });
  }

  /** An array of any length: a length and an SMT array, and the first few elements for a counterexample to show. */
  sequence(name: string, elem: SeqElement): void {
    const sort = elem === 'bool' ? 'bool' : 'int';
    this.constant(`${name}__len`, 'int');
    this.lengths.push(`${name}__len`);
    const smt = `(Array Int ${elem === 'bool' ? 'Bool' : 'Int'})`;
    this.lines.push(`(declare-const ${name}__data ${smt})`);
    this.declared.push({ name: `${name}__data`, sort: smt });
    this.assumptions.push(`(and (<= 0 ${name}__len) (<= ${name}__len 4294967295))`);
    for (let k = 0; k < shownElements; k += 1)
      this.constants.push({ name: `${name}__${k}`, sort, term: `(select ${name}__data ${k})` });
  }
}

/** JavaScript strings stop near 2^29 units; a longer one would also push their lengths out of the safe integers. */
const maxStringLength = 536870888;

function sequenceElement(shape: Shape): SeqElement | undefined {
  return shape === 'int' ? 'int' : shape === 'bigint' ? 'big' : shape === 'boolean' ? 'bool' : undefined;
}

function declareParam(
  name: string,
  shape: Shape,
  bound: number,
  decl: Declarations,
  intLimit: bigint | undefined,
  theory: boolean,
): Value {
  if (shape === 'number') {
    decl.constant(name, 'fp');
    decl.assumptions.push(`(and (not (fp.isNaN ${name})) (not (fp.isInfinite ${name})))`);
    return { k: 'fp', t: name };
  }
  if (shape === 'int') {
    decl.constant(name, 'int');
    decl.assumptions.push(
      intLimit === undefined ? safeRange(name) : `(and (<= (- ${intLimit}) ${name}) (<= ${name} ${intLimit}))`,
    );
    return { k: 'int', t: name };
  }
  if (shape === 'bigint') {
    decl.constant(name, 'int');
    return { k: 'big', t: name };
  }
  if (shape === 'boolean') {
    decl.constant(name, 'bool');
    return { k: 'bool', t: name };
  }
  if (shape === 'string') {
    decl.constant(name, 'str');
    // JavaScript strings are UTF-16; SMT-LIB strings are code points. Keep to the BMP so they agree.
    decl.assumptions.push(`(str.in_re ${name} (re.* (re.range "\\u{0}" "\\u{ffff}")))`);
    decl.assumptions.push(`(<= (str.len ${name}) ${maxStringLength})`);
    return { k: 'str', t: name };
  }
  if (shape === undefined) throw new Unsupported('a parameter type is not modelled');
  if ('array' in shape && theory) {
    const elem = sequenceElement(shape.array);
    if (elem === undefined) throw new Unsupported('arrays of this element type are proved only within the bound');
    decl.sequence(name, elem);
    return { k: 'seq', len: { k: 'int', t: `${name}__len` }, data: `${name}__data`, elem, id: { escaped: true } };
  }
  if ('array' in shape) {
    const len = `${name}__len`;
    decl.constant(len, 'int');
    decl.assumptions.push(`(and (<= 0 ${len}) (<= ${len} ${bound}))`);
    const slots: Value[] = [];
    for (let i = 0; i < bound; i += 1)
      slots.push(declareParam(`${name}__${i}`, shape.array, bound, decl, intLimit, theory));
    return { k: 'arr', len: { k: 'int', t: len }, slots, id: { escaped: true } };
  }
  const fields = new Map<string, Value>();
  for (const [field, fieldShape] of Object.entries(shape.fields))
    fields.set(field, declareParam(`${name}__${field}`, fieldShape, bound, decl, intLimit, theory));
  return { k: 'rec', fields };
}

// ---- reading Z3's model --------------------------------------------------------------------------------------

type Sexp = string | Sexp[];

function parseSexp(text: string): Sexp {
  let i = 0;
  const blank = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
  };
  const read = (): Sexp => {
    blank();
    if (text[i] === '(') {
      i += 1;
      const list: Sexp[] = [];
      for (;;) {
        blank();
        if (text[i] === ')') {
          i += 1;
          return list;
        }
        if (i >= text.length) throw new Unsupported('truncated model');
        list.push(read());
      }
    }
    if (text[i] === '"') {
      let out = '"';
      i += 1;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            out += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        out += text[i];
        i += 1;
      }
      return `${out}"`;
    }
    const start = i;
    while (i < text.length && !/[\s()]/.test(text[i]!)) i += 1;
    return text.slice(start, i);
  };
  return read();
}

function rational(e: Sexp): [bigint, bigint] {
  if (typeof e === 'string') {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(e);
    if (m === null) throw new Unsupported(`cannot read model number ${e}`);
    const frac = m[2] ?? '';
    return [BigInt(m[1]! + frac), 10n ** BigInt(frac.length)];
  }
  if (e[0] === '-' && e.length === 2) {
    const [n, d] = rational(e[1]!);
    return [-n, d];
  }
  if (e[0] === '/' && e.length === 3) {
    const [a, b] = rational(e[1]!);
    const [c, d] = rational(e[2]!);
    return [a * d, b * c];
  }
  throw new Unsupported(`cannot read model number ${JSON.stringify(e)}`);
}

/** The double a rational is, exactly when it is one (a model of an `fp.to_real`). */
function toDouble([n, d]: [bigint, bigint]): number {
  if (d < 0n) [n, d] = [-n, -d];
  if (d === 1n) return Number(n);
  let k = 0;
  let power = d;
  while (power > 1n && power % 2n === 0n) {
    power /= 2n;
    k += 1;
  }
  if (power !== 1n) return Number(n) / Number(d);
  let value = Number(n);
  for (let left = k; left > 0; left -= 500) value *= 2 ** -Math.min(left, 500);
  return value;
}

function decodeString(e: Sexp): string {
  if (typeof e !== 'string' || !e.startsWith('"')) throw new Unsupported('cannot read model string');
  return e.slice(1, -1).replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)));
}

function modelValue(sort: Sort, e: Sexp): number | bigint | boolean | string {
  if (sort === 'bool') return e === 'true';
  if (sort === 'str') return decodeString(e);
  const [n, d] = rational(e);
  if (sort === 'int') return n / d;
  return toDouble([n, d]);
}

function jsValue(shape: Shape, name: string, model: Map<string, number | bigint | boolean | string>): unknown {
  if (shape === 'number' || shape === 'int') return Number(model.get(name) ?? 0);
  if (shape === 'bigint') return BigInt(model.get(name) ?? 0);
  if (shape === 'boolean') return model.get(name) === true;
  if (shape === 'string') return String(model.get(name) ?? '');
  if (shape === undefined) return undefined;
  if ('array' in shape) {
    const len = Number(model.get(`${name}__len`) ?? 0);
    const out: unknown[] = [];
    for (let i = 0; i < len; i += 1) out.push(jsValue(shape.array, `${name}__${i}`, model));
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [field, fieldShape] of Object.entries(shape.fields))
    out[field] = jsValue(fieldShape, `${name}__${field}`, model);
  return out;
}

// ---- Z3 ------------------------------------------------------------------------------------------------------

// Z3 runs in a worker thread: its WebAssembly build blocks the thread and `:timeout` does not always interrupt it,
// so a query that runs away is stopped by terminating the worker, and the next query starts a fresh one.

interface SolverReply {
  id: number;
  out?: string;
  vals?: string;
  error?: string;
}

let nextId = 0;

function startWorker(): Worker {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const w = new Worker(new URL(`./smtWorker${ext}`, import.meta.url));
  w.unref();
  return w;
}

// Each Z3 instance holds a large WebAssembly heap; more than four at once run out of memory on the bigger queries.
const solvers = new WorkerPool(startWorker, () => Math.min(4, jobs()));

/**
 * Runs the query, and runs it again in a fresh worker when the solver itself fell over (a WebAssembly allocation that
 * fails on a machine short of memory). A query that merely ran too long is not retried: it would only run long again.
 */
export async function solve(query: string, values: string, timeoutMs: number): Promise<{ out: string; vals: string }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // A solve is a slot of the budget (the law's own, when it runs under one).
      return await budget.run(() => solveOnce(query, values, timeoutMs));
    } catch (error) {
      if (attempt >= 2 || !(error instanceof Unsupported) || !error.message.startsWith('the solver crashed'))
        throw error;
      await new Promise((done) => setTimeout(done, 400 * (attempt + 1)));
    }
  }
}

/** One try: gives up on the whole worker after the timeout plus a grace period. */
async function solveOnce(query: string, values: string, timeoutMs: number): Promise<{ out: string; vals: string }> {
  const current = await solvers.acquire();
  const id = (nextId += 1);
  return new Promise((resolve, reject) => {
    const drop = (): void => {
      clearTimeout(timer);
      current.off('message', onMessage);
      current.off('error', onError);
    };
    const kill = (): void => {
      solvers.discard(current);
    };
    const timer = setTimeout(() => {
      drop();
      kill();
      reject(new Unsupported(`the solver did not stop within ${timeoutMs} ms and was terminated`));
    }, timeoutMs + 3000);
    const onMessage = (reply: SolverReply): void => {
      if (reply.id !== id) return;
      drop();
      if (reply.error !== undefined) {
        kill();
        reject(new Unsupported(`the solver crashed: ${reply.error}`));
      } else {
        solvers.release(current);
        resolve({ out: reply.out ?? '', vals: reply.vals ?? '' });
      }
    };
    const onError = (error: Error): void => {
      drop();
      kill();
      reject(new Unsupported(`the solver crashed: ${error.message}`));
    };
    current.on('message', onMessage);
    current.on('error', onError);
    current.postMessage({ id, query, values });
  });
}

function resultOf(value: Value): string {
  return value.k === 'bool' ? value.t : 'true';
}

function containsArray(shape: Shape): boolean {
  if (shape === undefined || typeof shape === 'string') return false;
  if ('array' in shape) return true;
  return Object.values(shape.fields).some(containsArray);
}

function show(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));
}

/** What a proof silently takes for granted about each kind of parameter; shown with a `proved` or `bounded` result. */
const numberAssumption = 'number parameters exclude NaN and ±Infinity';
const intAssumption = 'int parameters stay within ±(2^53 - 1)';
const stringAssumption = `string parameters use only characters up to U+FFFF (no surrogate pairs) and at most ${maxStringLength} UTF-16 units`;

/**
 * The domain assumptions a proof rests on for parameters of these types, in order of first use and without repeats.
 * Arrays are left out (their length bound is a limit of the proof), as is `int` when `intLimit` narrows it (that range is
 * a limit too). `bigint` and `boolean` take nothing for granted.
 */
export function assumptionsFor(shapes: Shape[], intLimit?: bigint): string[] {
  const found = new Set<string>();
  const visit = (shape: Shape): void => {
    if (shape === 'number') found.add(numberAssumption);
    else if (shape === 'int') {
      if (intLimit === undefined) found.add(intAssumption);
    } else if (shape === 'string') found.add(stringAssumption);
    else if (shape === undefined || typeof shape === 'string') return;
    else if ('array' in shape) visit(shape.array);
    else for (const field of Object.values(shape.fields)) visit(field);
  };
  for (const shape of shapes) visit(shape);
  return [...found];
}

/** Ints stay within this in the second attempt, where products and sums cannot leave the safe range. */
const smallInts = 2n ** 26n;

/** Tries to prove `input.law` for every input within `input.bound`. */
export async function proveLaw(input: ProveInput): Promise<ProofResult> {
  try {
    try {
      return await attempt(input, undefined);
    } catch (error) {
      // The full safe range failed only on an obligation (an integer result that could round): try smaller ints.
      if (!(error instanceof SpuriousModel) || !input.shapes.some(containsInt)) throw error;
      const result = await attempt(input, smallInts);
      return result;
    }
  } catch (error) {
    if (error instanceof Unsupported) return { kind: 'unsupported', reason: error.message };
    if (error instanceof SolverUnavailable) return { kind: 'error', message: error.message };
    throw error;
  }
}

function containsInt(shape: Shape): boolean {
  if (shape === 'int') return true;
  if (shape === undefined || typeof shape === 'string') return false;
  if ('array' in shape) return containsInt(shape.array);
  return Object.values(shape.fields).some(containsInt);
}

/** Where a law's certificate is kept: a file name from the law's name and a hash of its key. */
function keepOf(
  input: ProveInput,
  certify: NonNullable<ProveInput['certify']>,
): { dir: string; name: string; root: string } {
  return { dir: certify.dir, root: certify.root, name: certificateName(lawKey(input.law.file, input.law.name)) };
}

/** What the build learnt about a law and the query it yields; `attemptWith` and `problemTexts` both start here. */
interface Problem {
  executor: Executor;
  decl: Declarations;
  names: string[];
  holds: string;
  safe: string;
  facts: string[];
}

function buildProblem(input: ProveInput, intLimit: bigint | undefined, theory: boolean): Problem {
  const source = ts.createSourceFile(
    input.jsFile,
    readFileSync(input.jsFile, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const fn = source.statements.find(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) && s.name?.text === (input.law.symbol ?? input.law.name),
  );
  if (fn === undefined || fn.body === undefined) throw new Unsupported('law function not found in the compiled output');
  if (fn.parameters.length !== input.shapes.length) throw new Unsupported('parameter count mismatch');
  const names = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
  const executor = new Executor(input.bound);
  executor.infer = theory;
  executor.intLimit = intLimit;
  const decl = new Declarations();
  const params = names.map((name, i) => declareParam(name, input.shapes[i], input.bound, decl, intLimit, theory));
  // In the clauses of a loop the parameters' domains are facts like any other, so they go where the executor keeps them.
  if (theory) executor.assumptions.push(...decl.assumptions);
  if (intLimit !== undefined) executor.bounded.push(`int values stay within ±2^26`);
  if (!theory && input.shapes.some(containsArray))
    executor.bounded.push(`arrays hold at most ${plural(input.bound, 'element')}`);
  const result = executor.runLaw(input.jsFile, fn, params);
  const holds = resultOf(result);
  const safe = and(...executor.obligations);
  const facts = theory ? executor.assumptions : [...decl.assumptions, ...executor.assumptions];
  return { executor, decl, names, holds, safe, facts };
}

/** The SMT-LIB query for a problem without loops, as the prover sends it to Z3. */
function queryOf(input: ProveInput, { decl, executor, facts, holds, safe }: Problem): string[] {
  return [
    `(set-option :timeout ${input.timeoutMs})`,
    ...decl.lines,
    ...executor.freshDecls,
    ...executor.defs,
    ...facts.map((a) => `(assert ${a})`),
    `(assert (or (not ${holds}) (not ${safe})))`,
    '(check-sat)',
  ];
}

/**
 * The SMT-LIB problems the prover can send for a law (unbounded arrays, then bounded; the full safe range, then the
 * small-int retry), as the checkers read them. `tslaws accept` compares a certificate's problem hash with these, so a
 * certificate counts only for what the law proves now. A law the prover cannot model has none, and a law proved with
 * loop invariants is a Horn problem that gets no certificate.
 */
export function problemTexts(input: ProveInput): string[] {
  const texts = new Set<string>();
  for (const theory of [true, false]) {
    for (const limit of [undefined, ...(input.shapes.some(containsInt) ? [smallInts] : [])]) {
      try {
        const problem = buildProblem(input, limit, theory);
        if (problem.executor.predicates.length > 0) continue;
        if (theory && problem.decl.lengths.length === 0) continue;
        texts.add(problemText(queryOf(input, problem).join('\n')));
      } catch {
        // A limit the law cannot be built under proves nothing.
      }
    }
  }
  return [...texts];
}

/**
 * One proof attempt: first with arrays of any length and loop invariants found by a Horn solver, and when that cannot
 * express the law or reach a verdict, the bounded way (arrays and loops cut at `bound`).
 */
async function attempt(input: ProveInput, intLimit: bigint | undefined): Promise<ProofResult> {
  try {
    const unbounded = await attemptWith(input, intLimit, true);
    if (unbounded !== undefined) return unbounded;
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
  }
  return (await attemptWith(input, intLimit, false))!;
}

const declaredConstant = /^\(declare-const (\S+) (.+)\)$/;

/** The Horn clauses of the loops, closed over every constant, and the query that the law and its obligations hold. */
function hornSystem(executor: Executor, decl: Declarations, facts: string[], holds: string, safe: string): HornSystem {
  const constants = [...decl.declared];
  for (const line of executor.freshDecls) {
    const m = declaredConstant.exec(line);
    if (m !== null) constants.push({ name: m[1]!, sort: m[2]! });
  }
  return {
    predicates: executor.predicates,
    constants,
    clauses: [...executor.clauses, `(=> ${and(...facts, not(and(holds, safe)))} false)`],
    shared: executor.sharedTerms,
  };
}

/** The certificate of a proof by loop invariants: none can exist, and with `certify` on the law says so. */
function hornCertificate(input: ProveInput): { certificate?: Certificate } {
  if (input.certify === undefined || input.certify.mode === false) return {};
  return {
    certificate: {
      status: 'uncertified',
      reason: 'proved with loop invariants found by a Horn solver; cvc5 and Carcara have no proof of that to check',
    },
  };
}

/**
 * `theory`: arrays are of any length and loops get inferred invariants. Undefined when that changes nothing, or no
 * verdict came of it, and the caller runs the bounded proof.
 */
async function attemptWith(
  input: ProveInput,
  intLimit: bigint | undefined,
  theory: boolean,
): Promise<ProofResult | undefined> {
  const problem = buildProblem(input, intLimit, theory);
  const { executor, decl, names, holds, safe, facts } = problem;
  if (theory && decl.lengths.length === 0 && executor.predicates.length === 0) return undefined;
  if (executor.predicates.length > 0) {
    // Cvc5 does not solve Horn clauses, so a proof it must confirm is left to the bounded way.
    if (input.solvers?.includes('cvc5')) return undefined;
    const verdict = await solveHorn(
      hornSystem(executor, decl, facts, holds, safe),
      { z3: solve, external: runExternalSolvers },
      input.timeoutMs,
    );
    if (verdict.kind === 'disagree') return { kind: 'unsupported', reason: verdict.reason };
    if (verdict.kind !== 'safe') return undefined;
    const assumptions = [...assumptionsFor(input.shapes, intLimit), ...verdict.invariants, ...verdict.notes];
    // A Horn proof has no SMT-LIB refutation for cvc5 and Carcara to check, so it is never certified, and `require` fails it.
    const certificate = hornCertificate(input);
    return executor.bounded.length > 0
      ? { kind: 'bounded', limits: executor.bounded, assumptions, ...certificate }
      : { kind: 'proved', assumptions, ...certificate };
  }
  const query = queryOf(input, problem);
  const watch = decl.constants.map((c) => {
    const term = c.term ?? c.name;
    return c.sort === 'fp' ? `(fp.to_real ${term})` : term;
  });
  // TSLAWS_DEBUG=1 keeps each query next to the compiled output, to replay in z3.
  if (process.env.TSLAWS_DEBUG !== undefined) {
    const dir = join(dirname(input.jsFile), '..', 'smt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${input.law.name}.smt2`), `${query.join('\n')}\n(get-model)\n`);
  }
  const valueQuery = watch.length === 0 ? '' : `(get-value (${watch.join(' ')}))`;
  const { out, vals } = await solve(query.join('\n'), valueQuery, input.timeoutMs);
  const check = out;
  if (check.startsWith('unsat')) {
    const assumptions = assumptionsFor(input.shapes, intLimit);
    const text = query.join('\n');
    const certifyQuery = async (): Promise<{ certificate?: Certificate }> =>
      input.certify === undefined || input.certify.mode === false
        ? {}
        : { certificate: await certify(text, { timeoutMs: input.timeoutMs, keep: keepOf(input, input.certify) }) };
    if (executor.bounded.length > 0)
      return { kind: 'bounded', limits: executor.bounded, assumptions, ...(await certifyQuery()) };
    // Only a proof that would stand is sent to the second solver.
    const unconfirmed = await secondOpinion(input.solvers ?? [], text, input.timeoutMs);
    return unconfirmed === undefined
      ? { kind: 'proved', assumptions, ...(await certifyQuery()) }
      : {
          kind: 'bounded',
          limits: [unconfirmed],
          assumptions,
          // Nothing was proved, so nothing is certified; `require` must not let this pass.
          ...(input.certify === undefined || input.certify.mode === false
            ? {}
            : { certificate: { status: 'uncertified', reason: unconfirmed } as Certificate }),
        };
  }
  if (check.startsWith('unknown')) throw new Unsupported(`solver gave up within ${input.timeoutMs} ms`);
  if (!check.startsWith('sat')) throw new Unsupported(`solver said: ${check.split('\n')[0]}`);
  const values = watch.length === 0 ? '()' : vals;
  const pairs = parseSexp(values) as Sexp[];
  const model = new Map<string, number | bigint | boolean | string>();
  decl.constants.forEach((c, i) => {
    const pair = pairs[i];
    if (Array.isArray(pair) && pair.length === 2) model.set(c.name, modelValue(c.sort, pair[1]!));
  });
  if (decl.lengths.some((len) => Number(model.get(len) ?? 0) > shownElements))
    throw new Unsupported(`the counterexample has more than ${shownElements} elements`);
  const inputs = names.map((name, i) => jsValue(input.shapes[i], name, model));
  // A model may break only an obligation, or rest on float effects the replay does not share.
  if (await input.holds(inputs)) {
    const why = `Z3 model ${show(inputs)} passes in JavaScript (an integer may leave the safe range, an index may leave its array, or the bound cut the code)`;
    const advice = executor.hints.length === 0 ? '' : `; ${executor.hints.join('; ')}`;
    throw intLimit === undefined ? new SpuriousModel(why + advice) : new Unsupported(why + advice);
  }
  return { kind: 'refuted', model: names.map((n, i) => `${n} = ${show(inputs[i])}`).join(', '), inputs };
}
