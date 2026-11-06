// The test frameworks migrate reads: which module each comes from, what its calls are named, and how a call in a test
// file is told apart (by the import it came from, or by the global the framework provides).
import ts from 'typescript';
import type { Source } from './source.ts';

export const sources = ['vitest', 'jest', 'rstest', 'bun', 'node', 'fast-check', 'playwright'] as const;
export type SourceName = (typeof sources)[number];

export function isSourceName(value: string | undefined): value is SourceName {
  return (sources as readonly string[]).includes(value ?? '');
}

/** Modules that provide test structure or matchers. Their imports are rebuilt rather than copied. */
export const frameworkModules: Record<string, SourceName> = {
  vitest: 'vitest',
  '@jest/globals': 'jest',
  '@rstest/core': 'rstest',
  'bun:test': 'bun',
  'node:test': 'node',
  '@playwright/test': 'playwright',
  'fast-check': 'fast-check',
  '@fast-check/vitest': 'vitest',
  '@fast-check/jest': 'jest',
};

/** Where `expect` (and the mock helpers) come from when a file uses the framework's globals instead of importing them. */
export const globalsModule: Partial<Record<SourceName, { module: string; names: string[] }>> = {
  vitest: { module: 'vitest', names: ['expect', 'vi'] },
  jest: { module: '@jest/globals', names: ['expect', 'jest'] },
  rstest: { module: '@rstest/core', names: ['expect', 'rs', 'rstest'] },
  bun: { module: 'bun:test', names: ['expect', 'mock', 'spyOn'] },
  playwright: { module: '@playwright/test', names: ['expect'] },
};

/** Names that only describe test structure: an import of one is dropped, never kept for the laws. */
export const structural = new Set([
  'describe',
  'suite',
  'it',
  'test',
  'xit',
  'xtest',
  'xdescribe',
  'fit',
  'ftest',
  'fdescribe',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'before',
  'after',
]);

export interface Callee {
  kind: 'describe' | 'test' | 'hook' | 'config';
  hook?: 'before' | 'after';
  /** Playwright's `use`, `setTimeout`, `step`, `info`, `configure`, `extend`. */
  config?: string;
  mods: Set<string>;
  /** The call of ``.each(...)`` or the tagged template of ``.each`...` ``. */
  each?: ts.CallExpression | ts.TaggedTemplateExpression;
  /** `.for` (vitest) hands each row to the test as one argument instead of spreading it. */
  forRows?: boolean;
  /** `it.prop(arbitraries, options?)` of @fast-check/vitest and @fast-check/jest. */
  prop?: ts.CallExpression;
  /** `.runIf(...)` / `.skipIf(...)`, which choose at run time. */
  conditional?: string;
}

/** `a.b.c` as `['a', 'b', 'c']`, or undefined when the expression is anything else. */
export function chainOf(node: ts.Expression): string[] | undefined {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    const inner = chainOf(node.expression);
    return inner === undefined ? undefined : [...inner, node.name.text];
  }
  return undefined;
}

export interface Bindings {
  /** Local name to the name the framework exports it under (`it as spec` gives `spec -> it`). */
  imported: Map<string, string>;
  /** Local names that are a framework's whole module (`import * as t from 'vitest'`). */
  namespaces: Set<string>;
  /** Local names the file declares itself or imports from elsewhere: they are not the framework's globals. */
  own: Set<string>;
  /** Local names of fast-check's namespace (`fc`) and its named exports (local to exported name). */
  fcNamespaces: Set<string>;
  fcNamed: Map<string, string>;
}

function declaredTopLevel(statement: ts.Statement): string[] {
  const names: string[] = [];
  const bind = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.push(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
  };
  if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) bind(d.name);
  else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined)
    names.push(statement.name.text);
  return names;
}

