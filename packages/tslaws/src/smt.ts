// The prover: lowers the compiled JavaScript of a law (and the project functions it calls) to SMT-LIB and asks
// Z3 whether any input makes it return `false`. Only a small pure subset lowers: numbers, booleans,
// arithmetic, comparisons, `const` bindings, `if`/`return`, `assume`, and calls to other lowerable
// functions. Anything else is reported as unsupported and the law stays property-tested.
//
// Numbers are modelled as exact reals by default, so a proof ignores rounding, overflow and NaN; that is the
// price of Z3 deciding in milliseconds what its floating-point theory cannot decide in 20 seconds.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import type { ManifestLaw } from './types.ts';

export type ProofResult =
  | { kind: 'proved'; model: NumberModel }
  | { kind: 'refuted'; model: string; inputs: unknown[] }
  | { kind: 'unsupported'; reason: string };

export type NumberModel = 'real' | 'fp';

export interface ProveInput {
  law: ManifestLaw;
  /** The shape of each parameter's type; `undefined` when the type is not modelled. */
  shapes: Shape[];
  /** The compiled JavaScript file of the law. */
  jsFile: string;
  model: NumberModel;
  timeoutMs: number;
  /** Runs the compiled law on concrete inputs; true when it holds. */
  holds: (inputs: unknown[]) => boolean;
}

/** The part of a parameter type the prover models: numbers, booleans and records of them. */
export type Shape = 'number' | 'boolean' | { fields: Record<string, Shape> } | undefined;

class Unsupported extends Error {}

type Sort = 'num' | 'bool' | 'rec';

interface Term {
  smt: string;
  sort: Sort;
  /** The members of a record: records are flattened to one constant per field. */
  fields?: Map<string, Term>;
}

type FunctionNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

interface FunctionIndex {
  /** Top-level functions: declarations and `const f = (...) => ...` bindings. */
  functions: Map<string, FunctionNode>;
  /** `local = require("./x")` bindings: local name to the resolved JavaScript file. */
  imports: Map<string, string>;
}

const maxInlineDepth = 8;

class Lowering {
  private readonly files = new Map<string, FunctionIndex>();
  readonly assumptions: string[] = [];
  private depth = 0;


