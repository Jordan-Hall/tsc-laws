// fast-check arbitraries that have a tslaws type: the law gets a typed parameter, and the arbitrary's own limits become
// `assume(...)` lines. Anything else has no faithful type, so the caller keeps the `fc.assert` as it was.
import ts from 'typescript';
import type { Bindings } from './framework.ts';
import { unwrap } from './source.ts';

/** A tslaws type for one arbitrary and the conditions that narrow it back to what the arbitrary produced. */
export interface Typed {
  type: string;
  /** Which tslaws helpers the type and conditions use. */
  uses: Set<'int' | 'forall'>;
  /** The expression for "`value` is one this arbitrary could have produced", when the type alone is wider. */
  condition?: (value: string, depth: number) => string;
}

export type Mapped = { ok: true; typed: Typed } | { ok: false; reason: string };

const no = (reason: string): Mapped => ({ ok: false, reason });

/** The name of the fast-check export an expression refers to (`fc.integer`, or `integer` when imported by name). */
export function fcMember(node: ts.Expression, b: Bindings): string | undefined {
  const e = unwrap(node);
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && b.fcNamespaces.has(e.expression.text))
    return e.name.text;
  if (ts.isIdentifier(e)) return b.fcNamed.get(e.text);
  return undefined;
}

function numberOf(node: ts.Expression | undefined): number | undefined {
  if (node === undefined) return undefined;
  const e = unwrap(node);
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand)) {
    if (e.operator === ts.SyntaxKind.MinusToken) return -Number(e.operand.text);
    if (e.operator === ts.SyntaxKind.PlusToken) return Number(e.operand.text);
  }
  return undefined;
}

type Options = { ok: true; values: Map<string, ts.Expression> } | { ok: false; reason: string };

/** The `{ key: value }` options of an arbitrary; only the keys in `allowed` are understood. */
function optionsOf(node: ts.Expression | undefined, allowed: string[], member: string): Options {
  const values = new Map<string, ts.Expression>();
  if (node === undefined) return { ok: true, values };
  const e = unwrap(node);
  if (!ts.isObjectLiteralExpression(e))
    return { ok: false, reason: `fc.${member} takes options that are not an object literal` };
  for (const p of e.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) || !allowed.includes(p.name.text))
      return {
        ok: false,
        reason: `fc.${member} has an option tslaws cannot express (${p.name?.getText() ?? 'spread'})`,
      };
    values.set(p.name.text, p.initializer);
  }
  return { ok: true, values };
}

const isTrue = (node: ts.Expression | undefined): boolean | undefined =>
  node === undefined
    ? undefined
    : unwrap(node).kind === ts.SyntaxKind.TrueKeyword
      ? true
      : unwrap(node).kind === ts.SyntaxKind.FalseKeyword
        ? false
        : undefined;

function combine(parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((p): p is string => p !== undefined);
  return present.length === 0 ? undefined : present.join(' && ');
}

/** `min` / `max` as comparisons, when both are numeric literals or absent. */
function range(
  values: Map<string, ts.Expression>,
  member: string,
): { ok: true; min?: number; max?: number } | { ok: false; reason: string } {
  const out: { min?: number; max?: number } = {};
  for (const key of ['min', 'max'] as const) {
    const node = values.get(key);
    if (node === undefined) continue;
    const n = numberOf(node);
    if (n === undefined || Number.isNaN(n))
      return { ok: false, reason: `fc.${member} has a ${key} that is not a number literal` };
    out[key] = n;
  }
  return { ok: true, ...out };
}

function bounds(value: string, r: { min?: number; max?: number }): string | undefined {
  return combine([
    r.min === undefined ? undefined : `${value} >= ${r.min}`,
    r.max === undefined ? undefined : `${value} <= ${r.max}`,
  ]);
}

