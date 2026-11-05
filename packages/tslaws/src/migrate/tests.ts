// The pieces of a test file that need reading before they become laws: test titles, the callbacks of tests and hooks,
// the rows of `test.each` tables and the titles they print, and the fixtures of a Playwright test.
import ts from 'typescript';
import { chainOf } from './framework.ts';
import type { Source } from './source.ts';
import { literalText, unwrap } from './source.ts';

export type FnLike = ts.ArrowFunction | ts.FunctionExpression;

export const isFn = (node: ts.Node | undefined): node is FnLike =>
  node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

export function isAsyncFn(fn: FnLike): boolean {
  return fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
}

/** The title of a test or suite: a string, a template, or a plain name such as a class. Undefined when it is computed. */
export function titleOf(node: ts.Expression | undefined, src: Source): string | undefined {
  if (node === undefined) return undefined;
  const literal = literalText(node);
  if (literal !== undefined) return literal;
  if (ts.isTemplateExpression(node)) return node.getText(src.file).slice(1, -1);
  if (chainOf(node) !== undefined) return node.getText(src.file);
  return undefined;
}

/** True when the function itself (not a function inside it) returns a value. */
export function returnsValue(fn: FnLike): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || (node !== fn.body && ts.isFunctionLike(node))) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) found = true;
    ts.forEachChild(node, visit);
  };
  if (ts.isBlock(fn.body)) visit(fn.body);
  return found;
}

/** True when `node` contains `await`, or `.resolves` / `.rejects`, outside nested functions. */
export function awaits(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || (n !== node && ts.isFunctionLike(n))) return;
    if (ts.isAwaitExpression(n)) found = true;
    if (ts.isPropertyAccessExpression(n) && (n.name.text === 'resolves' || n.name.text === 'rejects')) found = true;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** The names a function declares at its top level, for telling when inlining two of them in one block would clash. */
export function blockStatements(fn: FnLike): readonly ts.Statement[] {
  return ts.isBlock(fn.body) ? fn.body.statements : [];
}

export interface Fixtures {
  /** Local name to the fixture it stands for. */
  bindings: Map<string, string>;
  problem?: string;
}

/** The fixtures a Playwright callback asks for: `async ({ page, context }) => ...`. */
export function fixturesOf(fn: FnLike): Fixtures {
  const bindings = new Map<string, string>();
  if (fn.parameters.length === 0) return { bindings };
  if (fn.parameters.length > 1) return { bindings, problem: 'it takes testInfo, which a law has no equivalent of' };
  const parameter = fn.parameters[0]!;
  if (!ts.isObjectBindingPattern(parameter.name))
    return { bindings, problem: 'its fixtures are not destructured, so they cannot be mapped' };
  for (const element of parameter.name.elements) {
    if (element.dotDotDotToken !== undefined || element.initializer !== undefined || !ts.isIdentifier(element.name))
      return { bindings, problem: 'a fixture is renamed with a default, a rest or a pattern' };
    const fixture = element.propertyName === undefined ? element.name.text : ts.isIdentifier(element.propertyName) ? element.propertyName.text : undefined;
    if (fixture === undefined) return { bindings, problem: 'a fixture has a computed name' };
    if (fixture !== 'page' && fixture !== 'context' && fixture !== 'baseURL')
      return { bindings, problem: `the fixture ${fixture} has no counterpart in a law (only page, context and baseURL do)` };
    bindings.set(element.name.text, fixture);
  }
  return { bindings };
}

export interface Row {
  /** The arguments the callback receives. */
  args: ts.Expression[];
  /** For a table written as a template: the one object the callback receives, as text, and its cells by column. */
  synthetic?: string;
  cells?: Map<string, ts.Expression>;
  /** For rows of objects: the object, whose properties `$name` in a title refers to. */
  object?: ts.Expression;
  /** Source text of the arguments for the title. */
  texts: string[];
}

export type Rows = { ok: true; rows: Row[]; template: boolean; header: string[] } | { ok: false; reason: string };