  index(file: string): FunctionIndex {
    const known = this.files.get(file);
    if (known !== undefined) return known;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const index: FunctionIndex = { functions: new Map(), imports: new Map() };
    this.files.set(file, index);
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.body !== undefined)
        index.functions.set(statement.name.text, statement);
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const init = declaration.initializer;
          if (ts.isIdentifier(declaration.name) && init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
            index.functions.set(declaration.name.text, init);
          if (
            ts.isIdentifier(declaration.name) &&
            init !== undefined &&
            ts.isCallExpression(init) &&
            ts.isIdentifier(init.expression) &&
            init.expression.text === 'require' &&
            init.arguments.length === 1 &&
            ts.isStringLiteral(init.arguments[0]!)
          ) {
            const specifier = init.arguments[0].text;
            if (specifier.startsWith('.')) index.imports.set(declaration.name.text, this.resolveModule(file, specifier));
          }
        }
      }
    }
    return index;
  }

  private resolveModule(from: string, specifier: string): string {
    const base = resolve(dirname(from), specifier);
    return /\.[cm]?js$/.test(base) ? base : `${base}.js`;
  }

  /** The value a call of `fn` returns, with `args` bound to its parameters. */
  callFunction(file: string, fn: FunctionNode, args: Term[]): Term {
    if (this.depth >= maxInlineDepth) throw new Unsupported('calls nest too deeply (recursion?)');
    if (fn.parameters.length !== args.length) throw new Unsupported('call has the wrong number of arguments');
    const env = new Map<string, Term>();
    fn.parameters.forEach((parameter, i) => {
      if (!ts.isIdentifier(parameter.name) || parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined)
        throw new Unsupported('parameters must be plain identifiers');
      env.set(parameter.name.text, args[i]!);
    });
    this.depth += 1;
    try {
      const result = this.functionBody(file, fn, env);
      if (result === undefined) throw new Unsupported('a called function returns nothing');
      return result;
    } finally {
      this.depth -= 1;
    }
  }

  /** The law's own result: `undefined` when it returns nothing, which counts as holding. */
  lawResult(file: string, fn: FunctionNode, params: Term[]): Term | undefined {
    const env = new Map<string, Term>();
    fn.parameters.forEach((parameter, i) => {
      if (!ts.isIdentifier(parameter.name)) throw new Unsupported('parameters must be plain identifiers');
      env.set(parameter.name.text, params[i]!);
    });
    return this.functionBody(file, fn, env);
  }

  private functionBody(file: string, fn: FunctionNode, env: Map<string, Term>): Term | undefined {
    const body = fn.body;
    if (body === undefined) throw new Unsupported('function has no body');
    if (ts.isBlock(body)) return this.block(file, body.statements, env, true);
    return this.expression(file, body, env);
  }

  private block(file: string, statements: readonly ts.Statement[], env: Map<string, Term>, top: boolean): Term | undefined {
    const scope = new Map(env);
    for (let i = 0; i < statements.length; i += 1) {
      const statement = statements[i]!;
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined)
            throw new Unsupported('variable declarations need a name and an initializer');
          if (!(statement.declarationList.flags & ts.NodeFlags.Const)) throw new Unsupported('only const bindings lower');
          scope.set(declaration.name.text, this.expression(file, declaration.initializer, scope));
        }
      } else if (ts.isExpressionStatement(statement)) {
        if (!top || !this.assumption(file, statement.expression, scope)) throw new Unsupported('only assume() may be an expression statement');
      } else if (ts.isReturnStatement(statement)) {
        if (statement.expression === undefined) return undefined;
        return this.expression(file, statement.expression, scope);
      } else if (ts.isIfStatement(statement)) {
        const condition = this.boolean(this.expression(file, statement.expression, scope));
        const thenResult = this.branch(file, statement.thenStatement, scope);
        const rest = statement.elseStatement !== undefined ? [statement.elseStatement] : statements.slice(i + 1);
        const elseResult = this.branch(file, rest.length === 1 ? rest[0]! : ts.factory.createBlock(rest as ts.Statement[]), scope);
        if (thenResult === undefined || elseResult === undefined) throw new Unsupported('both branches of an if must return a value');
        if (thenResult.sort !== elseResult.sort || thenResult.sort === 'rec')
          throw new Unsupported('branches return different kinds of value or records');
        return { smt: `(ite ${condition} ${thenResult.smt} ${elseResult.smt})`, sort: thenResult.sort };
      } else if (ts.isBlock(statement)) {
        return this.block(file, statement.statements, scope, false);
      } else {
        throw new Unsupported(`statement ${ts.SyntaxKind[statement.kind]} does not lower`);
      }
    }
    return undefined;
  }

  private branch(file: string, statement: ts.Statement, env: Map<string, Term>): Term | undefined {
    return this.block(file, ts.isBlock(statement) ? statement.statements : [statement], env, false);
  }

  private assumption(file: string, expression: ts.Expression, env: Map<string, Term>): boolean {
    if (!ts.isCallExpression(expression)) return false;
    const callee = this.calleeName(expression.expression);
    if (callee?.name !== 'assume' || expression.arguments.length !== 1) return false;
    this.assumptions.push(this.boolean(this.expression(file, expression.arguments[0]!, env)));
    return true;
  }

  private calleeName(expression: ts.Expression): { owner: string | undefined; name: string } | undefined {
    let node = expression;
    // `(0, mod_1.fn)(...)` is how CommonJS emit calls an import.
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) node = node.right;
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (ts.isIdentifier(node)) return { owner: undefined, name: node.text };
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression))
      return { owner: node.expression.text, name: node.name.text };
    return undefined;
  }

  private num(term: Term): string {
    if (term.sort !== 'num') throw new Unsupported('a boolean was used as a number');
    return term.smt;
  }

  private boolean(term: Term): string {
    if (term.sort !== 'bool') throw new Unsupported('a number was used as a condition');
    return term.smt;
  }

  private literal(value: number): Term {
    if (!Number.isFinite(value)) throw new Unsupported('non-finite literal');
    const text = String(Math.abs(value));
    if (/e/i.test(text)) throw new Unsupported('literal needs exponent notation');
    const real = text.includes('.') ? text : `${text}.0`;
    return { smt: value < 0 ? `(- ${real})` : real, sort: 'num' };
  }

  expression(file: string, node: ts.Expression, env: Map<string, Term>): Term {
    if (ts.isParenthesizedExpression(node)) return this.expression(file, node.expression, env);
    if (ts.isNumericLiteral(node)) return this.literal(Number(node.text));
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { smt: 'true', sort: 'bool' };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { smt: 'false', sort: 'bool' };
    if (ts.isIdentifier(node)) {
      const bound = env.get(node.text);
      if (bound === undefined) throw new Unsupported(`unknown name ${node.text}`);
      return bound;
    }
    if (ts.isPrefixUnaryExpression(node)) {
      const operand = this.expression(file, node.operand, env);
      switch (node.operator) {
        case ts.SyntaxKind.MinusToken:
          return { smt: `(- ${this.num(operand)})`, sort: 'num' };
        case ts.SyntaxKind.PlusToken:
          return { smt: this.num(operand), sort: 'num' };
        case ts.SyntaxKind.ExclamationToken:
          return { smt: `(not ${this.boolean(operand)})`, sort: 'bool' };
      }
      throw new Unsupported('unary operator does not lower');
    }
    if (ts.isConditionalExpression(node)) {
      const condition = this.boolean(this.expression(file, node.condition, env));
      const a = this.expression(file, node.whenTrue, env);
      const b = this.expression(file, node.whenFalse, env);
      if (a.sort !== b.sort || a.sort === 'rec') throw new Unsupported('conditional branches differ in kind or are records');
      return { smt: `(ite ${condition} ${a.smt} ${b.smt})`, sort: a.sort };
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = this.expression(file, node.expression, env);
      const field = base.fields?.get(node.name.text);
      if (base.sort !== 'rec' || field === undefined) throw new Unsupported(`property ${node.name.text} is not modelled`);
      return field;
    }
    if (ts.isBinaryExpression(node)) return this.binary(file, node, env);
    if (ts.isCallExpression(node)) return this.call(file, node, env);
    throw new Unsupported(`expression ${ts.SyntaxKind[node.kind]} does not lower`);
  }

  private binary(file: string, node: ts.BinaryExpression, env: Map<string, Term>): Term {
    const left = this.expression(file, node.left, env);
    const right = this.expression(file, node.right, env);
    const arithmetic = (op: string): Term => ({ smt: `(${op} ${this.num(left)} ${this.num(right)})`, sort: 'num' });
    const comparison = (op: string): Term => ({ smt: `(${op} ${this.num(left)} ${this.num(right)})`, sort: 'bool' });
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return arithmetic('+');
      case ts.SyntaxKind.MinusToken:
        return arithmetic('-');
      case ts.SyntaxKind.AsteriskToken:
        return arithmetic('*');
      case ts.SyntaxKind.SlashToken: {
        // Real division by zero is unconstrained in SMT-LIB but Infinity or NaN in JavaScript.
        if (!ts.isNumericLiteral(node.right) || Number(node.right.text) === 0) throw new Unsupported('division only by a nonzero literal');
        return arithmetic('/');
      }
      case ts.SyntaxKind.LessThanToken:
        return comparison('<');
      case ts.SyntaxKind.LessThanEqualsToken:
        return comparison('<=');
      case ts.SyntaxKind.GreaterThanToken:
        return comparison('>');
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return comparison('>=');
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken: {
        if (left.sort !== right.sort || left.sort === 'rec') throw new Unsupported('comparison of unlike values or records');
        const equal = `(= ${left.smt} ${right.smt})`;
        return { smt: node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? equal : `(not ${equal})`, sort: 'bool' };
      }
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return { smt: `(and ${this.boolean(left)} ${this.boolean(right)})`, sort: 'bool' };
      case ts.SyntaxKind.BarBarToken:
        return { smt: `(or ${this.boolean(left)} ${this.boolean(right)})`, sort: 'bool' };
    }
    throw new Unsupported(`operator ${node.operatorToken.getText()} does not lower`);
  }

  private call(file: string, node: ts.CallExpression, env: Map<string, Term>): Term {
    const callee = this.calleeName(node.expression);
    if (callee === undefined) throw new Unsupported('call target is not a plain name');
    const args = node.arguments.map((arg) => this.expression(file, arg, env));
    if (callee.owner === 'Math') {
      const a = args.map((arg) => this.num(arg));
      switch (callee.name) {
        case 'abs':
          if (a.length === 1) return { smt: `(ite (< ${a[0]} 0.0) (- ${a[0]}) ${a[0]})`, sort: 'num' };
          break;
        case 'min':
          if (a.length === 2) return { smt: `(ite (< ${a[0]} ${a[1]}) ${a[0]} ${a[1]})`, sort: 'num' };
          break;
        case 'max':
          if (a.length === 2) return { smt: `(ite (> ${a[0]} ${a[1]}) ${a[0]} ${a[1]})`, sort: 'num' };
          break;
        case 'floor':
          if (a.length === 1) return { smt: `(to_real (to_int ${a[0]}))`, sort: 'num' };
          break;
      }
      throw new Unsupported(`Math.${callee.name} does not lower`);
    }
    const index = this.index(file);
    let targetFile = file;
    let target: FunctionNode | undefined;
    if (callee.owner === undefined) target = index.functions.get(callee.name);
    else {
      const moduleFile = index.imports.get(callee.owner);
      if (moduleFile !== undefined) {
        targetFile = moduleFile;
        target = this.index(moduleFile).functions.get(callee.name);
      }
    }
    if (target === undefined) throw new Unsupported(`cannot find the source of ${callee.owner === undefined ? '' : `${callee.owner}.`}${callee.name}`);
    return this.callFunction(targetFile, target, args);
  }
}

