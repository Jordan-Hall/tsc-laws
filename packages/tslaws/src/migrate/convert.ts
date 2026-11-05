// Converts one test file into the text of a laws file. Every test becomes a `law('describe > name', ...)` call; the
// bodies are copied from the source, with the hooks and the shared set-up of each `describe` placed in front of them.
import ts from 'typescript';
import { assumption, fcMember, mapArbitrary, type Typed } from './arbitraries.ts';
import {
  bindingsOf,
  chainOf,
  classify,
  frameworkModules,
  globalsModule,
  structural,
  type Bindings,
  type Callee,
  type SourceName,
} from './framework.ts';
import type { Entry, EntryKind } from './report.ts';
import { declaredNames, identifiersIn, quote, Source, unwrap } from './source.ts';
import {
  awaits,
  blockStatements,
  fixturesOf,
  isAsyncFn,
  isFn,
  returnsValue,
  rowsOf,
  rowTitle,
  titleOf,
  type FnLike,
  type Row,
} from './tests.ts';

export interface ConvertInput {
  /** The source file, relative to the working directory. */
  path: string;
  text: string;
  from: SourceName;
  /** Maps a relative module specifier of the source to the one the converted file needs where it is written. */
  rewrite: (specifier: string) => string;
}

export interface Converted {
  entries: Entry[];
  laws: string[];
  output?: string;
  /** Whether the laws drive a browser through `tslaws/e2e`, which names the file `*.browser.laws.ts`. */
  e2e: boolean;
}

interface Hook {
  fn: FnLike;
  line: number;
  kind: 'before' | 'after';
  scope: 'each' | 'all';
}

interface Level {
  prelude: ts.Statement[];
  hooks: Hook[];
  /** Why the tests under this level cannot be converted: a hook that cannot be placed in front of them. */
  broken?: string;
}

/** What goes into the body of one law, besides the hooks and shared set-up around it. */
interface Body {
  params: { name: string; type: string }[];
  lines: (depth: number) => string[];
  declared: string[];
  async: boolean;
  fns: FnLike[];
}

const pad = (depth: number): string => '  '.repeat(depth);

class Converter {
  readonly src: Source;
  readonly b: Bindings;
  readonly entries: Entry[] = [];
  readonly laws: string[] = [];
  private readonly lawBlocks: string[] = [];
  private readonly moduleStatements: ts.Statement[] = [];
  private readonly used = new Set<string>();
  private readonly lawNames = new Set<string>();
  private readonly helpers = new Set<'assume' | 'forall' | 'int'>();
  private readonly aliases = new Map<string, string>();
  private readonly playwright: boolean;
  private readonly dialect: SourceName | undefined;
  private e2eName = 'e2e';
  private usesE2e = false;
  private testLocals = new Set<string>();

  private readonly input: ConvertInput;

  constructor(input: ConvertInput) {
    this.input = input;
    this.src = new Source(input.path, input.text);
    this.b = bindingsOf(this.src);
    this.playwright = input.from === 'playwright';
    this.dialect = this.dialectOf();
    for (const [local, name] of this.b.imported) if (name === 'test' && this.playwright) this.testLocals.add(local);
  }

  private dialectOf(): SourceName | undefined {
    if (this.input.from !== 'fast-check') return this.input.from;
    for (const statement of this.src.file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const found = frameworkModules[statement.moduleSpecifier.text];
      if (found !== undefined && found !== 'fast-check' && found !== 'playwright') return found;
    }
    return undefined;
  }

  private entry(kind: EntryKind, node: ts.Node, message: string): void {
    this.entries.push({ file: this.input.path, line: this.src.lineOfNode(node), kind, message });
  }

  /** A name for something new in the file that no identifier of the source already uses. */
  private fresh(name: string): string {
    let candidate = name;
    while (this.src.taken.has(candidate)) candidate = `${candidate}_`;
    this.src.taken.add(candidate);
    return candidate;
  }

  private helper(name: 'assume' | 'forall' | 'int'): string {
    this.helpers.add(name);
    let alias = this.aliases.get(name);
    if (alias === undefined) {
      alias = this.fresh(name);
      this.aliases.set(name, alias);
    }
    return alias;
  }

  convert(): Converted {
    const file = this.src.file;
    if (this.src.taken.has('law') && this.lawIsTaken()) {
      this.entries.push({
        file: this.input.path,
        line: 1,
        kind: 'unconverted',
        message: 'the file already uses the name `law` for something else, and a law must be written with that name',
      });
      return { entries: this.entries, laws: [], e2e: false };
    }
    this.e2eName = this.fresh('e2e');
    this.rewriteSpecifiers();
    const root: Level = { prelude: [], hooks: [] };
    this.walk(file.statements, root, [root], [], undefined, true);
    if (this.laws.length === 0) {
      if (!this.entries.some((e) => e.kind === 'unconverted' || e.kind === 'skipped'))
        this.entries.push({
          file: this.input.path,
          line: 1,
          kind: 'unconverted',
          message: `no ${this.input.from} tests were found in this file`,
        });
      return { entries: this.entries, laws: [], e2e: false };
    }
    const output = this.assemble();
    this.entries.sort((a, b) => a.line - b.line);
    return { entries: this.entries, laws: this.laws, output, e2e: this.playwright };
  }