export function bindingsOf(source: Source): Bindings {
  const b: Bindings = {
    imported: new Map(),
    namespaces: new Set(),
    own: new Set(),
    fcNamespaces: new Set(),
    fcNamed: new Map(),
  };
  for (const statement of source.file.statements) {
    if (!ts.isImportDeclaration(statement)) {
      for (const name of declaredTopLevel(statement)) b.own.add(name);
      continue;
    }
    const clause = statement.importClause;
    if (clause === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    const known = frameworkModules[module] !== undefined;
    const fastCheck = module === 'fast-check';
    const fastCheckRelated = fastCheck || module === '@fast-check/vitest' || module === '@fast-check/jest';
    if (clause.name !== undefined) {
      if (fastCheck) b.fcNamespaces.add(clause.name.text);
      else if (known) b.imported.set(clause.name.text, 'test');
      else b.own.add(clause.name.text);
    }
    const named = clause.namedBindings;
    if (named === undefined) continue;
    if (ts.isNamespaceImport(named)) {
      if (fastCheck) b.fcNamespaces.add(named.name.text);
      else if (known) b.namespaces.add(named.name.text);
      else b.own.add(named.name.text);
      continue;
    }
    for (const element of named.elements) {
      const local = element.name.text;
      const original = (element.propertyName ?? element.name).text;
      if (fastCheck) b.fcNamed.set(local, original);
      else if (known && fastCheckRelated && original === 'fc') b.fcNamespaces.add(local);
      else if (known) b.imported.set(local, original);
      else b.own.add(local);
    }
  }
  return b;
}

const modifiers = new Set([
  'skip',
  'todo',
  'fixme',
  'only',
  'concurrent',
  'sequential',
  'serial',
  'parallel',
  'shuffle',
  'slow',
  'fails',
  'failing',
  'fail',
]);
const aliases: Record<string, [string, string]> = {
  xit: ['it', 'skip'],
  xtest: ['test', 'skip'],
  xdescribe: ['describe', 'skip'],
  fit: ['it', 'only'],
  ftest: ['test', 'only'],
  fdescribe: ['describe', 'only'],
};
const playwrightConfig = new Set(['use', 'setTimeout', 'step', 'info', 'extend', 'configure']);

/**
 * What a call's callee means in a test file: `describe`, `it.skip`, `test.each(table)`, `beforeEach`, `test.describe.serial`.
 * Undefined when the callee is not the framework's.
 */
export function classify(callee: ts.Expression, b: Bindings, playwright: boolean): Callee | undefined {
  const mods = new Set<string>();
  let each: Callee['each'];
  let prop: ts.CallExpression | undefined;
  let conditional: string | undefined;
  let forRows = false;
  let node = callee;
  if (ts.isTaggedTemplateExpression(node)) {
    const tag = chainOf(node.tag);
    if (tag?.[tag.length - 1] !== 'each') return undefined;
    each = node;
    node = node.tag;
  } else if (ts.isCallExpression(node)) {
    const inner = chainOf(node.expression);
    const last = inner?.[inner.length - 1];
    if (last === 'each' || last === 'for') {
      each = node;
      forRows = last === 'for';
    } else if (last === 'prop') prop = node;
    else if (last === 'runIf' || last === 'skipIf') conditional = last;
    else return undefined;
    node = node.expression;
  }
  const chain = chainOf(node);
  if (chain === undefined) return undefined;
  let [root, ...rest] = chain as [string, ...string[]];
  if (b.namespaces.has(root) && rest.length > 0) [root, ...rest] = rest as [string, ...string[]];
  else if (b.namespaces.has(root)) return undefined;
  if (each !== undefined || prop !== undefined || conditional !== undefined) rest = rest.slice(0, -1);
  let name = b.imported.get(root);
  if (name === undefined) {
    if (b.own.has(root) || !structural.has(root)) return undefined;
    name = root;
  }
  const alias = aliases[name];
  if (alias !== undefined) {
    name = alias[0];
    mods.add(alias[1]);
  }
  const result: Callee = { kind: 'test', mods, each, forRows, prop, conditional };
  if (playwright) {
    if (name !== 'test') return undefined;
    const sub = rest[0];
    if (sub === 'describe') {
      result.kind = 'describe';
      rest = rest.slice(1);
    } else if (sub === 'beforeEach' || sub === 'afterEach' || sub === 'beforeAll' || sub === 'afterAll') {
      name = sub;
      rest = rest.slice(1);
    } else if (sub !== undefined && playwrightConfig.has(sub)) {
      result.kind = 'config';
      result.config = sub;
      rest = rest.slice(1);
    }
    // `test.describe.configure(...)`
    if (result.kind === 'describe' && rest[0] !== undefined && playwrightConfig.has(rest[0])) {
      result.kind = 'config';
      result.config = rest[0];
      rest = rest.slice(1);
    }
  }
  for (const m of rest) {
    if (!modifiers.has(m)) return undefined;
    mods.add(m);
  }
  if (result.kind === 'config') return result;
  if (name === 'describe' || name === 'suite') result.kind = 'describe';
  else if (/^(before|after)(Each|All)?$/.test(name)) {
    result.kind = 'hook';
    result.hook = name.startsWith('before') ? 'before' : 'after';
  } else if (name !== 'it' && name !== 'test') return undefined;
  return result;
}