/** Declares the constants of a parameter, flattening a record to one per field. */
function declareParam(name: string, shape: Shape, declarations: string[]): Term {
  if (shape === 'number') {
    declarations.push(`(declare-const ${name} Real)`);
    return { smt: name, sort: 'num' };
  }
  if (shape === 'boolean') {
    declarations.push(`(declare-const ${name} Bool)`);
    return { smt: name, sort: 'bool' };
  }
  if (shape === undefined)
    throw new Unsupported('a parameter type is not modelled (only numbers, booleans and records of them)');
  const fields = new Map<string, Term>();
  for (const [field, fieldShape] of Object.entries(shape.fields))
    fields.set(field, declareParam(`${name}__${field}`, fieldShape, declarations));
  return { smt: name, sort: 'rec', fields };
}

/** The JavaScript value a model gives a parameter. */
function valueOfParam(name: string, shape: Shape, model: Map<string, number | boolean>): unknown {
  if (shape === 'number') return model.get(name) ?? 0;
  if (shape === 'boolean') return model.get(name) ?? false;
  const value: Record<string, unknown> = {};
  if (shape !== undefined)
    for (const [field, fieldShape] of Object.entries(shape.fields))
      value[field] = valueOfParam(`${name}__${field}`, fieldShape, model);
  return value;
}