/** Maps one arbitrary expression to a tslaws type, or says why it has none. */
export function mapArbitrary(node: ts.Expression, b: Bindings): Mapped {
  const e = unwrap(node);
  if (!ts.isCallExpression(e)) return no(`${e.getText().slice(0, 40)} is not a plain fc call`);
  const member = fcMember(e.expression, b);
  if (member === undefined) return no(`${e.expression.getText().slice(0, 40)} is not an fc arbitrary`);
  const [first, second] = e.arguments;
  switch (member) {
    case 'integer': {
      const o = optionsOf(first, ['min', 'max'], member);
      if (!o.ok) return no(o.reason);
      const r = range(o.values, member);
      if (!r.ok) return no(r.reason);
      return { ok: true, typed: { type: 'int', uses: new Set(['int']), condition: (v) => bounds(v, r) ?? 'true' } };
    }
    case 'nat': {
      const max = first === undefined ? undefined : numberOf(first);
      let upper: number | undefined = max;
      if (first !== undefined && max === undefined) {
        const o = optionsOf(first, ['max'], member);
        if (!o.ok) return no(o.reason);
        const r = range(o.values, member);
        if (!r.ok) return no(r.reason);
        upper = r.max;
      }
      return {
        ok: true,
        typed: { type: 'int', uses: new Set(['int']), condition: (v) => bounds(v, { min: 0, max: upper })! },
      };
    }
    case 'float':
    case 'double': {
      const o = optionsOf(first, ['min', 'max', 'noNaN', 'noDefaultInfinity'], member);
      if (!o.ok) return no(o.reason);
      const r = range(o.values, member);
      if (!r.ok) return no(r.reason);
      const noNaN = isTrue(o.values.get('noNaN'));
      const noInf = isTrue(o.values.get('noDefaultInfinity'));
      if ((o.values.has('noNaN') && noNaN === undefined) || (o.values.has('noDefaultInfinity') && noInf === undefined))
        return no(`fc.${member} has a flag that is not true or false`);
      const finite = noInf === true && r.min === undefined && r.max === undefined;
      return {
        ok: true,
        typed: {
          type: 'number',
          uses: new Set(),
          condition: (v) =>
            combine([
              noNaN === true ? `!Number.isNaN(${v})` : undefined,
              finite ? `(${v} !== Infinity && ${v} !== -Infinity)` : undefined,
              bounds(v, r),
            ]) ?? 'true',
        },
      };
    }
    case 'string': {
      const o = optionsOf(first, ['minLength', 'maxLength'], member);
      if (!o.ok) return no(o.reason);
      const lo = o.values.has('minLength') ? numberOf(o.values.get('minLength')) : undefined;
      const hi = o.values.has('maxLength') ? numberOf(o.values.get('maxLength')) : undefined;
      if ((o.values.has('minLength') && lo === undefined) || (o.values.has('maxLength') && hi === undefined))
        return no('fc.string has a length that is not a number literal');
      return {
        ok: true,
        typed: {
          type: 'string',
          uses: new Set(),
          condition: (v) => bounds(`${v}.length`, { min: lo, max: hi }) ?? 'true',
        },
      };
    }
    case 'boolean':
      if (first !== undefined) return no('fc.boolean takes no arguments');
      return { ok: true, typed: { type: 'boolean', uses: new Set() } };
    case 'array': {
      if (first === undefined) return no('fc.array needs an element arbitrary');
      const inner = mapArbitrary(first, b);
      if (!inner.ok) return inner;
      const o = optionsOf(second, ['minLength', 'maxLength'], member);
      if (!o.ok) return no(o.reason);
      const lo = o.values.has('minLength') ? numberOf(o.values.get('minLength')) : undefined;
      const hi = o.values.has('maxLength') ? numberOf(o.values.get('maxLength')) : undefined;
      if ((o.values.has('minLength') && lo === undefined) || (o.values.has('maxLength') && hi === undefined))
        return no('fc.array has a length that is not a number literal');
      const t = inner.typed;
      const element = t.condition?.('x', 0) === 'true' ? undefined : t.condition;
      const uses = new Set(t.uses);
      if (element !== undefined) uses.add('forall');
      return {
        ok: true,
        typed: {
          type: `${t.type}[]`,
          uses,
          condition: (v, depth) => {
            const e = `e${depth}`;
            return (
              combine([
                bounds(`${v}.length`, { min: lo, max: hi }),
                element === undefined ? undefined : `forall(${v}, (${e}) => ${element(e, depth + 1)})`,
              ]) ?? 'true'
            );
          },
        },
      };
    }
    default:
      return no(`fc.${member}(...) has no tslaws type`);
  }
}

/** The `assume(...)` argument that narrows `value` to what `typed` produced, or undefined when the type is already exact. */
export function assumption(typed: Typed, value: string): string | undefined {
  const text = typed.condition?.(value, 0);
  return text === undefined || text === 'true' ? undefined : text;
}
