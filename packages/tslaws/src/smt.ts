// The prover: symbolically executes the compiled JavaScript of a law (see symbolic.ts) and asks Z3 whether any input
// makes it return `false`, or break an obligation (an integer leaving the safe range, an index leaving its array).
//
//   proved    no such input exists, with no bound involved: the law holds for every input
//   bounded   no such input exists within the bounds the proof had to cut at (array length, loop count, recursion)
//   refuted   Z3 found an input and the compiled law really fails on it in JavaScript
//   unsupported  the code uses something that does not lower, Z3 gave up, or its model did not reproduce
//
// Numbers are IEEE doubles; a parameter typed `number` is a finite double (the generators exclude NaN and the
// infinities too). A parameter typed `int` (from 'tslaws') or `bigint` is an exact integer.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { Executor, SpuriousModel, Unsupported, and, type Value } from './symbolic.ts';
import type { ManifestLaw } from './types.ts';

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
  | { kind: 'proved' }
  | { kind: 'bounded'; limits: string[] }
  | { kind: 'refuted'; model: string; inputs: unknown[] }
  | { kind: 'unsupported'; reason: string };

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
  holds: (inputs: unknown[]) => boolean;
}

type Sort = 'fp' | 'int' | 'bool' | 'str';

interface Declared {
  name: string;
  sort: Sort;
}

const safeRange = (t: string): string => `(and (<= (- 9007199254740991) ${t}) (<= ${t} 9007199254740991))`;

class Declarations {
  readonly lines: string[] = [];
  readonly constants: Declared[] = [];
  readonly assumptions: string[] = [];

  constant(name: string, sort: Sort): void {
    const smt = { fp: '(_ FloatingPoint 11 53)', int: 'Int', bool: 'Bool', str: 'String' }[sort];
    this.lines.push(`(declare-const ${name} ${smt})`);
    this.constants.push({ name, sort });
  }
}

/** JavaScript strings stop near 2^29 units; a longer one would also push their lengths out of the safe integers. */
const maxStringLength = 536870888;

