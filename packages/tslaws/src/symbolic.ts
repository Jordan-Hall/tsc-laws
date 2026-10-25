// A symbolic executor for the compiled JavaScript of a law: it runs the law and the project functions it calls on
// SMT terms and collects what Z3 must refute.
//
//   assumptions  facts the law may rely on (`assume`, parameter domains, bounds)
//   obligations  facts the code must keep true on every path (integers stay exact, indexes stay in range)
//   bounded      the places where a loop, a recursion or an array was cut at the bound
//
// A proof with no `bounded` entry covers every input; with entries it covers every input within the bounds.
// Numbers are IEEE doubles (SMT-LIB floating point), except integer values, which are tracked exactly with an
// obligation that they stay within the safe integers, so the two agree with JavaScript.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

export class Unsupported extends Error {}

export const maxSafe = 9007199254740991n;

export interface Bool {
  k: 'bool';
  t: string;
}
export interface Int {
  k: 'int';
  t: string;
  c?: bigint;
}
export interface Big {
  k: 'big';
  t: string;
  c?: bigint;
}
export interface Fp {
  k: 'fp';
  t: string;
}
export interface Str {
  k: 'str';
  t: string;
  c?: string;
}
export interface Arr {
  k: 'arr';
  len: Int;
  slots: Value[];
  /** Shared by every version of one array: set when a second name could see it, which forbids mutation. */
  id: { escaped: boolean };
}
export interface Rec {
  k: 'rec';
  fields: Map<string, Value>;
}
export interface Undef {
  k: 'undef';
}
export type Value = Bool | Int | Big | Fp | Str | Arr | Rec | Undef;

type FunctionNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

interface FileIndex {
  functions: Map<string, FunctionNode>;
  imports: Map<string, string>;
  /** Module-level `const NAME = ...` and `exports.NAME = ...` initializers, evaluated on demand. */
  constants: Map<string, ts.Expression>;
}

class Frame {
  env = new Map<string, Value>();
  done = 'false';
  brk = 'false';
  cnt = 'false';
  ret: Value | undefined;
  readonly file: string;
  readonly depth: number;
  constructor(file: string, depth: number) {
    this.file = file;
    this.depth = depth;
  }

  fork(): Frame {
    const f = new Frame(this.file, this.depth);
    f.env = new Map(this.env);
    f.done = this.done;
    f.brk = this.brk;
    f.cnt = this.cnt;
    f.ret = this.ret;
    return f;
  }
}

const T: Bool = { k: 'bool', t: 'true' };
const F: Bool = { k: 'bool', t: 'false' };
const nan = '(_ NaN 11 53)';

export const bool = (t: string): Bool => (t === 'true' ? T : t === 'false' ? F : { k: 'bool', t });
const intLit = (c: bigint): Int => ({ k: 'int', t: c < 0n ? `(- ${-c})` : `${c}`, c });

export function not(t: string): string {
  return t === 'true' ? 'false' : t === 'false' ? 'true' : `(not ${t})`;
}
export function and(...ts_: string[]): string {
  const parts = ts_.filter((t) => t !== 'true');
  if (parts.includes('false')) return 'false';
  if (parts.length === 0) return 'true';
  return parts.length === 1 ? parts[0]! : `(and ${parts.join(' ')})`;
}
export function or(a: string, b: string): string {
  if (a === 'true' || b === 'true') return 'true';
  if (a === 'false') return b;
  if (b === 'false') return a;
  return `(or ${a} ${b})`;
}
const ite = (c: string, a: string, b: string): string =>
  c === 'true' ? a : c === 'false' ? b : a === b ? a : `(ite ${c} ${a} ${b})`;
const sorted = (a: string, b: string): [string, string] => (a <= b ? [a, b] : [b, a]);

function toFp(v: Int | Fp): Fp {
  if (v.k === 'fp') return v;
  const real = v.c !== undefined ? `${v.c < 0n ? `(- ${-v.c}.0)` : `${v.c}.0`}` : `(to_real ${v.t})`;
  return { k: 'fp', t: `((_ to_fp 11 53) RNE ${real})` };
}

function smtString(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    out += cp >= 32 && cp < 127 && ch !== '"' && ch !== '\\' ? ch : `\\u{${cp.toString(16)}}`;
  }
  return `"${out}"`;
}

/** Thrown when Z3's model is only a counterexample to an obligation, not to the law. */
export class SpuriousModel extends Unsupported {}

export class Executor {
  /** `define-fun`s naming the large terms, so merged values share structure instead of being printed twice. */
  readonly defs: string[] = [];
  /** Constants standing for the values of variables a loop with an invariant may change. */
  readonly freshDecls: string[] = [];
  private shared = 0;
  private havocked = 0;
  readonly assumptions: string[] = [];
  readonly obligations: string[] = [];
  readonly bounded: string[] = [];
  /** Advice for the reader when a proof fails on an obligation (a divisor that may be 0). */
  readonly hints: string[] = [];
  private readonly files = new Map<string, FileIndex>();

  readonly bound: number;
  constructor(bound: number) {
    this.bound = bound;
  }

  // ---- source index -------------------------------------------------------------------------------------------

