// Derives generator plans from the declared parameter types of laws, read from the declaration files the compiler
// emitted. Full TypeScript types map: primitives, literals, unions, enums, arrays, tuples, object types, index
// signatures, type parameters (via their constraint) and registered names. A plan is plain data (see plan.ts) that
// a worker turns into fast-check arbitraries without loading TypeScript.
import type * as fc from 'fast-check';
import ts from 'typescript';
import { arbitraryRegistry } from './api.ts';
import { arbitraryOf, UnsupportedType, type Plan } from './plan.ts';

export { toWire, UnsupportedType, wireKey } from './plan.ts';

export class GeneratorFactory {
  private readonly checker: ts.TypeChecker;
  private readonly active = new Set<ts.Type>();

  constructor(checker: ts.TypeChecker) {
    this.checker = checker;
  }

  /** The arbitrary for `type`, built in this process. */
  of(type: ts.Type): fc.Arbitrary<unknown> {
    return arbitraryOf(this.plan(type));
  }

  plan(type: ts.Type, depth = 0): Plan {
    return this.registered(type, depth) ?? this.structural(type, depth);
  }

  private structural(type: ts.Type, depth: number): Plan {
    const f = type.flags;
    if (f & ts.TypeFlags.Any || f & ts.TypeFlags.Unknown) return { k: 'anything' };
    if (f & ts.TypeFlags.Never) throw new UnsupportedType('type never has no values');
    if (f & ts.TypeFlags.Void || f & ts.TypeFlags.Undefined) return { k: 'const', v: undefined };
    if (f & ts.TypeFlags.Null) return { k: 'const', v: null };
    if (f & ts.TypeFlags.BooleanLiteral) return { k: 'const', v: this.checker.typeToString(type) === 'true' };
    if (f & ts.TypeFlags.Boolean) return { k: 'boolean' };
    if (f & ts.TypeFlags.NumberLiteral) return { k: 'const', v: (type as ts.NumberLiteralType).value };
    if (f & ts.TypeFlags.StringLiteral) return { k: 'const', v: (type as ts.StringLiteralType).value };
    if (f & ts.TypeFlags.BigIntLiteral) {
      const v = (type as ts.BigIntLiteralType).value;
      return { k: 'bigconst', v: `${v.negative ? '-' : ''}${v.base10Value}` };
    }
    if (f & ts.TypeFlags.EnumLiteral && f & ts.TypeFlags.Union) return this.union(type as ts.UnionType, depth);
    if (f & ts.TypeFlags.Number) return { k: 'number' };
    if (f & ts.TypeFlags.String) return { k: 'string' };
    if (f & ts.TypeFlags.BigInt) return { k: 'bigint' };
    if (f & ts.TypeFlags.ESSymbol) return { k: 'symbol' };
    if (f & ts.TypeFlags.TemplateLiteral) return this.template(type as ts.TemplateLiteralType, depth);
    if (f & ts.TypeFlags.TypeParameter) {
      const constraint = this.checker.getBaseConstraintOfType(type);
      if (constraint === undefined || constraint === type) return { k: 'anything' };
      return this.plan(constraint, depth);
    }
    if (f & ts.TypeFlags.Union) return this.union(type as ts.UnionType, depth);
    if (f & ts.TypeFlags.Intersection) return this.object(type, depth);
    if (f & ts.TypeFlags.Object) return this.object(type, depth);
    if (f & ts.TypeFlags.NonPrimitive) return { k: 'object' };
    throw new UnsupportedType(`no generator for type ${this.checker.typeToString(type)}`);
  }

  /** A type with a registered generator keeps its name in the plan, so a registration made later still applies. */
  private registered(type: ts.Type, depth: number): Plan | undefined {
    const symbol = type.aliasSymbol ?? type.getSymbol();
    if (symbol === undefined) return undefined;
    const name = symbol.getName();
    if (!arbitraryRegistry().has(name)) return undefined;
    if (name === 'int') return { k: 'named', name };
    // What to generate if the registration is not there where the plan is used (a worker has only the built-in ones).
    // `int` and the like are intersections that have no useful structure, so a type that cannot be planned has none.
    try {
      return { k: 'named', name, fallback: this.structural(type, depth) };
    } catch (error) {
      if (error instanceof UnsupportedType) return { k: 'named', name };
      throw error;
    }
  }

  private union(type: ts.UnionType, depth: number): Plan {
    const members = type.types.filter((t) => !(t.flags & ts.TypeFlags.Never));
    return { k: 'union', of: members.map((member) => this.plan(member, depth)) };
  }

  private template(type: ts.TemplateLiteralType, depth: number): Plan {
    return { k: 'template', texts: [...type.texts], parts: type.types.map((t) => this.plan(t, depth)) };
  }

  private object(type: ts.Type, depth: number): Plan {
    const checker = this.checker;
    if (this.active.has(type) || depth > 4) return { k: 'const', v: undefined };
    const name = type.getSymbol()?.getName();
    if (name === 'Date') return { k: 'date' };
    if (name === 'RegExp') return { k: 'regexp' };
    if (checker.isArrayType(type)) {
      const element = checker.getTypeArguments(type as ts.TypeReference)[0]!;
      return { k: 'array', of: this.plan(element, depth + 1) };
    }
    if (checker.isTupleType(type)) {
      const target = (type as ts.TypeReference).target as ts.TupleType;
      const args = checker.getTypeArguments(type as ts.TypeReference);
      return {
        k: 'tuple',
        required: args.slice(0, target.minLength).map((t) => this.plan(t, depth + 1)),
        optional: args.slice(target.minLength).map((t) => this.plan(t, depth + 1)),
      };
    }
    if (type.getCallSignatures().length > 0) {
      const signature = type.getCallSignatures()[0]!;
      return { k: 'fn', returns: this.plan(checker.getReturnTypeOfSignature(signature), depth + 1) };
    }
    this.active.add(type);
    try {
      const fields: Record<string, Plan> = {};
      const required: string[] = [];
      for (const property of checker.getPropertiesOfType(type)) {
        const declaration = property.valueDeclaration ?? property.declarations?.[0];
        if (declaration === undefined) continue;
        const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
        const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
        fields[property.getName()] = this.plan(optional ? checker.getNonNullableType(propertyType) : propertyType, depth + 1);
        if (!optional) required.push(property.getName());
      }
      const index = checker.getIndexInfosOfType(type)[0];
      if (index !== undefined && Object.keys(fields).length === 0) return { k: 'dict', of: this.plan(index.type, depth + 1) };
      return { k: 'record', fields, required };
    } finally {
      this.active.delete(type);
    }
  }
}