/** The rows of ``test.each([...])`` or ``test.each`a | b ...` ``. */
export function rowsOf(each: ts.CallExpression | ts.TaggedTemplateExpression, src: Source, spread: boolean): Rows {
  if (ts.isTaggedTemplateExpression(each)) {
    const template = each.template;
    if (ts.isNoSubstitutionTemplateLiteral(template)) return { ok: true, rows: [], template: true, header: [] };
    const header = template.head.text.trim().split('|').map((h) => h.trim()).filter((h) => h !== '');
    const cells = template.templateSpans.map((s) => s.expression);
    if (header.length === 0 || cells.length % header.length !== 0)
      return { ok: false, reason: 'the table has cells that do not line up with its header' };
    const rows: Row[] = [];
    for (let i = 0; i < cells.length; i += header.length) {
      const row = cells.slice(i, i + header.length);
      const key = (h: string): string => (/^[A-Za-z_$][\w$]*$/.test(h) ? h : JSON.stringify(h));
      const text = `{ ${header.map((h, j) => `${key(h)}: ${src.textOf(row[j]!)}`).join(', ')} }`;
      const byColumn = new Map(header.map((h, j) => [h, row[j]!] as const));
      rows.push({ args: [], synthetic: text, cells: byColumn, texts: [text] });
    }
    return { ok: true, rows, template: true, header };
  }
  const table = each.arguments[0];
  if (table === undefined || !ts.isArrayLiteralExpression(unwrap(table)))
    return { ok: false, reason: 'the table is not an array written in the file, so its rows cannot be listed' };
  const elements = (unwrap(table) as ts.ArrayLiteralExpression).elements;
  if (elements.some((e) => ts.isSpreadElement(e))) return { ok: false, reason: 'the table spreads another array' };
  const allArrays = spread && elements.length > 0 && elements.every((e) => ts.isArrayLiteralExpression(unwrap(e)));
  const rows: Row[] = [];
  for (const element of elements) {
    if (allArrays) {
      const cells = (unwrap(element) as ts.ArrayLiteralExpression).elements;
      if (cells.some((c) => ts.isSpreadElement(c))) return { ok: false, reason: 'a row spreads another array' };
      rows.push({ args: cells.slice(), texts: cells.map((c) => oneLine(src.textOf(c))) });
    } else {
      const e = unwrap(element);
      rows.push({ args: [element], object: ts.isObjectLiteralExpression(e) ? e : undefined, texts: [oneLine(src.textOf(element))] });
    }
  }
  return { ok: true, rows, template: false, header: [] };
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** What a value prints as in a title: strings without quotes, other values as written. */
function shown(node: ts.Expression, src: Source): string {
  const e = unwrap(node);
  const literal = literalText(e);
  if (literal !== undefined) return literal;
  return oneLine(src.textOf(e));
}

/** The title of one row of a table, with `%s`-style and `$name` placeholders filled from the row as the framework does. */
export function rowTitle(title: string, row: Row, index: number, src: Source): string {
  let argument = 0;
  const filled = title.replace(/%([sdifjopP#$%])/g, (whole, spec: string) => {
    if (spec === '%') return '%';
    if (spec === '#') return String(index);
    if (spec === '$') return String(index + 1);
    const node = row.args[argument];
    const text = row.texts[argument];
    argument += 1;
    if (text === undefined) return whole;
    if (spec === 's' && node !== undefined) return shown(node, src);
    return text;
  });
  return filled.replace(/\$(#|[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)/g, (whole, path: string) => {
    if (path === '#') return String(index);
    const [head, ...rest] = path.split('.') as [string, ...string[]];
    const cell = row.cells?.get(head);
    if (cell !== undefined && rest.length === 0) return shown(cell, src);
    const object = row.object;
    if (object !== undefined && ts.isObjectLiteralExpression(object)) {
      for (const p of object.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === head && rest.length === 0)
          return shown(p.initializer, src);
        if (ts.isShorthandPropertyAssignment(p) && p.name.text === head && rest.length === 0) return head;
      }
    }
    return whole;
  });
}
