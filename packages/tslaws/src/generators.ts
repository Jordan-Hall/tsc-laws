// Derives fast-check generators from the declared parameter types of laws, read from the declaration
// files the compiler emitted. Full TypeScript types map: primitives, literals, unions, enums, arrays,
// tuples, object types, index signatures, type parameters (via their constraint) and registered names.
import * as fc from 'fast-check';
import ts from 'typescript';
import { arbitraryRegistry } from './api.ts';

export class UnsupportedType extends Error {}

const numbers = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -8, max: 8 }) },
  { weight: 3, arbitrary: fc.integer({ min: -1000, max: 1000 }) },
  { weight: 1, arbitrary: fc.integer() },
  { weight: 2, arbitrary: fc.double({ noNaN: true, noDefaultInfinity: true }) },
);

// `int` from 'tslaws': whole numbers, biased to small ones.
arbitraryRegistry().set(
  'int',
  fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: -8, max: 8 }) },
    { weight: 3, arbitrary: fc.integer({ min: -1000, max: 1000 }) },
    { weight: 1, arbitrary: fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }) },
  ),
);

/** Marks a generated function on the wire: browser laws receive their arguments as structured data. */
export const wireKey = '$tslawsFn';

function pick(samples: unknown[], args: unknown[]): unknown {
  let key = '';
  try {
    key = JSON.stringify(args) ?? '';
  } catch {
    // Arguments that are not JSON (a node, a cycle) all share the first sample.
  }
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 33) + key.charCodeAt(i)) | 0;
  return samples[(h >>> 0) % samples.length];
}

/**
 * A function of a type with one call signature: it returns one of a few values generated from the return type,
 * chosen by its arguments (like `fc.func`: the same arguments give the same result, `void` gives `undefined`).
 * `samples` rides along so a browser law can rebuild the function in the page.
 */
function generatedFunction(samples: unknown[]): unknown {
  const fn = (...args: unknown[]): unknown => pick(samples, args);
  Object.defineProperty(fn, wireKey, { value: samples, enumerable: false });
  Object.defineProperty(fn, 'toString', { value: () => `[generated function]`, enumerable: false });
  return fn;
}

/** Replaces generated functions inside arguments with a structured-clone-safe marker `{ $tslawsFn: samples }`. */
export function toWire(value: unknown): unknown {
  if (typeof value === 'function') {
    const samples = (value as unknown as Record<string, unknown>)[wireKey];
    return { [wireKey]: Array.isArray(samples) ? samples : [undefined] };
  }
  if (Array.isArray(value)) return value.map(toWire);
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null)
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toWire(v)]));
  }
  return value;
}

export class GeneratorFactory {
  private readonly checker: ts.TypeChecker;
  private readonly active = new Set<ts.Type>();

  constructor(checker: ts.TypeChecker) {
    this.checker = checker;
  }

  of(type: ts.Type, depth = 0): fc.Arbitrary<unknown> {
    const named = this.registered(type);
    if (named !== undefined) return named;
    const f = type.flags;
    if (f & ts.TypeFlags.Any || f & ts.TypeFlags.Unknown) return fc.anything();
    if (f & ts.TypeFlags.Never) throw new UnsupportedType('type never has no values');
    if (f & ts.TypeFlags.Void || f & ts.TypeFlags.Undefined) return fc.constant(undefined);
    if (f & ts.TypeFlags.Null) return fc.constant(null);
    if (f & ts.TypeFlags.BooleanLiteral) return fc.constant(this.checker.typeToString(type) === 'true');
    if (f & ts.TypeFlags.Boolean) return fc.boolean();
    if (f & ts.TypeFlags.NumberLiteral) return fc.constant((type as ts.NumberLiteralType).value);
    if (f & ts.TypeFlags.StringLiteral) return fc.constant((type as ts.StringLiteralType).value);
    if (f & ts.TypeFlags.BigIntLiteral) {
      const v = (type as ts.BigIntLiteralType).value;
      return fc.constant(BigInt(`${v.negative ? '-' : ''}${v.base10Value}`));
    }
    if (f & ts.TypeFlags.EnumLiteral && f & ts.TypeFlags.Union) return this.union(type as ts.UnionType, depth);
    if (f & ts.TypeFlags.Number) return numbers;
    if (f & ts.TypeFlags.String) return fc.string({ maxLength: 24 });
    if (f & ts.TypeFlags.BigInt) return fc.bigInt();
    if (f & ts.TypeFlags.ESSymbol) return fc.string().map((s) => Symbol(s));
    if (f & ts.TypeFlags.TemplateLiteral) return this.template(type as ts.TemplateLiteralType, depth);
    if (f & ts.TypeFlags.TypeParameter) {
      const constraint = this.checker.getBaseConstraintOfType(type);
      if (constraint === undefined || constraint === type) return fc.anything();
      return this.of(constraint, depth);
    }
    if (f & ts.TypeFlags.Union) return this.union(type as ts.UnionType, depth);
    if (f & ts.TypeFlags.Intersection) return this.object(type, depth);
    if (f & ts.TypeFlags.Object) return this.object(type, depth);
    if (f & ts.TypeFlags.NonPrimitive) return fc.object();
    throw new UnsupportedType(`no generator for type ${this.checker.typeToString(type)}`);
  }