function declaredNames(name: string, shape: Shape): string[] {
  if (shape === 'number' || shape === 'boolean' || shape === undefined) return [name];
  return Object.entries(shape.fields).flatMap(([field, fieldShape]) => declaredNames(`${name}__${field}`, fieldShape));
}

/** Reads a Z3 value: `3.0`, `(- 1.5)`, `(/ 1.0 3.0)`, `true`. */
function parseValue(text: string): number | boolean {
  const value = text.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  const compound = /^\((-|\/)\s+(.+)\)$/.exec(value);
  if (compound !== null) {
    if (compound[1] === '-') return -(parseValue(compound[2]!) as number);
    const parts = /^(\S+|\(.+?\))\s+(\S+|\(.+?\))$/.exec(compound[2]!);
    if (parts === null) throw new Unsupported(`cannot read model value ${text}`);
    return (parseValue(parts[1]!) as number) / (parseValue(parts[2]!) as number);
  }
  const number = Number(value);
  if (Number.isNaN(number)) throw new Unsupported(`cannot read model value ${text}`);
  return number;
}

function parseModel(output: string, names: string[]): Map<string, number | boolean> {
  const values = new Map<string, number | boolean>();
  for (const name of names) {
    const match = new RegExp(`\\(define-fun ${name} \\(\\) \\w+\\s+([\\s\\S]*?)\\)\\s*(?=\\(define-fun|\\)\\s*$)`).exec(output);
    if (match !== null) values.set(name, parseValue(match[1]!));
  }
  return values;
}