  /** Whether `law` is declared or imported by the file, rather than being a stray property name. */
  private lawIsTaken(): boolean {
    return this.b.own.has('law') || this.b.imported.has('law');
  }

  // --- module specifiers -------------------------------------------------------------------------------------

  private rewriteSpecifiers(): void {
    const rewriteLiteral = (literal: ts.Expression | undefined): void => {
      if (literal === undefined || !ts.isStringLiteral(literal) || !literal.text.startsWith('.')) return;
      const moved = this.input.rewrite(literal.text);
      if (moved === literal.text) return;
      const q = this.src.text[literal.getStart(this.src.file)]!;
      this.src.edit(literal.getStart(this.src.file), literal.end, `${q}${moved}${q}`);
    };
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined)
        rewriteLiteral(node.moduleSpecifier);
      else if (ts.isCallExpression(node) && node.arguments.length > 0) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require'))
          rewriteLiteral(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(this.src.file);
  }

  // --- walking the test structure ----------------------------------------------------------------------------

  private classifyCall(node: ts.Node): Callee | undefined {
    return ts.isCallExpression(node) ? classify(node.expression, this.b, this.playwright) : undefined;
  }

  /** Whether a test, suite or hook is declared somewhere inside `node`. */
  private declaresTests(node: ts.Node): boolean {
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (this.classifyCall(n) !== undefined) found = true;
      else ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  }

  /** The `fc.assert(...)` a statement is, with an `await` in front of it allowed. */
  private assertOf(statement: ts.Statement): ts.CallExpression | undefined {
    if (!ts.isExpressionStatement(statement)) return undefined;
    let e = unwrap(statement.expression);
    if (ts.isAwaitExpression(e)) e = unwrap(e.expression);
    return ts.isCallExpression(e) && fcMember(e.expression, this.b) === 'assert' ? e : undefined;
  }

  private isModuleMock(statement: ts.Statement): boolean {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
    const chain = ts.isPropertyAccessExpression(statement.expression.expression)
      ? [statement.expression.expression.expression.getText(this.src.file), statement.expression.expression.name.text]
      : [];
    const [object, method] = chain;
    return (
      (object === 'vi' || object === 'jest' || object === 'rs' || object === 'rstest') &&
      (method === 'mock' || method === 'doMock' || method === 'unmock' || method === 'hoisted')
    );
  }