  private registered(type: ts.Type): fc.Arbitrary<unknown> | undefined {
    const symbol = type.aliasSymbol ?? type.getSymbol();
    if (symbol === undefined) return undefined;
    return arbitraryRegistry().get(symbol.getName());
  }

  private union(type: ts.UnionType, depth: number): fc.Arbitrary<unknown> {
    const members = type.types.filter((t) => !(t.flags & ts.TypeFlags.Never));
    return fc.oneof(...members.map((member) => this.of(member, depth)));
  }

  private template(type: ts.TemplateLiteralType, depth: number): fc.Arbitrary<unknown> {
    const parts: fc.Arbitrary<string>[] = [fc.constant(type.texts[0] ?? '')];
    type.types.forEach((t, i) => {
      parts.push(this.of(t, depth).map(String));
      parts.push(fc.constant(type.texts[i + 1] ?? ''));
    });
    return fc.tuple(...parts).map((p) => p.join(''));
  }

  private object(type: ts.Type, depth: number): fc.Arbitrary<unknown> {
    const checker = this.checker;
    if (this.active.has(type) || depth > 4) return fc.constant(undefined);
    const name = type.getSymbol()?.getName();
    if (name === 'Date') return fc.date({ noInvalidDate: true });
    if (name === 'RegExp') return fc.constant(/x/);
    if (checker.isArrayType(type)) {
      const element = checker.getTypeArguments(type as ts.TypeReference)[0]!;
      return fc.array(this.of(element, depth + 1), { maxLength: 8 });
    }
    if (checker.isTupleType(type)) {
      const target = (type as ts.TypeReference).target as ts.TupleType;
      const args = checker.getTypeArguments(type as ts.TypeReference);
      const required = args.slice(0, target.minLength).map((t) => this.of(t, depth + 1));
      const optional = args.slice(target.minLength).map((t) => this.of(t, depth + 1));
      return fc.tuple(...required).chain((head) => {
        if (optional.length === 0) return fc.constant(head);
        return fc.tuple(...optional).map((tail) => [...head, ...tail]);
      });
    }
    if (type.getCallSignatures().length > 0) {
      const signature = type.getCallSignatures()[0]!;
      const returns = this.of(checker.getReturnTypeOfSignature(signature), depth + 1);
      return fc.array(returns, { minLength: 1, maxLength: 4 }).map(generatedFunction);
    }
    this.active.add(type);
    try {
      const model: Record<string, fc.Arbitrary<unknown>> = {};
      const required: string[] = [];
      for (const property of checker.getPropertiesOfType(type)) {
        const declaration = property.valueDeclaration ?? property.declarations?.[0];
        if (declaration === undefined) continue;
        const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
        const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
        const generator = this.of(optional ? checker.getNonNullableType(propertyType) : propertyType, depth + 1);
        model[property.getName()] = generator;
        if (!optional) required.push(property.getName());
      }
      const index = checker.getIndexInfosOfType(type)[0];
      if (index !== undefined && Object.keys(model).length === 0) {
        return fc.dictionary(fc.string({ maxLength: 6 }), this.of(index.type, depth + 1), { maxKeys: 6 });
      }
      return fc.record(model, { requiredKeys: required });
    } finally {
      this.active.delete(type);
    }
  }
}