type Z3Api = { mk_context: (config: unknown) => unknown; mk_config: () => unknown; eval_smtlib2_string: (ctx: unknown, text: string) => Promise<string> };

let z3: Promise<Z3Api> | undefined;

async function z3Api(): Promise<Z3Api> {
  z3 ??= import('z3-solver').then(async (module) => (await module.init()).Z3 as unknown as Z3Api);
  return z3;
}

/** Closes the Z3 worker threads so the process can exit. */
export async function shutdownProver(): Promise<void> {
  if (z3 === undefined) return;
  z3 = undefined;
}

/** Tries to prove `input.law` for every input. */
export async function proveLaw(input: ProveInput): Promise<ProofResult> {
  try {
    const lowering = new Lowering();
    const source = ts.createSourceFile(input.jsFile, readFileSync(input.jsFile, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const fn = source.statements.find(
      (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === input.law.name,
    );
    if (fn === undefined || fn.body === undefined) throw new Unsupported('law function not found in the compiled output');
    if (fn.parameters.length !== input.shapes.length) throw new Unsupported('parameter count mismatch');
    const names = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
    const declare: string[] = [];
    const params = names.map((name, i) => declareParam(name, input.shapes[i], declare));
    const result = lowering.lawResult(input.jsFile, fn, params);
    // A law that returns a number (or nothing) holds as long as it does not throw, which lowering cannot see.
    const holds = result === undefined || result.sort === 'num' ? 'true' : result.smt;
    const query = [
      `(set-option :timeout ${input.timeoutMs})`,
      ...declare,
      ...lowering.assumptions.map((a) => `(assert ${a})`),
      `(assert (not ${holds}))`,
      '(check-sat)',
      '(get-model)',
    ].join('\n');
    const api = await z3Api();
    const ctx = api.mk_context(api.mk_config());
    const output = (await api.eval_smtlib2_string(ctx, query)).trim();
    if (output.startsWith('unsat')) return { kind: 'proved', model: input.model };
    if (output.startsWith('unknown')) throw new Unsupported(`solver gave up within ${input.timeoutMs} ms`);
    if (!output.startsWith('sat')) throw new Unsupported(`solver said: ${output.split('\n')[0]}`);
    const model = parseModel(
      output.slice(3),
      names.flatMap((name, i) => declaredNames(name, input.shapes[i])),
    );
    const inputs = names.map((name, i) => valueOfParam(name, input.shapes[i], model));
    // A model over reals may not be a double that fails in JavaScript; only a reproduced failure is a refutation.
    if (input.holds(inputs)) throw new Unsupported(`solver model ${JSON.stringify(inputs)} does not fail in JavaScript (float effects)`);
    return { kind: 'refuted', model: names.map((n, i) => `${n} = ${JSON.stringify(inputs[i])}`).join(', '), inputs };
  } catch (error) {
    if (error instanceof Unsupported) return { kind: 'unsupported', reason: error.message };
    throw error;
  }
}