  index(file: string): FileIndex {
    const known = this.files.get(file);
    if (known !== undefined) return known;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.JS,
    );
    const index: FileIndex = { functions: new Map(), imports: new Map(), constants: new Map() };
    this.files.set(file, index);
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.body !== undefined)
        index.functions.set(statement.name.text, statement);
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (!ts.isIdentifier(declaration.name) || init === undefined) continue;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) index.functions.set(declaration.name.text, init);
        else if (
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === 'require' &&
          init.arguments.length === 1 &&
          ts.isStringLiteral(init.arguments[0]!)
        ) {
          const specifier = init.arguments[0].text;
          if (specifier.startsWith('.')) {
            const base = resolve(dirname(file), specifier);
            index.imports.set(declaration.name.text, /\.[cm]?js$/.test(base) ? base : `${base}.js`);
          }
        } else if ((declaration.parent.flags & ts.NodeFlags.Const) !== 0)
          index.constants.set(declaration.name.text, init);
      }
    }
    this.indexExports(source, index);
    return index;
  }

  /** `exports.NAME = value` assigned exactly once, at the top level, is a constant; any other assignment spoils it. */
  private indexExports(source: ts.SourceFile, index: FileIndex): void {
    const endsVoid = (e: ts.Expression): boolean => {
      while (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) e = e.right;
      return ts.isVoidExpression(e);
    };
    const exported = (e: ts.Node): string | undefined =>
      ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'exports'
        ? e.name.text
        : undefined;
    const writes = new Map<string, number>();
    const visit = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && isAssignment(n.operatorToken.kind)) {
        const name = exported(n.left);
        if (name !== undefined && !endsVoid(n.right)) writes.set(name, (writes.get(name) ?? 0) + 1);
      }
      if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        const name = exported(n.operand);
        if (name !== undefined) writes.set(name, 2);
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
    for (const statement of source.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
      const e = statement.expression;
      const name = exported(e.left);
      if (e.operatorToken.kind !== ts.SyntaxKind.EqualsToken || name === undefined || endsVoid(e.right)) continue;
      if (writes.get(name) === 1 && !index.constants.has(name)) index.constants.set(name, e.right);
    }
  }

  private readonly constantValues = new Map<string, Value>();
  private readonly resolving = new Set<string>();

  /** The value of a module-level constant of `file` (a literal or arithmetic over other such constants). */
  private constantValue(file: string, name: string): Value | undefined {
    const init = this.index(file).constants.get(name);
    if (init === undefined) return undefined;
    const key = `${file}\0${name}`;
    const known = this.constantValues.get(key);
    if (known !== undefined) return known;
    if (this.resolving.has(key)) throw new Unsupported(`constant ${name} refers to itself`);
    this.simpleConstant(init, name);
    this.resolving.add(key);
    try {
      const value = this.ev(init, new Frame(file, 0), 'true');
      if (value.k === 'arr' || value.k === 'rec' || value.k === 'undef')
        throw new Unsupported(`constant ${name} is not a number, string or boolean`);
      this.constantValues.set(key, value);
      return value;
    } finally {
      this.resolving.delete(key);
    }
  }

  /** Only literals, names, property reads and operators: no calls, no functions, no object or array literals. */
  private simpleConstant(node: ts.Node, name: string): void {
    const ok =
      (node.kind >= ts.SyntaxKind.FirstPunctuation && node.kind <= ts.SyntaxKind.LastPunctuation) ||
      ts.isNumericLiteral(node) ||
      ts.isBigIntLiteral(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isTemplateSpan(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      ts.isIdentifier(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isConditionalExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) ||
      (ts.isPrefixUnaryExpression(node) &&
        node.operator !== ts.SyntaxKind.PlusPlusToken &&
        node.operator !== ts.SyntaxKind.MinusMinusToken) ||
      (ts.isBinaryExpression(node) &&
        !isAssignment(node.operatorToken.kind) &&
        node.operatorToken.kind !== ts.SyntaxKind.CommaToken);
    if (!ok) throw new Unsupported(`constant ${name} is not a simple constant expression`);
    ts.forEachChild(node, (child) => this.simpleConstant(child, name));
  }

  /** `exports.NAME` in this file, or `module_1.NAME` for an import: a module constant, when there is one. */
  private moduleConstant(owner: string, name: string, f: Frame): Value | undefined {
    if (f.env.has(owner)) return undefined;
    if (owner === 'exports') return this.constantValue(f.file, name);
    const file = this.index(f.file).imports.get(owner);
    return file === undefined ? undefined : this.constantValue(file, name);
  }

  // ---- entry --------------------------------------------------------------------------------------------------

  /** Runs the law on `params`; the result is what it returns (`undefined` counts as holding). */
  runLaw(file: string, fn: FunctionNode, params: Value[]): Value {
    const f = new Frame(file, 0);
    this.bindParams(f, fn, params);
    this.body(fn, f, 'true');
    return f.ret ?? { k: 'undef' };
  }

  private bindParams(f: Frame, fn: FunctionNode, args: Value[]): void {
    if (fn.parameters.length !== args.length) throw new Unsupported('call has the wrong number of arguments');
    fn.parameters.forEach((parameter, i) => {
      if (
        !ts.isIdentifier(parameter.name) ||
        parameter.initializer !== undefined ||
        parameter.dotDotDotToken !== undefined
      )
        throw new Unsupported('parameters must be plain identifiers');
      f.env.set(parameter.name.text, args[i]!);
    });
  }

  private body(fn: FunctionNode, f: Frame, pc: string): void {
    const body = fn.body;
    if (body === undefined) throw new Unsupported('function has no body');
    if (ts.isBlock(body)) this.execList(body.statements, f, pc);
    else {
      f.ret = this.ev(body, f, pc);
      f.done = 'true';
    }
  }

  // ---- guards -------------------------------------------------------------------------------------------------

  private active(f: Frame): string {
    return and(not(f.done), not(f.brk), not(f.cnt));
  }

  private guard(f: Frame, pc: string): string {
    return and(pc, this.active(f));
  }

  private oblige(f: Frame, pc: string, fact: string): void {
    const guard = this.guard(f, pc);
    if (fact === 'true' || guard === 'false') return;
    this.obligations.push(guard === 'true' ? fact : `(=> ${guard} ${fact})`);
  }

  private assume(f: Frame, pc: string, fact: string): void {
    const guard = this.guard(f, pc);
    if (fact === 'true' || guard === 'false') return;
    this.assumptions.push(guard === 'true' ? fact : `(=> ${guard} ${fact})`);
  }

  private cut(f: Frame, pc: string, reach: string, why: string): void {
    // Paths that would run past the bound are excluded, which is what makes the result bounded.
    this.assume(f, pc, not(reach));
    if (!this.bounded.includes(why)) this.bounded.push(why);
  }

  // ---- values -------------------------------------------------------------------------------------------------

  private share<V extends Value>(v: V): V {
    if (v.k === 'arr' || v.k === 'rec' || v.k === 'undef') return v;
    const t = (v as Bool | Int | Big | Fp | Str).t;
    if (t.length < 160) return v;
    const sort = { bool: 'Bool', int: 'Int', big: 'Int', fp: '(_ FloatingPoint 11 53)', str: 'String' }[v.k];
    const name = `_s${this.shared++}`;
    this.defs.push(`(define-fun ${name} () ${sort} ${t})`);
    return { ...v, t: name };
  }

  private merge(c: string, a: Value, b: Value, slot = false): Value {
    if (c === 'true') return a;
    if (c === 'false') return b;
    if (slot && a.k === 'undef') return b;
    if (slot && b.k === 'undef') return a;
    if ((a.k === 'int' || a.k === 'fp') && (b.k === 'int' || b.k === 'fp') && a.k !== b.k) {
      return this.share({ k: 'fp', t: ite(c, toFp(a).t, toFp(b).t) });
    }
    if (a.k !== b.k) throw new Unsupported(`a value is a ${a.k} on one path and a ${b.k} on another`);
    switch (a.k) {
      case 'bool':
        return this.share(bool(ite(c, a.t, (b as Bool).t)));
      case 'int': {
        const o = b as Int;
        return this.share({ k: 'int', t: ite(c, a.t, o.t), c: a.c !== undefined && a.c === o.c ? a.c : undefined });
      }
      case 'big': {
        const o = b as Big;
        return this.share({ k: 'big', t: ite(c, a.t, o.t), c: a.c !== undefined && a.c === o.c ? a.c : undefined });
      }
      case 'fp':
        return this.share({ k: 'fp', t: ite(c, a.t, (b as Fp).t) });
      case 'str': {
        const o = b as Str;
        return this.share({ k: 'str', t: ite(c, a.t, o.t), c: a.c !== undefined && a.c === o.c ? a.c : undefined });
      }
      case 'undef':
        return a;
      case 'arr': {
        const o = b as Arr;
        const n = Math.max(a.slots.length, o.slots.length);
        const slots: Value[] = [];
        for (let i = 0; i < n; i += 1)
          slots.push(this.merge(c, a.slots[i] ?? { k: 'undef' }, o.slots[i] ?? { k: 'undef' }, true));
        if (a.id !== o.id) a.id.escaped = o.id.escaped = true;
        return { k: 'arr', len: this.merge(c, a.len, o.len) as Int, slots, id: a.id };
      }
      case 'rec': {
        const o = b as Rec;
        const fields = new Map<string, Value>();
        for (const [name, v] of a.fields) {
          const w = o.fields.get(name);
          if (w === undefined) throw new Unsupported('records differ in shape across paths');
          fields.set(name, this.merge(c, v, w));
        }
        return { k: 'rec', fields };
      }
    }
  }

  private mergeFrames(c: string, a: Frame, b: Frame, into: Frame): void {
    const env = new Map<string, Value>();
    for (const [name, v] of a.env) {
      const w = b.env.get(name);
      if (w !== undefined) env.set(name, this.merge(c, v, w));
    }
    into.env = env;
    into.done = ite(c, a.done, b.done);
    into.brk = ite(c, a.brk, b.brk);
    into.cnt = ite(c, a.cnt, b.cnt);
    into.ret = a.ret === undefined ? b.ret : b.ret === undefined ? a.ret : this.merge(c, a.ret, b.ret);
  }

  private setVar(f: Frame, name: string, v: Value): void {
    const old = f.env.get(name);
    const act = this.active(f);
    f.env.set(name, old === undefined || act === 'true' ? v : this.merge(act, v, old));
  }

  private asBool(v: Value): string {
    if (v.k !== 'bool') throw new Unsupported(`a ${v.k} was used as a condition`);
    return v.t;
  }

  /** `v` used as a value somewhere other than a method receiver or index: a second name may now reach an array. */
  private escape(v: Value): Value {
    if (v.k === 'arr') v.id.escaped = true;
    if (v.k === 'rec') for (const field of v.fields.values()) this.escape(field);
    return v;
  }

  // ---- statements ---------------------------------------------------------------------------------------------

  private execList(statements: readonly ts.Statement[], f: Frame, pc: string): void {
    for (const statement of statements) this.exec(statement, f, pc);
  }

  private exec(node: ts.Statement, f: Frame, pc: string): void {
    if (ts.isVariableStatement(node)) return this.declarations(node.declarationList, f, pc);
    if (ts.isExpressionStatement(node)) {
      this.ev(node.expression, f, pc, true);
      return;
    }
    if (ts.isReturnStatement(node)) {
      const v =
        node.expression === undefined ? ({ k: 'undef' } as Value) : this.escape(this.ev(node.expression, f, pc));
      const act = this.active(f);
      f.ret = f.ret === undefined ? v : this.merge(act, v, f.ret, true);
      f.done = or(f.done, act);
      return;
    }
    if (ts.isIfStatement(node)) return this.ifStatement(node, f, pc);
    if (ts.isBlock(node)) return this.block(node.statements, f, pc);
    if (ts.isForStatement(node)) return this.forStatement(node, f, pc);
    if (ts.isWhileStatement(node)) return this.loop(undefined, node.expression, undefined, node.statement, f, pc);
    if (ts.isForOfStatement(node)) return this.forOf(node, f, pc);
    if (ts.isBreakStatement(node)) {
      if (node.label !== undefined) throw new Unsupported('labelled break');
      f.brk = or(f.brk, this.active(f));
      return;
    }
    if (ts.isContinueStatement(node)) {
      if (node.label !== undefined) throw new Unsupported('labelled continue');
      f.cnt = or(f.cnt, this.active(f));
      return;
    }
    if (ts.isEmptyStatement(node)) return;
    throw new Unsupported(`statement ${ts.SyntaxKind[node.kind]} does not lower`);
  }

  private block(statements: readonly ts.Statement[], f: Frame, pc: string): void {
    const outer = new Set(f.env.keys());
    this.execList(statements, f, pc);
    for (const name of [...f.env.keys()]) if (!outer.has(name)) f.env.delete(name);
  }

  private declarations(list: ts.VariableDeclarationList, f: Frame, pc: string): void {
    for (const declaration of list.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined)
        throw new Unsupported('variable declarations need a name and an initializer');
      const name = declaration.name.text;
      if (f.env.has(name)) throw new Unsupported(`${name} is declared twice or shadows another name`);
      const value = this.ev(declaration.initializer, f, pc, false, true);
      // A new array has one name, so it may be changed; anything else may be an alias of an array someone else holds.
      f.env.set(name, this.isNewArray(declaration.initializer) ? value : this.escape(value));
    }
  }

  private isNewArray(node: ts.Expression): boolean {
    let e = node;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    if (ts.isArrayLiteralExpression(e)) return true;
    return (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      ['map', 'filter', 'slice', 'concat'].includes(e.expression.name.text)
    );
  }

  private ifStatement(node: ts.IfStatement, f: Frame, pc: string): void {
    const c = this.asBool(this.ev(node.expression, f, pc));
    if (c === 'true') return this.branch(node.thenStatement, f, pc);
    if (c === 'false') {
      if (node.elseStatement !== undefined) this.branch(node.elseStatement, f, pc);
      return;
    }
    const a = f.fork();
    const b = f.fork();
    this.branch(node.thenStatement, a, and(pc, c));
    if (node.elseStatement !== undefined) this.branch(node.elseStatement, b, and(pc, not(c)));
    this.mergeFrames(c, a, b, f);
  }

  private branch(node: ts.Statement, f: Frame, pc: string): void {
    this.block(ts.isBlock(node) ? node.statements : [node], f, pc);
  }

  private forStatement(node: ts.ForStatement, f: Frame, pc: string): void {
    const outer = new Set(f.env.keys());
    if (node.initializer !== undefined) {
      if (ts.isVariableDeclarationList(node.initializer)) this.declarations(node.initializer, f, pc);
      else this.ev(node.initializer, f, pc, true);
    }
    this.loop(undefined, node.condition, node.incrementor, node.statement, f, pc);
    for (const name of [...f.env.keys()]) if (!outer.has(name)) f.env.delete(name);
  }

  private loop(
    _init: undefined,
    condition: ts.Expression | undefined,
    incrementor: ts.Expression | undefined,
    body: ts.Statement,
    f: Frame,
    pc: string,
  ): void {
    const invariants = this.invariantsOf(body);
    if (invariants !== undefined) {
      this.invariantLoop(condition, incrementor, invariants.rest, invariants.exprs, f, pc);
      return;
    }
    for (let iteration = 0; ; iteration += 1) {
      const c = condition === undefined ? 'true' : this.asBool(this.ev(condition, f, this.guard(f, pc)));
      const go = and(this.active(f), c);
      if (go === 'false') break;
      if (iteration >= this.bound) {
        this.cut(f, pc, go, `loops run at most ${this.bound} times`);
        break;
      }
      const run = f.fork();
      this.branch(body, run, and(pc, c));
      run.cnt = 'false';
      if (incrementor !== undefined) this.ev(incrementor, run, and(pc, c), true);
      this.mergeFrames(go, run, f, f);
    }
    f.brk = 'false';
  }

  // ---- loops with invariants: a proof for every number of iterations -------------------------------------------

  /** The `invariant(...)` calls leading a loop body, and the statements after them. */
  private invariantsOf(body: ts.Statement): { exprs: ts.Expression[]; rest: ts.Statement[] } | undefined {
    const statements = ts.isBlock(body) ? body.statements : [body];
    const exprs: ts.Expression[] = [];
    let i = 0;
    for (; i < statements.length; i += 1) {
      const s = statements[i]!;
      if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression)) break;
      const callee = this.calleeOf(s.expression);
      if (callee?.name !== 'invariant' || s.expression.arguments.length !== 1) break;
      exprs.push(s.expression.arguments[0]!);
    }
    return exprs.length === 0 ? undefined : { exprs, rest: statements.slice(i) };
  }

  private calleeOf(node: ts.CallExpression): { owner: string | undefined; name: string } | undefined {
    let callee: ts.Expression = node.expression;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken) callee = callee.right;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    if (ts.isIdentifier(callee)) return { owner: undefined, name: callee.text };
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression))
      return { owner: callee.expression.text, name: callee.name.text };
    return undefined;
  }

  /** The names a piece of code assigns, increments or mutates. */
  private modifiedNames(nodes: readonly ts.Node[]): Set<string> {
    const names = new Set<string>();
    const visit = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && isAssignment(n.operatorToken.kind)) {
        let target: ts.Expression = n.left;
        while (ts.isElementAccessExpression(target) || ts.isPropertyAccessExpression(target))
          target = target.expression;
        if (ts.isIdentifier(target)) names.add(target.text);
      }
      if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) &&
        ts.isIdentifier(n.operand)
      )
        names.add(n.operand.text);
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ts.isIdentifier(n.expression.expression)
      )
        if (['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill'].includes(n.expression.name.text))
          names.add(n.expression.expression.text);
      ts.forEachChild(n, visit);
    };
    for (const n of nodes) visit(n);
    return names;
  }

  /** A constant standing for an arbitrary value of the same kind as `v`, with the facts every such value has. */
  private fresh(v: Value): Value {
    const declare = (sort: string): string => {
      const name = `_h${this.havocked++}`;
      this.freshDecls.push(`(declare-const ${name} ${sort})`);
      return name;
    };
    switch (v.k) {
      case 'int': {
        const name = declare('Int');
        this.assumptions.push(`(and (<= (- ${maxSafe}) ${name}) (<= ${name} ${maxSafe}))`);
        return { k: 'int', t: name };
      }
      case 'big':
        return { k: 'big', t: declare('Int') };
      case 'fp':
        return { k: 'fp', t: declare('(_ FloatingPoint 11 53)') };
      case 'bool':
        return { k: 'bool', t: declare('Bool') };
      case 'str': {
        const name = declare('String');
        this.assumptions.push(
          `(and (str.in_re ${name} (re.* (re.range "\u{0}" "\u{ffff}"))) (<= (str.len ${name}) 536870888))`,
        );
        return { k: 'str', t: name };
      }
      case 'rec': {
        const fields = new Map<string, Value>();
        for (const [field, value] of v.fields) fields.set(field, this.fresh(value));
        return { k: 'rec', fields };
      }
      case 'arr': {
        // The array keeps the room it had, so the claim holds for arrays of at most that many elements.
        const room = v.slots.length;
        const len = declare('Int');
        this.assumptions.push(`(and (<= 0 ${len}) (<= ${len} ${room}))`);
        const why = `arrays changed in an invariant loop hold at most ${room} elements`;
        if (!this.bounded.includes(why)) this.bounded.push(why);
        return {
          k: 'arr',
          len: { k: 'int', t: len },
          slots: v.slots.map((slot) => (slot.k === 'undef' ? slot : this.fresh(slot))),
          id: { escaped: v.id.escaped },
        };
      }
      case 'undef':
        return v;
    }
  }

  private invariantTerm(exprs: readonly ts.Expression[], f: Frame, pc: string): string {
    return and(...exprs.map((e) => this.asBool(this.ev(e, f, pc))));
  }

  /**
   * Hoare-style: the invariant must hold on entry and after any iteration that starts from a state satisfying it; the
   * code after the loop sees an arbitrary such state where the condition is false. No unrolling, so no bound.
   */
  private invariantLoop(
    condition: ts.Expression | undefined,
    incrementor: ts.Expression | undefined,
    rest: readonly ts.Statement[],
    exprs: readonly ts.Expression[],
    f: Frame,
    pc: string,
  ): void {
    this.oblige(f, pc, this.invariantTerm(exprs, f, this.guard(f, pc)));
    const touched = this.modifiedNames([...rest, ...(incrementor === undefined ? [] : [incrementor])]);
    const kinds = new Map<string, Value['k']>();
    for (const name of touched) {
      const old = f.env.get(name);
      if (old === undefined) continue;
      kinds.set(name, old.k);
      f.env.set(name, this.fresh(old));
    }
    const holds = this.invariantTerm(exprs, f, this.guard(f, pc));
    this.assume(f, pc, holds);
    const c = condition === undefined ? 'true' : this.asBool(this.ev(condition, f, this.guard(f, pc)));

    const run = f.fork();
    const inside = and(pc, holds, c);
    this.execList(rest, run, inside);
    run.cnt = 'false';
    if (incrementor !== undefined) this.ev(incrementor, run, inside, true);
    if (f.brk !== 'false' || f.cnt !== 'false')
      throw new Unsupported('a loop with an invariant inside a break or continue');
    for (const [name, kind] of kinds) {
      if (run.env.get(name)?.k !== kind) throw new Unsupported(`${name} changes kind inside a loop with an invariant`);
    }
    this.oblige(run, inside, this.invariantTerm(exprs, run, this.guard(run, inside)));

    // After the loop: any state satisfying the invariant in which the condition is false, or the state of an iteration
    // that started from such a state and left through a return or break. Which of the two is not known: a fresh choice.
    const left = or(and(run.done, not(f.done)), run.brk);
    if (left === 'false') {
      this.assume(f, pc, not(c));
    } else {
      const choice = `_h${this.havocked++}`;
      this.freshDecls.push(`(declare-const ${choice} Bool)`);
      this.assume(f, pc, or(not(choice), and(holds, c, left)));
      this.assume(f, pc, or(choice, not(c)));
      run.brk = 'false';
      run.cnt = 'false';
      this.mergeFrames(choice, run, f, f);
    }
    f.brk = 'false';
  }

  private forOf(node: ts.ForOfStatement, f: Frame, pc: string): void {
    if (
      !ts.isVariableDeclarationList(node.initializer) ||
      node.initializer.declarations.length !== 1 ||
      !ts.isIdentifier(node.initializer.declarations[0]!.name)
    )
      throw new Unsupported('for-of needs one plain loop variable');
    const name = node.initializer.declarations[0]!.name.text;
    if (f.env.has(name)) throw new Unsupported(`${name} shadows another name`);
    const source = this.ev(node.expression, f, pc, false, true);
    if (source.k !== 'arr') throw new Unsupported('for-of over something other than an array');
    for (let k = 0; k < source.slots.length; k += 1) {
      const inRange = this.lt(intLit(BigInt(k)), source.len).t;
      const go = and(this.active(f), inRange);
      if (go === 'false') break;
      const run = f.fork();
      run.env.set(name, source.slots[k]!);
      this.branch(node.statement, run, and(pc, inRange));
      run.cnt = 'false';
      run.env.delete(name);
      this.mergeFrames(go, run, f, f);
    }
    f.brk = 'false';
  }

  // ---- expressions --------------------------------------------------------------------------------------------

  /** `statement`: the value is unused, so mutations are allowed. `value`: an identifier here is a use, not an alias. */
  ev(node: ts.Expression, f: Frame, pc: string, statement = false, plain = false): Value {
    void plain;
    if (ts.isParenthesizedExpression(node)) return this.ev(node.expression, f, pc, statement);
    if (ts.isNumericLiteral(node)) return this.numberLiteral(node.text);
    if (ts.isBigIntLiteral(node))
      return { k: 'big', t: intLit(BigInt(node.text.slice(0, -1))).t, c: BigInt(node.text.slice(0, -1)) };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return { k: 'str', t: smtString(node.text), c: node.text };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return T;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return F;
    if (ts.isIdentifier(node)) {
      if (node.text === 'undefined') return { k: 'undef' };
      const v = f.env.get(node.text) ?? this.constantValue(f.file, node.text);
      if (v === undefined) throw new Unsupported(`unknown name ${node.text}`);
      return v;
    }
    if (ts.isTemplateExpression(node)) return this.template(node, f, pc);
    if (ts.isPrefixUnaryExpression(node)) return this.prefix(node, f, pc, statement);
    if (ts.isPostfixUnaryExpression(node)) return this.update(node.operand, node.operator, f, pc, true);
    if (ts.isConditionalExpression(node)) {
      const c = this.asBool(this.ev(node.condition, f, pc));
      if (c === 'true') return this.ev(node.whenTrue, f, pc);
      if (c === 'false') return this.ev(node.whenFalse, f, pc);
      const a = this.ev(node.whenTrue, f, and(pc, c));
      const b = this.ev(node.whenFalse, f, and(pc, not(c)));
      return this.merge(c, a, b);
    }
    if (ts.isBinaryExpression(node)) return this.binary(node, f, pc);
    if (ts.isPropertyAccessExpression(node)) return this.property(node, f, pc);
    if (ts.isElementAccessExpression(node)) return this.element(node, f, pc);
    if (ts.isArrayLiteralExpression(node)) return this.arrayLiteral(node, f, pc);
    if (ts.isObjectLiteralExpression(node)) return this.objectLiteral(node, f, pc);
    if (ts.isCallExpression(node)) return this.call(node, f, pc, statement);
    if (ts.isTypeOfExpression(node)) return this.typeOf(this.ev(node.expression, f, pc));
    if (ts.isAsExpression(node) || ts.isNonNullExpression(node)) return this.ev(node.expression, f, pc);
    throw new Unsupported(`expression ${ts.SyntaxKind[node.kind]} does not lower`);
  }

  private numberLiteral(text: string): Value {
    if (/^\d+$/.test(text) && BigInt(text) <= maxSafe) return intLit(BigInt(text));
    if (/e/i.test(text) || /^0[xob]/i.test(text)) throw new Unsupported('literal needs exponent or radix notation');
    const value = Number(text);
    if (Number.isInteger(value) && Math.abs(value) <= Number(maxSafe)) return intLit(BigInt(value));
    return { k: 'fp', t: `((_ to_fp 11 53) RNE ${text})` };
  }

  private typeOf(v: Value): Value {
    const name = {
      int: 'number',
      fp: 'number',
      big: 'bigint',
      bool: 'boolean',
      str: 'string',
      arr: 'object',
      rec: 'object',
      undef: 'undefined',
    }[v.k];
    return { k: 'str', t: smtString(name), c: name };
  }

  private template(node: ts.TemplateExpression, f: Frame, pc: string): Value {
    let result: Value = { k: 'str', t: smtString(node.head.text), c: node.head.text };
    for (const span of node.templateSpans) {
      const part = this.ev(span.expression, f, pc);
      if (part.k !== 'str') throw new Unsupported('template literals lower only with string parts');
      result = this.concat(result as Str, part);
      result = this.concat(result as Str, { k: 'str', t: smtString(span.literal.text), c: span.literal.text });
    }
    return result;
  }

  private concat(a: Str, b: Str): Str {
    if (a.c !== undefined && b.c !== undefined) return { k: 'str', t: smtString(a.c + b.c), c: a.c + b.c };
    return { k: 'str', t: `(str.++ ${a.t} ${b.t})` };
  }

  private prefix(node: ts.PrefixUnaryExpression, f: Frame, pc: string, statement: boolean): Value {
    if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      return this.update(node.operand, node.operator, f, pc, false, statement);
    const v = this.ev(node.operand, f, pc);
    switch (node.operator) {
      case ts.SyntaxKind.ExclamationToken:
        return bool(not(this.asBool(v)));
      case ts.SyntaxKind.MinusToken:
        return this.negate(v, f, pc);
      case ts.SyntaxKind.PlusToken:
        if (v.k === 'int' || v.k === 'fp') return v;
    }
    throw new Unsupported('unary operator does not lower');
  }

  private negate(v: Value, f: Frame, pc: string): Value {
    if (v.k === 'fp') return { k: 'fp', t: `(fp.neg ${v.t})` };
    if (v.k === 'int') return this.exact(v.c !== undefined ? intLit(-v.c) : { k: 'int', t: `(- ${v.t})` }, f, pc);
    if (v.k === 'big')
      return {
        k: 'big',
        t: v.c !== undefined ? intLit(-v.c).t : `(- ${v.t})`,
        c: v.c === undefined ? undefined : -v.c,
      };
    throw new Unsupported('negation of a non-number');
  }

  /** An integer result must stay within the safe integers or JavaScript would round it. */
  private exact(v: Int, f: Frame, pc: string): Int {
    if (v.c !== undefined) {
      if (v.c > maxSafe || v.c < -maxSafe) this.oblige(f, pc, 'false');
      return v;
    }
    this.oblige(f, pc, `(and (<= (- ${maxSafe}) ${v.t}) (<= ${v.t} ${maxSafe}))`);
    return v;
  }

  private update(
    target: ts.Expression,
    op: ts.SyntaxKind,
    f: Frame,
    pc: string,
    postfix: boolean,
    statement = false,
  ): Value {
    if (!ts.isIdentifier(target)) throw new Unsupported('++/-- only on plain names');
    const old = f.env.get(target.text);
    if (old === undefined) throw new Unsupported(`unknown name ${target.text}`);
    const delta = op === ts.SyntaxKind.PlusPlusToken ? '+' : '-';
    const next = this.arith(delta, old, intLit(1n), f, pc);
    this.setVar(f, target.text, next);
    void statement;
    return postfix ? old : next;
  }

  private property(node: ts.PropertyAccessExpression, f: Frame, pc: string): Value {
    const name = node.name.text;
    if (ts.isIdentifier(node.expression) && node.expression.text === 'Math') {
      if (name === 'PI') return { k: 'fp', t: '((_ to_fp 11 53) RNE 3.141592653589793)' };
      throw new Unsupported(`Math.${name} does not lower`);
    }
    if (ts.isIdentifier(node.expression)) {
      const constant = this.moduleConstant(node.expression.text, name, f);
      if (constant !== undefined) return constant;
    }
    const base = this.ev(node.expression, f, pc);
    if (name === 'length') {
      if (base.k === 'arr') return base.len;
      if (base.k === 'str')
        return base.c !== undefined ? intLit(BigInt(base.c.length)) : { k: 'int', t: `(str.len ${base.t})` };
    }
    if (base.k === 'rec') {
      const field = base.fields.get(name);
      if (field !== undefined) return field;
    }
    throw new Unsupported(`property ${name} is not modelled`);
  }

  private element(node: ts.ElementAccessExpression, f: Frame, pc: string): Value {
    const base = this.ev(node.expression, f, pc);
    const index = this.ev(node.argumentExpression, f, pc);
    if (index.k !== 'int') throw new Unsupported('index is not an integer value');
    if (base.k === 'arr') return this.readSlot(base, index, f, pc);
    if (base.k === 'str') {
      this.oblige(f, pc, and(this.le(intLit(0n), index).t, this.lt(index, { k: 'int', t: `(str.len ${base.t})` }).t));
      return { k: 'str', t: `(str.at ${base.t} ${index.t})` };
    }
    throw new Unsupported('indexing something other than an array or string');
  }

  private readSlot(arr: Arr, index: Int, f: Frame, pc: string): Value {
    this.oblige(f, pc, and(this.le(intLit(0n), index).t, this.lt(index, arr.len).t));
    if (index.c !== undefined) {
      const slot = arr.slots[Number(index.c)];
      if (slot === undefined || slot.k === 'undef') throw new Unsupported('read of an unset array slot');
      return slot;
    }
    const live = arr.slots.map((s, i) => [s, i] as const).filter(([s]) => s.k !== 'undef');
    if (live.length === 0) throw new Unsupported('read of an empty array');
    let result: Value = live[live.length - 1]![0];
    for (let n = live.length - 2; n >= 0; n -= 1) {
      const [slot, i] = live[n]!;
      result = this.merge(`(= ${index.t} ${i})`, slot, result);
    }
    return result;
  }

  private arrayLiteral(node: ts.ArrayLiteralExpression, f: Frame, pc: string): Value {
    let out: Arr = { k: 'arr', len: intLit(0n), slots: [], id: { escaped: false } };
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        const source = this.spreadSource(element.expression, f, pc);
        out = this.concatArrays(out, source);
      } else {
        out = this.push(out, this.escape(this.ev(element, f, pc)), 'true', pc, f, true);
      }
    }
    while (out.slots.length < this.bound) out.slots.push({ k: 'undef' });
    return out;
  }

  /** `...xs`, or `...new Set(xs)` which removes duplicates. */
  private spreadSource(node: ts.Expression, f: Frame, pc: string): Arr {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Set' &&
      node.arguments?.length === 1
    ) {
      return this.dedupe(this.arrayOf(this.ev(node.arguments[0]!, f, pc)), f, pc);
    }
    return this.arrayOf(this.ev(node, f, pc));
  }

  private arrayOf(v: Value): Arr {
    if (v.k !== 'arr') throw new Unsupported(`a ${v.k} was used as an array`);
    return v;
  }

  private objectLiteral(node: ts.ObjectLiteralExpression, f: Frame, pc: string): Value {
    const fields = new Map<string, Value>();
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)))
        fields.set(property.name.text, this.escape(this.ev(property.initializer, f, pc)));
      else if (ts.isShorthandPropertyAssignment(property))
        fields.set(property.name.text, this.escape(this.ev(property.name, f, pc)));
      else throw new Unsupported('object literal member does not lower');
    }
    return { k: 'rec', fields };
  }

  // ---- arithmetic and comparison ------------------------------------------------------------------------------

  private arith(op: string, a: Value, b: Value, f: Frame, pc: string): Value {
    return this.share(this.arithRaw(op, a, b, f, pc));
  }

  private arithRaw(op: string, a: Value, b: Value, f: Frame, pc: string): Value {
    if (a.k === 'str' && b.k === 'str' && op === '+') return this.concat(a, b);
    if (a.k === 'big' && b.k === 'big') {
      if (op === '/' || op === '%') throw new Unsupported('bigint division does not lower');
      const c =
        a.c !== undefined && b.c !== undefined
          ? op === '+'
            ? a.c + b.c
            : op === '-'
              ? a.c - b.c
              : a.c * b.c
          : undefined;
      return { k: 'big', t: c !== undefined ? intLit(c).t : `(${op} ${a.t} ${b.t})`, c };
    }
    if (a.k === 'int' && b.k === 'int' && op === '%') return this.intDivide('mod', a, b, f, pc);
    if (a.k === 'int' && b.k === 'int' && op !== '/' && op !== '%') {
      if (a.c !== undefined && b.c !== undefined) {
        return this.exact(intLit(op === '+' ? a.c + b.c : op === '-' ? a.c - b.c : a.c * b.c), f, pc);
      }
      return this.exact({ k: 'int', t: `(${op} ${a.t} ${b.t})` }, f, pc);
    }
    if ((a.k === 'int' || a.k === 'fp') && (b.k === 'int' || b.k === 'fp')) {
      if (op === '%') throw new Unsupported('% does not lower');
      const x = toFp(a);
      const y = toFp(b);
      switch (op) {
        case '+': {
          const [p, q] = sorted(x.t, y.t);
          return { k: 'fp', t: `(fp.add RNE ${p} ${q})` };
        }
        case '*': {
          const [p, q] = sorted(x.t, y.t);
          return { k: 'fp', t: `(fp.mul RNE ${p} ${q})` };
        }
        case '-':
          return { k: 'fp', t: `(fp.sub RNE ${x.t} ${y.t})` };
        case '/':
          return { k: 'fp', t: `(fp.div RNE ${x.t} ${y.t})` };
      }
    }
    throw new Unsupported(`operator ${op} on ${a.k} and ${b.k} does not lower`);
  }

  private hint(text: string): void {
    if (!this.hints.includes(text)) this.hints.push(text);
  }

  /** `a / b` when `node` is one (through parentheses), the operand of a rounding that may make it integer division. */
  private divisionOf(node: ts.Expression): ts.BinaryExpression | undefined {
    let e = node;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    return ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.SlashToken ? e : undefined;
  }

  /** `Math.floor/ceil/trunc/round(a / b)`: exact integer division when both are `int`, else the double path. */
  private roundedDivision(
    mode: 'floor' | 'ceil' | 'trunc' | 'round',
    node: ts.BinaryExpression,
    f: Frame,
    pc: string,
  ): Value {
    const a = this.ev(node.left, f, pc);
    const b = this.ev(node.right, f, pc);
    if (a.k === 'int' && b.k === 'int') return this.share(this.intDivide(mode, a, b, f, pc));
    return this.math(mode, [this.arith('/', a, b, f, pc)], f, pc);
  }

  /** `x | 0` (ToInt32): exact when `x` is an int, or an integer division, that fits in 32 bits. */
  private toInt32(node: ts.Expression, f: Frame, pc: string): Value {
    const division = this.divisionOf(node);
    let v: Value;
    if (division !== undefined) {
      const a = this.ev(division.left, f, pc);
      const b = this.ev(division.right, f, pc);
      if (a.k !== 'int' || b.k !== 'int') throw new Unsupported('| 0 of a division lowers only for int operands');
      v = this.intDivide('trunc', a, b, f, pc);
    } else v = this.ev(node, f, pc);
    if (v.k !== 'int') throw new Unsupported(`| 0 of a ${v.k} does not lower`);
    this.within(v, f, pc, 2n ** 31n - 1n, -(2n ** 31n));
    return this.share(v);
  }

  /** An obligation that `v` lies in [lo, hi]. */
  private within(v: Int, f: Frame, pc: string, hi: bigint, lo: bigint = -hi): void {
    if (v.c !== undefined) {
      if (v.c > hi || v.c < lo) this.oblige(f, pc, 'false');
      return;
    }
    this.oblige(f, pc, `(and (<= ${intLit(lo).t} ${v.t}) (<= ${v.t} ${intLit(hi).t}))`);
  }

  /**
   * Exact integer division with JavaScript's meaning: floor, ceil, truncation toward zero, half-up rounding of the real
   * quotient, and `%` (the sign of the dividend). The divisor must be provably non-zero; for the quotients both sides
   * stay within 2^52 so that the double quotient JavaScript computes first cannot round across an integer or a half.
   */
  private intDivide(mode: 'floor' | 'ceil' | 'trunc' | 'round' | 'mod', a: Int, b: Int, f: Frame, pc: string): Int {
    if (b.c === 0n) throw new Unsupported('integer division by the literal 0 is NaN or Infinity in JavaScript');
    if (b.c === undefined) {
      this.oblige(f, pc, `(not (= ${b.t} 0))`);
      this.hint(
        'the divisor may be 0 (NaN or Infinity in JavaScript): add assume(divisor !== 0) or divide by a literal',
      );
    }
    if (mode !== 'mod') {
      const limit = 2n ** 52n;
      this.within(a, f, pc, limit);
      this.within(b, f, pc, limit);
    }
    if (a.c !== undefined && b.c !== undefined) return intLit(foldDivide(mode, a.c, b.c));
    const neg = (t: string): string => `(- ${t})`;
    const floorDiv = (x: string, y: string, yc?: bigint): string =>
      yc !== undefined && yc > 0n ? `(div ${x} ${y})` : `(ite (> ${y} 0) (div ${x} ${y}) (div ${neg(x)} ${neg(y)}))`;
    const abs = (t: string, c?: bigint): string =>
      c !== undefined ? intLit(c < 0n ? -c : c).t : `(ite (< ${t} 0) ${neg(t)} ${t})`;
    switch (mode) {
      case 'floor':
        return { k: 'int', t: floorDiv(a.t, b.t, b.c) };
      case 'ceil':
        return { k: 'int', t: neg(floorDiv(neg(a.t), b.t, b.c)) };
      case 'round':
        return {
          k: 'int',
          t: floorDiv(`(+ (* 2 ${a.t}) ${b.t})`, `(* 2 ${b.t})`, b.c === undefined ? undefined : 2n * b.c),
        };
      case 'trunc': {
        const q = `(div ${abs(a.t, a.c)} ${abs(b.t, b.c)})`;
        return { k: 'int', t: `(ite (= (< ${a.t} 0) (< ${b.t} 0)) ${q} ${neg(q)})` };
      }
      case 'mod': {
        const m = abs(b.t, b.c);
        return { k: 'int', t: `(ite (>= ${a.t} 0) (mod ${a.t} ${m}) ${neg(`(mod ${neg(a.t)} ${m})`)})` };
      }
    }
  }

  /** `Number.isFinite/isInteger/isNaN(x)`: no coercion, so only numbers can be true. */
  private numberPredicate(name: string, args: readonly ts.Expression[], f: Frame, pc: string): Value {
    if (args.length !== 1) throw new Unsupported(`Number.${name} takes one value here`);
    const v = this.ev(args[0]!, f, pc);
    if (v.k === 'big') return F;
    if (v.k === 'int') return name === 'isNaN' ? F : T;
    if (v.k !== 'fp') throw new Unsupported(`Number.${name} of a ${v.k} does not lower`);
    const finite = and(not(`(fp.isNaN ${v.t})`), not(`(fp.isInfinite ${v.t})`));
    if (name === 'isNaN') return bool(`(fp.isNaN ${v.t})`);
    if (name === 'isFinite') return bool(finite);
    return bool(and(finite, `(fp.eq (fp.roundToIntegral RTZ ${v.t}) ${v.t})`));
  }

  lt(a: Value, b: Value): Bool {
    return this.compare('<', a, b);
  }
  le(a: Value, b: Value): Bool {
    return this.compare('<=', a, b);
  }

  private compare(op: '<' | '<=' | '>' | '>=', a: Value, b: Value): Bool {
    if ((a.k === 'int' && b.k === 'int') || (a.k === 'big' && b.k === 'big')) {
      if (a.c !== undefined && b.c !== undefined) {
        const r = op === '<' ? a.c < b.c : op === '<=' ? a.c <= b.c : op === '>' ? a.c > b.c : a.c >= b.c;
        return r ? T : F;
      }
      return bool(`(${op} ${a.t} ${b.t})`);
    }
    if ((a.k === 'int' || a.k === 'fp') && (b.k === 'int' || b.k === 'fp')) {
      const fp = { '<': 'fp.lt', '<=': 'fp.leq', '>': 'fp.gt', '>=': 'fp.geq' }[op];
      return bool(`(${fp} ${toFp(a).t} ${toFp(b).t})`);
    }
    if (a.k === 'str' && b.k === 'str') {
      switch (op) {
        case '<':
          return bool(`(str.< ${a.t} ${b.t})`);
        case '<=':
          return bool(`(str.<= ${a.t} ${b.t})`);
        case '>':
          return bool(`(str.< ${b.t} ${a.t})`);
        case '>=':
          return bool(`(str.<= ${b.t} ${a.t})`);
      }
    }
    throw new Unsupported(`comparison of ${a.k} with ${b.k} does not lower`);
  }

  /** `===`. */
  strictEquals(a: Value, b: Value): Bool {
    if (a.k === 'undef' || b.k === 'undef') return a.k === b.k ? T : F;
    if ((a.k === 'int' || a.k === 'fp') && (b.k === 'int' || b.k === 'fp')) {
      if (a.k === 'int' && b.k === 'int') {
        if (a.c !== undefined && b.c !== undefined) return a.c === b.c ? T : F;
        return bool(`(= ${a.t} ${b.t})`);
      }
      const [p, q] = sorted(toFp(a).t, toFp(b).t);
      return bool(p === q ? `(not (fp.isNaN ${p}))` : `(fp.eq ${p} ${q})`);
    }
    if (a.k !== b.k) {
      if ((a.k === 'arr' || a.k === 'rec') && (b.k === 'arr' || b.k === 'rec')) return F;
      return F;
    }
    if (a.k === 'rec' || a.k === 'arr') throw new Unsupported('=== on objects compares references');
    const [p, q] = sorted((a as Bool).t, (b as Bool).t);
    return bool(p === q ? 'true' : `(= ${p} ${q})`);
  }

  private binary(node: ts.BinaryExpression, f: Frame, pc: string): Value {
    const kind = node.operatorToken.kind;
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken) {
      const left = this.asBool(this.ev(node.left, f, pc));
      // The right side only runs when the left does not decide, so its obligations hold under that condition.
      const right = this.asBool(
        this.ev(node.right, f, and(pc, kind === ts.SyntaxKind.AmpersandAmpersandToken ? left : not(left))),
      );
      return bool(kind === ts.SyntaxKind.AmpersandAmpersandToken ? and(left, right) : or(left, right));
    }
    if (isAssignment(kind)) return this.assignment(node, f, pc);
    if (kind === ts.SyntaxKind.CommaToken) {
      this.ev(node.left, f, pc, true);
      return this.ev(node.right, f, pc);
    }
    if (kind === ts.SyntaxKind.BarToken && ts.isNumericLiteral(node.right) && node.right.text === '0')
      return this.toInt32(node.left, f, pc);
    const a = this.ev(node.left, f, pc);
    const b = this.ev(node.right, f, pc);
    switch (kind) {
      case ts.SyntaxKind.PlusToken:
        return this.arith('+', a, b, f, pc);
      case ts.SyntaxKind.MinusToken:
        return this.arith('-', a, b, f, pc);
      case ts.SyntaxKind.AsteriskToken:
        return this.arith('*', a, b, f, pc);
      case ts.SyntaxKind.SlashToken:
        return this.arith('/', a, b, f, pc);
      case ts.SyntaxKind.PercentToken:
        return this.arith('%', a, b, f, pc);
      case ts.SyntaxKind.LessThanToken:
        return this.compare('<', a, b);
      case ts.SyntaxKind.LessThanEqualsToken:
        return this.compare('<=', a, b);
      case ts.SyntaxKind.GreaterThanToken:
        return this.compare('>', a, b);
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return this.compare('>=', a, b);
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        return this.strictEquals(a, b);
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return bool(not(this.strictEquals(a, b).t));
    }
    throw new Unsupported(`operator ${node.operatorToken.getText()} does not lower`);
  }

  private assignment(node: ts.BinaryExpression, f: Frame, pc: string): Value {
    const kind = node.operatorToken.kind;
    const op = {
      [ts.SyntaxKind.PlusEqualsToken]: '+',
      [ts.SyntaxKind.MinusEqualsToken]: '-',
      [ts.SyntaxKind.AsteriskEqualsToken]: '*',
      [ts.SyntaxKind.SlashEqualsToken]: '/',
    }[kind as number];
    const target = node.left;
    if (ts.isIdentifier(target)) {
      const old = f.env.get(target.text);
      if (old === undefined) throw new Unsupported(`assignment to unknown name ${target.text}`);
      let value = this.escape(this.ev(node.right, f, pc));
      if (kind !== ts.SyntaxKind.EqualsToken) {
        if (op === undefined) throw new Unsupported('compound assignment does not lower');
        value = this.arith(op, old, value, f, pc);
      }
      this.setVar(f, target.text, value);
      return value;
    }
    if (
      ts.isElementAccessExpression(target) &&
      ts.isIdentifier(target.expression) &&
      kind === ts.SyntaxKind.EqualsToken
    ) {
      const arr = f.env.get(target.expression.text);
      const index = this.ev(target.argumentExpression, f, pc);
      const value = this.escape(this.ev(node.right, f, pc));
      if (arr?.k !== 'arr' || index.k !== 'int')
        throw new Unsupported('indexed assignment only on arrays with integer indexes');
      if (arr.id.escaped) throw new Unsupported('mutation of an array another name can reach');
      this.oblige(f, pc, and(this.le(intLit(0n), index).t, this.lt(index, arr.len).t));
      const act = this.active(f);
      const slots = arr.slots.map((slot, i) => this.merge(and(act, `(= ${index.t} ${i})`), value, slot, true));
      this.setVar(f, target.expression.text, { ...arr, slots });
      return value;
    }
    throw new Unsupported('assignment target does not lower');
  }

  // ---- arrays -------------------------------------------------------------------------------------------------

  private addLen(a: Int, b: Int): Int {
    if (a.c !== undefined && b.c !== undefined) return intLit(a.c + b.c);
    return { k: 'int', t: `(+ ${a.t} ${b.t})` };
  }

  /** Appends `value` where `when` holds. A literal under construction grows; any other array stops at its capacity. */
  private push(arr: Arr, value: Value, when: string, pc: string, f: Frame, literal = false): Arr {
    const slots = arr.slots.slice();
    if (literal) slots.push({ k: 'undef' });
    else if (slots.length > 0) {
      this.assume(f, pc, this.implies(when, this.lt(arr.len, intLit(BigInt(slots.length))).t));
      const why = `arrays hold at most ${slots.length} elements here`;
      if (!this.bounded.includes(why)) this.bounded.push(why);
    }
    for (let i = 0; i < slots.length; i += 1)
      slots[i] = this.merge(and(when, this.strictEquals(arr.len, intLit(BigInt(i))).t), value, slots[i]!, true);
    const len = this.merge(when, this.addLen(arr.len, intLit(1n)), arr.len) as Int;
    return { k: 'arr', len, slots, id: arr.id };
  }

  private implies(a: string, b: string): string {
    return a === 'true' ? b : `(=> ${a} ${b})`;
  }

  private concatArrays(a: Arr, b: Arr): Arr {
    const cap = a.slots.length + b.slots.length;
    const slots: Value[] = [];
    for (let j = 0; j < cap; j += 1) {
      let v: Value = { k: 'undef' };
      // Past the end of a, slot j is b's slot j - len a.
      for (let la = a.slots.length; la >= 0; la -= 1) {
        const from = b.slots[j - la];
        if (j >= la && from !== undefined)
          v = this.merge(this.strictEquals(a.len, intLit(BigInt(la))).t, from, v, true);
      }
      const own = a.slots[j];
      if (own !== undefined) v = this.merge(this.lt(intLit(BigInt(j)), a.len).t, own, v, true);
      slots.push(v);
    }
    return { k: 'arr', len: this.addLen(a.len, b.len), slots, id: { escaped: false } };
  }

  private dedupe(source: Arr, f: Frame, pc: string): Arr {
    let out: Arr = {
      k: 'arr',
      len: intLit(0n),
      slots: source.slots.map(() => ({ k: 'undef' }) as Value),
      id: { escaped: false },
    };
    for (let k = 0; k < source.slots.length; k += 1) {
      const element = source.slots[k]!;
      if (element.k === 'undef') continue;
      let seen = 'false';
      for (let j = 0; j < out.slots.length; j += 1) {
        const other = out.slots[j]!;
        if (other.k === 'undef') continue;
        seen = or(seen, and(this.lt(intLit(BigInt(j)), out.len).t, this.strictEquals(other, element).t));
      }
      const take = and(this.lt(intLit(BigInt(k)), source.len).t, not(seen));
      out = this.push(out, element, take, pc, f);
    }
    return out;
  }

  private callback(node: ts.Expression): FunctionNode {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
    throw new Unsupported('callbacks must be function literals');
  }

  private applyCallback(fn: FunctionNode, args: Value[], f: Frame, pc: string): Value {
    // A callback closes over the names visible where it is written; its own parameters shadow them.
    const inner = new Frame(f.file, f.depth + 1);
    inner.env = new Map(f.env);
    if (fn.parameters.length > args.length) throw new Unsupported('callback takes more arguments than are passed');
    fn.parameters.forEach((parameter, i) => {
      if (
        !ts.isIdentifier(parameter.name) ||
        parameter.initializer !== undefined ||
        parameter.dotDotDotToken !== undefined
      )
        throw new Unsupported('parameters must be plain identifiers');
      inner.env.set(parameter.name.text, args[i]!);
    });
    this.body(fn, inner, pc);
    return inner.ret ?? { k: 'undef' };
  }

  private method(
    receiver: ts.Expression,
    name: string,
    args: readonly ts.Expression[],
    f: Frame,
    pc: string,
    statement: boolean,
  ): Value {
    const target = this.ev(receiver, f, pc);
    if (target.k === 'str') return this.stringMethod(target, name, args, f, pc);
    if (target.k !== 'arr') throw new Unsupported(`method ${name} on a ${target.k}`);
    const arr = target;
    const evalArg = (i: number): Value => this.ev(args[i]!, f, pc);
    const inRange = (k: number): string => this.lt(intLit(BigInt(k)), arr.len).t;
    const mutate = (next: Arr): void => {
      if (!ts.isIdentifier(receiver)) throw new Unsupported(`${name} on something other than a named array`);
      if (arr.id.escaped) throw new Unsupported('mutation of an array another name can reach');
      this.setVar(f, receiver.text, next);
    };
    switch (name) {
      case 'push': {
        if (args.length !== 1) throw new Unsupported('push takes one value here');
        if (!statement) throw new Unsupported('the result of push is not modelled');
        mutate(this.push(arr, this.escape(evalArg(0)), this.active(f), pc, f));
        return { k: 'undef' };
      }
      case 'map': {
        const fn = this.callback(args[0]!);
        const slots = arr.slots.map((slot, k) =>
          slot.k === 'undef' ? slot : this.applyCallback(fn, [slot, intLit(BigInt(k))], f, and(pc, inRange(k))),
        );
        return { k: 'arr', len: arr.len, slots, id: { escaped: false } };
      }
      case 'filter': {
        const fn = this.callback(args[0]!);
        let out: Arr = {
          k: 'arr',
          len: intLit(0n),
          slots: arr.slots.map(() => ({ k: 'undef' }) as Value),
          id: { escaped: false },
        };
        arr.slots.forEach((slot, k) => {
          if (slot.k === 'undef') return;
          const keep = this.asBool(this.applyCallback(fn, [slot, intLit(BigInt(k))], f, and(pc, inRange(k))));
          out = this.push(out, slot, and(inRange(k), keep), pc, f);
        });
        return out;
      }
      case 'every':
      case 'some': {
        const fn = this.callback(args[0]!);
        let result = name === 'every' ? 'true' : 'false';
        arr.slots.forEach((slot, k) => {
          if (slot.k === 'undef') return;
          const r = this.asBool(this.applyCallback(fn, [slot, intLit(BigInt(k))], f, and(pc, inRange(k))));
          result = name === 'every' ? and(result, ite(inRange(k), r, 'true')) : or(result, and(inRange(k), r));
        });
        return bool(result);
      }
      case 'reduce': {
        if (args.length !== 2) throw new Unsupported('reduce needs an initial value');
        const fn = this.callback(args[0]!);
        let acc = this.escape(evalArg(1));
        arr.slots.forEach((slot, k) => {
          if (slot.k === 'undef') return;
          const next = this.applyCallback(fn, [acc, slot, intLit(BigInt(k))], f, and(pc, inRange(k)));
          acc = this.merge(inRange(k), next, acc);
        });
        return acc;
      }
      case 'includes':
      case 'indexOf': {
        const needle = evalArg(0);
        if (name === 'includes') {
          let found = 'false';
          arr.slots.forEach((slot, k) => {
            if (slot.k !== 'undef') found = or(found, and(inRange(k), this.strictEquals(slot, needle).t));
          });
          return bool(found);
        }
        let index: Value = intLit(-1n);
        for (let k = arr.slots.length - 1; k >= 0; k -= 1) {
          const slot = arr.slots[k]!;
          if (slot.k !== 'undef')
            index = this.merge(and(inRange(k), this.strictEquals(slot, needle).t), intLit(BigInt(k)), index);
        }
        return index;
      }
      case 'slice': {
        const start = args.length > 0 ? evalArg(0) : intLit(0n);
        if (start.k !== 'int' || start.c === undefined || args.length > 1)
          throw new Unsupported('slice only with a literal start');
        const from = Number(start.c);
        if (from < 0) throw new Unsupported('slice with a negative start');
        const slots = arr.slots.slice(from);
        const len = this.merge(
          this.lt(intLit(BigInt(from)), arr.len).t,
          this.arith('-', arr.len, intLit(BigInt(from)), f, pc),
          intLit(0n),
        ) as Int;
        return { k: 'arr', len, slots, id: { escaped: false } };
      }
      case 'concat': {
        let out: Arr = arr;
        for (let i = 0; i < args.length; i += 1) out = this.concatArrays(out, this.arrayOf(evalArg(i)));
        return { ...out, id: { escaped: false } };
      }
      case 'reverse': {
        const slots: Value[] = arr.slots.map((_, j) => {
          let v: Value = { k: 'undef' };
          for (let m = arr.slots.length; m >= 1; m -= 1) {
            const from = arr.slots[m - 1 - j];
            if (from !== undefined) v = this.merge(this.strictEquals(arr.len, intLit(BigInt(m))).t, from, v, true);
          }
          return v;
        });
        const reversed: Arr = { k: 'arr', len: arr.len, slots, id: arr.id };
        if (ts.isIdentifier(receiver)) {
          mutate(reversed);
          return reversed;
        }
        if (arr.id.escaped) throw new Unsupported('reverse of an array another name can reach');
        return reversed;
      }
      case 'sort':
        return this.sort(arr, args, receiver, mutate, f, pc);
    }
    throw new Unsupported(`array method ${name} does not lower`);
  }

  /** Insertion sort as a fixed network of guarded swaps; stable, as `Array.prototype.sort` is. */
  private sort(
    arr: Arr,
    args: readonly ts.Expression[],
    receiver: ts.Expression,
    mutate: (a: Arr) => void,
    f: Frame,
    pc: string,
  ): Value {
    if (args.length !== 1) throw new Unsupported('sort needs a comparator (the default compares strings)');
    if (arr.id.escaped && ts.isIdentifier(receiver)) throw new Unsupported('sort of an array another name can reach');
    const fn = this.callback(args[0]!);
    const slots = arr.slots.slice();
    for (let i = 1; i < slots.length; i += 1) {
      for (let j = i; j >= 1; j -= 1) {
        const a = slots[j - 1]!;
        const b = slots[j]!;
        if (a.k === 'undef' || b.k === 'undef') continue;
        const live = this.lt(intLit(BigInt(j)), arr.len).t;
        const order = this.applyCallback(fn, [a, b], f, and(pc, live));
        if (order.k !== 'int' && order.k !== 'fp') throw new Unsupported('comparator must return a number');
        const swap = and(live, this.compare('>', order, intLit(0n)).t);
        slots[j - 1] = this.merge(swap, b, a);
        slots[j] = this.merge(swap, a, b);
      }
    }
    const sortedArr: Arr = { k: 'arr', len: arr.len, slots, id: arr.id };
    if (ts.isIdentifier(receiver)) mutate(sortedArr);
    return sortedArr;
  }

  private stringMethod(s: Str, name: string, args: readonly ts.Expression[], f: Frame, pc: string): Value {
    const arg = (i: number): Value => this.ev(args[i]!, f, pc);
    const inRangeIdx = (i: Value): void => {
      if (i.k !== 'int') throw new Unsupported('string index is not an integer value');
      this.oblige(f, pc, and(this.le(intLit(0n), i).t, this.le(i, { k: 'int', t: `(str.len ${s.t})` }).t));
    };
    switch (name) {
      case 'charAt': {
        const i = arg(0);
        inRangeIdx(i);
        return { k: 'str', t: `(str.at ${s.t} ${(i as Int).t})` };
      }
      case 'includes':
      case 'startsWith':
      case 'endsWith': {
        const needle = arg(0);
        if (needle.k !== 'str' || args.length !== 1) throw new Unsupported(`${name} with an unmodelled argument`);
        const op = name === 'includes' ? 'str.contains' : name === 'startsWith' ? 'str.prefixof' : 'str.suffixof';
        return bool(name === 'includes' ? `(${op} ${s.t} ${needle.t})` : `(${op} ${needle.t} ${s.t})`);
      }
      case 'indexOf': {
        const needle = arg(0);
        if (needle.k !== 'str' || args.length !== 1) throw new Unsupported('indexOf with an unmodelled argument');
        return { k: 'int', t: `(str.indexof ${s.t} ${needle.t} 0)` };
      }
      case 'slice':
      case 'substring': {
        const from = args.length > 0 ? arg(0) : intLit(0n);
        if (from.k !== 'int' || from.c === undefined || from.c < 0n)
          throw new Unsupported(`${name} only with a literal non-negative start`);
        if (args.length > 1) {
          const to = arg(1);
          if (to.k !== 'int' || to.c === undefined || to.c < from.c)
            throw new Unsupported(`${name} only with literal bounds`);
          return { k: 'str', t: `(str.substr ${s.t} ${from.c} ${to.c - from.c})` };
        }
        return { k: 'str', t: `(str.substr ${s.t} ${from.c} (- (str.len ${s.t}) ${from.c}))` };
      }
    }
    throw new Unsupported(`string method ${name} does not lower`);
  }

  // ---- calls --------------------------------------------------------------------------------------------------

  private call(node: ts.CallExpression, f: Frame, pc: string, statement: boolean): Value {
    let callee: ts.Expression = node.expression;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    // `(0, mod_1.fn)(...)` is how CommonJS emit calls an import.
    if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken) callee = callee.right;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;

    if (this.calleeOf(node)?.name === 'invariant')
      throw new Unsupported('invariant must be the first statements of a loop body');
    const quantifier = this.calleeOf(node);
    if (
      (quantifier?.name === 'forall' || quantifier?.name === 'exists') &&
      (quantifier.owner === undefined
        ? this.index(f.file).functions.get(quantifier.name) === undefined
        : /tslaws/.test(quantifier.owner) && !f.env.has(quantifier.owner))
    )
      return this.quantifier(quantifier.name, node.arguments, f, pc);
    if (ts.isPropertyAccessExpression(callee)) {
      const owner = ts.isIdentifier(callee.expression) ? callee.expression.text : undefined;
      const name = callee.name.text;
      if (owner === 'Math' && !f.env.has('Math') && ['floor', 'ceil', 'trunc', 'round'].includes(name)) {
        const division = node.arguments.length === 1 ? this.divisionOf(node.arguments[0]!) : undefined;
        if (division !== undefined)
          return this.roundedDivision(name as 'floor' | 'ceil' | 'trunc' | 'round', division, f, pc);
      }
      if (owner === 'Number' && !f.env.has('Number') && ['isFinite', 'isInteger', 'isNaN'].includes(name))
        return this.numberPredicate(name, node.arguments, f, pc);
      if (owner === 'Math')
        return this.math(
          name,
          node.arguments.map((a) => this.ev(a, f, pc)),
          f,
          pc,
        );
      if (owner === 'Array' && name === 'from' && node.arguments.length === 1) {
        const arg = node.arguments[0]!;
        return this.spreadSource(arg, f, pc);
      }
      if (owner !== undefined && !f.env.has(owner)) {
        const moduleFile = this.index(f.file).imports.get(owner);
        if (moduleFile !== undefined) return this.callProject(moduleFile, name, node.arguments, f, pc);
        if (owner === 'tslaws_1' || /tslaws/.test(owner)) {
          if (name === 'assume') return this.assumeCall(node, f, pc);
        }
      }
      return this.method(callee.expression, name, node.arguments, f, pc, statement);
    }
    if (ts.isIdentifier(callee)) {
      if (callee.text === 'assume') return this.assumeCall(node, f, pc);
      if (callee.text === 'Number' && node.arguments.length === 1) {
        const v = this.ev(node.arguments[0]!, f, pc);
        if (v.k === 'int' || v.k === 'fp') return v;
      }
      return this.callProject(f.file, callee.text, node.arguments, f, pc);
    }
    throw new Unsupported('call target is not a plain name');
  }

  /** `forall(xs, p)` / `exists(xs, p)` over the slots of the array model, so a claim about them is bounded like the array. */
  private quantifier(name: 'forall' | 'exists', args: readonly ts.Expression[], f: Frame, pc: string): Value {
    if (args.length !== 2) throw new Unsupported(`${name} takes an array and a predicate`);
    const arr = this.arrayOf(this.ev(args[0]!, f, pc));
    const fn = this.callback(args[1]!);
    if (fn.parameters.length > 2) throw new Unsupported(`${name} predicate takes at most (element, index)`);
    let result = name === 'forall' ? 'true' : 'false';
    arr.slots.forEach((slot, k) => {
      if (slot.k === 'undef') return;
      const inRange = this.lt(intLit(BigInt(k)), arr.len).t;
      const args2: Value[] = [slot, intLit(BigInt(k))];
      const r = this.asBool(this.applyCallback(fn, args2, f, and(pc, inRange)));
      result = name === 'forall' ? and(result, ite(inRange, r, 'true')) : or(result, and(inRange, r));
    });
    return bool(result);
  }

  private assumeCall(node: ts.CallExpression, f: Frame, pc: string): Value {
    if (node.arguments.length !== 1) throw new Unsupported('assume takes one condition');
    this.assume(f, pc, this.asBool(this.ev(node.arguments[0]!, f, pc)));
    return { k: 'undef' };
  }

  private callProject(file: string, name: string, args: readonly ts.Expression[], f: Frame, pc: string): Value {
    const fn = this.index(file).functions.get(name);
    if (fn === undefined) throw new Unsupported(`cannot find the source of ${name}`);
    const values = args.map((a) => this.escape(this.ev(a, f, pc)));
    if (f.depth + 1 > this.bound + 2) {
      this.cut(f, pc, 'true', `recursion is cut at depth ${this.bound}`);
      return { k: 'undef' };
    }
    const inner = new Frame(file, f.depth + 1);
    this.bindParams(inner, fn, values);
    this.body(fn, inner, this.guard(f, pc));
    if (inner.ret === undefined) return { k: 'undef' };
    return inner.ret;
  }

  private math(name: string, args: Value[], f: Frame, pc: string): Value {
    return this.share(this.mathRaw(name, args, f, pc));
  }

  private mathRaw(name: string, args: Value[], f: Frame, pc: string): Value {
    const numeric = (v: Value | undefined): Int | Fp => {
      if (v === undefined || (v.k !== 'int' && v.k !== 'fp')) throw new Unsupported(`Math.${name} needs numbers`);
      return v;
    };
    const a = numeric(args[0]);
    switch (name) {
      case 'abs':
        if (a.k === 'int')
          return a.c !== undefined
            ? intLit(a.c < 0n ? -a.c : a.c)
            : { k: 'int', t: `(ite (< ${a.t} 0) (- ${a.t}) ${a.t})` };
        return { k: 'fp', t: `(fp.abs ${a.t})` };
      case 'round':
        if (a.k === 'int') return a;
        throw new Unsupported('Math.round of a double does not lower (only of an int or an int quotient)');
      case 'sign': {
        if (a.k === 'int') {
          if (a.c !== undefined) return intLit(a.c > 0n ? 1n : a.c < 0n ? -1n : 0n);
          return { k: 'int', t: `(ite (> ${a.t} 0) 1 (ite (< ${a.t} 0) (- 1) 0))` };
        }
        const one = '((_ to_fp 11 53) RNE 1.0)';
        return {
          k: 'fp',
          t: `(ite (or (fp.isNaN ${a.t}) (fp.isZero ${a.t})) ${a.t} (ite (fp.isNegative ${a.t}) (fp.neg ${one}) ${one}))`,
        };
      }
      case 'floor':
      case 'ceil':
      case 'trunc':
        if (a.k === 'int') return a;
        return { k: 'fp', t: `(fp.roundToIntegral ${{ floor: 'RTN', ceil: 'RTP', trunc: 'RTZ' }[name]} ${a.t})` };
      case 'min':
      case 'max': {
        if (args.length < 2) throw new Unsupported(`Math.${name} takes at least two numbers here`);
        if (args.length > 2) {
          // Folding pairwise keeps NaN and the sign of zero as the specification has them.
          const rest = this.mathRaw(name, args.slice(1), f, pc);
          return this.mathRaw(name, [a, numeric(rest)], f, pc);
        }
        const b = numeric(args[1]);
        if (a.k === 'int' && b.k === 'int') {
          const pick = name === 'min' ? this.compare('<', a, b) : this.compare('>', a, b);
          return this.merge(pick.t, a, b);
        }
        const x = toFp(a).t;
        const y = toFp(b).t;
        const first = name === 'min' ? `(fp.lt ${x} ${y})` : `(fp.gt ${x} ${y})`;
        const second = name === 'min' ? `(fp.lt ${y} ${x})` : `(fp.gt ${y} ${x})`;
        const tie = name === 'min' ? `(ite (fp.isNegative ${x}) ${x} ${y})` : `(ite (fp.isNegative ${x}) ${y} ${x})`;
        return {
          k: 'fp',
          t: `(ite (or (fp.isNaN ${x}) (fp.isNaN ${y})) ${nan} (ite ${first} ${x} (ite ${second} ${y} ${tie})))`,
        };
      }
    }
    void f;
    void pc;
    throw new Unsupported(`Math.${name} does not lower`);
  }
}

function foldDivide(mode: 'floor' | 'ceil' | 'trunc' | 'round' | 'mod', a: bigint, b: bigint): bigint {
  const floorDiv = (x: bigint, y: bigint): bigint => {
    const q = x / y;
    return x % y !== 0n && x < 0n !== y < 0n ? q - 1n : q;
  };
  switch (mode) {
    case 'floor':
      return floorDiv(a, b);
    case 'ceil':
      return -floorDiv(-a, b);
    case 'trunc':
      return a / b;
    case 'round':
      return floorDiv(2n * a + b, 2n * b);
    case 'mod':
      return a % b;
  }
}

function isAssignment(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken
  );
}

export type { FunctionNode };