function declareParam(name: string, shape: Shape, bound: number, decl: Declarations, intLimit: bigint | undefined): Value {
  if (shape === 'number') {
    decl.constant(name, 'fp');
    decl.assumptions.push(`(and (not (fp.isNaN ${name})) (not (fp.isInfinite ${name})))`);
    return { k: 'fp', t: name };
  }
  if (shape === 'int') {
    decl.constant(name, 'int');
    decl.assumptions.push(intLimit === undefined ? safeRange(name) : `(and (<= (- ${intLimit}) ${name}) (<= ${name} ${intLimit}))`);
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
  if ('array' in shape) {
    const len = `${name}__len`;
    decl.constant(len, 'int');
    decl.assumptions.push(`(and (<= 0 ${len}) (<= ${len} ${bound}))`);
    const slots: Value[] = [];
    for (let i = 0; i < bound; i += 1) slots.push(declareParam(`${name}__${i}`, shape.array, bound, decl, intLimit));
    return { k: 'arr', len: { k: 'int', t: len }, slots, id: { escaped: true } };
  }
  const fields = new Map<string, Value>();
  for (const [field, fieldShape] of Object.entries(shape.fields))
    fields.set(field, declareParam(`${name}__${field}`, fieldShape, bound, decl, intLimit));
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
  for (const [field, fieldShape] of Object.entries(shape.fields)) out[field] = jsValue(fieldShape, `${name}__${field}`, model);
  return out;
}

// ---- Z3 ------------------------------------------------------------------------------------------------------

// Z3 runs in a worker thread: its WebAssembly build blocks the thread and `:timeout` does not always interrupt it,
// so a query that runs away is stopped by terminating the worker, and the next query starts a fresh one.
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { init } = require(workerData.z3);
const ready = init().then((api) => api.Z3);
parentPort.on('message', async ({ id, query, values }) => {
  try {
    const Z3 = await ready;
    const config = Z3.mk_config();
    const ctx = Z3.mk_context(config);
    let out = '';
    let vals = '';
    try {
      out = (await Z3.eval_smtlib2_string(ctx, query)).trim();
      vals = out.startsWith('sat') && values ? (await Z3.eval_smtlib2_string(ctx, values)).trim() : '';
    } finally {
      Z3.del_context(ctx);
      Z3.del_config(config);
    }
    parentPort.postMessage({ id, out, vals });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error && error.message || error) });
  }
});
`;

interface SolverReply {
  id: number;
  out?: string;
  vals?: string;
  error?: string;
}

let worker: Worker | undefined;
let nextId = 0;

function startWorker(): Worker {
  const w = new Worker(workerSource, { eval: true, workerData: { z3: createRequire(import.meta.url).resolve('z3-solver') } });
  w.unref();
  return w;
}

/** Runs `query` (and `values` when it is sat) in Z3, giving up on the whole worker after `timeoutMs` + a grace period. */
async function solve(query: string, values: string, timeoutMs: number): Promise<{ out: string; vals: string }> {
  worker ??= startWorker();
  const current = worker;
  const id = (nextId += 1);
  return new Promise((resolve, reject) => {
    const drop = (): void => {
      clearTimeout(timer);
      current.off('message', onMessage);
      current.off('error', onError);
    };
    const kill = (): void => {
      void current.terminate();
      if (worker === current) worker = undefined;
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
      } else resolve({ out: reply.out ?? '', vals: reply.vals ?? '' });
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
    throw error;
  }
}

function containsInt(shape: Shape): boolean {
  if (shape === 'int') return true;
  if (shape === undefined || typeof shape === 'string') return false;
  if ('array' in shape) return containsInt(shape.array);
  return Object.values(shape.fields).some(containsInt);
}

async function attempt(input: ProveInput, intLimit: bigint | undefined): Promise<ProofResult> {
  {
    const source = ts.createSourceFile(input.jsFile, readFileSync(input.jsFile, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const fn = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === input.law.name);
    if (fn === undefined || fn.body === undefined) throw new Unsupported('law function not found in the compiled output');
    if (fn.parameters.length !== input.shapes.length) throw new Unsupported('parameter count mismatch');
    const names = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
    const executor = new Executor(input.bound);
    const decl = new Declarations();
    const params = names.map((name, i) => declareParam(name, input.shapes[i], input.bound, decl, intLimit));
    if (intLimit !== undefined) executor.bounded.push(`int values stay within ±2^26`);
    if (input.shapes.some(containsArray)) executor.bounded.push(`arrays hold at most ${input.bound} elements`);
    const result = executor.runLaw(input.jsFile, fn, params);
    const holds = resultOf(result);
    const safe = and(...executor.obligations);
    const query = [
      `(set-option :timeout ${input.timeoutMs})`,
      ...decl.lines,
      ...executor.freshDecls,
      ...executor.defs,
      ...[...decl.assumptions, ...executor.assumptions].map((a) => `(assert ${a})`),
      `(assert (or (not ${holds}) (not ${safe})))`,
      '(check-sat)',
    ];
    const watch = decl.constants.map((c) => (c.sort === 'fp' ? `(fp.to_real ${c.name})` : c.name));
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
      return executor.bounded.length === 0 ? { kind: 'proved' } : { kind: 'bounded', limits: executor.bounded };
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
    const inputs = names.map((name, i) => jsValue(input.shapes[i], name, model));
    // A model may break only an obligation, or rest on float effects the replay does not share.
    if (input.holds(inputs)) {
      const why = `Z3 model ${show(inputs)} passes in JavaScript (an integer may leave the safe range, an index may leave its array, or the bound cut the code)`;
      throw intLimit === undefined ? new SpuriousModel(why) : new Unsupported(why);
    }
    return { kind: 'refuted', model: names.map((n, i) => `${n} = ${show(inputs[i])}`).join(', '), inputs };
  }
}