  private walk(
    statements: readonly ts.Statement[],
    level: Level,
    levels: Level[],
    titles: string[],
    skip: string | undefined,
    moduleLevel: boolean,
  ): void {
    const children: { statement: ts.Statement; call: ts.CallExpression; callee?: Callee }[] = [];
    for (const statement of statements) {
      if (ts.isImportDeclaration(statement)) continue;
      const call = ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) ? statement.expression : undefined;
      const callee = call === undefined ? undefined : this.classifyCall(call);
      if (call !== undefined && callee !== undefined) {
        if (callee.kind === 'hook') this.addHook(level, call, callee);
        else if (callee.kind === 'config')
          this.entry(
            'unconverted',
            statement,
            `test.${callee.config ?? 'use'}(...) configures the Playwright runner and has no equivalent in a law; set it in tslaws.json or in the test`,
          );
        else children.push({ statement, call, callee });
        continue;
      }
      if (this.assertOf(statement) !== undefined) {
        children.push({ statement, call: this.assertOf(statement)! });
        continue;
      }
      if (this.isModuleMock(statement)) {
        this.entry('unconverted', statement, 'module mocking has no equivalent outside the framework runner; the call is left out');
        continue;
      }
      if (this.declaresTests(statement)) {
        this.entry(
          'unconverted',
          statement,
          'tests declared inside a loop, condition or function are not converted; write them out as laws',
        );
        continue;
      }
      if (moduleLevel) this.moduleStatements.push(statement);
      else level.prelude.push(statement);
    }
    for (const child of children) {
      if (child.callee === undefined) this.bareProperty(child.statement, child.call, levels, titles, skip);
      else if (child.callee.kind === 'describe') this.describe(child.call, child.callee, levels, titles, skip);
      else this.test(child.call, child.callee, levels, titles, skip);
    }
  }

  private addHook(level: Level, call: ts.CallExpression, callee: Callee): void {
    const fn = call.arguments[0];
    const written = chainOf(call.expression)?.at(-1) ?? '';
    const name = this.b.imported.get(written) ?? written;
    // node:test's `before` and `after` run once, like `beforeAll`.
    const scope = /All$|^(?:before|after)$/.test(name) ? 'all' : 'each';
    const problem = !isFn(fn)
      ? 'the hook is not a function written in place'
      : this.hookProblem(fn);
    if (problem !== undefined) {
      this.entry('unconverted', call, `${name}: ${problem}`);
      level.broken ??= `the ${name} hook at line ${this.src.lineOfNode(call)} was not converted (${problem})`;
      return;
    }
    const hook = fn as FnLike;
    if (scope === 'all')
      this.entry('note', call, `${name} now runs in front of every law instead of once`);
    level.hooks.push({ fn: hook, line: this.src.lineOfNode(call), kind: callee.hook!, scope });
  }

  private hookProblem(fn: FnLike): string | undefined {
    if (this.playwright) {
      const f = fixturesOf(fn);
      if (f.problem !== undefined) return f.problem;
    } else if (fn.parameters.length > 0) return 'it takes a callback or context argument';
    if (returnsValue(fn)) return 'it returns a value (a clean-up function), which a law cannot run afterwards';
    return this.testUse(fn);
  }

  /** Playwright's `test.step(...)` and friends inside a body have no law equivalent. */
  private testUse(fn: FnLike): string | undefined {
    if (this.testLocals.size === 0) return undefined;
    let found: string | undefined;
    const visit = (n: ts.Node): void => {
      if (found !== undefined) return;
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && this.testLocals.has(n.expression.text))
        found = `it uses ${n.expression.text}.${n.name.text}, which only the Playwright runner provides`;
      else ts.forEachChild(n, visit);
    };
    visit(fn.body);
    return found;
  }

  private describe(call: ts.CallExpression, callee: Callee, levels: Level[], titles: string[], skip: string | undefined): void {
    const [titleArg, fn] = call.arguments;
    const title = titleOf(titleArg, this.src);
    if (callee.each !== undefined || callee.prop !== undefined || callee.conditional !== undefined) {
      this.entry('unconverted', call, `${callee.each !== undefined ? 'describe.each' : callee.conditional !== undefined ? `describe.${callee.conditional}` : 'describe'} is not converted; its tests have no laws`);
      return;
    }
    if (title === undefined || !isFn(fn) || !ts.isBlock(fn.body) || fn.parameters.length > 0) {
      this.entry('unconverted', call, 'this describe has a computed title or a callback that is not a plain block; its tests have no laws');
      return;
    }
    let inner = skip;
    if (callee.mods.has('skip') || callee.mods.has('todo') || callee.mods.has('fixme'))
      inner ??= `inside a skipped describe (${title}) at line ${this.src.lineOfNode(call)}`;
    if (callee.mods.has('only')) this.entry('note', call, `describe.only on "${title}": the focus is dropped, every law runs`);
    if (callee.mods.has('fails') || callee.mods.has('failing') || callee.mods.has('fail')) {
      this.entry('unconverted', call, `describe "${title}" is expected to fail; a law cannot expect a failure`);
      return;
    }
    const level: Level = { prelude: [], hooks: [] };
    this.walk(fn.body.statements, level, [...levels, level], [...titles, title], inner, false);
  }

  // --- tests -------------------------------------------------------------------------------------------------

  private unique(name: string): string {
    let candidate = name;
    for (let n = 2; this.lawNames.has(candidate); n += 1) candidate = `${name} (${n})`;
    this.lawNames.add(candidate);
    return candidate;
  }

  private test(call: ts.CallExpression, callee: Callee, levels: Level[], titles: string[], skip: string | undefined): void {
    const args = call.arguments;
    const title = titleOf(args[0], this.src);
    const label = title ?? call.getText(this.src.file).slice(0, 30);
    if (callee.conditional !== undefined) {
      this.entry('unconverted', call, `test.${callee.conditional}(...) chooses at run time; "${label}" has no law`);
      return;
    }
    if (callee.mods.has('fails') || callee.mods.has('failing') || callee.mods.has('fail')) {
      this.entry('unconverted', call, `"${label}" is expected to fail, which a law cannot express`);
      return;
    }
    const fnIndex = args.findIndex((a, i) => i > 0 && isFn(a));
    const fn = fnIndex < 0 ? undefined : (args[fnIndex] as FnLike);
    const options = args.find((a, i) => i > 0 && ts.isObjectLiteralExpression(a)) as ts.ObjectLiteralExpression | undefined;
    const optionMods = new Set<string>();
    const dropped: string[] = [];
    if (options !== undefined)
      for (const p of options.properties) {
        const key = ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
        if (key !== undefined && (key === 'skip' || key === 'todo' || key === 'only') && p.kind === ts.SyntaxKind.PropertyAssignment) {
          const value = (p as ts.PropertyAssignment).initializer.kind;
          if (value === ts.SyntaxKind.TrueKeyword || (value === ts.SyntaxKind.StringLiteral)) optionMods.add(key);
          else dropped.push(key);
        } else dropped.push(key ?? 'option');
      }
    if (args.length > 2 && args.some((a, i) => i > 0 && ts.isNumericLiteral(a))) dropped.push('timeout');
    if (title === undefined && !this.isPropOrEach(callee)) {
      this.entry('unconverted', call, `a test with a computed title or no title (${label}) has no law`);
      return;
    }
    const skipped = ['skip', 'todo', 'fixme'].find((m) => callee.mods.has(m) || optionMods.has(m));
    if (skipped !== undefined || fn === undefined && callee.prop === undefined) {
      this.entry('skipped', call, `${skipped ?? 'todo'}: "${[...titles, title ?? label].join(' > ')}"`);
      return;
    }
    if (skip !== undefined) {
      this.entry('skipped', call, `"${[...titles, title ?? label].join(' > ')}" is ${skip}`);
      return;
    }
    if (callee.mods.has('only') || optionMods.has('only'))
      this.entry('note', call, `only on "${[...titles, title ?? label].join(' > ')}": the focus is dropped, every law runs`);
    if (dropped.length > 0)
      this.entry('note', call, `"${[...titles, title ?? label].join(' > ')}": ${dropped.join(', ')} not kept (a law takes its limits from tslaws.json and the command line)`);
    const broken = levels.find((l) => l.broken !== undefined)?.broken;
    if (broken !== undefined) {
      this.entry('unconverted', call, `"${[...titles, title ?? label].join(' > ')}" has no law because ${broken}`);
      return;
    }
    if (callee.prop !== undefined) {
      this.propTest(call, callee, fn, title, levels, titles);
      return;
    }
    if (callee.each !== undefined) {
      this.eachTest(call, callee, fn!, title!, levels, titles);
      return;
    }
    this.plainTest(call, fn!, title!, levels, titles);
  }

  private isPropOrEach(callee: Callee): boolean {
    return callee.prop !== undefined || callee.each !== undefined;
  }

  private nameOf(titles: string[], title: string): string {
    return this.unique([...titles, title].join(' > '));
  }

  private plainTest(call: ts.CallExpression, fn: FnLike, title: string, levels: Level[], titles: string[]): void {
    const name = this.nameOf(titles, title);
    const problem = this.playwright ? (fixturesOf(fn).problem ?? this.testUse(fn)) : fn.parameters.length > 0 ? 'it takes a callback or context argument' : undefined;
    if (problem !== undefined) {
      this.lawNames.delete(name);
      this.entry('unconverted', call, `"${name}": ${problem}`);
      return;
    }
    const typed = this.propertyOf(fn);
    if (typed !== undefined && typed.ok) {
      this.emitProperty(call, name, typed, levels, [fn]);
      return;
    }
    if (typed !== undefined)
      this.entry('unconverted', typed.node, `fc.assert kept as it is in a zero-parameter law: ${typed.reason}`);
    else this.keepStrayAsserts(fn);
    this.emit(call, name, this.callbackBody(fn), levels);
  }

  /** `fc.assert` calls left inside a law that has no parameters: they still run, but nothing is generated by tslaws. */
  private keepStrayAsserts(fn: FnLike): void {
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && fcMember(n.expression, this.b) === 'assert')
        this.entry('unconverted', n, 'fc.assert kept as it is in a zero-parameter law: it is not the only statement of the test');
      else ts.forEachChild(n, visit);
    };
    visit(fn.body);
  }

  /** The body of a callback as it stands: its statements, or its expression as one statement. */
  private callbackBody(fn: FnLike, extra?: { lines: string[]; declared: string[]; returns?: boolean }): Body {
    const statements = blockStatements(fn);
    const declared = [...statements.flatMap(declaredNames), ...(extra?.declared ?? [])];
    const asyncBody = isAsyncFn(fn) || awaits(fn.body) || (this.playwright && !ts.isBlock(fn.body));
    return {
      params: [],
      declared,
      async: asyncBody,
      fns: [fn],
      lines: (depth) => [
        ...(extra?.lines.map((l) => pad(depth) + l) ?? []),
        ...this.fnLines(fn, depth, asyncBody, extra?.returns === true),
      ],
    };
  }

  private fnLines(fn: FnLike, depth: number, awaited: boolean, returns = false): string[] {
    this.includeNode(fn.body);
    this.playwrightEdits(fn);
    if (ts.isBlock(fn.body)) return this.src.statements(fn.body.statements, depth);
    const expression = fn.body;
    const lines = this.src.block(expression.getStart(this.src.file), expression.end, depth);
    if (lines.length === 0) return [];
    if (returns) lines[0] = `${pad(depth)}return ${lines[0]!.trimStart()}`;
    else if (awaited && !ts.isAwaitExpression(unwrap(expression))) lines[0] = `${pad(depth)}await ${lines[0]!.trimStart()}`;
    lines[lines.length - 1] += ';';
    return lines;
  }

  private includeNode(node: ts.Node): void {
    identifiersIn(node, this.used);
  }

  // --- fast-check ---------------------------------------------------------------------------------------------

  /** A test whose whole body is `fc.assert(fc.property(...))`, mapped to typed parameters when every arbitrary has a type. */
  private propertyOf(fn: FnLike): PropertyResult | undefined {
    if (!ts.isBlock(fn.body) || fn.body.statements.length !== 1) return undefined;
    const assert = this.assertOf(fn.body.statements[0]!);
    if (assert === undefined) return undefined;
    const [prop, options] = assert.arguments;
    const node = fn.body.statements[0]!;
    const fail = (reason: string): PropertyResult => ({ ok: false, reason, node });
    if (prop === undefined) return fail('there is no property');
    const property = unwrap(prop);
    if (!ts.isCallExpression(property)) return fail('the property is built elsewhere');
    const kind = fcMember(property.expression, this.b);
    if (kind !== 'property' && kind !== 'asyncProperty') return fail('the property is not fc.property(...) or fc.asyncProperty(...)');
    const fnArg = property.arguments[property.arguments.length - 1];
    if (!isFn(fnArg)) return fail('the property function is not written in place');
    const note = options === undefined ? undefined : `fc.assert options (${options.getText(this.src.file).replace(/\s+/g, ' ').slice(0, 60)}) are not kept; use --runs and --seed`;
    return this.typedProperty(property.arguments.slice(0, -1), fnArg, node, note, kind === 'asyncProperty');
  }

  private typedProperty(
    arbitraries: readonly ts.Expression[],
    fn: FnLike,
    node: ts.Node,
    note: string | undefined,
    asyncProperty: boolean,
    names?: string[],
  ): PropertyResult {
    const fail = (reason: string): PropertyResult => ({ ok: false, reason, node });
    if (arbitraries.length === 0) return fail('the property has no arbitraries');
    if (names === undefined && fn.parameters.length > arbitraries.length)
      return fail('the property function takes more arguments than there are arbitraries');
    const params: PropertyParam[] = [];
    for (const [i, arbitrary] of arbitraries.entries()) {
      const mapped = mapArbitrary(arbitrary, this.b);
      if (!mapped.ok) return fail(mapped.reason);
      const parameter = names === undefined ? fn.parameters[i] : undefined;
      if (parameter !== undefined && (!ts.isIdentifier(parameter.name) || parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined))
        return fail('a parameter of the property function is destructured or has a default');
      params.push({
        name: names?.[i] ?? (parameter === undefined ? `_${i + 1}` : (parameter.name as ts.Identifier).text),
        typed: mapped.typed,
      });
    }
    return { ok: true, params, fn, note, async: asyncProperty || isAsyncFn(fn), node };
  }

  private emitProperty(call: ts.Node, name: string, p: PropertyOk, levels: Level[], extraFns: FnLike[]): void {
    if (p.note !== undefined) this.entry('note', p.node, p.note);
    const lines: string[] = [];
    const declared: string[] = [];
    const fn = p.fn;
    for (const { name: n, typed } of p.params) {
      const condition = assumption(typed, n);
      if (condition !== undefined) lines.push(`${this.helper('assume')}(${condition});`);
    }
    // `fc.pre(x)` is `assume(x)`.
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && fcMember(n.expression, this.b) === 'pre')
        this.src.edit(n.expression.getStart(this.src.file), n.expression.end, this.helper('assume'));
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
    const body = this.callbackBody(fn, { lines, declared, returns: true });
    body.async = p.async;
    body.fns = [...extraFns];
    body.params = p.params.map((x) => ({ name: x.name, type: this.typeText(x.typed) }));
    this.emit(call, name, body, levels);
  }

  private typeText(typed: Typed): string {
    for (const u of typed.uses) this.helper(u);
    return typed.type.replace(/\bint\b/g, this.aliases.get('int') ?? 'int');
  }

  /** A top-level `fc.assert(...)` outside any test. */
  private bareProperty(statement: ts.Statement, call: ts.CallExpression, levels: Level[], titles: string[], skip: string | undefined): void {
    const line = this.src.lineOfNode(statement);
    const name = this.nameOf(titles, `property at line ${line}`);
    if (skip !== undefined) {
      this.lawNames.delete(name);
      this.entry('skipped', statement, `property at line ${line} is ${skip}`);
      return;
    }
    const broken = levels.find((l) => l.broken !== undefined)?.broken;
    if (broken !== undefined) {
      this.lawNames.delete(name);
      this.entry('unconverted', statement, `property at line ${line} has no law because ${broken}`);
      return;
    }
    const [prop, options] = call.arguments;
    const property = prop === undefined ? undefined : unwrap(prop);
    const kind = property !== undefined && ts.isCallExpression(property) ? fcMember(property.expression, this.b) : undefined;
    const fnArg = property !== undefined && ts.isCallExpression(property) ? property.arguments[property.arguments.length - 1] : undefined;
    let result: PropertyResult;
    if (property === undefined || !ts.isCallExpression(property) || (kind !== 'property' && kind !== 'asyncProperty') || !isFn(fnArg))
      result = { ok: false, reason: 'the property is not fc.property(...) written in place', node: statement };
    else
      result = this.typedProperty(
        property.arguments.slice(0, -1),
        fnArg,
        statement,
        options === undefined ? undefined : `fc.assert options (${options.getText(this.src.file).replace(/\s+/g, ' ').slice(0, 60)}) are not kept; use --runs and --seed`,
        kind === 'asyncProperty',
      );
    if (result.ok) {
      this.emitProperty(statement, name, result, levels, []);
      return;
    }
    this.entry('unconverted', statement, `fc.assert kept as it is in a zero-parameter law: ${result.reason}`);
    this.includeNode(statement);
    const lines = (depth: number): string[] => this.src.statements([statement], depth);
    this.emit(statement, name, { params: [], lines, declared: [], async: awaits(statement), fns: [] }, levels);
  }

  /** `it.prop([arbitraries])('name', (a, b) => ...)` of @fast-check/vitest and @fast-check/jest. */
  private propTest(call: ts.CallExpression, callee: Callee, fn: FnLike | undefined, title: string | undefined, levels: Level[], titles: string[]): void {
    const prop = callee.prop!;
    const name = this.nameOf(titles, title ?? `property at line ${this.src.lineOfNode(call)}`);
    const give = (reason: string): void => this.entry('unconverted', call, `"${name}": ${reason}`);
    if (fn === undefined) {
      this.lawNames.delete(name);
      give('the test function is not written in place');
      return;
    }
    const [arbitraries, options] = prop.arguments;
    if (arbitraries === undefined) {
      this.lawNames.delete(name);
      give('there are no arbitraries');
      return;
    }
    const note = options === undefined ? undefined : `property options (${options.getText(this.src.file).replace(/\s+/g, ' ').slice(0, 60)}) are not kept; use --runs and --seed`;
    const list = unwrap(arbitraries);
    let result: PropertyResult;
    let keys: string[] | undefined;
    if (ts.isArrayLiteralExpression(list)) {
      result = this.typedProperty(list.elements.slice(), fn, call, note, false);
    } else if (ts.isObjectLiteralExpression(list)) {
      // `{ a: fc.integer() }` with a callback that destructures `({ a })`.
      const pattern = fn.parameters[0]?.name;
      const members = new Map<string, ts.Expression>();
      for (const p of list.properties)
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) members.set(p.name.text, p.initializer);
      if (pattern === undefined || !ts.isObjectBindingPattern(pattern) || fn.parameters.length !== 1 || members.size !== list.properties.length) {
        result = { ok: false, reason: 'the object of arbitraries is not matched by a destructured parameter', node: call };
      } else {
        const picked: ts.Expression[] = [];
        keys = [];
        let ok = true;
        for (const element of pattern.elements) {
          const key = element.propertyName === undefined ? (ts.isIdentifier(element.name) ? element.name.text : undefined) : ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName) ? element.propertyName.text : undefined;
          const arbitrary = key === undefined ? undefined : members.get(key);
          if (arbitrary === undefined || !ts.isIdentifier(element.name) || element.initializer !== undefined || element.dotDotDotToken !== undefined) {
            ok = false;
            break;
          }
          picked.push(arbitrary);
          keys.push(element.name.text);
        }
        if (!ok) result = { ok: false, reason: 'a destructured property is renamed with a default or has no arbitrary', node: call };
        else {
          result = this.typedProperty(picked, fn, call, note, false, keys);
        }
      }
    } else result = { ok: false, reason: 'the arbitraries are not written as an array or an object', node: call };
    if (result.ok) {
      this.emitProperty(call, name, result, levels, []);
      return;
    }
    // No tslaws type: keep the property as fast-check runs it, in a law without parameters.
    this.entry('unconverted', call, `"${name}": kept as fc.assert in a zero-parameter law: ${result.reason}`);
    this.includeNode(call);
    const fc = this.fcName();
    const arbs = ts.isObjectLiteralExpression(list) ? `${fc}.record(${this.src.textOf(list)})` : undefined;
    const arbList = ts.isArrayLiteralExpression(list) ? list.elements.map((e) => this.src.textOf(e)) : [arbs ?? this.src.textOf(list)];
    const asyncProperty = isAsyncFn(fn);
    const head = `${asyncProperty ? 'await ' : ''}${fc}.assert(${fc}.${asyncProperty ? 'asyncProperty' : 'property'}(${arbList.join(', ')}, `;
    const lines = (depth: number): string[] => {
      const inner = this.src.block(fn.getStart(this.src.file), fn.end, depth);
      if (inner.length === 0) return [];
      inner[0] = `${pad(depth)}${head}${inner[0]!.trimStart()}`;
      inner[inner.length - 1] += '));';
      return inner;
    };
    this.usedFc = true;
    this.emit(call, name, { params: [], lines, declared: [], async: asyncProperty || awaits(fn), fns: [] }, levels);
  }

  private usedFc = false;

  private fcName(): string {
    for (const n of this.b.fcNamespaces) return n;
    return 'fc';
  }

  // --- test.each ----------------------------------------------------------------------------------------------

  private eachTest(call: ts.CallExpression, callee: Callee, fn: FnLike, title: string, levels: Level[], titles: string[]): void {
    const rows = rowsOf(callee.each!, this.src, callee.forRows !== true);
    const here = (reason: string): void => this.entry('unconverted', call, `"${[...titles, title].join(' > ')}": ${reason}`);
    if (!rows.ok) return here(rows.reason);
    if (rows.rows.length === 0) return here('the table has no rows');
    for (const parameter of fn.parameters)
      if (parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined)
        return here('a parameter has a default or is a rest parameter');
    const problem = this.playwright ? (fixturesOf(fn).problem ?? undefined) : undefined;
    if (problem !== undefined) return here(problem);
    for (const [index, row] of rows.rows.entries()) {
      const name = this.unique([...titles, rowTitle(title, row, index, this.src)].join(' > '));
      const texts = row.synthetic === undefined ? row.args.map((a) => this.src.textOf(a)) : [row.synthetic];
      const bindings: string[] = [];
      const declared: string[] = [];
      for (const [i, parameter] of fn.parameters.entries()) {
        const value = callee.forRows === true && row.args.length === 1 && row.synthetic === undefined && fn.parameters.length === 1 ? texts[0] : texts[i];
        const type = parameter.type === undefined ? '' : `: ${parameter.type.getText(this.src.file)}`;
        bindings.push(`const ${parameter.name.getText(this.src.file)}${type} = ${value ?? 'undefined'};`);
        const pattern = new Set<string>();
        identifiersIn(parameter.name, pattern);
        declared.push(...pattern);
      }
      const statements = blockStatements(fn);
      const asyncBody = isAsyncFn(fn) || awaits(fn.body);
      this.emit(
        call,
        name,
        {
          params: [],
          declared: [...declared, ...statements.flatMap(declaredNames)],
          async: asyncBody,
          fns: [fn],
          lines: (depth) => [...bindings.map((l) => pad(depth) + l), ...this.fnLines(fn, depth, asyncBody)],
        },
        levels,
      );
    }
  }

  // --- Playwright ---------------------------------------------------------------------------------------------

  private playwrightEdits(fn: FnLike): void {
    if (!this.playwright) return;
    const pages = new Set<string>();
    for (const [local, fixture] of fixturesOf(fn).bindings) if (fixture === 'page') pages.add(local);
    if (pages.size === 0) return;
    const relative = (text: string): boolean => !/^[a-z][a-z\d+.-]*:/i.test(text) && !text.startsWith('//');
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'goto' &&
        ts.isIdentifier(n.expression.expression) &&
        pages.has(n.expression.expression.text)
      ) {
        const url = n.arguments[0];
        const text = url === undefined ? undefined : ts.isStringLiteral(url) || ts.isNoSubstitutionTemplateLiteral(url) ? url.text : undefined;
        if (url === undefined) {
          /* page.goto() without a URL is not valid */
        } else if (text === undefined)
          this.entry('note', n, 'page.goto with a computed address: a relative one does not resolve against the base URL in a law; use open(path)');
        else if (relative(text)) {
          this.usesE2e = true;
          const quoted = quote(text);
          if (n.arguments.length === 1 && ts.isAwaitExpression(n.parent))
            this.src.edit(n.getStart(this.src.file), n.end, `${this.e2eName}.open(${quoted})`);
          else this.src.edit(url.getStart(this.src.file), url.end, `new URL(${quoted}, ${this.e2eName}.baseURL()).toString()`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
  }

  // --- placing a law ------------------------------------------------------------------------------------------

  private emit(node: ts.Node, name: string, body: Body, levels: Level[]): void {
    const hooks = levels.flatMap((l) => l.hooks);
    const fixtures = new Map<string, string>();
    if (this.playwright) {
      for (const fn of [...hooks.map((h) => h.fn), ...body.fns])
        for (const [local, fixture] of fixturesOf(fn).bindings) fixtures.set(local, fixture);
      for (const hook of hooks) this.playwrightEdits(hook.fn);
    }
    const isAsync = body.async || hooks.some((h) => isAsyncFn(h.fn) || awaits(h.fn.body) || (this.playwright && !ts.isBlock(h.fn.body)));
    const scope = new Set<string>([...body.params.map((p) => p.name), ...fixtures.keys()]);
    const lines: string[] = [];
    for (const [local, fixture] of fixtures) {
      this.usesE2e = true;
      lines.push(`${pad(1)}const ${local} = ${this.e2eName}.${fixture}();`);
    }
    lines.push(...this.levelLines(levels, 0, 1, scope, body));
    const params = body.params.map((p) => `${p.name}: ${p.type}`).join(', ');
    const head = `law(${quote(name)}, ${isAsync ? 'async ' : ''}(${params}) => {`;
    this.lawBlocks.push(lines.length === 0 ? `${head.replace(/\{$/, '{}')});` : `${head}\n${lines.join('\n')}\n});`);
    this.laws.push(name);
    void node;
  }

  private statementsLines(statements: readonly ts.Statement[], depth: number, scope: Set<string>, wrapAlways: boolean): string[] {
    const names = statements.flatMap(declaredNames);
    this.includeNode({ forEachChild: () => undefined } as unknown as ts.Node);
    for (const s of statements) this.includeNode(s);
    const inner = this.src.statements(statements, names.length > 0 && (wrapAlways || names.some((n) => scope.has(n))) ? depth + 1 : depth);
    if (names.length > 0 && (wrapAlways || names.some((n) => scope.has(n)))) return [`${pad(depth)}{`, ...inner, `${pad(depth)}}`];
    for (const n of names) scope.add(n);
    return inner;
  }

  private hookLines(hook: Hook, depth: number, scope: Set<string>): string[] {
    this.playwrightEdits(hook.fn);
    const fn = hook.fn;
    const awaited = isAsyncFn(fn) || awaits(fn.body) || (this.playwright && !ts.isBlock(fn.body));
    if (!ts.isBlock(fn.body)) {
      this.includeNode(fn.body);
      return this.fnLines(fn, depth, awaited);
    }
    return this.statementsLines(fn.body.statements, depth, scope, true);
  }

  private levelLines(levels: Level[], index: number, depth: number, scope: Set<string>, body: Body): string[] {
    const level = levels[index];
    if (level === undefined) {
      const names = body.declared;
      const wrap = names.some((n) => scope.has(n));
      const lines = body.lines(wrap ? depth + 1 : depth);
      for (const n of body.declared) scope.add(n);
      return wrap ? [`${pad(depth)}{`, ...lines, `${pad(depth)}}`] : lines;
    }
    const out: string[] = [];
    let here = depth;
    let sc = scope;
    const preludeNames = level.prelude.flatMap(declaredNames);
    const opened = index > 0 && preludeNames.some((n) => scope.has(n));
    if (opened) {
      out.push(`${pad(depth)}{`);
      here += 1;
      sc = new Set();
    }
    out.push(...this.statementsLines(level.prelude, here, sc, false));
    for (const hook of level.hooks.filter((h) => h.kind === 'before')) out.push(...this.hookLines(hook, here, sc));
    const after = level.hooks.filter((h) => h.kind === 'after').reverse();
    if (after.length > 0) {
      out.push(`${pad(here)}try {`);
      out.push(...this.levelLines(levels, index + 1, here + 1, new Set(), body));
      out.push(`${pad(here)}} finally {`);
      const finallyScope = new Set<string>();
      for (const hook of after) out.push(...this.hookLines(hook, here + 1, finallyScope));
      out.push(`${pad(here)}}`);
    } else out.push(...this.levelLines(levels, index + 1, here, sc, body));
    if (opened) out.push(`${pad(depth)}}`);
    return out;
  }

  // --- the file -----------------------------------------------------------------------------------------------

  private assemble(): string {
    for (const s of this.moduleStatements) this.includeNode(s);
    const importLines: string[] = [];
    const extra = new Map<string, Set<string>>();
    const tslaws = ['law', ...[...this.helpers].filter((h) => h !== 'int').map((h) => (this.aliases.get(h) === h ? h : `${h} as ${this.aliases.get(h)}`))];
    if (this.helpers.has('int')) tslaws.push(this.aliases.get('int') === 'int' ? 'type int' : `type int as ${this.aliases.get('int')}`);
    importLines.push(`import { ${tslaws.join(', ')} } from 'tslaws';`);
    // The import of `tslaws/e2e` is what makes the file an end-to-end law file, so it stays even when no law uses it.
    if (this.playwright)
      importLines.push(this.usesE2e ? `import * as ${this.e2eName} from 'tslaws/e2e';` : `import 'tslaws/e2e';`);
    const globals = this.dialect === undefined ? undefined : globalsModule[this.dialect];
    const provided = new Set<string>();
    for (const statement of this.src.file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const module = statement.moduleSpecifier.text;
      if (frameworkModules[module] === undefined) {
        importLines.push(...this.src.statements([statement], 0));
        continue;
      }
      const rebuilt = this.frameworkImport(statement, module);
      if (rebuilt !== undefined) importLines.push(rebuilt);
      for (const element of statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) ? statement.importClause.namedBindings.elements : [])
        provided.add(element.name.text);
    }
    if (globals !== undefined) {
      const wanted = globals.names.filter((n) => this.used.has(n) && !provided.has(n) && !this.b.own.has(n));
      if (wanted.length > 0) extra.set(globals.module, new Set(wanted));
    }
    for (const [module, names] of extra) importLines.push(`import { ${[...names].join(', ')} } from ${quote(module)};`);
    if (this.usedFc && !this.src.file.statements.some((s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === 'fast-check' && this.used.has(this.fcName())))
      importLines.push(`import * as ${this.fcName()} from 'fast-check';`);
    const module = this.src.statements(this.moduleStatements, 0);
    return `${[importLines.join('\n'), module.join('\n'), this.lawBlocks.join('\n\n')].filter((p) => p !== '').join('\n\n')}\n`;
  }

  /** A framework import rebuilt with only what the laws still use: usually `expect`, never the test structure. */
  private frameworkImport(statement: ts.ImportDeclaration, module: string): string | undefined {
    const clause = statement.importClause;
    if (clause === undefined) return undefined;
    const typeOnly = clause.isTypeOnly ? 'type ' : '';
    const fastCheck = module === 'fast-check';
    const parts: string[] = [];
    const named = clause.namedBindings;
    const fcFromRunner = module === '@fast-check/vitest' || module === '@fast-check/jest';
    if (fastCheck && clause.name !== undefined && this.used.has(clause.name.text)) parts.push(clause.name.text);
    if (named !== undefined && ts.isNamespaceImport(named)) {
      if (this.used.has(named.name.text)) parts.push(`* as ${named.name.text}`);
    } else if (named !== undefined) {
      const keep = named.elements.filter((e) => {
        const original = (e.propertyName ?? e.name).text;
        if (!fastCheck && structural.has(original)) return false;
        if (fcFromRunner && original === 'fc') return false;
        return this.used.has(e.name.text);
      });
      if (keep.length > 0) {
        const text = `{ ${keep.map((e) => e.getText(this.src.file)).join(', ')} }`;
        parts.push(text);
      }
    }
    if (fcFromRunner && this.usedFc) return undefined;
    if (parts.length === 0) return undefined;
    // A default import and a namespace import cannot share the braces of a named list.
    const heads = parts.filter((p) => !p.startsWith('{'));
    const braces = parts.filter((p) => p.startsWith('{'));
    return `import ${typeOnly}${[...heads, ...braces].join(', ')} from ${quote(module)};`;
  }
}

interface PropertyParam {
  name: string;
  typed: Typed;
}

interface PropertyOk {
  ok: true;
  params: PropertyParam[];
  fn: FnLike;
  note: string | undefined;
  async: boolean;
  node: ts.Node;
}

type PropertyResult = PropertyOk | { ok: false; reason: string; node: ts.Node };

export function convertTestFile(input: ConvertInput): Converted {
  return new Converter(input).convert();
}

export type { Row };
